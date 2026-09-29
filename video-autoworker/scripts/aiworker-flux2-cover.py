#!/usr/bin/env python3
"""Run the pinned local FLUX.2 Klein 4B cover model without network access."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time


REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294"
REPO_CACHE = "models--black-forest-labs--FLUX.2-klein-4B"
MODEL_ROOT = Path("/Users/heisenbergs-1/models/flux2-klein-4b")
SERVICE_ROOT = Path("/Users/heisenbergs-1/ai-worker/services/flux2-klein-4b")
STATE_ROOT = Path("/Users/heisenbergs-1/ai-worker/state/image-generation/flux2-klein-4b")
OUTPUT_ROOT = Path("/Users/heisenbergs-1/ai-worker/output/covers")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def paths() -> tuple[Path, Path]:
    snapshot = MODEL_ROOT / "hf-home" / "hub" / REPO_CACHE / "snapshots" / REVISION
    cli = SERVICE_ROOT / "venv" / "bin" / "mflux-generate-flux2"
    return snapshot, cli


def readiness() -> dict:
    snapshot, cli = paths()
    integrity_path = STATE_ROOT / "model-integrity.json"
    deployment_path = STATE_ROOT / "deployment-receipt.json"
    required = (
        "transformer/diffusion_pytorch_model.safetensors",
        "text_encoder/model-00001-of-00002.safetensors",
        "text_encoder/model-00002-of-00002.safetensors",
        "vae/diffusion_pytorch_model.safetensors",
        "tokenizer/tokenizer.json",
    )
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise RuntimeError("mflux_runtime_missing")
    if not snapshot.is_dir() or not snapshot.resolve().is_relative_to(MODEL_ROOT.resolve()):
        raise RuntimeError("pinned_model_snapshot_missing")
    if any(not (snapshot / name).is_file() for name in required):
        raise RuntimeError("pinned_model_files_incomplete")
    if not integrity_path.is_file() or not deployment_path.is_file():
        raise RuntimeError("deployment_receipt_missing")
    integrity = json.loads(integrity_path.read_text())
    deployment = json.loads(deployment_path.read_text())
    if integrity.get("currentState") != "VERIFIED" or integrity.get("revision") != REVISION:
        raise RuntimeError("model_integrity_unverified")
    if deployment.get("currentState") not in ("DEPLOYED_VALIDATED", "COMPLETED"):
        raise RuntimeError("runtime_deployment_unverified")
    return {
        "currentState": "READY",
        "errorCode": None,
        "nextAction": "generate_or_edit_cover",
        "modelRevision": REVISION,
        "modelSnapshot": str(snapshot),
        "mfluxVersion": "0.20.0",
        "runtime": str(cli),
        "outputRoot": str(OUTPUT_ROOT),
        "offline": True,
    }


def generate(args: argparse.Namespace) -> dict:
    ready = readiness()
    snapshot, cli = paths()
    prompt = Path(args.prompt_file).expanduser().resolve(strict=True)
    if not prompt.is_file() or not 0 < prompt.stat().st_size <= 16 * 1024:
        raise ValueError("prompt_file_invalid")
    output = Path(args.output).expanduser()
    if not output.is_absolute() or output.suffix.lower() != ".png":
        raise ValueError("output_must_be_absolute_png")
    if not (512 <= args.width <= 2048 and args.width % 16 == 0
            and 512 <= args.height <= 2048 and args.height % 16 == 0):
        raise ValueError("dimensions_must_be_512_to_2048_and_divisible_by_16")
    if not 1 <= args.steps <= 8 or not 0 <= args.seed <= 2**31 - 1:
        raise ValueError("steps_or_seed_out_of_range")
    if not 0.05 <= args.image_strength <= 1.0:
        raise ValueError("image_strength_out_of_range")
    if not output.resolve().is_relative_to(OUTPUT_ROOT.resolve(strict=True)):
        raise ValueError("output_outside_covers_root")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not output.resolve().is_relative_to(OUTPUT_ROOT.resolve(strict=True)):
        raise ValueError("output_parent_escaped_covers_root")
    if output.exists() or output.with_suffix(".receipt.json").exists():
        raise FileExistsError("output_or_receipt_already_exists")
    image = None
    if args.image:
        image = Path(args.image).expanduser().resolve(strict=True)
        if not image.is_file() or image.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            raise ValueError("reference_image_invalid")

    env = os.environ.copy()
    env.update({
        "HF_HOME": str(MODEL_ROOT / "hf-home"),
        "XDG_CACHE_HOME": str(MODEL_ROOT / "xdg-cache"),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    })
    command = [
        str(cli), "--model", str(snapshot), "--base-model", "flux2-klein-4b",
        "--prompt-file", str(prompt), "--width", str(args.width),
        "--height", str(args.height), "--steps", str(args.steps),
        "--guidance", "1.0", "--seed", str(args.seed),
        "--output", str(output),
    ]
    if image:
        command.extend(("--image", str(image), str(args.image_strength)))
    started = time.monotonic()
    subprocess.run(command, check=True, env=env)
    with output.open("rb") as produced:
        header = produced.read(24)
    if (len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n"
            or struct.unpack(">II", header[16:24]) != (args.width, args.height)):
        raise RuntimeError("generated_image_specification_mismatch")

    result = {
        "schema": "aiworker-flux2-cover-result/v1",
        "currentState": "COMPLETED",
        "errorCode": None,
        "nextAction": "review_cover_and_add_exact_title",
        "modelRevision": ready["modelRevision"],
        "mfluxVersion": ready["mfluxVersion"],
        "offline": True,
        "method": "image_to_image" if image else "text_to_image",
        "promptSha256": sha256_file(prompt),
        "referenceImageSha256": sha256_file(image) if image else None,
        "output": str(output),
        "outputBytes": output.stat().st_size,
        "outputSha256": sha256_file(output),
        "width": args.width,
        "height": args.height,
        "steps": args.steps,
        "seed": args.seed,
        "elapsedSeconds": round(time.monotonic() - started, 3),
    }
    receipt = output.with_suffix(".receipt.json")
    temporary = receipt.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(receipt)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("status", help="Read the pinned model and runtime receipt")
    create = sub.add_parser("generate", help="Generate one PNG in the controlled covers directory")
    create.add_argument("--prompt-file", required=True)
    create.add_argument("--output", required=True)
    create.add_argument("--image", help="Optional reference image for image-to-image editing")
    create.add_argument("--image-strength", type=float, default=0.25)
    create.add_argument("--width", type=int, default=1280)
    create.add_argument("--height", type=int, default=720)
    create.add_argument("--steps", type=int, default=4)
    create.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    try:
        result = readiness() if args.action == "status" else generate(args)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(json.dumps({"currentState": "FAILED", "errorCode": str(error),
                          "nextAction": "check_pinned_runtime_and_inputs"}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

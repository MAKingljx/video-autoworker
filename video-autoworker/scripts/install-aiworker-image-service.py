#!/usr/bin/env python3
"""Install the independent image application component from its canonical commit.

Existing model Python/weights/CLI are verified and reused, never installed or
rewritten here. Only this new service's paths and LaunchAgent may be created.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import sqlite3
import subprocess
import sys
import time
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("image_install_contract", ROOT / "scripts/install-openclaw-image-studio.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
LABEL = "ai.aiworker.image-generation"
SCHEMA = "aiworker-image-service-install/v1"


def bundle_payload(root: Path) -> dict[str, bytes]:
    files = {"scripts/aiworker-image-service.py": (root / "scripts/aiworker-image-service.py").read_bytes()}
    for directory in (root / "src/image_generation", root / "openclaw-plugins/aiworker-image-command"):
        for member in sorted(directory.rglob("*")):
            contract.safe_path(member)
            if any(part in {"test", "tests", "__pycache__", "node_modules"} for part in member.relative_to(directory).parts):
                continue
            if member.is_file():
                contract.require(member.stat().st_mode & 0o022 == 0 and member.stat().st_uid == os.getuid(), "bundle_member_mode_invalid")
                files[member.relative_to(root).as_posix()] = member.read_bytes()
    contract.require("src/image_generation/service.py" in files and "src/image_generation/__init__.py" in files
                     and "openclaw-plugins/aiworker-image-command/index.js" in files, "bundle_dependency_missing")
    return files


def configuration(home: Path, commit: str) -> dict:
    value = json.loads((ROOT / "ops/image-generation/service/service.template.json").read_bytes())
    service = home / "ai-worker/services/qwen-image-edit-2511"
    value.update({"state_root": str(home / "ai-worker/state/image-generation/jobs"),
        "output_root": str(home / "ai-worker/output/covers/image-jobs"),
        "reference_roots": [str(home / "ai-worker/output/covers"), str(home / ".openclaw-image-studio/media")],
        "backend_script": str(service / "aiworker-qwen-cover.py"), "backend_python": str(service / "venv/bin/python"),
        "profiles_file": str(service / "cover-design-profiles.json"), "source_commit": commit})
    return value


def service_plist(home: Path, release: Path, config_file: Path, logs: Path) -> bytes:
    python = home / "ai-worker/services/qwen-image-edit-2511/venv/bin/python"
    return plistlib.dumps({"Label": LABEL,
        "ProgramArguments": [str(python), str(release / "scripts/aiworker-image-service.py"), "--config", str(config_file)],
        "WorkingDirectory": str(release), "RunAtLoad": True, "KeepAlive": True,
        "ThrottleInterval": 10, "Umask": 0o077,
        "StandardOutPath": str(logs / "service.log"), "StandardErrorPath": str(logs / "service-error.log"),
        "EnvironmentVariables": {"HOME": str(home), "PATH": f"{python.parent}:/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}})


def validate_backend(config: dict, script_sha: str, profiles_sha: str) -> dict:
    script, profiles, python = (Path(config[key]) for key in ("backend_script", "profiles_file", "backend_python"))
    contract.safe_path(script, file=True)
    contract.safe_path(profiles, file=True)
    contract.require(contract.sha(script.read_bytes()) == script_sha and contract.sha(profiles.read_bytes()) == profiles_sha,
                     "existing_backend_digest_mismatch")
    contract.require(python.is_file() and os.access(python, os.X_OK), "existing_backend_python_missing")
    # The managed venv's python may be a symlink to its verified shared runtime.
    actual_python = contract.safe_path(python.resolve(strict=True), file=True)
    contract.require(actual_python.stat().st_mode & 0o022 == 0, "backend_python_target_mode_invalid")
    env = {"HOME": str(Path.home()), "PATH": f"{python.parent}:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
    result = contract.run([str(python), str(script), "generate", "--help"], env)
    contract.require("--wait-for-model" in result.stdout, "shared_model_lock_cli_required")
    result = contract.run([str(python), "-c", "import sys,PIL;print(sys.version.split()[0]);print(PIL.__version__)"], env)
    values = result.stdout.strip().splitlines()
    contract.require(len(values) == 2 and all(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", v) for v in values), "backend_runtime_probe_invalid")
    return {"python": values[0], "pillow": values[1], "pythonBinarySha256": contract.sha(actual_python.read_bytes()),
            "backendScriptSha256": script_sha, "profilesSha256": profiles_sha}


def listener_pids() -> list[int]:
    result = subprocess.run(["/usr/sbin/lsof", "-nP", "-tiTCP:18095", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=15)
    contract.require(result.returncode in {0, 1} and not result.stderr.strip(), "image_listener_probe_failed")
    contract.require(all(value.isdecimal() for value in result.stdout.split()), "image_listener_probe_invalid")
    return [int(value) for value in result.stdout.split()]


def launch_pid() -> int | None:
    result = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        contract.require("Could not find service" in result.stderr or "Could not find specified service" in result.stderr,
                         "image_launchagent_query_failed")
        return None
    match = re.search(r"^\s*pid = ([0-9]+)\s*$", result.stdout, re.MULTILINE)
    return int(match.group(1)) if match else 0


def create_private_tree(path: Path) -> None:
    contract.safe_path(path)
    missing = []
    member = path
    while not member.exists():
        missing.append(member)
        member = member.parent
    for member in reversed(missing):
        member.mkdir(mode=0o700)


def health(commit: str, database: Path) -> dict:
    opener = build_opener(ProxyHandler({}))
    with opener.open("http://127.0.0.1:18095/healthz", timeout=5) as result:
        contract.require(result.status == 200, "image_health_unavailable")
        value = json.loads(result.read(8192))
    contract.require(value.get("currentState") == "READY" and value.get("sourceCommit") == commit
                     and value.get("concurrency") == 1, "image_health_identity_mismatch")
    contract.safe_path(database, file=True)
    contract.require(database.stat().st_uid == os.getuid() and database.stat().st_mode & 0o077 == 0,
                     "private_database_required")
    identity = {"device": database.stat().st_dev, "inode": database.stat().st_ino}
    contract.require(value.get("databaseIdentity") == identity, "image_database_identity_mismatch")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        contract.require(connection.execute("PRAGMA quick_check").fetchone()[0] == "ok", "image_database_integrity_failed")
    value["listenerPids"] = listener_pids()
    contract.require(len(value["listenerPids"]) == 1 and value["listenerPids"][0] == launch_pid(), "image_listener_not_owned_launchagent")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--backend-script-sha256", required=True)
    parser.add_argument("--profiles-sha256", required=True)
    parser.add_argument("--startup-timeout", type=int, default=90)
    args = parser.parse_args(argv)
    contract.require(platform.system() == "Darwin", "image_service_macos_required")
    contract.require(not args.resume or args.apply, "resume_requires_apply")
    contract.require(re.fullmatch(r"[a-f0-9]{40}", args.source_commit) is not None
                     and all(re.fullmatch(r"[a-f0-9]{64}", v) for v in (args.backend_script_sha256, args.profiles_sha256)), "source_identity_argument_invalid")
    contract.require(10 <= args.startup_timeout <= 3600, "startup_timeout_invalid")
    home = contract.safe_path(Path.home(), file=False)
    payload = bundle_payload(ROOT)
    extras = tuple(ROOT / name for name in payload) + (ROOT / "scripts/install-aiworker-image-service.py",
        ROOT / "ops/image-generation/service/service.template.json", ROOT / "scripts/aiworker-qwen-cover.py")
    source = contract.source_identity(ROOT, ROOT / "openclaw-plugins/aiworker-image-command", args.source_commit, extra_sources=extras)
    contract.require(contract.sha((ROOT / "scripts/aiworker-qwen-cover.py").read_bytes()) == args.backend_script_sha256,
                     "backend_does_not_match_committed_source")
    config = configuration(home, args.source_commit)
    runtime = validate_backend(config, args.backend_script_sha256, args.profiles_sha256)
    root = home / "ai-worker/services/image-generation"
    release = root / "releases" / args.source_commit
    state = home / "ai-worker/state/image-generation/image-service"
    config_file, receipt_file = state / "service.json", state / "install-receipt.json"
    jobs, output = Path(config["state_root"]), Path(config["output_root"])
    plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    for path in (root, release, state, jobs, output, plist):
        contract.safe_path(path)
    contract.safe_path(home / "ai-worker/output/covers", file=False)
    manifest = {"schema": "aiworker-image-service-artifact/v1", "sourceCommit": args.source_commit,
                "sourceRepository": contract.SOURCE_REPOSITORY, "files": {name: contract.sha(data) for name, data in payload.items()}}
    manifest_bytes, config_bytes = contract.encoded(manifest), contract.encoded(config)
    plist_bytes = service_plist(home, release, config_file, state / "logs")
    expected = {"schema": SCHEMA, "sourceCommit": args.source_commit, "sourceEvidence": source,
        "artifactSha256": contract.sha(manifest_bytes), "configSha256": contract.sha(config_bytes),
        "launchAgentSha256": contract.sha(plist_bytes), "runtime": runtime}
    exists = receipt_file.exists()
    receipt = None
    if exists:
        receipt = json.loads(contract.private_file(receipt_file))
        contract.require(all(receipt.get(k) == v for k, v in expected.items()), "existing_image_installation_mismatch")
        contract.require(contract.private_file(config_file) == config_bytes and contract.private_file(plist) == plist_bytes
                         and contract.private_file(release / "manifest.json") == manifest_bytes, "image_installation_drift")
        inventory = contract.bounded_files(release)
        contract.require(inventory == {**manifest["files"], "manifest.json": contract.sha(manifest_bytes)}, "installed_image_artifact_drift")
        if receipt["currentState"] == "SERVICE_HEALTHY":
            health(args.source_commit, jobs / "jobs.sqlite")
            print(json.dumps({"currentState": "UNCHANGED_HEALTHY", "sourceCommit": args.source_commit}))
            return 0
        contract.require(args.resume and receipt["currentState"] in {"PAYLOAD_PREPARED", "SERVICE_STARTED"}, "owned_image_install_requires_resume")
    else:
        contract.require(not any(path.exists() for path in (root, state, jobs, output, plist)), "new_image_target_must_be_absent")
        contract.require(not listener_pids() and launch_pid() is None, "image_port_or_launchagent_busy")
    print(json.dumps({"currentState": "PREFLIGHT_READY", "component": LABEL, "sourceCommit": args.source_commit,
                      "artifactSha256": expected["artifactSha256"], "listen": "127.0.0.1:18095"}))
    if args.dry_run:
        return 0
    with contract.installation_lock(home / "ai-worker/state/.image-service-install.lock"):
        if not exists:
            contract.require(not any(path.exists() for path in (root, state, jobs, output, plist)), "new_image_target_changed")
            for directory in (release, state / "logs", jobs, output):
                create_private_tree(directory)
            for name, data in payload.items():
                target = release / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                contract.create_file(target, data)
            contract.create_file(release / "manifest.json", manifest_bytes)
            contract.create_file(config_file, config_bytes)
            contract.create_file(plist, plist_bytes)
            receipt = dict(expected, currentState="PAYLOAD_PREPARED", errorCode=None, nextAction="start_owned_image_service",
                           databaseIdentity=None, modelGenerationValidated=False)
            contract.create_file(receipt_file, contract.encoded(receipt))
        try:
            env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
            if receipt["currentState"] == "PAYLOAD_PREPARED":
                existing_pid = launch_pid()
                if existing_pid is None:
                    contract.require(not listener_pids(), "image_port_changed")
                    # No bootout, no existing service replacement, no other restart.
                    contract.run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)], env)
                else:
                    contract.require(args.resume, "loaded_image_service_requires_resume")
                receipt = contract.advance_receipt(receipt_file, receipt, {"currentState": "SERVICE_STARTED", "nextAction": "verify_image_service_health"})
            deadline = time.monotonic() + args.startup_timeout
            while True:
                try:
                    current = health(args.source_commit, jobs / "jobs.sqlite")
                    break
                except (OSError, ValueError, contract.InstallError):
                    contract.require(time.monotonic() < deadline, "image_service_health_failed")
                    time.sleep(1)
            receipt = contract.advance_receipt(receipt_file, receipt, {"currentState": "SERVICE_HEALTHY", "errorCode": None,
                "nextAction": "verify_image_studio_tool_then_real_model_trial", "databaseIdentity": current["databaseIdentity"],
                "healthEvidenceSha256": contract.sha(contract.encoded(current)), "modelGenerationValidated": False})
        except (OSError, ValueError, subprocess.SubprocessError, contract.InstallError) as error:
            code = str(error) if isinstance(error, contract.InstallError) else "image_service_installation_io_failed"
            contract.advance_receipt(receipt_file, receipt, {"errorCode": code, "nextAction": "inspect_owned_image_service_then_resume"})
            raise
    print(json.dumps({"currentState": "SERVICE_HEALTHY", "receipt": str(receipt_file), "modelGenerationValidated": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError, contract.InstallError) as error:
        code = str(error) if isinstance(error, contract.InstallError) else "image_service_installation_probe_failed"
        print(json.dumps({"currentState": "INCOMPLETE", "errorCode": code, "nextAction": "inspect_only_owned_image_service_targets"}), file=sys.stderr)
        raise SystemExit(1)

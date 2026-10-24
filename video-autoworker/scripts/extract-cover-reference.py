#!/usr/bin/env python3
"""Extract a bounded set of native-resolution cover references without AI."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import uuid


MAX_TIMES = 12
MAX_PIXELS = 24 * 1024 * 1024
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi"}
PNG = b"\x89PNG\r\n\x1a\n"


def identity(path):
    value = Path(path).stat()
    return {"device": value.st_dev, "inode": value.st_ino, "bytes": value.st_size,
            "mtimeNs": value.st_mtime_ns, "ctimeNs": value.st_ctime_ns}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            result.update(part)
    return result.hexdigest()


def absolute(value, code):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or "\x00" in str(path):
        raise ValueError(code)
    return path


def source_path(value, allowed_root):
    path = absolute(value, "cover_reference_source_invalid")
    if path.is_symlink():
        raise ValueError("cover_reference_source_invalid")
    try:
        path = path.resolve(strict=True)
        root = absolute(allowed_root, "cover_reference_source_root_invalid").resolve(strict=True)
        details = path.stat()
    except OSError as error:
        raise ValueError("cover_reference_source_invalid") from error
    if (not root.is_dir() or not path.is_relative_to(root)
            or not stat.S_ISREG(details.st_mode) or details.st_size <= 0
            or path.suffix.lower() not in VIDEO_SUFFIXES):
        raise ValueError("cover_reference_source_invalid")
    return path


def output_path(value, allowed_root):
    path = absolute(value, "cover_reference_output_invalid")
    try:
        root = absolute(allowed_root, "cover_reference_output_root_invalid").resolve(strict=True)
    except OSError as error:
        raise ValueError("cover_reference_output_root_invalid") from error
    if path.exists() or path.is_symlink():
        raise ValueError("cover_reference_output_exists")
    try:
        parent = path.parent.resolve(strict=True)
    except OSError as error:
        raise ValueError("cover_reference_output_invalid") from error
    if not root.is_dir() or not parent.is_relative_to(root):
        raise ValueError("cover_reference_output_outside_root")
    return parent / path.name


def tool(value, name):
    found = str(value) if value else shutil.which(name)
    if not found or not Path(found).is_absolute() or not Path(found).is_file() or not os.access(found, os.X_OK):
        raise ValueError("cover_reference_tool_unavailable:" + name)
    return str(Path(found).resolve(strict=True))


def run(arguments, timeout):
    try:
        result = subprocess.run(arguments, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError("cover_reference_utility_timeout") from error
    except OSError as error:
        raise ValueError("cover_reference_tool_unavailable") from error
    if result.returncode:
        raise ValueError("cover_reference_decode_failed")
    return result


def probe(source, executable):
    result = run([executable, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries",
                  "stream=width,height,field_order,avg_frame_rate,sample_aspect_ratio,pix_fmt:"
                  "stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json", str(source)], 45)
    try:
        value = json.loads(result.stdout)
        stream = value["streams"][0]
        width, height = stream["width"], stream["height"]
        duration = float(value["format"]["duration"])
    except (ValueError, TypeError, KeyError, IndexError) as error:
        raise ValueError("cover_reference_probe_invalid") from error
    if (type(width) is not int or type(height) is not int or not 1 <= width <= 8192
            or not 1 <= height <= 8192 or width * height > MAX_PIXELS
            or not math.isfinite(duration) or duration <= 0):
        raise ValueError("cover_reference_probe_invalid")
    rotations = [x["rotation"] for x in stream.get("side_data_list", []) if "rotation" in x]
    try:
        rotation = float(rotations[0] if rotations else stream.get("tags", {}).get("rotate", 0))
    except (ValueError, TypeError) as error:
        raise ValueError("cover_reference_rotation_unsupported") from error
    if not math.isfinite(rotation) or abs(rotation / 90 - round(rotation / 90)) > 0.001:
        raise ValueError("cover_reference_rotation_unsupported")
    display = (height, width) if int(round(rotation / 90)) % 2 else (width, height)
    return {"codedWidth": width, "codedHeight": height, "width": display[0], "height": display[1],
            "durationSeconds": duration, "rotationDegrees": rotation,
            "fieldOrder": stream.get("field_order", "unknown"),
            "frameRate": stream.get("avg_frame_rate", "unknown"),
            "sampleAspectRatio": stream.get("sample_aspect_ratio", "unknown"),
            "pixelFormat": stream.get("pix_fmt", "unknown")}


def write_manifest(path, value):
    temporary = path.with_name(".manifest-" + uuid.uuid4().hex + ".json")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as target:
        json.dump(value, target, ensure_ascii=False, indent=2)
        target.write("\n")
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)


def extract_frames(source, output, seconds, *, allowed_source_root, allowed_output_root,
                   ffmpeg=None, ffprobe=None):
    """Create a new private task directory; never overwrite a frame or video.

    Only finite seeks are decoded. No resize, sharpening, interpolation or model
    is involved. A utility timeout bounds each local decoder, not a batch/job.
    """
    source = source_path(source, allowed_source_root)
    output = output_path(output, allowed_output_root)
    if (not isinstance(seconds, (list, tuple)) or not 1 <= len(seconds) <= MAX_TIMES
            or any(type(t) not in (int, float) or not math.isfinite(t) or t < 0 for t in seconds)):
        raise ValueError("cover_reference_times_invalid")
    times = [round(float(t), 6) for t in seconds]
    if len(set(times)) != len(times):
        raise ValueError("cover_reference_times_invalid")
    encoder, inspector = tool(ffmpeg, "ffmpeg"), tool(ffprobe, "ffprobe")
    before = identity(source)
    video = probe(source, inspector)
    if identity(source) != before:
        raise ValueError("cover_reference_source_changed")
    if any(t >= video["durationSeconds"] for t in times):
        raise ValueError("cover_reference_time_out_of_range")
    output.mkdir(mode=0o700)
    incoming, files = output / "_incoming", output / "files"
    incoming.mkdir(mode=0o700)
    files.mkdir(mode=0o700)
    manifest = {"schema": "aiworker-cover-references/v1", "currentState": "EXTRACTING",
                "createdAt": datetime.now(timezone.utc).isoformat(), "source": str(source),
                "sourceIdentity": before, "video": video, "requestedSeconds": times,
                "processing": "native_decode_no_scale_no_ai", "frames": [], "errorCode": None}
    path = output / "manifest.json"
    write_manifest(path, manifest)
    try:
        for index, requested in enumerate(times):
            if identity(source) != before:
                raise ValueError("cover_reference_source_changed")
            name = "frame-" + format(requested, ".6f").rstrip("0").rstrip(".") + ".png"
            temporary, final = incoming / name, files / name
            # Absolute local paths and argv prevent URL/protocol or shell input.
            result = run([encoder, "-nostdin", "-hide_banner", "-loglevel", "info", "-n",
                          "-protocol_whitelist", "file", "-ss", format(requested, ".6f"), "-copyts", "-i", str(source),
                          "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
                          "-vf", "showinfo", "-fps_mode", "passthrough", str(temporary)], 120)
            if identity(source) != before:
                raise ValueError("cover_reference_source_changed")
            with temporary.open("rb") as frame:
                header = frame.read(24)
            if (header[:8] != PNG or header[12:16] != b"IHDR"
                    or struct.unpack(">II", header[16:24]) != (video["width"], video["height"])
                    or temporary.stat().st_size < 64):
                raise ValueError("cover_reference_frame_invalid")
            # showinfo observes source timestamps because copyts is explicit.
            observed = re.findall(r"\bpts_time:([0-9.+-]+)", result.stderr)
            actual = float(observed[0]) if observed else None
            if actual is not None and (not math.isfinite(actual) or abs(actual - requested) > 2):
                raise ValueError("cover_reference_timestamp_invalid")
            record = {"index": index, "requestedSeconds": requested,
                      "observedSourceSeconds": actual, "path": str(final),
                      "width": video["width"], "height": video["height"],
                      "bytes": temporary.stat().st_size, "sha256": digest(temporary),
                      "status": "VERIFIED"}
            temporary.chmod(0o600)
            os.link(temporary, final)
            temporary.unlink()
            manifest["frames"].append(record)
            write_manifest(path, manifest)
        if identity(source) != before:
            raise ValueError("cover_reference_source_changed")
        manifest.update({"currentState": "COMPLETE", "sourceIdentityAfter": identity(source)})
        write_manifest(path, manifest)
        return manifest
    except BaseException as error:
        manifest.update({"currentState": "CANCELLED" if isinstance(error, KeyboardInterrupt) else "FAILED",
                         "errorCode": str(error) if isinstance(error, ValueError) else type(error).__name__})
        write_manifest(path, manifest)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allowed-source-root", required=True)
    parser.add_argument("--allowed-output-root", default=str(Path.home() / "ai-worker/output/covers"))
    parser.add_argument("--seconds", type=float, nargs="+", required=True)
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    args = parser.parse_args()
    try:
        value = extract_frames(args.source, args.output, args.seconds,
                               allowed_source_root=args.allowed_source_root,
                               allowed_output_root=args.allowed_output_root,
                               ffmpeg=args.ffmpeg, ffprobe=args.ffprobe)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"currentState": "FAILED", "errorCode": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps({"currentState": value["currentState"], "frames": len(value["frames"]),
                      "width": value["video"]["width"], "height": value["video"]["height"],
                      "manifest": str(Path(args.output) / "manifest.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

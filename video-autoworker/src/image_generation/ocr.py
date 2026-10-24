"""Bounded offline Apple Vision OCR for application-owned image assets."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import unicodedata


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/aiworker-image-ocr.swift"
SWIFT = Path("/usr/bin/swift")
MAX_IMAGE_BYTES = 40 * 1024 * 1024
MAX_PIXELS = 24 * 1024 * 1024
MAX_RESULT_BYTES = 4 * 1024 * 1024
UTILITY_TIMEOUT_SECONDS = 120
CACHE_ENV = "AIWORKER_IMAGE_OCR_CACHE"


def _identity(path: Path) -> tuple:
    value = path.stat()
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _image(path) -> tuple[Path, tuple[int, int]]:
    try:
        path = Path(path)
    except TypeError as error:
        raise ValueError("image_ocr_input_invalid") from error
    if not path.is_absolute() or ".." in path.parts or path.is_symlink():
        raise ValueError("image_ocr_input_invalid")
    try:
        path = path.resolve(strict=True)
        value = path.stat()
        if not stat.S_ISREG(value.st_mode) or not 24 <= value.st_size <= MAX_IMAGE_BYTES:
            raise ValueError("image_ocr_input_invalid")
        with path.open("rb") as source:
            header = source.read(24)
    except OSError as error:
        raise ValueError("image_ocr_input_invalid") from error
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError("image_ocr_input_invalid")
    width, height = struct.unpack(">II", header[16:24])
    if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width * height > MAX_PIXELS:
        raise ValueError("image_ocr_input_invalid")
    return path, (width, height)


def _script(path) -> Path:
    # A release may use a byte-identical mirror, never arbitrary caller code.
    try:
        default = SCRIPT.resolve(strict=True)
        requested = Path(path) if path is not None else SCRIPT
        if not requested.is_absolute() or requested.is_symlink():
            raise ValueError("image_ocr_script_invalid")
        resolved = requested.resolve(strict=True)
        if not resolved.is_file() or resolved.name != default.name:
            raise ValueError("image_ocr_script_invalid")
        if hashlib.sha256(resolved.read_bytes()).digest() != hashlib.sha256(default.read_bytes()).digest():
            raise ValueError("image_ocr_script_invalid")
        return resolved
    except (OSError, TypeError) as error:
        raise ValueError("image_ocr_script_invalid") from error


def _checked_result(data, dimensions):
    if (not isinstance(data, dict) or set(data) != {"engine", "width", "height", "lines"}
            or data.get("engine") != "apple-vision"
            or type(data.get("width")) is not int or type(data.get("height")) is not int
            or (data.get("width"), data.get("height")) != dimensions
            or not isinstance(data.get("lines"), list) or len(data["lines"]) > 512):
        raise ValueError("image_ocr_result_invalid")
    width, height = dimensions
    for line in data["lines"]:
        if (not isinstance(line, dict) or set(line) != {"text", "confidence", "box"}
                or not isinstance(line.get("text"), str) or not 0 < len(line["text"]) <= 1024
                or any(unicodedata.category(c).startswith("C") for c in line["text"])
                or type(line.get("confidence")) not in (int, float)
                or not math.isfinite(line["confidence"]) or not 0 <= line["confidence"] <= 1
                or not isinstance(line.get("box"), list) or len(line["box"]) != 4
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in line["box"])):
            raise ValueError("image_ocr_result_invalid")
        x, y, w, h = line["box"]
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
            raise ValueError("image_ocr_result_invalid")
    return data


def recognize(image_path, *, script_path=None):
    """Read a PNG locally; coordinates are pixels from the displayed top-left.

    A managed service may reuse its private vision-ocr-cache via CACHE_ENV;
    isolated callers default beside the owned stage asset. The timeout bounds
    a single OS OCR utility, not model inference or a job.
    """
    image, dimensions = _image(image_path)
    script = _script(script_path)
    if not SWIFT.is_file() or not os.access(SWIFT, os.X_OK):
        raise ValueError("image_ocr_runtime_unavailable")
    cache = Path(os.environ.get(CACHE_ENV, str(image.parent / ".vision-module-cache")))
    if (not cache.is_absolute() or ".." in cache.parts
            or cache.name not in {".vision-module-cache", "vision-ocr-cache"}):
        raise ValueError("image_ocr_cache_invalid")
    if cache.exists() and (cache.is_symlink() or not cache.is_dir()
                           or cache.stat().st_uid != os.getuid()):
        raise ValueError("image_ocr_cache_invalid")
    try:
        cache.mkdir(mode=0o700, exist_ok=True)
        cache.chmod(0o700)
    except OSError as error:
        raise ValueError("image_ocr_cache_unavailable") from error
    try:
        before, script_before = _identity(image), _identity(script)
    except OSError as error:
        raise ValueError("image_ocr_input_changed") from error
    # Do not inherit toolchain/frontend/loader overrides from a calling shell.
    env = {"HOME": os.environ.get("HOME", str(Path.home())),
           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "CLANG_MODULE_CACHE_PATH": str(cache)}
    if os.environ.get("TMPDIR"):
        env["TMPDIR"] = os.environ["TMPDIR"]
    # Internal service-owned process provenance, never a caller/request field.
    owner = os.environ.get("AIWORKER_IMAGE_JOB_OWNER", "")
    if re.fullmatch(r"[a-f0-9]{32}", owner):
        env["AIWORKER_IMAGE_JOB_OWNER"] = owner
    try:
        process = subprocess.run([str(SWIFT), "-module-cache-path", str(cache), str(script), str(image)],
                                 capture_output=True, text=True, env=env,
                                 timeout=UTILITY_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError("image_ocr_timeout") from error
    except OSError as error:
        raise ValueError("image_ocr_runtime_unavailable") from error
    except UnicodeError as error:
        raise ValueError("image_ocr_result_invalid") from error
    try:
        after = _identity(image)
    except OSError as error:
        raise ValueError("image_ocr_input_changed") from error
    if after != before:
        raise ValueError("image_ocr_input_changed")
    try:
        if _identity(script) != script_before:
            raise ValueError("image_ocr_script_changed")
    except OSError as error:
        raise ValueError("image_ocr_script_changed") from error
    if process.returncode:
        raise ValueError("image_ocr_failed")
    if len(process.stdout.encode("utf-8")) > MAX_RESULT_BYTES:
        raise ValueError("image_ocr_result_invalid")
    try:
        data = json.loads(process.stdout)
    except (ValueError, UnicodeError) as error:
        raise ValueError("image_ocr_result_invalid") from error
    return _checked_result(data, dimensions)

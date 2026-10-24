"""OCR boundary and failure tests; no model calls or OS OCR in unit tests."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from image_generation import ocr


def png(width=20, height=10):
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\xff\xff" * width) * height))
            + chunk(b"IEND", b""))


class ProtectedOCRTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image = self.root / "字形 素材.png"
        self.image.write_bytes(png())
        self.swift = self.root / "swift"
        self.swift.write_text("test executable is mocked")
        self.swift.chmod(0o700)
        self.result = {"engine": "apple-vision", "width": 20, "height": 10,
                       "lines": [{"text": "北极驯鹿人", "confidence": .98, "box": [1, 1, 18, 8]}]}

    def tearDown(self):
        self.temp.cleanup()

    def run_ocr(self, output=None, **kwargs):
        response = SimpleNamespace(returncode=0, stdout=json.dumps(output or self.result), stderr="")
        with patch.object(ocr, "SWIFT", self.swift), patch.object(ocr.subprocess, "run", return_value=response) as mock:
            value = ocr.recognize(self.image, **kwargs)
        return value, mock

    def test_offline_fixed_command_private_cache_and_pixel_boxes(self):
        value, mock = self.run_ocr()
        self.assertEqual(value, self.result)
        args, kwargs = mock.call_args
        self.assertEqual(args[0][0], str(self.swift))
        self.assertEqual(args[0][-1], str(self.image.resolve()))
        self.assertEqual(args[0][-2], str(ocr.SCRIPT.resolve()))
        self.assertNotIn("shell", kwargs)
        cache = self.root / ".vision-module-cache"
        self.assertEqual(cache.stat().st_mode & 0o777, 0o700)
        self.assertEqual(kwargs["env"]["CLANG_MODULE_CACHE_PATH"], str(cache.resolve()))

    def test_image_symlink_non_png_and_huge_dimensions_fail_before_utility(self):
        link = self.root / "link.png"
        link.symlink_to(self.image)
        with patch.object(ocr.subprocess, "run") as run:
            for candidate in [link, Path("relative.png")]:
                with self.assertRaisesRegex(ValueError, "image_ocr_input_invalid"):
                    ocr.recognize(candidate)
            self.image.write_bytes(b"not a PNG")
            with self.assertRaisesRegex(ValueError, "image_ocr_input_invalid"):
                ocr.recognize(self.image)
            self.image.write_bytes(png(8193, 1))
            with self.assertRaisesRegex(ValueError, "image_ocr_input_invalid"):
                ocr.recognize(self.image)
            run.assert_not_called()

    def test_only_byte_identical_script_mirror_can_be_overridden(self):
        mirror = self.root / ocr.SCRIPT.name
        mirror.write_bytes(ocr.SCRIPT.read_bytes())
        self.run_ocr(script_path=mirror)
        mirror.write_text("arbitrary code")
        with self.assertRaisesRegex(ValueError, "image_ocr_script_invalid"):
            self.run_ocr(script_path=mirror)

    def test_managed_cache_can_be_reused_but_cannot_target_other_directories(self):
        cache = self.root / "vision-ocr-cache"
        with patch.dict(ocr.os.environ, {ocr.CACHE_ENV: str(cache)}):
            _, mock = self.run_ocr()
        self.assertEqual(mock.call_args.kwargs["env"]["CLANG_MODULE_CACHE_PATH"], str(cache))
        with patch.dict(ocr.os.environ, {ocr.CACHE_ENV: str(self.root)}):
            with self.assertRaisesRegex(ValueError, "image_ocr_cache_invalid"):
                self.run_ocr()

    def test_only_valid_internal_job_owner_is_inherited_by_swift(self):
        owner = "0123456789abcdef" * 2
        with patch.dict(ocr.os.environ, {"AIWORKER_IMAGE_JOB_OWNER": owner}):
            _, mock = self.run_ocr()
        self.assertEqual(mock.call_args.kwargs["env"]["AIWORKER_IMAGE_JOB_OWNER"], owner)
        for invalid in ["", "a" * 31, "a" * 33, "A" * 32, "g" * 32, "a" * 32 + "\n"]:
            with self.subTest(length=len(invalid)), patch.dict(ocr.os.environ, {"AIWORKER_IMAGE_JOB_OWNER": invalid}):
                _, mock = self.run_ocr()
            self.assertNotIn("AIWORKER_IMAGE_JOB_OWNER", mock.call_args.kwargs["env"])

    def test_invalid_bbox_confidence_dimension_and_extra_fields_rejected(self):
        bad = [
            {**self.result, "width": 21},
            {**self.result, "source": "unexpected"},
            {**self.result, "lines": [{"text": "x", "confidence": 2, "box": [1, 1, 1, 1]}]},
            {**self.result, "lines": [{"text": "x", "confidence": .9, "box": [19, 1, 2, 1]}]},
            {**self.result, "lines": [{"text": "x", "confidence": True, "box": [1, 1, 1, 1]}]},
        ]
        for result in bad:
            with self.subTest(result=result), self.assertRaisesRegex(ValueError, "image_ocr_result_invalid"):
                self.run_ocr(result)

    def test_native_failure_and_timeout_are_stable_without_echoing_stderr(self):
        with patch.object(ocr, "SWIFT", self.swift), patch.object(ocr.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="private diagnostic")):
            with self.assertRaisesRegex(ValueError, "^image_ocr_failed$"):
                ocr.recognize(self.image)
        with patch.object(ocr, "SWIFT", self.swift), patch.object(ocr.subprocess, "run", side_effect=subprocess.TimeoutExpired("swift", 120)):
            with self.assertRaisesRegex(ValueError, "^image_ocr_timeout$"):
                ocr.recognize(self.image)

    def test_source_mutation_during_ocr_rejected(self):
        def changed(*args, **kwargs):
            self.image.write_bytes(self.image.read_bytes() + b"changed")
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.result), stderr="")
        with patch.object(ocr, "SWIFT", self.swift), patch.object(ocr.subprocess, "run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "image_ocr_input_changed"):
                ocr.recognize(self.image)

    def test_disappearing_input_has_stable_change_error(self):
        def removed(*args, **kwargs):
            self.image.unlink()
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.result), stderr="")
        with patch.object(ocr, "SWIFT", self.swift), patch.object(ocr.subprocess, "run", side_effect=removed):
            with self.assertRaisesRegex(ValueError, "^image_ocr_input_changed$"):
                ocr.recognize(self.image)


if __name__ == "__main__":
    unittest.main()

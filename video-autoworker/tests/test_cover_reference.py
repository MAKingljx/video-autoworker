"""Native reference extraction invariants, using a local decoder fixture."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cover_reference", ROOT / "scripts/extract-cover-reference.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def png(width=1920, height=1080):
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))
    # Valid native-size flat image; no font rendering or image model involved.
    return (module.PNG + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\x10\x20\x30" * width) * height))
            + chunk(b"IEND", b""))


class CoverReferenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.output_root = self.root / "covers"
        self.output_root.mkdir()
        self.source = self.media / "原片 $(literal).mp4"
        self.source.write_bytes(b"unchanged fixture video")
        self.output = self.output_root / "trial"
        self.tool = self.root / "ffmpeg"
        self.tool.write_text("mock decoder")
        self.tool.chmod(0o700)
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def fake(self, args, timeout):
        self.calls.append(args)
        if "-show_entries" in args:
            value = {"streams": [{"width": 1920, "height": 1080, "field_order": "progressive", "avg_frame_rate": "25/1"}], "format": {"duration": "2220"}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(value), stderr="")
        target = Path(args[-1])
        target.write_bytes(png())
        seconds = float(args[args.index("-ss") + 1])
        return SimpleNamespace(returncode=0, stdout="", stderr=f"showinfo pts_time:{seconds}")

    def extract(self, times=(619.5, 620), **kwargs):
        with patch.object(module, "run", side_effect=self.fake):
            return module.extract_frames(self.source, self.output, list(times),
                                         allowed_source_root=self.media, allowed_output_root=self.output_root,
                                         ffmpeg=self.tool, ffprobe=self.tool, **kwargs)

    def test_native_size_argv_manifest_and_original_bytes_preserved(self):
        before = self.source.read_bytes()
        value = self.extract()
        self.assertEqual(value["currentState"], "COMPLETE")
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(value["video"]["width"], 1920)
        self.assertEqual(len(value["frames"]), 2)
        self.assertEqual((self.output / "manifest.json").stat().st_mode & 0o777, 0o600)
        for frame in value["frames"]:
            path = Path(frame["path"])
            self.assertEqual(struct.unpack(">II", path.read_bytes()[16:24]), (1920, 1080))
            self.assertEqual(module.digest(path), frame["sha256"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        for args in self.calls:
            self.assertIn(str(self.source.resolve()), args)
            self.assertNotIn("scale", " ".join(args))
            self.assertIn("-protocol_whitelist", args)

    def test_existing_output_url_escape_and_symlink_fail_before_write(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, "output_exists"):
            self.extract()
        self.output.rmdir()
        for source in [Path("relative.mp4"), Path("https:/example/video.mp4")]:
            with self.assertRaisesRegex(ValueError, "source_invalid"):
                module.extract_frames(source, self.output, [1], allowed_source_root=self.media,
                                      allowed_output_root=self.output_root, ffmpeg=self.tool, ffprobe=self.tool)
        escaped = self.root / "outside.mp4"
        escaped.write_bytes(b"other")
        linked = self.media / "link.mp4"
        linked.symlink_to(escaped)
        with self.assertRaisesRegex(ValueError, "source_invalid"):
            module.source_path(linked, self.media)
        with self.assertRaisesRegex(ValueError, "output_outside_root"):
            module.output_path(self.root / "escape", self.output_root)
        self.assertFalse(self.output.exists())

    def test_bounded_unique_finite_times(self):
        for times in [[], [1] * 13, [1, 1], [-1], [float("nan")], [2220]]:
            with self.subTest(times=times), self.assertRaisesRegex(ValueError, "times_invalid|time_out_of_range"):
                self.extract(times)
            self.assertFalse(self.output.exists())

    def test_decoder_failure_stops_without_processing_next_time(self):
        original_fake = self.fake
        count = []
        def fail(args, timeout):
            if "-show_entries" in args:
                return original_fake(args, timeout)
            count.append(args)
            raise ValueError("cover_reference_decode_failed")
        with patch.object(module, "run", side_effect=fail):
            with self.assertRaisesRegex(ValueError, "decode_failed"):
                module.extract_frames(self.source, self.output, [1, 2], allowed_source_root=self.media,
                                      allowed_output_root=self.output_root, ffmpeg=self.tool, ffprobe=self.tool)
        self.assertEqual(len(count), 1)
        value = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(value["currentState"], "FAILED")
        self.assertEqual(value["frames"], [])

    def test_source_drift_rejects_before_publishing_frame(self):
        original_fake = self.fake
        def change(args, timeout):
            value = original_fake(args, timeout)
            if "-show_entries" not in args:
                self.source.write_bytes(b"changed")
            return value
        with patch.object(module, "run", side_effect=change):
            with self.assertRaisesRegex(ValueError, "source_changed"):
                module.extract_frames(self.source, self.output, [620], allowed_source_root=self.media,
                                      allowed_output_root=self.output_root, ffmpeg=self.tool, ffprobe=self.tool)
        self.assertEqual(list((self.output / "files").iterdir()), [])

    def test_scaled_or_mistimestamped_frame_cannot_be_published_as_native(self):
        for defect in ["size", "time"]:
            with self.subTest(defect=defect):
                destination = self.output_root / defect
                def incorrect(args, timeout):
                    if "-show_entries" in args:
                        return self.fake(args, timeout)
                    Path(args[-1]).write_bytes(png(1280, 720) if defect == "size" else png())
                    return SimpleNamespace(returncode=0, stdout="", stderr="showinfo pts_time:0")
                with patch.object(module, "run", side_effect=incorrect):
                    with self.assertRaisesRegex(ValueError, "frame_invalid|timestamp_invalid"):
                        module.extract_frames(self.source, destination, [620], allowed_source_root=self.media,
                                              allowed_output_root=self.output_root, ffmpeg=self.tool, ffprobe=self.tool)
                self.assertEqual(list((destination / "files").iterdir()), [])


if __name__ == "__main__":
    unittest.main()

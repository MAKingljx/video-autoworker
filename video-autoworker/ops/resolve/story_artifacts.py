#!/usr/bin/env python3
"""Build a Resolve-importable FCPXML and a bounded preview from a story plan.

This helper is intentionally outside the OpenClaw task state machine. GPT
produces a bounded JSON story plan; this file only validates it, writes a
round-trip interchange artifact, and can render a disposable preview while a
Resolve executor is unavailable.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
from pathlib import Path


def seconds(value: float) -> str:
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return (text or "0") + "s"


def probe_duration(ffmpeg: str, path: str) -> float:
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path],
        text=True,
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    match = re.search(r"Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)", result.stdout)
    if not match:
        return 0.0
    hours, minutes, secs = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(secs)


def validate_plan(plan: dict) -> tuple[list[dict], float]:
    clips = plan.get("clips")
    if not isinstance(clips, list) or not clips:
        raise ValueError("story_plan_clips_required")
    total = 0.0
    for index, clip in enumerate(clips, 1):
        path = str(clip.get("sourcePath", ""))
        start = float(clip["startSeconds"])
        end = float(clip["endSeconds"])
        if not path.startswith("/") or end <= start:
            raise ValueError(f"story_plan_invalid_clip_{index}")
        total += end - start
    target = float(plan.get("targetDurationSeconds", 0))
    if target <= 0 or abs(total - target) > 0.05:
        raise ValueError("story_plan_duration_mismatch")
    return clips, total


def write_fcpxml(plan: dict, output: Path, ffmpeg: str) -> None:
    clips, total = validate_plan(plan)
    assets: dict[str, dict] = {}
    for clip in clips:
        path = str(clip["sourcePath"])
        assets.setdefault(path, {
            "id": f"r{len(assets) + 1}",
            "name": str(clip.get("displayName") or Path(path).name),
            "duration": max(probe_duration(ffmpeg, path), float(clip["endSeconds"])),
        })
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<fcpxml version="1.10">']
    lines.append('  <resources>')
    lines.append('    <format id="r-format" name="AI-worker 1080p25" frameDuration="1/25s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>')
    for path, asset in assets.items():
        lines.append(
            "    <asset id=\"{id}\" name=\"{name}\" src=\"file://{src}\" "
            "start=\"0s\" duration=\"{duration}\" hasVideo=\"1\" hasAudio=\"1\" "
            "audioSources=\"1\" audioChannels=\"2\" format=\"r-format\"/>".format(
                id=asset["id"],
                name=html.escape(asset["name"], quote=True),
                src=html.escape(path, quote=True),
                duration=seconds(asset["duration"]),
            )
        )
    lines.append('  </resources>')
    lines.append('  <library>')
    lines.append('    <event name="AI-worker story test">')
    lines.append(f'      <project name="{html.escape(str(plan["planId"]), quote=True)}">')
    lines.append(f'        <sequence duration="{seconds(total)}" format="r-format" tcStart="0s" tcFormat="NDF">')
    lines.append('          <spine>')
    offset = 0.0
    for clip in clips:
        path = str(clip["sourcePath"])
        asset = assets[path]
        duration = float(clip["endSeconds"]) - float(clip["startSeconds"])
        lines.append(
            "            <asset-clip name=\"{name}\" offset=\"{offset}\" ref=\"{ref}\" "
            "start=\"{start}\" duration=\"{duration}\"/>".format(
                name=html.escape(str(clip.get("displayName") or Path(path).name), quote=True),
                offset=seconds(offset),
                ref=asset["id"],
                start=seconds(float(clip["startSeconds"])),
                duration=seconds(duration),
            )
        )
        offset += duration
    lines.extend(['          </spine>', '        </sequence>', '      </project>', '    </event>', '  </library>', '</fcpxml>'])
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def render_preview(plan: dict, output: Path, ffmpeg: str) -> None:
    clips, _ = validate_plan(plan)
    output.parent.mkdir(parents=True, exist_ok=True)
    segment_dir = output.parent / "segments"
    segment_dir.mkdir(parents=True, exist_ok=True)
    list_path = output.parent / "concat.txt"
    segment_paths: list[Path] = []
    for index, clip in enumerate(clips, 1):
        segment = segment_dir / f"{index:03d}.mp4"
        duration = float(clip["endSeconds"]) - float(clip["startSeconds"])
        command = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", str(float(clip["startSeconds"])), "-t", str(duration),
            "-i", str(clip["sourcePath"]),
            "-map", "0:v:0", "-map", "0:a?",
            "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
            "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-ac", "2", "-ar", "48000", "-movflags", "+faststart",
            str(segment),
        ]
        subprocess.run(command, check=True)
        segment_paths.append(segment)
    list_path.write_text("\n".join(f"file '{path.as_posix()}'" for path in segment_paths) + "\n", encoding="utf-8")
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(output)], check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    clips, total = validate_plan(plan)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    fcpxml = args.output_dir / f"{plan['planId']}.fcpxml"
    write_fcpxml(plan, fcpxml, args.ffmpeg)
    manifest = {
        "schemaVersion": 1,
        "planId": plan["planId"],
        "clipCount": len(clips),
        "durationSeconds": total,
        "fcpxmlPath": str(fcpxml),
        "previewPath": None,
    }
    if args.preview:
        preview = args.output_dir / f"{plan['planId']}.preview.mp4"
        render_preview(plan, preview, args.ffmpeg)
        manifest["previewPath"] = str(preview)
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

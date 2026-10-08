#!/usr/bin/env python3
"""One local Resolve adapter. Application DB owns plans, tasks and scheduling.

Per-operation receipts record a write intent and its readback; they are recovery
 evidence, never an independent queue. Unknown writes are reconciled, not replayed.
API signatures follow the installed Resolve 21.1 SDK (DaVinciResolveScript.pyi).
"""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid
from typing import Any

MAX_MESSAGE_BYTES = 4 * 1024 * 1024
SCHEMA_VERSION = 1
HASH = re.compile(r"^[0-9a-f]{64}$")
OPERATION = re.compile(r"^resolve-operation:([0-9a-f]{64})$")
INCARNATION = str(uuid.uuid4())


class Rejected(RuntimeError):
    """Known rejection before any Resolve mutation."""


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()



def secure_directory(path: Path) -> Path:
    path = path.absolute()
    if path.is_symlink():
        raise Rejected("resolve_state_symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700 or path.resolve() != path):
        raise Rejected("resolve_state_permissions")
    return path


def load_resolve():
    try:
        import DaVinciResolveScript as dvr_script  # type: ignore
    except ImportError:
        sdk = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules")
        sys.path.insert(0, str(sdk))
        os.environ.setdefault("RESOLVE_SCRIPT_LIB", "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so")
        try:
            import DaVinciResolveScript as dvr_script  # type: ignore
        except Exception as exc:
            raise Rejected("resolve_scripting_module_unavailable") from exc
    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        raise Rejected("resolve_not_connected")
    return resolve


def process_identity(node_id: str) -> str:
    # PID alone is reusable; bind PID + start time + owning UID and this server.
    result = subprocess.run(["/bin/ps", "-axo", "pid=,uid=,lstart=,comm="],
                            capture_output=True, text=True, check=True)
    rows = [s.strip() for s in result.stdout.splitlines()
            if s.endswith("/DaVinci Resolve.app/Contents/MacOS/Resolve")]
    owned = [s for s in rows if s.split()[1] == str(os.getuid())]
    if len(owned) != 1:
        raise Rejected("resolve_process_identity_ambiguous")
    return node_id + ":resolve:" + fingerprint({"process": owned[0], "executor": INCARNATION})


def timeline_by_id(project, unique_id: str):
    matches = [project.GetTimelineByIndex(i) for i in range(1, project.GetTimelineCount() + 1)]
    found = [t for t in matches if t is not None and str(t.GetUniqueId()) == unique_id]
    return found[0] if len(found) == 1 else None


def timeline_content(timeline) -> dict[str, Any]:
    tracks = []
    for kind in ("video", "audio", "subtitle"):
        for track in range(1, int(timeline.GetTrackCount(kind)) + 1):
            items = []
            for item in timeline.GetItemListInTrack(kind, track) or []:
                media = item.GetMediaPoolItem()
                data = {"id": str(item.GetUniqueId()), "name": item.GetName(),
                        "mediaId": str(media.GetUniqueId()) if media else None,
                        "start": item.GetStart(), "end": item.GetEnd(),
                        "duration": item.GetDuration()}
                if kind != "subtitle":
                    data.update(sourceStart=item.GetSourceStartFrame(), sourceEnd=item.GetSourceEndFrame())
                if kind == "audio":
                    properties = item.GetProperties() or {}
                    data.update(audioGainDb=properties.get("AudioVolume"), audioGainEnabled=properties.get("AudioVolumeEnabled"))
                items.append(data)
            tracks.append({"kind": kind, "index": track, "items": items})
    return {"start": timeline.GetStartFrame(), "end": timeline.GetEndFrame(),
            "settings": timeline.GetSettings(), "tracks": tracks}


def timeline_fingerprint(timeline) -> str:
    return fingerprint({"id": str(timeline.GetUniqueId()), "name": timeline.GetName(),
                        "content": timeline_content(timeline)})


def comparable_content(timeline) -> dict[str, Any]:
    content = timeline_content(timeline)
    for track in content["tracks"]:
        for item in track["items"]:
            item.pop("id", None)
    return content


def copy_name(plan: dict[str, Any]) -> str:
    return f"AIW {plan['planId'][:48]} r{plan['revision']} {plan['planSha256'][:16]}"


def frame_rate(value):
    text = str(value)
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?(?: (?:DF|NDF))?", text):
        raise Rejected("resolve_frame_rate_unavailable")
    number = float(text.split(" ")[0])
    if number <= 0:
        raise Rejected("resolve_frame_rate_unavailable")
    return number


def empty_timeline_matches(plan, timeline):
    content = timeline_content(timeline)
    desired = plan["timelineFrameRate"]["numerator"] / plan["timelineFrameRate"]["denominator"]
    return (not any(t["items"] for t in content["tracks"]) and content["start"] == 0
            and abs(frame_rate(content["settings"].get("timelineFrameRate", 0)) - desired) <= 0.001)


def validate_plan(plan: dict[str, Any]):
    digest = plan.get("planSha256", "")
    if not isinstance(digest, str) or not HASH.fullmatch(digest):
        raise Rejected("edit_plan_identity_invalid")
    if fingerprint({k: v for k, v in plan.items() if k != "planSha256"}) != digest:
        raise Rejected("edit_plan_integrity_mismatch")
    if plan.get("status") != "approved":
        raise Rejected("edit_plan_not_approved")


class Executor:
    def __init__(self, state_dir: Path, output_root: Path, node_id: str, resolver=load_resolve,
                 identity=process_identity):
        self.state_dir = secure_directory(state_dir)
        self.output_root = output_root.resolve(strict=True)
        self.node_id, self.resolver, self.identity = node_id, resolver, identity
        self.receipts = secure_directory(self.state_dir / "operations")
        self.file_hashes: dict[tuple, str] = {}

    def _receipt_path(self, operation_id):
        match = OPERATION.fullmatch(operation_id)
        if not match:
            raise Rejected("resolve_operation_identity_invalid")
        return self.receipts / (match.group(1) + ".json")

    def _read(self, operation_id):
        path = self._receipt_path(operation_id)
        if not path.exists():
            return None
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise Rejected("resolve_receipt_permissions")
        return json.loads(path.read_text())

    def _save(self, operation_id, receipt):
        path = self._receipt_path(operation_id)
        tmp = path.with_name(path.name + "." + uuid.uuid4().hex)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(receipt, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
            dfd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        finally:
            if tmp.exists():
                tmp.unlink()

    def _current(self):
        resolve = self.resolver()
        project = resolve.GetProjectManager().GetCurrentProject()
        if project is None:
            raise Rejected("resolve_project_not_open")
        return resolve, project

    def inspect(self):
        resolve, project = self._current()
        timeline = project.GetCurrentTimeline()
        capabilities = ["project.read", "timeline.read", "render.status", "media.import", "timeline.create", "timeline.append", "audio.append", "render.queue"]
        if timeline is not None:
            capabilities += ["timeline.duplicate"]
            if callable(getattr(timeline, "CreateSubtitlesFromAudio", None)):
                capabilities += ["subtitle.auto"]
        snapshot = {"connected": True, "nodeId": self.node_id,
                    "resolveVersion": str(resolve.GetVersionString()),
                    "studio": bool(resolve.IsStudio()), "capabilities": capabilities,
                    "projectUniqueId": str(project.GetUniqueId()),
                    "projectName": str(project.GetName()),
                    "processIdentity": self.identity(self.node_id),
                    "currentProjectFingerprint": fingerprint({"id": str(project.GetUniqueId()), "name": project.GetName()}),
                    "renderPresets": project.GetRenderPresetList() or [],
                    "projectSettings": project.GetSettings(),
                    "observedAt": int(time.time() * 1000)}
        if timeline is not None:
            snapshot.update(timelineUniqueId=str(timeline.GetUniqueId()), timelineName=timeline.GetName(),
                            currentTimelineFingerprint=timeline_fingerprint(timeline),
                            timelineSettings=timeline.GetSettings(), timelineContent=timeline_content(timeline))
        return snapshot

    def _context(self, plan, operation, expected_identity=None):
        resolve, project = self._current()
        base = plan["base"]
        if not resolve.IsStudio():
            raise Rejected("resolve_studio_required")
        if expected_identity is not None and self.identity(self.node_id) != expected_identity:
            raise Rejected("resolve_process_identity_changed")
        if (self.node_id != base["editorNodeId"] or str(resolve.GetVersionString()) != base["resolveVersion"]
                or str(project.GetUniqueId()) != base["projectUniqueId"]):
            raise Rejected("resolve_project_identity_mismatch")
        if fingerprint({"id": str(project.GetUniqueId()), "name": project.GetName()}) != base["projectFingerprint"]:
            raise Rejected("resolve_project_changed")
        source = None
        if base.get("timelineUniqueId"):
            source = timeline_by_id(project, base["timelineUniqueId"])
            if source is None or str(source.GetName()) != base["timelineName"]:
                raise Rejected("resolve_source_timeline_missing")
            if not base.get("timelineFingerprint") or timeline_fingerprint(source) != base["timelineFingerprint"]:
                raise Rejected("resolve_source_timeline_changed")
        elif operation["phase"] == "duplicate_timeline":
            raise Rejected("resolve_source_timeline_missing")
        if operation["phase"] == "create_timeline" and source is not None:
            raise Rejected("resolve_new_timeline_mode_required")
        target = None
        if operation["phase"] not in ("duplicate_timeline", "create_timeline"):
            target_id = operation.get("timelineUniqueId", "")
            target = timeline_by_id(project, target_id)
            if target is None or (source is not None and target_id == str(source.GetUniqueId())) or target.GetName() != copy_name(plan):
                raise Rejected("resolve_copy_binding_required")
            # A durable intent is evidence of ownership, never a name alone.
            ownership = self._operation_receipts(plan, operation["taskId"])
            matching_copy = any(r.get("phase") in ("duplicate_timeline", "create_timeline")
                and (r.get("result", {}).get("timelineUniqueId") == target_id
                     or (r.get("phase") == "create_timeline" and empty_timeline_matches(plan, target))
                     or comparable_content(target) == r.get("sourceContent")) for r in ownership)
            matching_step = any(r.get("targetUniqueId") == target_id for r in ownership)
            if not matching_copy and not matching_step:
                raise Rejected("resolve_copy_ownership_missing")
        return resolve, project, source, target

    def _validate_operation(self, plan, operation, operation_id):
        if not isinstance(operation, dict) or operation.get("operationId") != operation_id:
            raise Rejected("resolve_operation_identity_mismatch")
        key = f"{plan['planId']}:{plan['revision']}:{operation.get('phase')}:{operation.get('taskId')}:{operation.get('stepId')}"
        expected = "resolve-operation:" + hashlib.sha256(key.encode()).hexdigest()
        if (operation_id != expected or operation.get("planId") != plan["planId"]
                or operation.get("planRevision") != plan["revision"]
                or operation.get("executorNodeId") != plan["base"]["editorNodeId"]
                or operation.get("resolveVersion") != plan["base"]["resolveVersion"]):
            raise Rejected("resolve_operation_identity_mismatch")
        phase = operation.get("phase")
        assets = [c["asset"] for c in plan["clips"] if c["asset"].get("assetId") == operation.get("stepId")] if phase == "import_media" else []
        if assets and len({fingerprint(a) for a in assets}) != 1:
            raise Rejected("resolve_asset_reference_ambiguous")
        payload = assets[0] if assets else plan["base"] if phase in ("duplicate_timeline", "create_timeline") else plan["output"] if phase in ("queue_render", "start_render", "verify", "subtitles") else next((c for c in plan["clips"] if c["itemId"] == operation.get("stepId")), None)
        if payload is None or phase not in ("duplicate_timeline", "create_timeline", "edit", "queue_render", "start_render", "verify", "subtitles", "import_media"):
            raise Rejected("resolve_operation_unsupported")
        if operation.get("payloadSha256") != fingerprint(payload):
            raise Rejected("resolve_operation_payload_mismatch")
        return payload

    def _operation_receipts(self, plan, task_id):
        receipts = []
        for path in self.receipts.glob("*.json"):
            if HASH.fullmatch(path.stem):
                value = self._read("resolve-operation:" + path.stem)
                if value.get("planSha256") == plan["planSha256"] and value.get("taskId") == task_id:
                    receipts.append(value)
        return receipts

    def _pool_items(self, pool):
        folders, items, seen = [pool.GetRootFolder()], [], set()
        while folders:
            folder = folders.pop()
            fid = str(folder.GetUniqueId())
            if fid in seen:
                continue
            seen.add(fid)
            if len(seen) > 10000:
                raise Rejected("resolve_media_pool_limit")
            items.extend(folder.GetClipList() or [])
            folders.extend(folder.GetSubFolderList() or [])
        return items

    def _checked_file(self, path, asset):
        if not path.is_absolute() or not path.is_file():
            raise Rejected("resolve_media_file_unavailable")
        if asset.get("sourcePathRef") and path.resolve() != Path(asset["sourcePathRef"]).resolve():
            raise Rejected("resolve_media_path_mismatch")
        st = path.stat()
        key = (str(path.resolve()), st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if key not in self.file_hashes:
            self.file_hashes[key] = file_digest(path)
        after = path.stat()
        if self.file_hashes[key] != asset["contentSha256"] or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns):
            raise Rejected("resolve_media_content_mismatch")
        return path.resolve()

    def _matches_path(self, pool, source):
        return [item for item in self._pool_items(pool)
                if str((item.GetClipProperty() or {}).get("File Path", ""))
                and Path(str(item.GetClipProperty()["File Path"])).resolve() == source]

    def _import_status(self, project, target, receipt):
        asset = receipt["asset"]
        source = self._checked_file(Path(asset["sourcePathRef"]), asset)
        matches = self._matches_path(project.GetMediaPool(), source)
        if len(matches) != 1:
            return {"status": "unknown", "errorCode": "resolve_import_not_unique"}
        uid = str(matches[0].GetUniqueId())
        expected = receipt.get("result", {}).get("resolveMediaPoolItemUniqueId")
        if (expected and uid != expected) or (not expected and uid in receipt["beforeMediaIds"]):
            return {"status": "unknown", "errorCode": "resolve_import_identity_unknown"}
        return {"status": "succeeded", "result": self._result(target, assetId=asset["assetId"],
                resolveMediaPoolItemUniqueId=uid, contentSha256=asset["contentSha256"])}

    def _media(self, pool, asset, plan, operation, project, target):
        uid = asset.get("resolveMediaPoolItemUniqueId")
        if not uid:
            matches = [r for r in self._operation_receipts(plan, operation["taskId"])
                       if r.get("phase") == "import_media"
                       and r.get("asset") == asset]
            if len(matches) != 1:
                raise Rejected("resolve_media_pool_item_identity_required")
            readback = self._import_status(project, target, matches[0])
            if readback["status"] != "succeeded":
                raise Rejected("resolve_media_import_unresolved")
            uid = readback["result"]["resolveMediaPoolItemUniqueId"]
        found = [item for item in self._pool_items(pool) if str(item.GetUniqueId()) == uid]
        if len(found) != 1:
            raise Rejected("resolve_media_pool_item_identity_mismatch")
        self._checked_file(Path(str((found[0].GetClipProperty() or {}).get("File Path", ""))), asset)
        return found[0]

    def _result(self, timeline, **extra):
        return {"timelineUniqueId": str(timeline.GetUniqueId()), "timelineName": timeline.GetName(),
                "timelineFingerprint": timeline_fingerprint(timeline), **extra}

    def reconcile(self, plan, operation):
        receipt = self._read(operation["operationId"])
        if receipt is None or receipt.get("planSha256") != plan["planSha256"]:
            return {"status": "unknown", "errorCode": "resolve_write_receipt_missing"}
        _, project, source, target = self._context(plan, operation)
        phase = operation["phase"]
        if phase in ("duplicate_timeline", "create_timeline"):
            matches = [project.GetTimelineByIndex(i) for i in range(1, project.GetTimelineCount() + 1)]
            matches = [t for t in matches if t.GetName() == copy_name(plan)]
            if len(matches) == 1:
                if phase == "create_timeline":
                    valid = empty_timeline_matches(plan, matches[0])
                else:
                    valid = comparable_content(matches[0]) == receipt["sourceContent"]
                if valid:
                    return {"status": "succeeded", "result": self._result(matches[0], created=True)}
        elif phase == "import_media":
            return self._import_status(project, target, receipt)
        elif phase == "edit":
            actual = timeline_content(target)
            before = receipt["beforeContent"]
            previous_ids = {item["id"] for track in before["tracks"] for item in track["items"]}
            # Preserve every prior item exactly; only the declared appended items may differ.
            prior_now = [(track["kind"], track["index"], item) for track in actual["tracks"] for item in track["items"] if item["id"] in previous_ids]
            prior_then = [(track["kind"], track["index"], item) for track in before["tracks"] for item in track["items"]]
            if sorted(prior_now, key=lambda x: x[2]["id"]) != sorted(prior_then, key=lambda x: x[2]["id"]) or actual["settings"] != before["settings"]:
                return {"status": "unknown", "errorCode": "resolve_timeline_baseline_changed"}
            additions = [(t["kind"], t["index"], item) for t in actual["tracks"] for item in t["items"] if item["id"] not in previous_ids]
            clip = self._validate_operation(plan, operation, operation["operationId"])
            expected_kinds = ["video", "audio"] if clip["mediaType"] == "av" else [clip["mediaType"]]
            if len(additions) == len(expected_kinds) and sorted(k for k, _, _ in additions) == sorted(expected_kinds):
                good = all(idx == clip["trackIndex"] and item["mediaId"] == receipt["mediaUniqueId"]
                           and item["sourceStart"] == clip["sourceRange"]["start"]
                           and item["start"] == clip["timelineStartFrame"]
                           and item["duration"] == clip["sourceRange"]["endExclusive"] - clip["sourceRange"]["start"]
                           for _, idx, item in additions)
                if good and "audioGainDb" in clip:
                    good = all(item.get("audioGainEnabled") is True and item.get("audioGainDb") is not None
                               and abs(float(item["audioGainDb"]) - float(clip["audioGainDb"])) < 0.001
                               for kind, _, item in additions if kind == "audio")
                if good:
                    return {"status": "succeeded", "result": self._result(target, appendedItemIds=[i["id"] for _, _, i in additions])}
        elif phase == "queue_render":
            return self._queued_render_status(project, target, receipt)
        elif phase == "start_render":
            return self._render_status(project, target, receipt)
        elif phase == "verify":
            return {"status": "succeeded", "result": self._result(target, content=timeline_content(target))}
        elif phase == "subtitles":
            content = timeline_content(target)
            subtitles = [i for t in content["tracks"] if t["kind"] == "subtitle" for i in t["items"]]
            before = receipt.get("beforeContent", {})
            old_av = [t for t in before.get("tracks", []) if t["kind"] != "subtitle"]
            new_av = [t for t in content["tracks"] if t["kind"] != "subtitle"]
            if subtitles and old_av == new_av and before.get("settings") == content["settings"]:
                return {"status": "succeeded", "result": self._result(target, subtitleCount=len(subtitles))}
        return {"status": "unknown", "errorCode": "resolve_readback_incomplete"}

    def _queued_render_status(self, project, target, receipt):
        if receipt.get("targetFingerprint") != timeline_fingerprint(target):
            return {"status": "unknown", "errorCode": "resolve_render_timeline_changed"}
        expected_id = receipt.get("result", {}).get("jobId")
        matches = [j for j in project.GetRenderJobList() or []
                   if j.get("OutputFilename") == receipt.get("outputName")
                   and j.get("TargetDir") == receipt.get("outputDir")
                   and j.get("TimelineName") == target.GetName()
                   and ((expected_id and j.get("JobId") == expected_id)
                        or (not expected_id and j.get("JobId") not in receipt.get("priorRenderJobIds", [])))]
        if len(matches) != 1:
            return {"status": "unknown", "errorCode": "resolve_render_job_unresolved"}
        job_id = matches[0].get("JobId")
        status = project.GetRenderJobStatus(job_id) or {}
        return {"status": "succeeded", "result": self._result(target, jobId=job_id,
                outputPath=str(Path(receipt["outputDir"]) / receipt["outputName"]), jobStatus=status.get("JobStatus"))}

    def _render_status(self, project, target, receipt):
        result = receipt.get("result", {})
        if receipt.get("targetFingerprint") != timeline_fingerprint(target):
            return {"status": "unknown", "errorCode": "resolve_render_timeline_changed"}
        job_id = result.get("jobId")
        if not job_id:
            return {"status": "unknown", "errorCode": "resolve_render_job_unresolved"}
        jobs = [j for j in project.GetRenderJobList() or [] if j.get("JobId") == job_id]
        path = Path(result.get("outputPath", ""))
        if (len(jobs) != 1 or jobs[0].get("TimelineName") != target.GetName()
                or jobs[0].get("TargetDir") != str(path.parent) or jobs[0].get("OutputFilename") != path.name):
            return {"status": "unknown", "errorCode": "resolve_render_job_identity_changed"}
        status = project.GetRenderJobStatus(job_id) or {}
        result = {**result, "jobStatus": status.get("JobStatus"), "completionPercentage": status.get("CompletionPercentage")}
        if status.get("JobStatus") == "Complete":
            path = Path(result.get("outputPath", ""))
            if not path.is_file() or path.stat().st_size <= 0:
                return {"status": "unknown", "errorCode": "resolve_render_output_unverified", "result": result}
            result["outputSha256"] = file_digest(path)
            result["outputBytes"] = path.stat().st_size
            return {"status": "succeeded", "result": result}
        if status.get("JobStatus") == "Failed":
            return {"status": "failed", "errorCode": "resolve_render_failed", "result": result}
        if status.get("JobStatus") in ("Cancelled", "Canceled", "Background Render Cancelled", "Remote Render Cancelled"):
            return {"status": "cancelled", "result": result}
        if status.get("JobStatus") not in ("Rendering", "InProgress", "Running"):
            return {"status": "unknown", "errorCode": "resolve_render_start_requires_review", "result": {**result, "nextAction": "review_existing_render_job"}}
        return {"status": "accepted", "result": result}

    def apply(self, plan, operation, expected_identity):
        if not expected_identity:
            raise Rejected("resolve_process_fence_required")
        payload = self._validate_operation(plan, operation, operation["operationId"])
        if self._read(operation["operationId"]) is not None:
            return self.reconcile(plan, operation)
        _, project, source, target = self._context(plan, operation, expected_identity)
        phase = operation["phase"]
        if phase not in ("verify", "start_render") and project.IsRenderingInProgress():
            raise Rejected("resolve_render_busy")
        receipt = {"planSha256": plan["planSha256"], "phase": phase, "operationId": operation["operationId"], "taskId": operation["taskId"],
                   "processIdentity": expected_identity, "intentAt": int(time.time() * 1000),
                   "targetUniqueId": str(target.GetUniqueId()) if target is not None else None,
                   "targetFingerprint": timeline_fingerprint(target) if target is not None else None}
        if phase in ("duplicate_timeline", "create_timeline"):
            if any(project.GetTimelineByIndex(i).GetName() == copy_name(plan) for i in range(1, project.GetTimelineCount() + 1)):
                raise Rejected("resolve_unowned_copy_exists")
            if source is not None:
                receipt["sourceContent"] = comparable_content(source)
            self._save(operation["operationId"], receipt)
            created = source.DuplicateTimeline(copy_name(plan)) if source is not None else project.GetMediaPool().CreateEmptyTimeline(copy_name(plan))
            if created is None:
                raise RuntimeError("resolve_timeline_duplicate_unknown")
            if phase == "create_timeline":
                if not project.SetCurrentTimeline(created):
                    raise RuntimeError("resolve_timeline_select_unknown")
                fps = plan["timelineFrameRate"]["numerator"] / plan["timelineFrameRate"]["denominator"]
                if not created.SetSettings({"useCustomSettings": "1", "timelineFrameRate": f"{fps:.3f}".rstrip("0").rstrip(".")}):
                    raise RuntimeError("resolve_new_timeline_settings_unknown")
                if not created.SetStartTimecode("00:00:00:00"):
                    raise RuntimeError("resolve_new_timeline_start_unknown")
            result = self.reconcile(plan, operation)
        else:
            if not operation.get("timelineFingerprint") or timeline_fingerprint(target) != operation["timelineFingerprint"]:
                raise Rejected("resolve_copy_baseline_changed")
            if phase == "import_media":
                source = Path(payload.get("sourcePathRef", ""))
                if not source.is_absolute() or not source.is_file() or source.resolve() != source:
                    raise Rejected("resolve_import_canonical_path_required")
                self._checked_file(source, payload)
                pool = project.GetMediaPool()
                matches = self._matches_path(pool, source)
                if len(matches) > 1:
                    raise Rejected("resolve_import_not_unique")
                if payload.get("resolveMediaPoolItemUniqueId") and (len(matches) != 1 or str(matches[0].GetUniqueId()) != payload["resolveMediaPoolItemUniqueId"]):
                    raise Rejected("resolve_media_pool_item_identity_mismatch")
                receipt.update(asset=payload, beforeMediaIds=[str(i.GetUniqueId()) for i in self._pool_items(pool)])
                if matches:
                    receipt["result"] = self._result(target, assetId=payload["assetId"],
                        resolveMediaPoolItemUniqueId=str(matches[0].GetUniqueId()), contentSha256=payload["contentSha256"])
                    result = {"status": "succeeded", "result": receipt["result"]}
                else:
                    self._save(operation["operationId"], receipt)
                    pool.ImportMedia([{"FilePath": str(source)}])
                    result = self._import_status(project, target, receipt)
            elif phase == "edit":
                if plan["sourceFrameRate"]["numerator"] * plan["timelineFrameRate"]["denominator"] != plan["timelineFrameRate"]["numerator"] * plan["sourceFrameRate"]["denominator"]:
                    raise Rejected("resolve_mixed_frame_rate_unsupported")
                media = self._media(project.GetMediaPool(), payload["asset"], plan, operation, project, target)
                expected_fps = plan["timelineFrameRate"]["numerator"] / plan["timelineFrameRate"]["denominator"]
                actual_fps = frame_rate((target.GetSettings() or {}).get("timelineFrameRate", 0))
                if abs(actual_fps - expected_fps) > 0.001:
                    raise Rejected("resolve_timeline_frame_rate_mismatch")
                if payload["mediaType"] != "audio":
                    media_fps = frame_rate((media.GetClipProperty() or {}).get("FPS", 0))
                    if abs(media_fps - expected_fps) > 0.001:
                        raise Rejected("resolve_media_frame_rate_mismatch")
                kind = payload["mediaType"]
                if "audioGainDb" in payload and (kind == "video" or not isinstance(payload["audioGainDb"], (int, float)) or not -100 <= payload["audioGainDb"] <= 30):
                    raise Rejected("resolve_audio_gain_invalid")
                kinds = ("video", "audio") if kind == "av" else (kind,)
                for k in kinds:
                    if target.GetTrackCount(k) < payload["trackIndex"]:
                        raise Rejected("resolve_destination_track_missing")
                    start = payload["timelineStartFrame"]
                    end = start + payload["sourceRange"]["endExclusive"] - payload["sourceRange"]["start"]
                    if start < target.GetStartFrame() or any(i.GetStart() < end and i.GetEnd() > start for i in target.GetItemListInTrack(k, payload["trackIndex"]) or []):
                        raise Rejected("resolve_timeline_range_occupied")
                receipt["beforeContent"] = timeline_content(target)
                receipt["mediaUniqueId"] = str(media.GetUniqueId())
                self._save(operation["operationId"], receipt)
                if not project.SetCurrentTimeline(target):
                    raise RuntimeError("resolve_timeline_select_unknown")
                info = {"mediaPoolItem": media, "startFrame": payload["sourceRange"]["start"],
                        "endFrame": payload["sourceRange"]["endExclusive"] - 1,
                        "trackIndex": payload["trackIndex"], "recordFrame": payload["timelineStartFrame"]}
                if kind != "av":
                    info["mediaType"] = 1 if kind == "video" else 2
                project.GetMediaPool().AppendToTimeline([info])
                if "audioGainDb" in payload:
                    previous_ids = {i["id"] for t in receipt["beforeContent"]["tracks"] for i in t["items"]}
                    audio = [i for i in target.GetItemListInTrack("audio", payload["trackIndex"]) or []
                             if str(i.GetUniqueId()) not in previous_ids and i.GetMediaPoolItem() is not None
                             and str(i.GetMediaPoolItem().GetUniqueId()) == receipt["mediaUniqueId"]
                             and i.GetStart() == payload["timelineStartFrame"]
                             and i.GetSourceStartFrame() == payload["sourceRange"]["start"]]
                    if len(audio) != 1:
                        raise RuntimeError("resolve_audio_item_unresolved")
                    if not audio[0].SetProperties({"AudioVolumeEnabled": True, "AudioVolume": payload["audioGainDb"]}):
                        raise RuntimeError("resolve_audio_gain_unknown")
                result = self.reconcile(plan, operation)
            elif phase == "queue_render":
                if project.IsRenderingInProgress():
                    raise Rejected("resolve_render_busy")
                output = Path(payload.get("outputPathRef", ""))
                if not output.is_absolute() or not output.parent.exists() or output.parent.resolve() != output.parent:
                    raise Rejected("resolve_render_output_required")
                if not output.resolve().is_relative_to(self.output_root) or output.exists() or list(output.parent.glob(output.stem + ".*")):
                    raise Rejected("resolve_render_output_unsafe")
                preset = payload.get("renderPreset")
                if not preset or preset not in project.GetRenderPresetList():
                    raise Rejected("resolve_render_preset_missing")
                jobs = project.GetRenderJobList() or []
                if any(j.get("OutputFilename") == output.name and j.get("TargetDir") == str(output.parent) for j in jobs):
                    raise Rejected("resolve_render_output_already_queued")
                receipt.update(outputName=output.name, outputDir=str(output.parent), priorRenderJobIds=[j.get("JobId") for j in jobs])
                self._save(operation["operationId"], receipt)
                if not project.SetCurrentTimeline(target) or not project.LoadRenderPreset(preset):
                    raise RuntimeError("resolve_render_setup_unknown")
                fmt = project.GetCurrentRenderFormatAndCodec() or {}
                if output.suffix.lower() != "." + str(fmt.get("format", "")).lower():
                    raise RuntimeError("resolve_render_extension_mismatch")
                render_settings = {"TargetDir": str(output.parent), "CustomName": output.stem, "SelectAllFrames": True, "ExportVideo": True, "ExportAudio": True, "UseUniqueFilenames": False, "ReplaceExistingFilesInPlace": False}
                if payload.get("autoSubtitles") is True:
                    render_settings.update(ExportSubtitle=True, SubtitleFormat="BurnIn")
                if not project.SetCurrentRenderMode(1) or not project.SetRenderSettings(render_settings):
                    raise RuntimeError("resolve_render_settings_unknown")
                job = project.AddRenderJob()
                if not job:
                    raise RuntimeError("resolve_render_job_unknown")
                receipt["result"] = self._result(target, jobId=str(job), outputPath=str(output))
                self._save(operation["operationId"], receipt)
                result = self._queued_render_status(project, target, receipt)
            elif phase == "start_render":
                queued = [r for r in self._operation_receipts(plan, operation["taskId"])
                          if r.get("phase") == "queue_render" and r.get("targetUniqueId") == str(target.GetUniqueId())]
                if len(queued) != 1:
                    raise Rejected("resolve_render_queue_receipt_required")
                queued_status = self._queued_render_status(project, target, queued[0])
                if queued_status["status"] != "succeeded":
                    raise Rejected("resolve_render_queue_unresolved")
                receipt["result"] = queued_status["result"]
                receipt["queueOperationId"] = queued[0]["operationId"]
                status = queued_status["result"].get("jobStatus")
                if status == "Ready":
                    if project.IsRenderingInProgress():
                        raise Rejected("resolve_render_busy")
                    output = Path(receipt["result"]["outputPath"])
                    if output.exists():
                        raise Rejected("resolve_render_output_unsafe")
                    self._save(operation["operationId"], receipt)
                    if not project.StartRendering([receipt["result"]["jobId"]], False):
                        raise RuntimeError("resolve_render_start_unknown")
                elif status not in ("Rendering", "Complete"):
                    raise Rejected("resolve_render_start_state_unsupported")
                result = self._render_status(project, target, receipt)
            elif phase == "subtitles":
                if payload.get("autoSubtitles") is not True:
                    raise Rejected("resolve_subtitle_mode_unsupported")
                if any(target.GetItemListInTrack("subtitle", i) for i in range(1, target.GetTrackCount("subtitle") + 1)):
                    raise Rejected("resolve_subtitle_track_occupied")
                receipt["beforeContent"] = timeline_content(target)
                self._save(operation["operationId"], receipt)
                if not project.SetCurrentTimeline(target):
                    raise RuntimeError("resolve_timeline_select_unknown")
                if not target.CreateSubtitlesFromAudio():
                    raise RuntimeError("resolve_auto_subtitles_unknown")
                content = timeline_content(target)
                count = sum(len(t["items"]) for t in content["tracks"] if t["kind"] == "subtitle")
                if not count:
                    raise RuntimeError("resolve_subtitles_empty")
                result = self.reconcile(plan, operation)
            elif phase == "verify":
                result = {"status": "succeeded", "result": self._result(target, content=timeline_content(target))}
            else:
                raise Rejected("resolve_operation_unsupported")
        receipt.update(result=result.get("result", {}), outcome=result["status"])
        self._save(operation["operationId"], receipt)
        return result

    def handle(self, request):
        allowed = {"schemaVersion", "requestId", "operationId", "action", "planJson", "payload"}
        if (not isinstance(request, dict) or set(request) - allowed or request.get("schemaVersion") != SCHEMA_VERSION
                or not re.fullmatch(r"[0-9a-f-]{36}", str(request.get("requestId", "")))
                or not OPERATION.fullmatch(str(request.get("operationId", "")))):
            raise Rejected("resolve_protocol_invalid")
        action = request.get("action")
        if action == "inspect":
            return {"status": "succeeded", "result": self.inspect()}
        # Resolve only offers global StopRendering. It cannot safely cancel one
        # job in the presence of UI writers, so do not expose a misleading cancel.
        if action == "cancel":
            raise Rejected("resolve_render_cancel_unsupported")
        plan = json.loads(request.get("planJson", "null"))
        if not isinstance(plan, dict):
            raise Rejected("resolve_plan_required")
        validate_plan(plan)
        payload = request.get("payload") or {}
        operation = payload.get("operation")
        self._validate_operation(plan, operation, request["operationId"])
        if action == "status":
            return self.reconcile(plan, operation)
        if action == "apply":
            return self.apply(plan, operation, payload.get("expectedProcessIdentity"))
        raise Rejected("resolve_action_unsupported")


def response_for(executor, request):
    response = {"schemaVersion": SCHEMA_VERSION, "requestId": request.get("requestId"), "operationId": request.get("operationId")}
    try:
        response.update(executor.handle(request))
    except Rejected as exc:
        written = False
        if request.get("action") == "apply" and OPERATION.fullmatch(str(request.get("operationId", ""))):
            try:
                written = executor._read(request["operationId"]) is not None
            except Exception:
                written = True
        response.update(status="unknown" if written else "failed", errorCode=str(exc))
    except Exception:
        # Do not leak exception strings, paths, model output or credentials.
        response.update(status="unknown" if request.get("action") == "apply" else "failed", errorCode="resolve_executor_outcome_unknown")
    return response


def peer_uid(connection):
    if sys.platform == "darwin":
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise Rejected("resolve_peer_identity_unavailable")
        return uid.value
    if hasattr(socket, "SO_PEERCRED"):
        return struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[1]
    raise Rejected("resolve_peer_identity_unsupported")


def serve(executor, socket_path: Path):
    if socket_path.parent != executor.state_dir or len(str(socket_path).encode()) > 103:
        raise Rejected("resolve_socket_path_invalid")
    lock = os.open(executor.state_dir / "executor.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(lock)
        raise Rejected("resolve_lock_permissions")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        raise Rejected("resolve_executor_already_running")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        if socket_path.exists():
            st = socket_path.lstat()
            if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
                raise Rejected("resolve_socket_identity_invalid")
            socket_path.unlink()  # lock proves a prior managed server is gone
        server.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        socket_inode = socket_path.stat().st_ino
        server.listen(8)
        while True:
            conn, _ = server.accept()
            with conn:
                conn.settimeout(10)  # bounded framing read, not a Resolve task limit
                if peer_uid(conn) != os.getuid():
                    continue
                raw = bytearray()
                try:
                    while b"\n" not in raw and len(raw) <= MAX_MESSAGE_BYTES:
                        chunk = conn.recv(min(65536, MAX_MESSAGE_BYTES + 1 - len(raw)))
                        if not chunk:
                            break
                        raw.extend(chunk)
                except (socket.timeout, ConnectionResetError):
                    continue
                if len(raw) > MAX_MESSAGE_BYTES or not raw.endswith(b"\n") or raw.count(b"\n") != 1:
                    continue
                try:
                    request = json.loads(raw)
                    if not isinstance(request, dict):
                        continue
                except (ValueError, UnicodeError):
                    continue
                conn.settimeout(None)
                response = response_for(executor, request)
                try:
                    conn.sendall((json.dumps(response, ensure_ascii=False) + "\n").encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass  # persisted intent remains available to readback
    finally:
        server.close()
        if socket_path.exists() and 'socket_inode' in locals() and socket_path.stat().st_ino == socket_inode:
            socket_path.unlink()
        os.close(lock)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--node-id", required=True)
    args = parser.parse_args()
    executor = Executor(args.state_dir, args.output_root, args.node_id)
    serve(executor, executor.state_dir / "executor.sock")


if __name__ == "__main__":
    main()

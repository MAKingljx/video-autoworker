#!/usr/bin/env python3
"""Local DaVinci Resolve executor.

The process is intentionally JSONL and fail-closed. It is a device adapter,
not a task queue or a second business state machine. The application owns plan
approval, operation identity, retries and result persistence.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from typing import Any


def _load_resolve():
    try:
        import DaVinciResolveScript as dvr_script  # type: ignore
    except Exception as exc:
        raise RuntimeError("resolve_scripting_module_unavailable") from exc
    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        raise RuntimeError("resolve_not_connected")
    return resolve


def _version(resolve) -> str:
    if hasattr(resolve, "GetVersionString"):
        return str(resolve.GetVersionString())
    values = resolve.GetVersion()
    return ".".join(str(value) for value in values if value not in (None, ""))


def _current(resolve):
    project = resolve.GetProjectManager().GetCurrentProject()
    if project is None:
        raise RuntimeError("resolve_project_not_open")
    timeline = project.GetCurrentTimeline()
    return project, timeline


def _timeline_by_id(project, timeline_unique_id: str):
    for index in range(1, int(project.GetTimelineCount()) + 1):
        candidate = project.GetTimelineByIndex(index)
        if candidate is not None and str(candidate.GetUniqueId()) == timeline_unique_id:
            return candidate
    return None


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def inspect() -> dict[str, Any]:
    resolve = _load_resolve()
    project, timeline = _current(resolve)
    capabilities = ["project.read", "timeline.read", "timeline.duplicate"]
    if timeline is not None and hasattr(resolve, "GetProjectManager"):
        capabilities.extend(["timeline.append", "render.queue", "render.status"])
    project_id = str(project.GetUniqueId()) if hasattr(project, "GetUniqueId") else ""
    timeline_id = str(timeline.GetUniqueId()) if timeline is not None and hasattr(timeline, "GetUniqueId") else None
    studio = bool(resolve.IsStudio()) if hasattr(resolve, "IsStudio") else True
    node_id = os.environ.get("AIWORKER_RESOLVE_NODE_ID", "mac-resolve-local")
    version = _version(resolve)
    snapshot = {
        "connected": True,
        "nodeId": node_id,
        "resolveVersion": version,
        "studio": studio,
        "capabilities": sorted(set(capabilities)),
        "projectUniqueId": project_id,
        "timelineUniqueId": timeline_id,
        "processIdentity": f"{node_id}:resolve:{version}",
        "observedAt": int(time.time() * 1000),
    }
    snapshot["projectFingerprint"] = _fingerprint({"id": project_id, "name": project.GetName()})
    if timeline is not None:
        snapshot["timelineFingerprint"] = _fingerprint({
            "id": timeline_id,
            "name": timeline.GetName(),
            "start": timeline.GetStartFrame() if hasattr(timeline, "GetStartFrame") else None,
            "end": timeline.GetEndFrame() if hasattr(timeline, "GetEndFrame") else None,
        })
        if hasattr(timeline, "GetSettings"):
            settings = timeline.GetSettings() or {}
            snapshot["timelineFrameRate"] = settings.get("timelineFrameRate")
            snapshot["timelineResolution"] = {
                "width": settings.get("timelineResolutionWidth"),
                "height": settings.get("timelineResolutionHeight"),
            }
    return snapshot


def _find_timeline(project, name: str):
    for index in range(1, int(project.GetTimelineCount()) + 1):
        candidate = project.GetTimelineByIndex(index)
        if candidate is not None and str(candidate.GetName()) == name:
            return candidate
    return None


def duplicate_timeline(plan: dict[str, Any]) -> dict[str, Any]:
    resolve = _load_resolve()
    project, current = _current(resolve)
    base = plan["base"]
    if str(project.GetUniqueId()) != base["projectUniqueId"]:
        raise RuntimeError("resolve_project_identity_mismatch")
    source_name = base["timelineName"]
    target_name = f"{source_name} · {plan['planId']} r{plan['revision']}"
    existing = _find_timeline(project, target_name)
    if existing is not None:
        return {"timelineUniqueId": str(existing.GetUniqueId()), "timelineName": target_name, "created": False}
    if current is None or str(current.GetName()) != source_name:
        raise RuntimeError("resolve_timeline_identity_mismatch")
    created = project.DuplicateTimeline(target_name)
    if created is None:
        raise RuntimeError("resolve_timeline_duplicate_failed")
    return {"timelineUniqueId": str(created.GetUniqueId()), "timelineName": target_name, "created": True}


def create_project(request: dict[str, Any]) -> dict[str, Any]:
    resolve = _load_resolve()
    project_manager = resolve.GetProjectManager()
    name = str(request["projectName"])
    existing = project_manager.LoadProject(name)
    if existing is not None:
        project_id = str(existing.GetUniqueId()) if hasattr(existing, "GetUniqueId") else ""
        return {"projectUniqueId": project_id, "projectName": name, "created": False}
    media_location = request.get("mediaLocationPath")
    project = project_manager.CreateProject(name, media_location) if media_location else project_manager.CreateProject(name)
    if project is None:
        raise RuntimeError("resolve_project_create_failed")
    project_id = str(project.GetUniqueId()) if hasattr(project, "GetUniqueId") else ""
    return {"projectUniqueId": project_id, "projectName": str(project.GetName()), "created": True}


def create_timeline(request: dict[str, Any]) -> dict[str, Any]:
    resolve = _load_resolve()
    project, _ = _current(resolve)
    name = str(request["timelineName"])
    existing = _find_timeline(project, name)
    if existing is not None:
        project.SetCurrentTimeline(existing)
        return {"timelineUniqueId": str(existing.GetUniqueId()), "timelineName": name, "created": False}
    timeline = project.GetMediaPool().CreateEmptyTimeline(name)
    if timeline is None:
        raise RuntimeError("resolve_timeline_create_failed")
    project.SetCurrentTimeline(timeline)
    return {"timelineUniqueId": str(timeline.GetUniqueId()), "timelineName": name, "created": True}


def _media_item_for_clip(media_pool, clip: dict[str, Any]):
    asset = clip.get("asset", {})
    unique_id = asset.get("resolveMediaPoolItemUniqueId")
    if unique_id and hasattr(media_pool, "GetItemById"):
        item = media_pool.GetItemById(unique_id)
        if item is not None:
            return item
    source_path = asset.get("sourcePathRef")
    if not source_path:
        raise RuntimeError("resolve_media_pool_item_identity_required")
    imported = media_pool.ImportMedia([{"FilePath": source_path}])
    if not imported:
        raise RuntimeError("resolve_media_pool_import_failed")
    wanted_name = str(asset.get("assetId", ""))
    for item in imported:
        if wanted_name and hasattr(item, "GetName") and str(item.GetName()) == wanted_name:
            return item
    return imported[0]


def append_clips(plan: dict[str, Any], timeline_unique_id: str) -> dict[str, Any]:
    resolve = _load_resolve()
    project, _ = _current(resolve)
    timeline = _timeline_by_id(project, timeline_unique_id)
    if timeline is None:
        raise RuntimeError("resolve_timeline_not_found")
    project.SetCurrentTimeline(timeline)
    media_pool = project.GetMediaPool()
    items = []
    for clip in plan.get("clips", []):
        item = _media_item_for_clip(media_pool, clip)
        source = clip["sourceRange"]
        items.append({
            "mediaPoolItem": item,
            "startFrame": source["start"],
            "endFrame": source["endExclusive"],
            "trackIndex": clip["trackIndex"],
            "recordFrame": clip["timelineStartFrame"],
        })
    result = media_pool.AppendToTimeline(items)
    if result is None:
        raise RuntimeError("resolve_timeline_append_failed")
    return {"timelineUniqueId": timeline_unique_id, "appendedCount": len(result)}


def render(request: dict[str, Any]) -> dict[str, Any]:
    resolve = _load_resolve()
    project, timeline = _current(resolve)
    if timeline is None:
        raise RuntimeError("resolve_timeline_not_open")
    settings = dict(request.get("renderSettings") or {})
    settings.setdefault("SelectAllFrames", True)
    settings.setdefault("ExportVideo", True)
    settings.setdefault("ExportAudio", True)
    if not settings.get("TargetDir") or not settings.get("CustomName"):
        raise RuntimeError("resolve_render_output_required")
    if not project.SetRenderSettings(settings):
        raise RuntimeError("resolve_render_settings_failed")
    job_id = project.AddRenderJob()
    if not job_id:
        raise RuntimeError("resolve_render_job_create_failed")
    if not project.StartRendering([job_id], False):
        raise RuntimeError("resolve_render_start_failed")
    deadline = time.time() + float(request.get("timeoutSeconds", 3600))
    status = project.GetRenderJobStatus(job_id) or {}
    while project.IsRenderingInProgress() and time.time() < deadline:
        time.sleep(float(request.get("pollSeconds", 2)))
        status = project.GetRenderJobStatus(job_id) or {}
    if project.IsRenderingInProgress():
        project.StopRendering()
        raise RuntimeError("resolve_render_timeout")
    job_status = str(status.get("JobStatus", ""))
    if job_status != "Complete":
        raise RuntimeError("resolve_render_failed:" + (str(status.get("Error", "")) or job_status or "unknown"))
    output_path = os.path.join(str(settings["TargetDir"]), str(settings["CustomName"]))
    return {"jobId": str(job_id), "jobStatus": job_status, "outputPath": output_path, "status": status}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action == "inspect":
        return {"status": "succeeded", "result": inspect()}
    if action == "duplicate_timeline":
        return {"status": "succeeded", "result": duplicate_timeline(request["plan"])}
    if action == "create_project":
        return {"status": "succeeded", "result": create_project(request)}
    if action == "create_timeline":
        return {"status": "succeeded", "result": create_timeline(request)}
    if action == "append_clips":
        return {"status": "succeeded", "result": append_clips(request["plan"], request["timelineUniqueId"])}
    if action == "render":
        return {"status": "succeeded", "result": render(request)}
    raise RuntimeError("resolve_action_unsupported")


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            response = {"requestId": request.get("requestId"), "operationId": request.get("operationId")}
            response.update(handle(request))
        except Exception as exc:
            response = {
                "requestId": request.get("requestId") if isinstance(request, dict) else None,
                "operationId": request.get("operationId") if isinstance(request, dict) else None,
                "status": "failed",
                "errorCode": str(exc) or "resolve_executor_failed",
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

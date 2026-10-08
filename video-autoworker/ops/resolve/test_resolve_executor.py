"""Contract tests using explicit SDK doubles; never evidence of real Resolve use."""
import copy
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import socket
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("resolve_executor", Path(__file__).with_name("resolve_executor.py"))
executor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(executor)


class Media:
    def __init__(self, path): self.path = path
    def GetUniqueId(self): return "media-1"
    def GetClipProperty(self): return {"File Path": str(self.path), "FPS": "24"}


class Item:
    def __init__(self, media, info, uid): self.media, self.info, self.uid = media, info, uid; self.properties = {"AudioVolume": 0, "AudioVolumeEnabled": True}
    def GetUniqueId(self): return self.uid
    def GetName(self): return "clip"
    def GetMediaPoolItem(self): return self.media
    def GetStart(self): return self.info["recordFrame"]
    def GetEnd(self): return self.GetStart() + self.GetDuration()
    def GetDuration(self): return self.info["endFrame"] - self.info["startFrame"] + 1
    def GetSourceStartFrame(self): return self.info["startFrame"]
    def GetSourceEndFrame(self): return self.info["endFrame"]
    def GetProperties(self): return dict(self.properties)
    def SetProperties(self, properties): self.properties.update(properties); return True


class Timeline:
    def __init__(self, project, name, uid):
        self.project, self.name, self.uid = project, name, uid
        self.tracks = {"video": [[]], "audio": [[], []], "subtitle": [[]]}
    def GetUniqueId(self): return self.uid
    def GetName(self): return self.name
    def GetStartFrame(self): return 0
    def GetEndFrame(self): return max([item.GetEnd() for rows in self.tracks.values() for row in rows for item in row] + [0])
    def GetSettings(self): return {"timelineFrameRate": "24", "timelineResolutionWidth": "1920", "timelineResolutionHeight": "1080"}
    def SetSettings(self, settings): return True
    def SetStartTimecode(self, value): return value == "00:00:00:00"
    def GetTrackCount(self, kind): return len(self.tracks[kind])
    def GetItemListInTrack(self, kind, index): return self.tracks[kind][index - 1]
    def DuplicateTimeline(self, name):
        target = Timeline(self.project, name, "copy-" + str(len(self.project.timelines)))
        target.tracks = copy.deepcopy(self.tracks)
        self.project.timelines.append(target)
        return target
    def CreateSubtitlesFromAudio(self): return False


class Folder:
    def __init__(self, pool): self.pool = pool
    def GetUniqueId(self): return "folder-1"
    def GetClipList(self): return self.pool.items
    def GetSubFolderList(self): return []


class Pool:
    def __init__(self, project, path):
        self.project, self.media, self.writes = project, Media(path), 0
        self.items, self.imports = [self.media], 0
    def ImportMedia(self, infos):
        self.imports += 1
        self.items = [Media(Path(infos[0]["FilePath"]))]
        return self.items
    def GetRootFolder(self): return Folder(self)
    def CreateEmptyTimeline(self, name):
        timeline = Timeline(self.project, name, "new-" + str(len(self.project.timelines)))
        self.project.timelines.append(timeline)
        return timeline
    def AppendToTimeline(self, infos):
        self.writes += 1
        result = []
        for info in infos:
            kinds = ["video", "audio"] if not info.get("mediaType") else ["video" if info["mediaType"] == 1 else "audio"]
            for kind in kinds:
                item = Item(info["mediaPoolItem"], info, f"item-{self.writes}-{kind}")
                self.project.current.tracks[kind][info["trackIndex"] - 1].append(item)
                result.append(item)
        return result


class Project:
    def __init__(self, path):
        self.timelines = [Timeline(self, "Base", "source-1")]
        self.current, self.pool = self.timelines[0], Pool(self, path)
        self.jobs, self.started, self.stop_calls = {}, [], 0
        self.settings = None
    def GetUniqueId(self): return "project-1"
    def GetName(self): return "Isolated fixture"
    def GetSettings(self): return {"timelineFrameRate": "24"}
    def GetCurrentTimeline(self): return self.current
    def SetCurrentTimeline(self, timeline): self.current = timeline; return True
    def GetTimelineCount(self): return len(self.timelines)
    def GetTimelineByIndex(self, i): return self.timelines[i - 1]
    def GetMediaPool(self): return self.pool
    def GetRenderPresetList(self): return ["h264"]
    def LoadRenderPreset(self, name): return name == "h264"
    def GetCurrentRenderFormatAndCodec(self): return {"format": "mp4", "codec": "H264"}
    def SetCurrentRenderMode(self, mode): return mode == 1
    def SetRenderSettings(self, settings): self.settings = settings; return True
    def AddRenderJob(self):
        job = "job-" + str(len(self.jobs) + 1)
        self.jobs[job] = {"JobStatus": "Ready", "TimelineName": self.current.GetName(), "TargetDir": self.settings["TargetDir"], "OutputFilename": self.settings["CustomName"] + ".mp4"}
        return job
    def StartRendering(self, jobs, interactive):
        self.started.extend(jobs)
        for job in jobs: self.jobs[job]["JobStatus"] = "Rendering"
        return True
    def IsRenderingInProgress(self): return any(s["JobStatus"] == "Rendering" for s in self.jobs.values())
    def GetRenderJobStatus(self, job): return self.jobs.get(job, {})
    def GetRenderJobList(self): return [{"JobId": key, **value} for key, value in self.jobs.items()]
    def StopRendering(self): self.stop_calls += 1


class Resolve:
    def __init__(self, path): self.project = Project(path)
    def GetProjectManager(self): return self
    def GetCurrentProject(self): return self.project
    def GetVersionString(self): return "21.1.0"
    def IsStudio(self): return True


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.media = self.root / "media.mp4"
        self.media.write_bytes(b"fixture-not-a-real-video")
        self.resolve = Resolve(self.media)
        self.identity = "fixture:resolve:" + "a" * 64
        self.adapter = executor.Executor(self.root / "state", self.root, "fixture", lambda: self.resolve, lambda _: self.identity)
        snapshot = self.adapter.inspect()
        self.plan = {"schemaVersion": 1, "planId": "plan", "revision": 1, "status": "approved",
                     "sourceFrameRate": {"numerator": 24, "denominator": 1}, "timelineFrameRate": {"numerator": 24, "denominator": 1},
                     "base": {"editorNodeId": "fixture", "resolveVersion": "21.1.0", "projectUniqueId": "project-1",
                              "projectFingerprint": snapshot["currentProjectFingerprint"], "timelineUniqueId": "source-1",
                              "timelineName": "Base", "timelineFingerprint": snapshot["currentTimelineFingerprint"]},
                     "clips": [{"itemId": "clip-1", "mediaType": "av", "asset": {"assetId": "asset-1", "resolveMediaPoolItemUniqueId": "media-1", "contentSha256": executor.file_digest(self.media)},
                                "trackIndex": 1, "timelineStartFrame": 0, "sourceRange": {"start": 10, "endExclusive": 34}}],
                     "output": {"renderPreset": "h264", "outputPathRef": str(self.root / "output.mp4")}}
        self.seal()
    def tearDown(self): self.temp.cleanup()
    def seal(self):
        self.plan.pop("planSha256", None)
        self.plan["planSha256"] = executor.fingerprint(self.plan)
    def operation(self, phase, target=None):
        step = "asset-1" if phase == "import_media" else "clip-1" if phase == "edit" else phase
        uid = "resolve-operation:" + executor.hashlib.sha256(f"plan:1:{phase}:task-1:{step}".encode()).hexdigest()
        payload = self.plan["clips"][0]["asset"] if phase == "import_media" else self.plan["base"] if phase in ("duplicate_timeline", "create_timeline") else self.plan["clips"][0] if phase == "edit" else self.plan["output"]
        result = {"operationId": uid, "phase": phase, "stepId": step, "taskId": "task-1", "planId": "plan", "planRevision": 1,
                  "executorNodeId": "fixture", "resolveVersion": "21.1.0", "payloadSha256": executor.fingerprint(payload)}
        if target: result.update(timelineUniqueId=target.GetUniqueId(), timelineFingerprint=executor.timeline_fingerprint(target))
        return result
    def request(self, action, op):
        return {"schemaVersion": 1, "requestId": str(uuid.uuid4()), "operationId": op["operationId"], "action": action,
                "planJson": json.dumps(self.plan), "payload": {"operation": op, "expectedProcessIdentity": self.identity}}
    def apply(self, op): return executor.response_for(self.adapter, self.request("apply", op))
    def duplicate(self):
        result = self.apply(self.operation("duplicate_timeline"))
        self.assertEqual(result["status"], "succeeded", result)
        return self.resolve.project.timelines[-1]

    def test_official_timeline_duplicate_and_lost_response_readback(self):
        source = self.resolve.project.timelines[0]
        original = source.DuplicateTimeline
        def lost(name): original(name); raise ConnectionError()
        with patch.object(source, "DuplicateTimeline", lost):
            result = self.apply(self.operation("duplicate_timeline"))
        self.assertEqual(result["status"], "unknown")
        result = self.adapter.handle(self.request("status", self.operation("duplicate_timeline")))
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.apply(self.operation("duplicate_timeline"))["status"], "succeeded")
        self.assertEqual(len(self.resolve.project.timelines), 2)

    def test_new_timeline_does_not_copy_original_content(self):
        source = self.resolve.project.timelines[0]
        source.tracks["video"][0].append(Item(self.resolve.project.pool.media, {"recordFrame": 0, "startFrame": 0, "endFrame": 47}, "original-1"))
        self.plan["base"].pop("timelineUniqueId")
        self.plan["base"].pop("timelineFingerprint")
        self.seal()
        op = self.operation("create_timeline")
        result = self.apply(op)
        self.assertEqual(result["status"], "succeeded", result)
        target = self.resolve.project.timelines[-1]
        self.assertEqual(target.GetEndFrame(), 0)
        self.assertEqual(source.GetEndFrame(), 48)
        self.assertEqual(self.apply(self.operation("edit", target))["status"], "succeeded")
        self.assertEqual(target.GetEndFrame(), 24)
        self.assertEqual(source.GetEndFrame(), 48)

    def test_new_timeline_unknown_is_reconciled_without_second_creation(self):
        self.plan["base"].pop("timelineUniqueId")
        self.plan["base"].pop("timelineFingerprint")
        self.seal()
        op = self.operation("create_timeline")
        original = self.resolve.project.pool.CreateEmptyTimeline
        def lost(name): original(name); raise ConnectionError()
        with patch.object(self.resolve.project.pool, "CreateEmptyTimeline", lost):
            self.assertEqual(self.apply(op)["status"], "unknown")
        self.assertEqual(self.apply(op)["status"], "succeeded")
        target = self.resolve.project.timelines[-1]
        self.assertEqual(self.apply(self.operation("edit", target))["status"], "succeeded")
        self.assertEqual(len(self.resolve.project.timelines), 2)

    def test_append_inclusive_conversion_and_readback_never_replays(self):
        target = self.duplicate()
        op = self.operation("edit", target)
        original = self.resolve.project.pool.AppendToTimeline
        def lost(infos): original(infos); raise ConnectionError()
        with patch.object(self.resolve.project.pool, "AppendToTimeline", lost):
            self.assertEqual(self.apply(op)["status"], "unknown")
        result = self.apply(op)
        self.assertEqual(result["status"], "succeeded", result)
        self.assertEqual(self.resolve.project.pool.writes, 1)
        self.assertEqual(target.tracks["video"][0][0].GetSourceEndFrame(), 33)
        self.assertEqual(target.tracks["video"][0][0].GetDuration(), 24)
        self.assertEqual(self.resolve.project.timelines[0].GetEndFrame(), 0)

    def test_audio_uses_same_append_path(self):
        self.plan["clips"][0].update(mediaType="audio", trackIndex=2, audioGainDb=-18)
        self.seal()
        target = self.duplicate()
        self.assertEqual(self.apply(self.operation("edit", target))["status"], "succeeded")
        self.assertEqual(len(target.tracks["audio"][1]), 1)
        self.assertEqual(target.tracks["audio"][1][0].GetProperties()["AudioVolume"], -18)
        self.assertEqual(target.tracks["video"][0], [])

    def test_import_lost_response_reconciles_and_append_uses_receipt(self):
        asset = self.plan["clips"][0]["asset"]
        asset.pop("resolveMediaPoolItemUniqueId")
        asset["sourcePathRef"] = str(self.media)
        self.seal()
        digest = self.plan["planSha256"]
        self.resolve.project.pool.items = []
        target = self.duplicate()
        op = self.operation("import_media", target)
        original = self.resolve.project.pool.ImportMedia
        def lost(infos): original(infos); raise ConnectionError()
        with patch.object(self.resolve.project.pool, "ImportMedia", lost):
            self.assertEqual(self.apply(op)["status"], "unknown")
        imported = self.apply(op)
        self.assertEqual(imported["status"], "succeeded", imported)
        self.assertEqual(imported["result"]["resolveMediaPoolItemUniqueId"], "media-1")
        self.assertEqual(self.resolve.project.pool.imports, 1)
        self.assertEqual(self.apply(self.operation("edit", target))["status"], "succeeded")
        self.assertNotIn("resolveMediaPoolItemUniqueId", asset)
        self.assertEqual(self.plan["planSha256"], digest)

    def test_import_reuses_unique_existing_path_without_mutating_pool(self):
        self.plan["clips"][0]["asset"]["sourcePathRef"] = str(self.media)
        self.seal()
        target = self.duplicate()
        op = self.operation("import_media", target)
        self.assertEqual(self.apply(op)["status"], "succeeded")
        self.assertEqual(self.resolve.project.pool.imports, 0)
        self.assertEqual(self.adapter.handle(self.request("status", op))["status"], "succeeded")

    def test_source_edit_and_tampered_plan_are_rejected(self):
        source = self.resolve.project.timelines[0]
        result = self.apply(self.operation("edit", source))
        self.assertEqual(result["errorCode"], "resolve_copy_binding_required")
        self.plan["objective"] = "tampered"
        self.assertEqual(self.apply(self.operation("duplicate_timeline"))["errorCode"], "edit_plan_integrity_mismatch")
        self.assertEqual(self.resolve.project.pool.writes, 0)

    def test_changed_source_copy_or_media_does_not_write(self):
        target = self.duplicate()
        op = self.operation("edit", target)
        self.media.write_bytes(b"changed")
        self.assertEqual(self.apply(op)["errorCode"], "resolve_media_content_mismatch")
        self.resolve.project.timelines[0].name = "Changed"
        self.assertEqual(self.apply(op)["errorCode"], "resolve_source_timeline_missing")
        self.assertEqual(self.resolve.project.pool.writes, 0)

    def test_real_process_fence_prevents_stale_writer(self):
        request = self.request("apply", self.operation("duplicate_timeline"))
        self.identity = "fixture:resolve:" + "b" * 64
        result = executor.response_for(self.adapter, request)
        self.assertEqual(result["errorCode"], "resolve_process_identity_changed")
        self.assertEqual(len(self.resolve.project.timelines), 1)

    def test_render_is_async_and_starts_only_owned_job(self):
        target = self.duplicate()
        self.resolve.project.jobs["unrelated"] = {"JobStatus": "Ready"}
        queued = self.apply(self.operation("queue_render", target))
        self.assertEqual(queued["status"], "succeeded", queued)
        self.assertEqual(self.resolve.project.started, [])
        op = self.operation("start_render", target)
        result = self.apply(op)
        self.assertEqual(result["status"], "accepted", result)
        job = result["result"]["jobId"]
        self.assertEqual(self.resolve.project.started, [job])
        self.assertEqual(self.apply(op)["status"], "accepted")
        self.assertEqual(self.resolve.project.started, [job])
        self.resolve.project.jobs[job]["JobStatus"] = "Complete"
        self.assertEqual(self.adapter.handle(self.request("status", op))["status"], "unknown")
        (self.root / "output.mp4").write_bytes(b"render fixture")
        self.assertEqual(self.adapter.handle(self.request("status", op))["status"], "succeeded")
        cancelled = executor.response_for(self.adapter, self.request("cancel", op))
        self.assertEqual(cancelled["errorCode"], "resolve_render_cancel_unsupported")
        self.assertEqual(self.resolve.project.stop_calls, 0)

    def test_queue_lost_response_is_recovered_before_separate_start(self):
        target = self.duplicate()
        op = self.operation("queue_render", target)
        original = self.resolve.project.AddRenderJob
        def lost(): original(); raise ConnectionError()
        with patch.object(self.resolve.project, "AddRenderJob", lost):
            self.assertEqual(self.apply(op)["status"], "unknown")
        self.assertEqual(self.apply(op)["status"], "succeeded")
        self.assertEqual(len(self.resolve.project.jobs), 1)
        self.assertEqual(self.resolve.project.started, [])
        self.assertEqual(self.apply(self.operation("start_render", target))["status"], "accepted")
        self.assertEqual(self.resolve.project.started, ["job-1"])

    def test_unknown_start_that_remains_ready_requires_review_without_replay(self):
        target = self.duplicate()
        self.assertEqual(self.apply(self.operation("queue_render", target))["status"], "succeeded")
        op = self.operation("start_render", target)
        with patch.object(self.resolve.project, "StartRendering", side_effect=ConnectionError()):
            self.assertEqual(self.apply(op)["status"], "unknown")
        result = self.apply(op)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["errorCode"], "resolve_render_start_requires_review")
        self.assertEqual(result["result"]["nextAction"], "review_existing_render_job")
        self.assertEqual(self.resolve.project.started, [])

    def test_unverified_audio_gain_does_not_reappend(self):
        self.plan["clips"][0].update(mediaType="audio", trackIndex=2, audioGainDb=-18)
        self.seal()
        target = self.duplicate()
        op = self.operation("edit", target)
        with patch.object(Item, "SetProperties", return_value=False):
            self.assertEqual(self.apply(op)["status"], "unknown")
        self.assertEqual(self.apply(op)["status"], "unknown")
        self.assertEqual(self.resolve.project.pool.writes, 1)

    def test_unresolved_write_is_never_replayed(self):
        target = self.duplicate()
        op = self.operation("edit", target)
        with patch.object(self.resolve.project.pool, "AppendToTimeline", side_effect=RuntimeError()):
            self.assertEqual(self.apply(op)["status"], "unknown")
        self.assertEqual(self.apply(op)["status"], "unknown")
        self.assertEqual(self.resolve.project.pool.writes, 0)

    def test_subtitles_lost_response_are_reconciled_and_burned_in(self):
        self.plan["output"]["autoSubtitles"] = True
        self.seal()
        target = self.duplicate()
        self.assertEqual(self.apply(self.operation("edit", target))["status"], "succeeded")
        op = self.operation("subtitles", target)
        def generate():
            target.tracks["subtitle"][0].append(Item(None, {"recordFrame": 0, "startFrame": 0, "endFrame": 23}, "subtitle-1"))
            raise ConnectionError()
        with patch.object(target, "CreateSubtitlesFromAudio", generate):
            self.assertEqual(self.apply(op)["status"], "unknown")
        result = self.adapter.handle(self.request("status", op))
        self.assertEqual(result["status"], "succeeded", result)
        self.assertEqual(result["result"]["subtitleCount"], 1)
        self.assertEqual(self.apply(self.operation("queue_render", target))["status"], "succeeded")
        self.assertEqual(self.apply(self.operation("start_render", target))["status"], "accepted")
        self.assertTrue(self.resolve.project.settings["ExportSubtitle"])
        self.assertEqual(self.resolve.project.settings["SubtitleFormat"], "BurnIn")

    def test_media_frame_rate_mismatch_is_rejected_before_append(self):
        target = self.duplicate()
        with patch.object(self.resolve.project.pool.media, "GetClipProperty", return_value={"File Path": str(self.media), "FPS": "30"}):
            result = self.apply(self.operation("edit", target))
        self.assertEqual(result["errorCode"], "resolve_media_frame_rate_mismatch")
        self.assertEqual(self.resolve.project.pool.writes, 0)

    def test_state_permissions_and_symlinks_are_rejected(self):
        path = self.root / "unsafe"
        path.mkdir(mode=0o755)
        with self.assertRaisesRegex(executor.Rejected, "resolve_state_permissions"):
            executor.secure_directory(path)
        link = self.root / "link"
        link.symlink_to(self.adapter.state_dir)
        with self.assertRaisesRegex(executor.Rejected, "resolve_state_symlink"):
            executor.secure_directory(link)

    def test_actual_unix_socket_has_private_permissions_and_same_uid(self):
        process = multiprocessing.get_context("fork").Process(target=executor.serve, args=(self.adapter, self.adapter.state_dir / "executor.sock"))
        process.start()
        sock = self.adapter.state_dir / "executor.sock"
        try:
            deadline = time.monotonic() + 3
            while not sock.exists() and time.monotonic() < deadline: time.sleep(0.02)
            self.assertEqual(sock.stat().st_mode & 0o777, 0o600)
            original_inode = sock.stat().st_ino
            with self.assertRaisesRegex(executor.Rejected, "resolve_executor_already_running"):
                executor.serve(self.adapter, sock)
            self.assertEqual(sock.stat().st_ino, original_inode)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(sock))
                request = self.request("inspect", self.operation("duplicate_timeline"))
                client.sendall((json.dumps(request) + "\n").encode())
                result = json.loads(client.recv(65536))
                self.assertEqual(result["status"], "succeeded")
                self.assertEqual(result["requestId"], request["requestId"])
                self.assertEqual(result["schemaVersion"], 1)
        finally:
            process.terminate()
            process.join(3)


if __name__ == "__main__": unittest.main()

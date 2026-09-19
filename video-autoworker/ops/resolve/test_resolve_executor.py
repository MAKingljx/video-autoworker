import importlib.util
import json
import pathlib
import sys
import types
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("resolve_executor.py")
SPEC = importlib.util.spec_from_file_location("resolve_executor", MODULE_PATH)
assert SPEC and SPEC.loader
executor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(executor)


class FakeTimeline:
    def __init__(self, name, unique_id):
        self.name = name
        self.unique_id = unique_id

    def GetName(self):
        return self.name

    def GetUniqueId(self):
        return self.unique_id

    def GetStartFrame(self):
        return 0

    def GetEndFrame(self):
        return 48


class FakeProject:
    def __init__(self):
        self.timelines = [FakeTimeline("Assembly", "timeline-base")]
        self.current = self.timelines[0]

    def GetUniqueId(self):
        return "project-test"

    def GetName(self):
        return "Test Project"

    def GetCurrentTimeline(self):
        return self.current

    def GetTimelineCount(self):
        return len(self.timelines)

    def GetTimelineByIndex(self, index):
        return self.timelines[index - 1]

    def DuplicateTimeline(self, name):
        timeline = FakeTimeline(name, "timeline-" + str(len(self.timelines)))
        self.timelines.append(timeline)
        return timeline


class FakeProjectManager:
    def __init__(self, project):
        self.project = project

    def GetCurrentProject(self):
        return self.project


class FakeResolve:
    def __init__(self):
        self.project = FakeProject()

    def GetProjectManager(self):
        return FakeProjectManager(self.project)

    def GetVersionString(self):
        return "21.1.0"

    def IsStudio(self):
        return True


class ResolveExecutorTests(unittest.TestCase):
    def setUp(self):
        self.resolve = FakeResolve()
        self.previous = sys.modules.get("DaVinciResolveScript")
        sys.modules["DaVinciResolveScript"] = types.SimpleNamespace(
            scriptapp=lambda name: self.resolve if name == "Resolve" else None,
        )

    def tearDown(self):
        if self.previous is None:
            sys.modules.pop("DaVinciResolveScript", None)
        else:
            sys.modules["DaVinciResolveScript"] = self.previous

    def test_inspect_and_duplicate_are_readable_and_idempotent(self):
        snapshot = executor.inspect()
        self.assertTrue(snapshot["connected"])
        self.assertTrue(snapshot["studio"])
        self.assertEqual(snapshot["projectUniqueId"], "project-test")
        plan = {
            "planId": "plan-test",
            "revision": 1,
            "base": {"projectUniqueId": "project-test", "timelineName": "Assembly"},
        }
        first = executor.duplicate_timeline(plan)
        second = executor.duplicate_timeline(plan)
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["timelineUniqueId"], second["timelineUniqueId"])

    def test_protocol_error_is_json_serializable(self):
        payload = {"status": "failed", "errorCode": "resolve_not_connected"}
        self.assertEqual(json.loads(json.dumps(payload))["errorCode"], "resolve_not_connected")


if __name__ == "__main__":
    unittest.main()

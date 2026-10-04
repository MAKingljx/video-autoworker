"""Focused component-install tests, with macOS lifecycle/production paths mocked."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/install-aiworker-image-service.py"
SPEC = importlib.util.spec_from_file_location("image_service_install", SCRIPT)
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


class ServiceInstallTests(unittest.TestCase):
    def test_application_payload_has_one_service_and_excludes_tests_and_runtime(self):
        payload = install.bundle_payload(install.ROOT)
        self.assertIn("scripts/aiworker-image-service.py", payload)
        self.assertIn("src/image_generation/service.py", payload)
        self.assertIn("openclaw-plugins/aiworker-image-command/index.js", payload)
        self.assertFalse(any(set(Path(name).parts) & {"tests", "test", "__pycache__", "node_modules"} for name in payload))
        self.assertFalse(any("qwen-cover.py" in name for name in payload))

    def test_fixed_loopback_and_shared_backend_do_not_create_second_model_install(self):
        config = install.configuration(Path("/Users/h1"), "b" * 40)
        self.assertEqual((config["listenHost"], config["listenPort"]), ("127.0.0.1", 18095))
        self.assertEqual(config["backend_script"], "/Users/h1/ai-worker/services/qwen-image-edit-2511/aiworker-qwen-cover.py")
        self.assertEqual(config["state_root"], "/Users/h1/ai-worker/state/image-generation/jobs")
        self.assertEqual(config["output_root"], "/Users/h1/ai-worker/output/covers/image-jobs")
        self.assertIn("/Users/h1/.openclaw-image-studio/media", config["reference_roots"])

    def test_new_launchagent_pins_immutable_runtime_and_private_environment(self):
        plist = plistlib.loads(install.service_plist(Path("/Users/h1"), Path("/Users/h1/ai-worker/services/image-generation/releases/" + "b" * 40),
            Path("/Users/h1/ai-worker/state/image-generation/image-service/service.json"), Path("/Users/h1/ai-worker/state/image-generation/image-service/logs")))
        self.assertEqual(plist["Label"], "ai.aiworker.image-generation")
        self.assertIn("/releases/" + "b" * 40, plist["WorkingDirectory"])
        self.assertEqual(plist["EnvironmentVariables"]["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertNotIn("OPENAI_API_KEY", plist["EnvironmentVariables"])
        self.assertEqual(plist["Umask"], 0o077)

    def test_dry_run_success_creates_no_service_database_or_output(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(install.main(fixture.arguments("--dry-run")), 0)
            self.assertFalse((fixture.home / "ai-worker/services/image-generation").exists())
            self.assertFalse((fixture.home / "ai-worker/state/image-generation/jobs").exists())
            self.assertFalse(fixture.bootstraps)

    def test_unknown_existing_database_directory_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            jobs = fixture.home / "ai-worker/state/image-generation/jobs"
            jobs.mkdir()
            data = jobs / "keep-me"
            data.write_text("original")
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(install.contract.InstallError, "new_image_target_must_be_absent"):
                    install.main(fixture.arguments("--apply"))
            self.assertEqual(data.read_text(), "original")
            self.assertFalse(fixture.bootstraps)

    def test_complete_install_reuses_same_artifact_without_restart_or_model_claim(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(install.main(fixture.arguments("--apply")), 0)
                before = (fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json").read_bytes()
                self.assertEqual(install.main(fixture.arguments("--apply")), 0)
            self.assertEqual(len(fixture.bootstraps), 1)
            receipt = json.loads(before)
            self.assertEqual(receipt["currentState"], "SERVICE_HEALTHY")
            self.assertFalse(receipt["modelGenerationValidated"])
            self.assertEqual((fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json").read_bytes(), before)
            self.assertFalse((fixture.home / "ai-worker/state/.image-service-install.lock").exists())

    def test_health_failure_keeps_started_service_and_resume_does_not_bootstrap_twice(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            fixture.fail_health = True
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(install.time, "monotonic", side_effect=[0, 11]):
                    with self.assertRaisesRegex(install.contract.InstallError, "image_service_health_failed"):
                        install.main(fixture.arguments("--apply") + ["--startup-timeout", "10"])
                fixture.fail_health = False
                self.assertEqual(install.main(fixture.arguments("--apply") + ["--resume"]), 0)
            self.assertEqual(len(fixture.bootstraps), 1)

    def test_health_uses_application_integrity_and_real_identity_without_opening_sqlite(self):
        with tempfile.TemporaryDirectory() as task_dir:
            database = Path(task_dir).resolve() / "jobs.sqlite"
            database.write_bytes(b"inspection must not open this as sqlite")
            database.chmod(0o600)
            value = {"currentState": "READY", "sourceCommit": "b" * 40, "concurrency": 1,
                "databaseIntegrity": "ok", "databaseIdentity": {"device": database.stat().st_dev, "inode": database.stat().st_ino}, "counts": {}}
            class Response:
                status = 200
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, *args): return json.dumps(value).encode()
            with patch.object(install, "build_opener") as opener, patch.object(install, "listener_pids", return_value=[123]), \
                 patch.object(install, "launch_pid", return_value=123):
                opener.return_value.open.return_value = Response()
                self.assertEqual(install.health("b" * 40, database)["databaseIntegrity"], "ok")
                value["databaseIntegrity"] = "failed"
                with self.assertRaisesRegex(install.contract.InstallError, "image_database_integrity_failed"):
                    install.health("b" * 40, database)

    def test_owned_unvalidated_replacement_preserves_database_output_and_old_release(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            fixture.fail_health = True
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(install.time, "monotonic", side_effect=[0, 11]):
                    with self.assertRaises(install.contract.InstallError):
                        install.main(fixture.arguments("--apply") + ["--startup-timeout", "10"])
                fixture.fail_health = False
                database = fixture.home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
                identity = (database.stat().st_dev, database.stat().st_ino)
                new_args = fixture.arguments("--apply", commit="d" * 40) + ["--replace-owned-unvalidated", "--previous-source-commit", "b" * 40]
                self.assertEqual(install.main(new_args), 0)
            self.assertEqual((database.stat().st_dev, database.stat().st_ino), identity)
            self.assertTrue((fixture.home / ("ai-worker/services/image-generation/releases/" + "b" * 40)).exists())
            self.assertTrue((fixture.home / ("ai-worker/services/image-generation/releases/" + "d" * 40)).exists())
            self.assertEqual(len(fixture.bootouts), 1)
            receipt = json.loads((fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json").read_bytes())
            self.assertEqual(receipt["sourceCommit"], "d" * 40)
            self.assertEqual(receipt["currentState"], "SERVICE_HEALTHY")
            self.assertFalse(receipt["modelGenerationValidated"])
            self.assertTrue(Path(receipt["recoveryBackup"]).is_dir())

    def test_healthy_or_nonempty_application_cannot_use_unvalidated_replacement(self):
        for state, counts, expected in [("SERVICE_HEALTHY", {}, "previous_owned_unvalidated_receipt_required"),
                                        ("SERVICE_STARTED", {"SUCCEEDED": 1}, "owned_unvalidated_service_has_jobs")]:
            with self.subTest(state=state), tempfile.TemporaryDirectory() as task_dir:
                fixture = Fixture(Path(task_dir).resolve())
                with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                    install.main(fixture.arguments("--apply"))
                    receipt_path = fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json"
                    receipt = json.loads(receipt_path.read_bytes())
                    receipt["currentState"] = state
                    receipt_path.write_bytes(install.contract.encoded(receipt))
                    fixture.counts = counts
                    with self.assertRaisesRegex(install.contract.InstallError, expected):
                        install.main(fixture.arguments("--apply", commit="d" * 40) + ["--replace-owned-unvalidated", "--previous-source-commit", "b" * 40])
                self.assertFalse(fixture.bootouts)


class Fixture:
    def __init__(self, home):
        self.home, self.bootstraps, self.bootouts, self.pid, self.fail_health, self.counts = home, [], [], None, False, {}
        for directory in [home / "ai-worker/services", home / "ai-worker/state/image-generation",
                          home / "ai-worker/output/covers", home / "Library/LaunchAgents"]:
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.backend_sha = install.contract.sha((install.ROOT / "scripts/aiworker-qwen-cover.py").read_bytes())

    def arguments(self, mode, *, commit="b" * 40):
        return [mode, "--source-commit", commit, "--backend-script-sha256", self.backend_sha,
                "--profiles-sha256", "c" * 64]

    @contextlib.contextmanager
    def patches(self):
        with patch.object(install.Path, "home", return_value=self.home), \
             patch.object(install.platform, "system", return_value="Darwin"), \
             patch.object(install.contract, "source_identity", side_effect=lambda source, plugin, commit, **kwargs: {"mode": "canonical_git", "sourceCommit": commit}), \
             patch.object(install, "validate_backend", return_value={"python": "3.12.13", "pillow": "12.2.0"}), \
             patch.object(install, "listener_pids", side_effect=lambda: [] if self.pid is None else [self.pid]), \
             patch.object(install, "launch_pid", side_effect=lambda: self.pid), \
             patch.object(install.contract, "run", side_effect=self.run), \
             patch.object(install, "health", side_effect=self.health), patch.object(install.os, "kill", side_effect=ProcessLookupError):
            yield

    def run(self, command, env, **kwargs):
        if "bootout" in command:
            self.bootouts.append(command)
            self.pid = None
            return subprocess.CompletedProcess(command, 0, "", "")
        self.bootstraps.append(command)
        self.pid = 123
        database = self.home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
        with contextlib.closing(sqlite3.connect(database)) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS test_identity(value TEXT)")
            connection.commit()
        database.chmod(0o600)
        return subprocess.CompletedProcess(command, 0, "", "")

    def health(self, commit, database, **kwargs):
        if self.fail_health:
            raise OSError("unavailable")
        return {"currentState": "READY", "sourceCommit": commit, "databaseIntegrity": "ok", "counts": self.counts,
            "databaseIdentity": {"device": database.stat().st_dev, "inode": database.stat().st_ino}, "listenerPids": [self.pid]}


if __name__ == "__main__":
    unittest.main()

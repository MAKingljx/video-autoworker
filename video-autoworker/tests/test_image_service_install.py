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

    def test_private_routing_marker_is_rejected_from_final_bundle_members(self):
        with tempfile.TemporaryDirectory() as task_dir:
            root = Path(task_dir).resolve()
            for directory in [root / "scripts", root / "src/image_generation", root / "openclaw-plugins/aiworker-image-command"]:
                directory.mkdir(parents=True, exist_ok=True)
            (root / "scripts/aiworker-image-service.py").write_text("# isolated packaging fixture")
            (root / "src/image_generation/service.py").write_text("# fixture")
            (root / "src/image_generation/__init__.py").write_text("")
            (root / "openclaw-plugins/aiworker-image-command/index.js").write_text("export default {}")
            (root / "src/image_generation/.PhoenixBrain").write_text("private isolated negative fixture")
            with self.assertRaisesRegex(install.contract.InstallError, "bundle_private_member_rejected"):
                install.bundle_payload(root)

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

    def test_healthy_upgrade_preserves_historical_rows_database_and_output(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"))
                fixture.add_history()
                database = fixture.home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
                identity = (database.stat().st_dev, database.stat().st_ino)
                before = install.database_summary(database)
                output = fixture.home / "ai-worker/output/covers/image-jobs" / "keep.png"
                output.write_bytes(b"original generated output")
                args = fixture.arguments("--apply", commit="d" * 40) + ["--upgrade-existing", "--previous-source-commit", "b" * 40]
                self.assertEqual(install.main(args), 0)
                self.assertEqual(install.main(args), 0)
            self.assertEqual((database.stat().st_dev, database.stat().st_ino), identity)
            self.assertEqual(install.database_summary(database), before)
            self.assertEqual(output.read_bytes(), b"original generated output")
            self.assertEqual((len(fixture.bootouts), len(fixture.bootstraps)), (1, 2))
            receipt = json.loads((fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json").read_bytes())
            self.assertEqual(receipt["sourceCommit"], "d" * 40)
            self.assertFalse(receipt["modelGenerationValidated"])
            recovery = Path(receipt["recoveryBackup"])
            saved = install.verify_recovery_backup(recovery, require_database=True)
            self.assertEqual(saved["databaseSummary"], before)
            self.assertEqual(install.database_summary(recovery / "jobs.sqlite", check_integrity=True), before)
            self.assertTrue((fixture.home / ("ai-worker/services/image-generation/releases/" + "b" * 40)).is_dir())

    def test_healthy_upgrade_dry_run_with_history_has_no_write_or_restart(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                self.assertEqual(install.main(fixture.arguments("--dry-run", commit="d" * 40)
                    + ["--upgrade-existing", "--previous-source-commit", "b" * 40]), 0)
            self.assertFalse(fixture.bootouts)
            self.assertFalse((fixture.home / "ai-worker/backups/image-service-install").exists())
            self.assertFalse((fixture.home / ("ai-worker/services/image-generation/releases/" + "d" * 40)).exists())

    def test_active_job_blocks_upgrade_before_backup_or_stop(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history("QUEUED")
                with self.assertRaisesRegex(install.contract.InstallError, "active_jobs_require_drain"):
                    install.main(fixture.arguments("--apply", commit="d" * 40)
                        + ["--upgrade-existing", "--previous-source-commit", "b" * 40])
            self.assertFalse(fixture.bootouts)
            self.assertFalse((fixture.home / "ai-worker/backups/image-service-install").exists())
            self.assertEqual(fixture.pid, 123)

    def test_upgrade_partial_file_swap_resumes_same_operation_and_recovery(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            args = fixture.arguments("--apply", commit="d" * 40) + ["--upgrade-existing", "--previous-source-commit", "b" * 40]
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                original = install.replace_owned_file
                def fail_plist(path, old, new):
                    if path.suffix == ".plist":
                        raise install.contract.InstallError("simulated_plist_replace_failed")
                    return original(path, old, new)
                with patch.object(install, "replace_owned_file", side_effect=fail_plist):
                    with self.assertRaisesRegex(install.contract.InstallError, "simulated_plist"):
                        install.main(args)
                operation_file = fixture.home / ("ai-worker/state/image-generation/image-service/upgrade-" + "d" * 40 + ".json")
                failed = json.loads(operation_file.read_bytes())
                self.assertEqual(failed["currentState"], "RECOVERY_VERIFIED")
                backup = failed["backup"]
                self.assertIsNone(fixture.pid)
                self.assertEqual(install.main(args + ["--resume"]), 0)
                complete = json.loads(operation_file.read_bytes())
            self.assertEqual(complete["backup"], backup)
            self.assertEqual(complete["currentState"], "UPGRADE_HEALTHY")
            self.assertEqual((len(fixture.bootouts), len(fixture.bootstraps)), (1, 2))
            self.assertEqual(len(list((fixture.home / "ai-worker/backups/image-service-install").iterdir())), 1)

    def test_upgrade_health_failure_resumes_without_second_bootstrap(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            args = fixture.arguments("--apply", commit="d" * 40) + ["--upgrade-existing", "--previous-source-commit", "b" * 40]
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                fixture.fail_health_commit = "d" * 40
                with patch.object(install.time, "monotonic", side_effect=[0, 0, 11]):
                    with self.assertRaisesRegex(install.contract.InstallError, "image_service_health_failed"):
                        install.main(args + ["--startup-timeout", "10"])
                fixture.fail_health_commit = None
                self.assertEqual(install.main(args + ["--resume"]), 0)
            self.assertEqual((len(fixture.bootouts), len(fixture.bootstraps)), (1, 2))

    def test_recovery_rejects_tampered_database_and_keeps_valid_previous_versions(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                install.main(fixture.arguments("--apply", commit="d" * 40)
                    + ["--upgrade-existing", "--previous-source-commit", "b" * 40])
            receipt = json.loads((fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json").read_bytes())
            backup = Path(receipt["recoveryBackup"])
            with (backup / "jobs.sqlite").open("ab") as f:f.write(b"tampered")
            with self.assertRaisesRegex(install.contract.InstallError, "owned_recovery_drift"):
                install.verify_recovery_backup(backup, require_database=True)
            self.assertTrue((fixture.home / "ai-worker/state/image-generation/jobs/jobs.sqlite").exists())

    def test_loaded_release_binding_must_match_program_and_working_directory(self):
        home = Path("/Users/h1")
        release = home / "ai-worker/services/image-generation/releases" / ("b" * 40)
        config = home / "ai-worker/state/image-generation/image-service/service.json"
        output = f"arguments = {{\n {release}/scripts/aiworker-image-service.py\n --config\n {config}\n}}\nworking directory = {release}\n"
        with patch.object(install.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output, "")):
            install.verify_live_binding(home, "b" * 40)
        with patch.object(install.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output.replace("working directory =", "unrelated ="), "")):
            with self.assertRaisesRegex(install.contract.InstallError, "loaded_release_binding_mismatch"):
                install.verify_live_binding(home, "b" * 40)

    def test_upgrade_reuses_pending_recovery_after_interrupted_database_copy(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            args = fixture.arguments("--apply", commit="d" * 40) + ["--upgrade-existing", "--previous-source-commit", "b" * 40]
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                def interrupted(backup, database, summary):
                    partial = backup / "jobs.sqlite"
                    partial.write_bytes(b"incomplete owned copy")
                    partial.chmod(0o600)
                    raise install.contract.InstallError("simulated_database_copy_interrupted")
                with patch.object(install, "finish_database_backup", side_effect=interrupted):
                    with self.assertRaisesRegex(install.contract.InstallError, "simulated_database"):
                        install.main(args)
                operation_file = fixture.home / ("ai-worker/state/image-generation/image-service/upgrade-" + "d" * 40 + ".json")
                failed = json.loads(operation_file.read_bytes())
                self.assertEqual(failed["currentState"], "OWNED_SERVICE_STOPPED")
                self.assertEqual(install.main(args + ["--resume"]), 0)
                backup = Path(json.loads(operation_file.read_bytes())["backup"])
            self.assertEqual((len(fixture.bootouts), len(fixture.bootstraps)), (1, 2))
            self.assertEqual(install.verify_recovery_backup(backup, require_database=True)["databaseSummary"]["rows"], 1)

    def test_only_two_verified_recovery_versions_retained_after_later_upgrades(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                previous = "b" * 40
                for current in ["d" * 40, "e" * 40, "f" * 40]:
                    install.main(fixture.arguments("--apply", commit=current)
                        + ["--upgrade-existing", "--previous-source-commit", previous])
                    previous = current
            backups = list((fixture.home / "ai-worker/backups/image-service-install").iterdir())
            self.assertEqual(len(backups), 2)
            self.assertEqual({install.verify_recovery_backup(p, require_database=True)["previousSourceCommit"] for p in backups},
                             {"d" * 40, "e" * 40})

    def test_data_accepted_during_stop_is_not_erased_or_silently_restored(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = Fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"));fixture.add_history()
                normal_run = fixture.run
                def race(command, env, **kwargs):
                    if "bootout" in command:
                        database = fixture.home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
                        with contextlib.closing(sqlite3.connect(database)) as db:
                            db.execute("INSERT INTO image_jobs VALUES(?,?,?)", ("2" * 32, "QUEUED", "new user task"))
                            db.commit()
                    return normal_run(command, env, **kwargs)
                with patch.object(install.contract, "run", side_effect=race):
                    with self.assertRaisesRegex(install.contract.InstallError, "active_jobs_require_drain"):
                        install.main(fixture.arguments("--apply", commit="d" * 40)
                            + ["--upgrade-existing", "--previous-source-commit", "b" * 40])
            database = fixture.home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
            self.assertEqual(install.database_summary(database)["counts"], {"GENERATED_PENDING_REVIEW": 1, "QUEUED": 1})
            receipt = json.loads((fixture.home / "ai-worker/state/image-generation/image-service/install-receipt.json").read_bytes())
            self.assertEqual(receipt["sourceCommit"], "b" * 40)
            self.assertEqual(len(fixture.bootstraps), 1)


class Fixture:
    def __init__(self, home):
        self.home, self.bootstraps, self.bootouts, self.pid, self.fail_health, self.counts = home, [], [], None, False, {}
        self.fail_health_commit = None
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
             patch.object(install, "verify_live_binding"), \
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
            connection.execute("CREATE TABLE IF NOT EXISTS image_jobs(job_id TEXT PRIMARY KEY,state TEXT,content TEXT)")
            connection.commit()
        database.chmod(0o600)
        return subprocess.CompletedProcess(command, 0, "", "")

    def health(self, commit, database, **kwargs):
        if self.fail_health or self.fail_health_commit == commit:
            raise OSError("unavailable")
        return {"currentState": "READY", "sourceCommit": commit, "databaseIntegrity": "ok", "counts": self.counts,
            "databaseIdentity": {"device": database.stat().st_dev, "inode": database.stat().st_ino}, "listenerPids": [self.pid]}

    def add_history(self, state="GENERATED_PENDING_REVIEW"):
        database = self.home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
        with contextlib.closing(sqlite3.connect(database)) as connection:
            connection.execute("INSERT INTO image_jobs VALUES(?,?,?)", ("1" * 32, state, "private historical payload"))
            connection.commit()
        self.counts = {state: 1}


if __name__ == "__main__":
    unittest.main()

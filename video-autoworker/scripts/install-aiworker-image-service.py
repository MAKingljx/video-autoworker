#!/usr/bin/env python3
"""Install the independent image application component from its canonical commit.

Existing model Python/weights/CLI are verified and reused, never installed or
rewritten here. Only this new service's paths and LaunchAgent may be created.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("image_install_contract", ROOT / "scripts/install-openclaw-image-studio.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
LABEL = "ai.aiworker.image-generation"
SCHEMA = "aiworker-image-service-install/v1"


def bundle_payload(root: Path) -> dict[str, bytes]:
    files = {"scripts/aiworker-image-service.py": (root / "scripts/aiworker-image-service.py").read_bytes()}
    for directory in (root / "src/image_generation", root / "openclaw-plugins/aiworker-image-command"):
        for member in sorted(directory.rglob("*")):
            contract.safe_path(member)
            parts = member.relative_to(directory).parts
            contract.require(not any(part in {".PhoenixBrain", ".git"} for part in parts), "bundle_private_member_rejected")
            if any(part in {"test", "tests", "__pycache__", "node_modules"} for part in parts):
                continue
            if member.is_file():
                contract.require(member.stat().st_mode & 0o022 == 0 and member.stat().st_uid == os.getuid(), "bundle_member_mode_invalid")
                files[member.relative_to(root).as_posix()] = member.read_bytes()
    contract.require("src/image_generation/service.py" in files and "src/image_generation/__init__.py" in files
                     and "openclaw-plugins/aiworker-image-command/index.js" in files, "bundle_dependency_missing")
    if "src/image_generation/protected_cover.py" in files:
        ocr = root / "scripts/aiworker-image-ocr.swift"
        contract.safe_path(ocr, file=True)
        contract.require(ocr.stat().st_uid == os.getuid() and ocr.stat().st_mode & 0o022 == 0,
                         "bundle_member_mode_invalid")
        files["scripts/aiworker-image-ocr.swift"] = ocr.read_bytes()
        contract.require(all(name in files for name in ("src/image_generation/protected_worker.py",
            "src/image_generation/stage_cache.py", "src/image_generation/ocr.py")), "protected_bundle_dependency_missing")
    return files


def configuration(home: Path, commit: str) -> dict:
    value = json.loads((ROOT / "ops/image-generation/service/service.template.json").read_bytes())
    service = home / "ai-worker/services/qwen-image-edit-2511"
    value.update({"state_root": str(home / "ai-worker/state/image-generation/jobs"),
        "output_root": str(home / "ai-worker/output/covers/image-jobs"),
        "reference_roots": [str(home / "ai-worker/output/covers"), str(home / ".openclaw-image-studio/media")],
        "backend_script": str(service / "aiworker-qwen-cover.py"), "backend_python": str(service / "venv/bin/python"),
        "profiles_file": str(service / "cover-design-profiles.json"), "source_commit": commit})
    return value


def service_plist(home: Path, release: Path, config_file: Path, logs: Path) -> bytes:
    python = home / "ai-worker/services/qwen-image-edit-2511/venv/bin/python"
    return plistlib.dumps({"Label": LABEL,
        "ProgramArguments": [str(python), str(release / "scripts/aiworker-image-service.py"), "--config", str(config_file)],
        "WorkingDirectory": str(release), "RunAtLoad": True, "KeepAlive": True,
        "ThrottleInterval": 10, "Umask": 0o077,
        "StandardOutPath": str(logs / "service.log"), "StandardErrorPath": str(logs / "service-error.log"),
        "EnvironmentVariables": {"HOME": str(home), "PATH": f"{python.parent}:/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}})


def validate_backend(config: dict, script_sha: str, profiles_sha: str) -> dict:
    script, profiles, python = (Path(config[key]) for key in ("backend_script", "profiles_file", "backend_python"))
    contract.safe_path(script, file=True)
    contract.safe_path(profiles, file=True)
    contract.require(contract.sha(script.read_bytes()) == script_sha and contract.sha(profiles.read_bytes()) == profiles_sha,
                     "existing_backend_digest_mismatch")
    contract.require(python.is_file() and os.access(python, os.X_OK), "existing_backend_python_missing")
    # The managed venv's python may be a symlink to its verified shared runtime.
    actual_python = contract.safe_path(python.resolve(strict=True), file=True)
    contract.require(actual_python.stat().st_mode & 0o022 == 0, "backend_python_target_mode_invalid")
    env = {"HOME": str(Path.home()), "PATH": f"{python.parent}:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
    result = contract.run([str(python), str(script), "generate", "--help"], env)
    contract.require("--wait-for-model" in result.stdout, "shared_model_lock_cli_required")
    result = contract.run([str(python), "-c", "import sys,PIL;print(sys.version.split()[0]);print(PIL.__version__)"], env)
    values = result.stdout.strip().splitlines()
    contract.require(len(values) == 2 and all(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", v) for v in values), "backend_runtime_probe_invalid")
    result = contract.run([str(python), "-c", "import numpy;print(numpy.__version__)"], env)
    numpy_version = result.stdout.strip()
    contract.require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", numpy_version) is not None,
                     "protected_numpy_runtime_probe_invalid")
    contract.require(Path("/usr/bin/swift").is_file() and os.access("/usr/bin/swift", os.X_OK)
        and Path("/System/Library/Frameworks/Vision.framework").is_dir(), "protected_native_ocr_runtime_missing")
    return {"python": values[0], "pillow": values[1], "pythonBinarySha256": contract.sha(actual_python.read_bytes()),
            "backendScriptSha256": script_sha, "profilesSha256": profiles_sha, "numpy": numpy_version}


def listener_pids() -> list[int]:
    result = subprocess.run(["/usr/sbin/lsof", "-nP", "-tiTCP:18095", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=15)
    contract.require(result.returncode in {0, 1} and not result.stderr.strip(), "image_listener_probe_failed")
    contract.require(all(value.isdecimal() for value in result.stdout.split()), "image_listener_probe_invalid")
    return [int(value) for value in result.stdout.split()]


def launch_pid() -> int | None:
    result = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        contract.require("Could not find service" in result.stderr or "Could not find specified service" in result.stderr,
                         "image_launchagent_query_failed")
        return None
    match = re.search(r"^\s*pid = ([0-9]+)\s*$", result.stdout, re.MULTILINE)
    return int(match.group(1)) if match else 0


def create_private_tree(path: Path) -> None:
    contract.safe_path(path)
    missing = []
    member = path
    while not member.exists():
        missing.append(member)
        member = member.parent
    for member in reversed(missing):
        member.mkdir(mode=0o700)


def health(commit: str, database: Path, *, require_integrity: bool = True) -> dict:
    opener = build_opener(ProxyHandler({}))
    with opener.open("http://127.0.0.1:18095/healthz", timeout=5) as result:
        contract.require(result.status == 200, "image_health_unavailable")
        value = json.loads(result.read(8192))
    contract.require(value.get("currentState") == "READY" and value.get("sourceCommit") == commit
                     and value.get("concurrency") == 1, "image_health_identity_mismatch")
    contract.safe_path(database, file=True)
    contract.require(database.stat().st_uid == os.getuid() and database.stat().st_mode & 0o077 == 0,
                     "private_database_required")
    identity = {"device": database.stat().st_dev, "inode": database.stat().st_ino}
    contract.require(value.get("databaseIdentity") == identity, "image_database_identity_mismatch")
    # SQLite integrity belongs to the application's own shared connection. A
    # second mode=ro connection can fail on a cold WAL without -wal/-shm files.
    if require_integrity:
        contract.require(value.get("databaseIntegrity") == "ok", "image_database_integrity_failed")
    value["listenerPids"] = listener_pids()
    contract.require(len(value["listenerPids"]) == 1 and value["listenerPids"][0] == launch_pid(), "image_listener_not_owned_launchagent")
    return value


def check_zero_jobs(value: dict) -> None:
    counts = value.get("counts")
    contract.require(isinstance(counts, dict) and all(type(count) is int and count == 0 for count in counts.values()),
                     "owned_unvalidated_service_has_jobs")


def previous_artifact(home: Path, previous: str, receipt: dict, runtime: dict) -> dict:
    old_runtime = receipt.get("runtime")
    contract.require(receipt.get("schema") == SCHEMA and receipt.get("sourceCommit") == previous
        and receipt.get("sourceEvidence", {}).get("sourceCommit") == previous
        and receipt.get("sourceEvidence", {}).get("mode") == "canonical_git"
        and isinstance(old_runtime, dict) and old_runtime and set(old_runtime) <= set(runtime)
        and all(runtime[key] == value for key, value in old_runtime.items()), "previous_owned_receipt_identity_invalid")
    release = home / "ai-worker/services/image-generation/releases" / previous
    manifest_raw = contract.private_file(release / "manifest.json")
    manifest = json.loads(manifest_raw)
    contract.require(manifest.get("schema") == "aiworker-image-service-artifact/v1"
        and manifest.get("sourceCommit") == previous and manifest.get("sourceRepository") == contract.SOURCE_REPOSITORY
        and contract.sha(manifest_raw) == receipt.get("artifactSha256") and isinstance(manifest.get("files"), dict),
        "previous_artifact_manifest_invalid")
    inventory = contract.bounded_files(release)
    contract.require(inventory == {**manifest["files"], "manifest.json": contract.sha(manifest_raw)}, "previous_artifact_drift")
    config_file = home / "ai-worker/state/image-generation/image-service/service.json"
    expected_config = contract.encoded(configuration(home, previous))
    expected_plist = service_plist(home, release, config_file, config_file.parent / "logs")
    contract.require(contract.sha(expected_config) == receipt.get("configSha256")
        and contract.sha(expected_plist) == receipt.get("launchAgentSha256"), "previous_owned_receipt_digest_invalid")
    return {"config": expected_config, "plist": expected_plist, "receipt": contract.encoded(receipt)}


def verify_previous_installation(home: Path, previous: str, receipt: dict, config_file: Path,
                                plist: Path, runtime: dict, database: Path, *, allow_history: bool = False) -> dict:
    if allow_history:
        contract.require(receipt.get("currentState") == "SERVICE_HEALTHY"
            and type(receipt.get("modelGenerationValidated")) is bool, "previous_healthy_image_service_required")
    else:
        contract.require(receipt.get("currentState") in {"PAYLOAD_PREPARED", "SERVICE_STARTED"}
            and receipt.get("modelGenerationValidated") is False, "previous_owned_unvalidated_receipt_required")
    expected = previous_artifact(home, previous, receipt, runtime)
    expected_config, expected_plist = expected["config"], expected["plist"]
    contract.require(contract.private_file(config_file) == expected_config
        and contract.sha(expected_config) == receipt.get("configSha256")
        and contract.private_file(plist) == expected_plist and contract.sha(expected_plist) == receipt.get("launchAgentSha256"),
        "previous_owned_config_or_plist_drift")
    pid = launch_pid()
    if pid is None:
        contract.require(receipt["currentState"] == "PAYLOAD_PREPARED" and not listener_pids()
            and not database.exists(), "previous_service_state_unknown")
        current = {"counts": {}, "databaseIdentity": None, "listenerPids": []}
    else:
        contract.require(pid > 0, "previous_service_pid_unknown")
        current = health(previous, database, require_integrity=False)
        contract.require(current["listenerPids"] == [pid], "previous_service_listener_drift")
    if allow_history:
        check_no_active_jobs(current)
        verify_live_binding(home, previous)
        snapshot = database_summary(database)
        contract.require(snapshot["counts"] == current["counts"], "image_database_health_snapshot_changed")
        contract.require(receipt.get("databaseIdentity") == current["databaseIdentity"], "previous_database_identity_drift")
        expected["databaseSummary"] = snapshot
    else:
        check_zero_jobs(current)
    return {"pid": pid, "health": current, **expected}


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_recovery_backup(directory: Path, *, require_database: bool = False) -> dict:
    contract.safe_path(directory, file=False)
    saved = json.loads(contract.private_file(directory / "manifest.json"))
    required = {"service.json", "install-receipt.json", "launch-agent.plist"}
    contract.require(isinstance(saved, dict) and isinstance(saved.get("files"), dict), "owned_recovery_manifest_invalid")
    members = set(saved.get("files", {}))
    contract.require(saved.get("schema") == "aiworker-image-service-recovery/v1"
        and required <= members <= required | {"jobs.sqlite"}, "owned_recovery_manifest_invalid")
    actual = {member.name for member in directory.iterdir()}
    permitted = members | {"manifest.json"}
    if saved.get("databasePending") is True:
        permitted.add("jobs.sqlite")
    contract.require(actual <= permitted and members | {"manifest.json"} <= actual, "owned_recovery_drift")
    for name in actual:
        path = contract.safe_path(directory / name, file=True)
        contract.require(path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o077 == 0,
                         "owned_recovery_member_not_private")
    for name, digest in saved["files"].items():
        path = directory / name
        contract.private_file(path) if name != "jobs.sqlite" else contract.safe_path(path, file=True)
        contract.require(path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o077 == 0
            and file_digest(path) == digest, "owned_recovery_drift")
    if require_database:
        contract.require("jobs.sqlite" in members and saved.get("databasePending") is not True,
                         "image_recovery_database_incomplete")
        contract.require(database_summary(directory / "jobs.sqlite", check_integrity=True) == saved.get("databaseSummary"),
                         "image_recovery_database_invalid")
    return saved


def prune_recovery_backups(root: Path) -> None:
    histories = sorted(root.iterdir(), key=lambda member: member.name)
    for directory in histories:
        saved = verify_recovery_backup(directory)
        contract.require(saved.get("databasePending") is not True, "image_recovery_pending_review_required")
        if "jobs.sqlite" in saved["files"]:
            verify_recovery_backup(directory, require_database=True)
    for directory in histories[:-2]:
        shutil.rmtree(directory)


def backup_owned_installation(home: Path, previous: str, current: str, before: dict, *, pending_database: bool = False) -> Path:
    root = home / "ai-worker/backups/image-service-install"
    create_private_tree(root)
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    backup = root / f"{stamp}-{time.time_ns()}-{previous[:12]}"
    backup.mkdir(mode=0o700)
    files = {"service.json": before["config"], "install-receipt.json": before["receipt"], "launch-agent.plist": before["plist"]}
    for name, raw in files.items():
        contract.create_file(backup / name, raw)
    manifest = {"schema": "aiworker-image-service-recovery/v1", "previousSourceCommit": previous,
        "replacementSourceCommit": current, "files": {name: contract.sha(raw) for name, raw in files.items()}}
    if pending_database:
        manifest["databasePending"] = True
    contract.create_file(backup / "manifest.json", contract.encoded(manifest))
    verify_recovery_backup(backup)
    # Keep the two newest fully verified recovery objects. Original release/DB
    # and all output remain untouched and are never included in these copies.
    if not pending_database:
        prune_recovery_backups(root)
    return backup


def replace_owned_file(path: Path, expected: bytes, replacement: bytes) -> None:
    contract.require(contract.private_file(path) == expected, "owned_replace_cas_failed")
    temporary = path.parent / f".{path.name}.image-replace-{os.getpid()}"
    contract.create_file(temporary, replacement)
    contract.require(contract.private_file(path) == expected, "owned_replace_cas_failed")
    os.replace(temporary, path)
    contract.require(contract.private_file(path) == replacement, "owned_replace_readback_failed")


def wait_owned_stopped(pid: int | None, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while True:
        alive = False
        if pid:
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                pass
        if launch_pid() is None and not listener_pids() and not alive:
            return
        contract.require(time.monotonic() < deadline, "owned_service_stop_not_confirmed")
        time.sleep(0.2)


def check_no_active_jobs(value: dict) -> None:
    counts = value.get("counts")
    allowed = {"QUEUED", "RUNNING", "CANCEL_REQUESTED", "GENERATED_PENDING_REVIEW",
               "FAILED", "CANCELLED", "RECONCILE_REQUIRED"}
    contract.require(isinstance(counts, dict) and set(counts) <= allowed
        and all(type(count) is int and count >= 0 for count in counts.values()), "image_history_counts_invalid")
    contract.require(not any(counts.get(key, 0) for key in ("QUEUED", "RUNNING", "CANCEL_REQUESTED")),
                     "image_service_active_jobs_require_drain")


def verify_live_binding(home: Path, commit: str) -> None:
    """The loaded LaunchAgent, not just the plist on disk, must run this release."""
    release = home / "ai-worker/services/image-generation/releases" / commit
    config = home / "ai-worker/state/image-generation/image-service/service.json"
    loaded = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
                            capture_output=True, text=True, timeout=15)
    contract.require(loaded.returncode == 0 and str(release / "scripts/aiworker-image-service.py") in loaded.stdout
        and str(config) in loaded.stdout
        and re.search(r"(?m)^\s*working directory = " + re.escape(str(release)) + r"\s*$", loaded.stdout),
        "image_loaded_release_binding_mismatch")


def database_summary(database: Path, *, check_integrity: bool = False) -> dict:
    """Read-only semantic fingerprint; it contains no prompts or row contents."""
    contract.private_file(database) if database.stat().st_size < 4096 else contract.safe_path(database, file=True)
    contract.require(database.stat().st_uid == os.getuid() and database.stat().st_mode & 0o077 == 0,
                     "private_database_required")
    before = database.stat()
    with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        if check_integrity:
            contract.require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok", "image_recovery_database_integrity_failed")
        schema = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        contract.require(any(row[0] == "image_jobs" for row in schema), "image_database_contract_missing")
        counts = dict(db.execute("SELECT state,count(*) FROM image_jobs GROUP BY state").fetchall())
        digest = hashlib.sha256()
        row_count = 0
        for row in db.execute("SELECT * FROM image_jobs ORDER BY job_id"):
            digest.update(contract.encoded(list(row)))
            row_count += 1
    after = database.stat()
    contract.require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
        (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "image_database_changed_during_snapshot")
    return {"schemaSha256": contract.sha(contract.encoded(schema)), "rows": row_count,
            "rowsSha256": digest.hexdigest(), "counts": counts}


def finish_database_backup(backup: Path, database: Path, expected_summary: dict) -> None:
    manifest_path = backup / "manifest.json"
    saved = verify_recovery_backup(backup)
    if saved.get("databasePending") is not True:
        verify_recovery_backup(backup, require_database=True)
        contract.require(saved.get("databaseSummary") == expected_summary, "image_recovery_database_changed")
        return
    contract.require(database_summary(database) == expected_summary, "image_database_changed_before_backup")
    target = backup / "jobs.sqlite"
    if target.exists():
        try:
            complete = database_summary(target, check_integrity=True) == expected_summary
        except (OSError, ValueError, sqlite3.Error, contract.InstallError):
            complete = False
        if not complete:
            # This exact private file is an unverified copy owned by the
            # pending operation; the live DB and older recovery sets remain.
            contract.safe_path(target, file=True)
            contract.require(target.stat().st_uid == os.getuid() and target.stat().st_mode & 0o077 == 0,
                             "image_pending_backup_not_owned")
            target.unlink()
    if not target.exists():
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, \
             contextlib.closing(sqlite3.connect(target)) as destination:
            source.execute("PRAGMA query_only=ON")
            source.backup(destination)
            destination.commit()
            # A recovery file is standalone, never dependent on missing WAL.
            destination.execute("PRAGMA journal_mode=DELETE")
            destination.commit()
        with target.open("rb") as f:
            os.fsync(f.fileno())
    contract.require(database_summary(database) == expected_summary
        and database_summary(target, check_integrity=True) == expected_summary, "image_database_backup_readback_failed")
    updated = {**saved, "databasePending": False, "databaseSummary": expected_summary,
               "files": {**saved["files"], "jobs.sqlite": file_digest(target)}}
    replace_owned_file(manifest_path, contract.encoded(saved), contract.encoded(updated))
    verify_recovery_backup(backup, require_database=True)
    prune_recovery_backups(backup.parent)


def replace_or_confirm(path: Path, old: bytes, new: bytes) -> None:
    actual = contract.private_file(path)
    contract.require(actual in {old, new}, "image_upgrade_file_drift")
    if actual == old:
        replace_owned_file(path, old, new)


def upgrade_existing(home: Path, args, *, payload: dict, manifest_bytes: bytes, expected: dict,
                     config_bytes: bytes, plist_bytes: bytes, runtime: dict) -> int:
    """Upgrade only this owned service; existing rows and output stay in place."""
    current, previous = args.source_commit, args.previous_source_commit
    state = home / "ai-worker/state/image-generation/image-service"
    config_file, receipt_file = state / "service.json", state / "install-receipt.json"
    plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    database = home / "ai-worker/state/image-generation/jobs/jobs.sqlite"
    release = home / "ai-worker/services/image-generation/releases" / current
    operation_file = state / f"upgrade-{current}.json"
    receipt = json.loads(contract.private_file(receipt_file))
    saved_operation = json.loads(contract.private_file(operation_file)) if operation_file.exists() else None
    contract.require(saved_operation is None or isinstance(saved_operation, dict), "owned_image_upgrade_identity_invalid")
    operation_finished = saved_operation is None or saved_operation.get("currentState") == "UPGRADE_HEALTHY"
    if receipt.get("sourceCommit") == current and receipt.get("currentState") == "SERVICE_HEALTHY" and operation_finished:
        contract.require(all(receipt.get(key) == value for key, value in expected.items()), "existing_image_installation_mismatch")
        contract.require(contract.private_file(config_file) == config_bytes and contract.private_file(plist) == plist_bytes,
                         "image_installation_drift")
        contract.require(contract.bounded_files(release) == {**json.loads(manifest_bytes)["files"],
            "manifest.json": contract.sha(manifest_bytes)}, "installed_image_artifact_drift")
        health(current, database)
        verify_live_binding(home, current)
        print(json.dumps({"currentState": "UNCHANGED_HEALTHY", "sourceCommit": current}))
        return 0
    operation = None
    before = None
    if operation_file.exists():
        contract.require(args.resume, "owned_image_upgrade_requires_resume")
        operation = saved_operation
        contract.require(operation.get("schema") == "aiworker-image-service-upgrade/v1"
            and operation.get("previousSourceCommit") == previous and operation.get("sourceCommit") == current
            and operation.get("candidateArtifactSha256") == expected["artifactSha256"], "owned_image_upgrade_identity_invalid")
        backup = contract.safe_path(Path(operation["backup"]), file=False)
        saved = verify_recovery_backup(backup)
        contract.require(saved.get("previousSourceCommit") == previous and saved.get("replacementSourceCommit") == current,
                         "owned_image_upgrade_backup_mismatch")
        old_receipt = json.loads(contract.private_file(backup / "install-receipt.json"))
        before = previous_artifact(home, previous, old_receipt, runtime)
        before.update({"databaseSummary": operation["beforeDatabaseSummary"],
                       "health": {"databaseIdentity": operation["databaseIdentity"]}})
        phase = operation.get("currentState")
        contract.require(phase in {"UPGRADE_PREPARED", "OWNED_SERVICE_STOPPED", "RECOVERY_VERIFIED",
                                  "OWNED_PAYLOAD_REPLACED", "SERVICE_STARTED"}, "owned_image_upgrade_phase_invalid")
        if phase == "UPGRADE_PREPARED":
            live = verify_previous_installation(home, previous, receipt, config_file, plist, runtime, database, allow_history=True)
            contract.require(live["receipt"] == before["receipt"] and live["databaseSummary"] == before["databaseSummary"],
                             "image_upgrade_source_changed_before_stop")
        elif phase in {"OWNED_SERVICE_STOPPED", "RECOVERY_VERIFIED"}:
            contract.require(launch_pid() is None and not listener_pids(), "owned_image_upgrade_stop_drift")
            prepared = contract.encoded(dict(expected, currentState="PAYLOAD_PREPARED", errorCode=None,
                nextAction="start_owned_image_service", databaseIdentity=operation["databaseIdentity"],
                modelGenerationValidated=False, previousSourceCommit=previous, recoveryBackup=str(backup)))
            allowed_new = phase == "RECOVERY_VERIFIED"
            for path, old, new in ((config_file, before["config"], config_bytes),
                                   (plist, before["plist"], plist_bytes),
                                   (receipt_file, before["receipt"], prepared)):
                contract.require(contract.private_file(path) in ({old, new} if allowed_new else {old}),
                                 "image_upgrade_file_drift")
        else:
            contract.require(all(receipt.get(key) == value for key, value in expected.items())
                and receipt.get("databaseIdentity") == operation["databaseIdentity"]
                and contract.private_file(config_file) == config_bytes and contract.private_file(plist) == plist_bytes,
                "owned_image_upgrade_target_drift")
            if launch_pid() is not None:
                verify_live_binding(home, current)
    else:
        contract.require(not args.resume, "owned_image_upgrade_operation_missing")
        before = verify_previous_installation(home, previous, receipt, config_file, plist, runtime, database, allow_history=True)
        backup = None
    if release.exists():
        contract.require(contract.bounded_files(release) == {**json.loads(manifest_bytes)["files"],
            "manifest.json": contract.sha(manifest_bytes)}, "upgrade_candidate_artifact_drift")
    print(json.dumps({"currentState": "PREFLIGHT_READY", "component": LABEL, "sourceCommit": current,
        "previousSourceCommit": previous, "historicalJobs": before["databaseSummary"]["rows"],
        "activeJobs": 0, "databaseIdentity": before["health"]["databaseIdentity"]}))
    if args.dry_run:
        return 0
    with contract.installation_lock(home / "ai-worker/state/.image-service-install.lock"):
        if operation is None:
            latest_receipt = json.loads(contract.private_file(receipt_file))
            latest = verify_previous_installation(home, previous, latest_receipt, config_file, plist, runtime, database, allow_history=True)
            contract.require(latest["receipt"] == before["receipt"] and latest["databaseSummary"] == before["databaseSummary"]
                and latest["pid"] == before["pid"], "image_upgrade_preflight_changed")
            backup = backup_owned_installation(home, previous, current, before, pending_database=True)
            operation = {"schema": "aiworker-image-service-upgrade/v1", "sourceCommit": current,
                "previousSourceCommit": previous, "candidateArtifactSha256": expected["artifactSha256"],
                "backup": str(backup), "databaseIdentity": before["health"]["databaseIdentity"],
                "beforeDatabaseSummary": before["databaseSummary"], "currentState": "UPGRADE_PREPARED",
                "errorCode": None, "nextAction": "stop_only_owned_image_service"}
            contract.create_file(operation_file, contract.encoded(operation))
        try:
            if not release.exists():
                create_private_tree(release)
                for name, raw in payload.items():
                    target = release / name
                    create_private_tree(target.parent)
                    contract.create_file(target, raw)
                contract.create_file(release / "manifest.json", manifest_bytes)
            contract.require(contract.bounded_files(release) == {**json.loads(manifest_bytes)["files"],
                "manifest.json": contract.sha(manifest_bytes)}, "upgrade_candidate_artifact_drift")
            if operation["currentState"] == "UPGRADE_PREPARED":
                latest = verify_previous_installation(home, previous,
                    json.loads(contract.private_file(receipt_file)), config_file, plist, runtime, database, allow_history=True)
                contract.require(latest["receipt"] == before["receipt"] and latest["databaseSummary"] == before["databaseSummary"],
                                 "image_upgrade_source_changed_before_stop")
                contract.run(["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"],
                             {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
                wait_owned_stopped(latest["pid"], args.startup_timeout)
                operation = contract.advance_receipt(operation_file, operation,
                    {"currentState": "OWNED_SERVICE_STOPPED", "nextAction": "verify_stopped_database_and_backup"})
            if operation["currentState"] in {"OWNED_SERVICE_STOPPED", "RECOVERY_VERIFIED"}:
                contract.require(launch_pid() is None and not listener_pids(), "owned_image_upgrade_stop_drift")
                contract.require({"device": database.stat().st_dev, "inode": database.stat().st_ino}
                    == operation["databaseIdentity"], "image_database_identity_changed")
                summary = database_summary(database)
                check_no_active_jobs(summary)
                contract.require(summary == operation["beforeDatabaseSummary"], "image_database_changed_during_upgrade_stop")
                finish_database_backup(backup, database, summary)
                if operation["currentState"] == "OWNED_SERVICE_STOPPED":
                    operation = contract.advance_receipt(operation_file, operation,
                        {"currentState": "RECOVERY_VERIFIED", "nextAction": "replace_owned_config_plist_and_receipt"})
                new_receipt = dict(expected, currentState="PAYLOAD_PREPARED", errorCode=None,
                    nextAction="start_owned_image_service", databaseIdentity=operation["databaseIdentity"],
                    modelGenerationValidated=False, previousSourceCommit=previous, recoveryBackup=str(backup))
                replace_or_confirm(config_file, before["config"], config_bytes)
                replace_or_confirm(plist, before["plist"], plist_bytes)
                replace_or_confirm(receipt_file, before["receipt"], contract.encoded(new_receipt))
                operation = contract.advance_receipt(operation_file, operation,
                    {"currentState": "OWNED_PAYLOAD_REPLACED", "nextAction": "start_owned_image_service"})
            receipt = json.loads(contract.private_file(receipt_file))
            contract.require(all(receipt.get(key) == value for key, value in expected.items())
                and receipt.get("databaseIdentity") == operation["databaseIdentity"]
                and contract.private_file(config_file) == config_bytes and contract.private_file(plist) == plist_bytes,
                "owned_image_upgrade_target_drift")
            if operation["currentState"] == "OWNED_PAYLOAD_REPLACED":
                if launch_pid() is None:
                    contract.require(not listener_pids(), "image_port_changed")
                    contract.run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)],
                                 {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
                receipt = contract.advance_receipt(receipt_file, receipt,
                    {"currentState": "SERVICE_STARTED", "nextAction": "verify_image_service_health"})
                operation = contract.advance_receipt(operation_file, operation,
                    {"currentState": "SERVICE_STARTED", "nextAction": "verify_image_service_health"})
            deadline = time.monotonic() + args.startup_timeout
            while True:
                try:
                    current_health = health(current, database)
                    verify_live_binding(home, current)
                    break
                except (OSError, ValueError, contract.InstallError):
                    contract.require(time.monotonic() < deadline, "image_service_health_failed")
                    time.sleep(1)
            contract.require(current_health["databaseIdentity"] == operation["databaseIdentity"], "image_database_identity_changed")
            receipt = contract.advance_receipt(receipt_file, receipt,
                {"currentState": "SERVICE_HEALTHY", "errorCode": None,
                 "nextAction": "verify_image_studio_tool_then_protected_model_trial",
                 "healthEvidenceSha256": contract.sha(contract.encoded(current_health)), "modelGenerationValidated": False})
            operation = contract.advance_receipt(operation_file, operation,
                {"currentState": "UPGRADE_HEALTHY", "errorCode": None,
                 "nextAction": "verify_image_studio_tool_then_protected_model_trial",
                 "currentReceiptSha256": contract.sha(contract.encoded(receipt))})
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError, contract.InstallError) as error:
            code = str(error) if isinstance(error, contract.InstallError) else "owned_image_upgrade_io_failed"
            contract.advance_receipt(operation_file, operation, {"errorCode": code,
                "nextAction": "inspect_owned_upgrade_phase_and_verified_recovery_then_resume"})
            raise
    print(json.dumps({"currentState": "SERVICE_HEALTHY", "receipt": str(receipt_file),
                      "historicalJobsPreserved": before["databaseSummary"]["rows"], "modelGenerationValidated": False}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--replace-owned-unvalidated", action="store_true")
    parser.add_argument("--upgrade-existing", action="store_true",
                        help="Upgrade the verified healthy image service, preserving historical jobs and output")
    parser.add_argument("--previous-source-commit")
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--backend-script-sha256", required=True)
    parser.add_argument("--profiles-sha256", required=True)
    parser.add_argument("--startup-timeout", type=int, default=90)
    args = parser.parse_args(argv)
    contract.require(platform.system() == "Darwin", "image_service_macos_required")
    contract.require(not args.resume or args.apply, "resume_requires_apply")
    contract.require(not (args.replace_owned_unvalidated and args.upgrade_existing), "owned_replacement_mode_invalid")
    contract.require(not args.replace_owned_unvalidated or (args.apply or args.dry_run) and not args.resume,
                     "owned_replacement_mode_invalid")
    contract.require(bool(args.previous_source_commit) == (args.replace_owned_unvalidated or args.upgrade_existing),
                     "previous_commit_requires_owned_replacement")
    if args.previous_source_commit:
        contract.require(re.fullmatch(r"[a-f0-9]{40}", args.previous_source_commit) is not None
            and args.previous_source_commit != args.source_commit, "previous_source_commit_invalid")
    contract.require(re.fullmatch(r"[a-f0-9]{40}", args.source_commit) is not None
                     and all(re.fullmatch(r"[a-f0-9]{64}", v) for v in (args.backend_script_sha256, args.profiles_sha256)), "source_identity_argument_invalid")
    contract.require(10 <= args.startup_timeout <= 3600, "startup_timeout_invalid")
    home = contract.safe_path(Path.home(), file=False)
    payload = bundle_payload(ROOT)
    extras = tuple(ROOT / name for name in payload) + (ROOT / "scripts/install-aiworker-image-service.py",
        ROOT / "ops/image-generation/service/service.template.json", ROOT / "scripts/aiworker-qwen-cover.py")
    source = contract.source_identity(ROOT, ROOT / "openclaw-plugins/aiworker-image-command", args.source_commit, extra_sources=extras)
    contract.require(contract.sha((ROOT / "scripts/aiworker-qwen-cover.py").read_bytes()) == args.backend_script_sha256,
                     "backend_does_not_match_committed_source")
    config = configuration(home, args.source_commit)
    runtime = validate_backend(config, args.backend_script_sha256, args.profiles_sha256)
    root = home / "ai-worker/services/image-generation"
    release = root / "releases" / args.source_commit
    state = home / "ai-worker/state/image-generation/image-service"
    config_file, receipt_file = state / "service.json", state / "install-receipt.json"
    jobs, output = Path(config["state_root"]), Path(config["output_root"])
    plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    for path in (root, release, state, jobs, output, plist):
        contract.safe_path(path)
    contract.safe_path(home / "ai-worker/output/covers", file=False)
    manifest = {"schema": "aiworker-image-service-artifact/v1", "sourceCommit": args.source_commit,
                "sourceRepository": contract.SOURCE_REPOSITORY, "files": {name: contract.sha(data) for name, data in payload.items()}}
    manifest_bytes, config_bytes = contract.encoded(manifest), contract.encoded(config)
    plist_bytes = service_plist(home, release, config_file, state / "logs")
    expected = {"schema": SCHEMA, "sourceCommit": args.source_commit, "sourceEvidence": source,
        "artifactSha256": contract.sha(manifest_bytes), "configSha256": contract.sha(config_bytes),
        "launchAgentSha256": contract.sha(plist_bytes), "runtime": runtime}
    if args.upgrade_existing:
        return upgrade_existing(home, args, payload=payload, manifest_bytes=manifest_bytes, expected=expected,
                                config_bytes=config_bytes, plist_bytes=plist_bytes, runtime=runtime)
    exists = receipt_file.exists()
    receipt = None
    if exists:
        receipt = json.loads(contract.private_file(receipt_file))
        if args.replace_owned_unvalidated:
            verify_previous_installation(home, args.previous_source_commit, receipt, config_file, plist, runtime, jobs / "jobs.sqlite")
            if release.exists():
                contract.require(contract.bounded_files(release) == {**manifest["files"], "manifest.json": contract.sha(manifest_bytes)},
                                 "replacement_candidate_artifact_drift")
        else:
            contract.require(all(receipt.get(k) == v for k, v in expected.items()), "existing_image_installation_mismatch")
            contract.require(contract.private_file(config_file) == config_bytes and contract.private_file(plist) == plist_bytes
                             and contract.private_file(release / "manifest.json") == manifest_bytes, "image_installation_drift")
            inventory = contract.bounded_files(release)
            contract.require(inventory == {**manifest["files"], "manifest.json": contract.sha(manifest_bytes)}, "installed_image_artifact_drift")
            if receipt["currentState"] == "SERVICE_HEALTHY":
                health(args.source_commit, jobs / "jobs.sqlite")
                print(json.dumps({"currentState": "UNCHANGED_HEALTHY", "sourceCommit": args.source_commit}))
                return 0
            contract.require(args.resume and receipt["currentState"] in {"PAYLOAD_PREPARED", "SERVICE_STARTED"}, "owned_image_install_requires_resume")
    else:
        contract.require(not args.replace_owned_unvalidated, "owned_replacement_requires_receipt")
        contract.require(not any(path.exists() for path in (root, state, jobs, output, plist)), "new_image_target_must_be_absent")
        contract.require(not listener_pids() and launch_pid() is None, "image_port_or_launchagent_busy")
    print(json.dumps({"currentState": "PREFLIGHT_READY", "component": LABEL, "sourceCommit": args.source_commit,
                      "artifactSha256": expected["artifactSha256"], "listen": "127.0.0.1:18095"}))
    if args.dry_run:
        return 0
    with contract.installation_lock(home / "ai-worker/state/.image-service-install.lock"):
        if args.replace_owned_unvalidated:
            contract.require(contract.private_file(receipt_file) == contract.encoded(receipt), "previous_receipt_changed")
            before = verify_previous_installation(home, args.previous_source_commit, receipt, config_file, plist, runtime, jobs / "jobs.sqlite")
            if not release.exists():
                create_private_tree(release)
                for name, data in payload.items():
                    target = release / name
                    create_private_tree(target.parent)
                    contract.create_file(target, data)
                contract.create_file(release / "manifest.json", manifest_bytes)
            contract.require(contract.bounded_files(release) == {**manifest["files"], "manifest.json": contract.sha(manifest_bytes)},
                             "replacement_candidate_artifact_drift")
            backup = backup_owned_installation(home, args.previous_source_commit, args.source_commit, before)
            operation_file = state / f"replacement-{args.source_commit}.json"
            operation = {"schema": "aiworker-image-service-replacement/v1", "previousSourceCommit": args.previous_source_commit,
                "sourceCommit": args.source_commit, "backup": str(backup), "previousReceiptSha256": contract.sha(before["receipt"]),
                "candidateArtifactSha256": expected["artifactSha256"], "currentState": "REPLACEMENT_PREPARED",
                "errorCode": None, "nextAction": "stop_only_owned_image_service"}
            contract.create_file(operation_file, contract.encoded(operation))
            try:
                latest = verify_previous_installation(home, args.previous_source_commit, receipt, config_file, plist, runtime, jobs / "jobs.sqlite")
                contract.require(latest["pid"] == before["pid"] and latest["receipt"] == before["receipt"], "previous_service_changed_before_stop")
                if before["pid"] is not None:
                    contract.run(["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"],
                                 {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
                wait_owned_stopped(before["pid"], args.startup_timeout)
                operation = contract.advance_receipt(operation_file, operation, {"currentState": "OWNED_SERVICE_STOPPED",
                    "nextAction": "replace_owned_config_plist_and_receipt"})
                replace_owned_file(config_file, before["config"], config_bytes)
                replace_owned_file(plist, before["plist"], plist_bytes)
                updated = dict(expected, currentState="PAYLOAD_PREPARED", errorCode=None, nextAction="start_owned_image_service",
                    databaseIdentity=before["health"].get("databaseIdentity"), modelGenerationValidated=False,
                    previousSourceCommit=args.previous_source_commit, recoveryBackup=str(backup))
                replace_owned_file(receipt_file, before["receipt"], contract.encoded(updated))
                receipt = updated
                operation = contract.advance_receipt(operation_file, operation, {"currentState": "OWNED_PAYLOAD_REPLACED",
                    "nextAction": "start_and_verify_replacement"})
            except (OSError, ValueError, subprocess.SubprocessError, contract.InstallError) as error:
                code = str(error) if isinstance(error, contract.InstallError) else "owned_replacement_io_failed"
                contract.advance_receipt(operation_file, operation, {"errorCode": code,
                    "nextAction": "inspect_exact_owned_replacement_and_verified_backup_before_resuming"})
                raise
        if not exists:
            contract.require(not any(path.exists() for path in (root, state, jobs, output, plist)), "new_image_target_changed")
            for directory in (release, state / "logs", jobs, output):
                create_private_tree(directory)
            for name, data in payload.items():
                target = release / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                contract.create_file(target, data)
            contract.create_file(release / "manifest.json", manifest_bytes)
            contract.create_file(config_file, config_bytes)
            contract.create_file(plist, plist_bytes)
            receipt = dict(expected, currentState="PAYLOAD_PREPARED", errorCode=None, nextAction="start_owned_image_service",
                           databaseIdentity=None, modelGenerationValidated=False)
            contract.create_file(receipt_file, contract.encoded(receipt))
        try:
            env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
            if receipt["currentState"] == "PAYLOAD_PREPARED":
                existing_pid = launch_pid()
                if existing_pid is None:
                    contract.require(not listener_pids(), "image_port_changed")
                    # No bootout, no existing service replacement, no other restart.
                    contract.run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)], env)
                else:
                    contract.require(args.resume, "loaded_image_service_requires_resume")
                receipt = contract.advance_receipt(receipt_file, receipt, {"currentState": "SERVICE_STARTED", "nextAction": "verify_image_service_health"})
            deadline = time.monotonic() + args.startup_timeout
            while True:
                try:
                    current = health(args.source_commit, jobs / "jobs.sqlite")
                    break
                except (OSError, ValueError, contract.InstallError):
                    contract.require(time.monotonic() < deadline, "image_service_health_failed")
                    time.sleep(1)
            receipt = contract.advance_receipt(receipt_file, receipt, {"currentState": "SERVICE_HEALTHY", "errorCode": None,
                "nextAction": "verify_image_studio_tool_then_real_model_trial", "databaseIdentity": current["databaseIdentity"],
                "healthEvidenceSha256": contract.sha(contract.encoded(current)), "modelGenerationValidated": False})
            if args.replace_owned_unvalidated:
                contract.advance_receipt(operation_file, operation, {"currentState": "REPLACEMENT_HEALTHY", "errorCode": None,
                    "nextAction": "verify_image_studio_tool_then_real_model_trial",
                    "currentReceiptSha256": contract.sha(contract.encoded(receipt))})
        except (OSError, ValueError, subprocess.SubprocessError, contract.InstallError) as error:
            code = str(error) if isinstance(error, contract.InstallError) else "image_service_installation_io_failed"
            contract.advance_receipt(receipt_file, receipt, {"errorCode": code, "nextAction": "inspect_owned_image_service_then_resume"})
            raise
    print(json.dumps({"currentState": "SERVICE_HEALTHY", "receipt": str(receipt_file), "modelGenerationValidated": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError, contract.InstallError) as error:
        code = str(error) if isinstance(error, contract.InstallError) else "image_service_installation_probe_failed"
        print(json.dumps({"currentState": "INCOMPLETE", "errorCode": code, "nextAction": "inspect_only_owned_image_service_targets"}), file=sys.stderr)
        raise SystemExit(1)

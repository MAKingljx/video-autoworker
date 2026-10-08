#!/usr/bin/env python3
"""Prepare/install the single per-user Resolve adapter LaunchAgent.

This does not enable external scripting, edit a Resolve project, or create tasks.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys

LABEL = "com.aiworker.resolve-executor"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["plan", "install", "status"])
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--node-id", required=True)
    args = parser.parse_args()
    adapter = Path(__file__).resolve().parents[1] / "ops/resolve/resolve_executor.py"
    state, output = args.state_dir.absolute(), args.output_root.resolve(strict=True)
    python = args.python.resolve(strict=True)
    if not output.is_dir() or not python.is_file() or not adapter.is_file():
        raise SystemExit("resolve_service_paths_invalid")
    if state.resolve() != state or len(str(state / "executor.sock").encode()) > 103:
        raise SystemExit("resolve_service_state_invalid")
    target = f"gui/{os.getuid()}/{LABEL}"
    config = {"Label": LABEL, "ProgramArguments": [str(python), str(adapter), "--state-dir", str(state),
                "--output-root", str(output), "--node-id", args.node_id],
              "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 10,
              "ProcessType": "Interactive", "Umask": 63,
              "StandardOutPath": str(state / "stdout.log"), "StandardErrorPath": str(state / "stderr.log")}
    encoded = plistlib.dumps(config, sort_keys=True)
    destination = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    receipt = {"schemaVersion": 1, "label": LABEL, "nodeId": args.node_id, "socketPath": str(state / "executor.sock"),
               "adapterSha256": hashlib.sha256(adapter.read_bytes()).hexdigest(),
               "launchAgentSha256": hashlib.sha256(encoded).hexdigest(), "launchAgentPath": str(destination)}
    if args.action == "plan":
        print(json.dumps({**receipt, "launchAgent": config}, ensure_ascii=False))
        return
    if args.action == "status":
        result = subprocess.run(["/bin/launchctl", "print", target], capture_output=True, text=True)
        print(json.dumps({**receipt, "loaded": result.returncode == 0, "socketExists": (state / "executor.sock").exists()}))
        return
    if sys.platform != "darwin":
        raise SystemExit("resolve_launchagent_requires_macos")
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    if state.stat().st_uid != os.getuid() or (state.stat().st_mode & 0o777) != 0o700:
        raise SystemExit("resolve_service_state_permissions")
    # Never stop a service merely because another install is requested. A changed
    # install must be drained/stopped by its owner before this exact installer runs.
    loaded = subprocess.run(["/bin/launchctl", "print", target], capture_output=True).returncode == 0
    if destination.exists():
        if destination.is_symlink() or destination.read_bytes() != encoded:
            raise SystemExit("resolve_service_existing_config_conflict")
        if loaded:
            print(json.dumps({**receipt, "installed": True, "reused": True}))
            return
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    for name in ("stdout.log", "stderr.log"):
        fd = os.open(state / name, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    subprocess.run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(destination)], check=True)
    print(json.dumps({**receipt, "installed": True, "reused": False}))


if __name__ == "__main__":
    main()

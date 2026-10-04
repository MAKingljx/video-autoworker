#!/usr/bin/env python3
"""Create only the independent image-studio profile; never edit another profile.

The official gateway install command installs AND starts its service. All payload,
provider, path, port and offline-config checks therefore precede that command.
No image business logic or model weights are installed here.
"""
from __future__ import annotations

import argparse
import copy
import ctypes
from contextlib import contextmanager
import hashlib
import json
import os
import platform
import plistlib
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

PROFILE = "image-studio"
LABEL = "ai.openclaw.image-studio"
SCHEMA = "aiworker-openclaw-image-studio-install/v1"
TOKEN_SERVICE = "aiworker.openclaw.image-studio.gateway"
TOKEN_ACCOUNT = PROFILE
SOURCE_REPOSITORY = "https://github.com/MAKingljx/video-autoworker"
PROVIDER_KEYS = {"baseUrl", "api", "timeoutSeconds", "request", "models", "auth", "apiKey"}
MODEL_KEYS = {"id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat", "contextTokens"}
ROOT = Path(__file__).resolve().parent.parent


class InstallError(RuntimeError):
    pass


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def encoded(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def require(condition: bool, code: str) -> None:
    if not condition:
        raise InstallError(code)


def safe_path(path: Path, *, file: bool | None = None) -> Path:
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)), "invalid_absolute_path")
    for ancestor in [*reversed(path.parents), path]:
        require(not ancestor.is_symlink(), "symlink_target_rejected")
        if ancestor.exists():
            require(ancestor.stat().st_uid in {0, os.getuid()}, "foreign_path_owner")
    if file is not None:
        require(path.is_file() if file else path.is_dir(), "target_type_mismatch")
    return path


def private_file(path: Path) -> bytes:
    safe_path(path, file=True)
    require(path.stat().st_uid == os.getuid() and stat.S_IMODE(path.stat().st_mode) & 0o077 == 0,
            "private_file_required")
    return path.read_bytes()


def owned_public_file(path: Path) -> bytes:
    safe_path(path, file=True)
    require(path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o022 == 0, "owned_readonly_file_required")
    return path.read_bytes()


def bounded_files(directory: Path) -> dict[str, str]:
    result, size = {}, 0
    safe_path(directory, file=False)
    for member in sorted(directory.rglob("*")):
        safe_path(member)
        require(member.is_dir() or member.is_file(), "artifact_special_member_rejected")
        if member.is_dir():
            continue
        require(member.stat().st_uid == os.getuid() and member.stat().st_mode & 0o022 == 0,
                "artifact_member_owner_or_mode_invalid")
        size += member.stat().st_size
        require(len(result) < 1000 and size <= 20 * 1024 * 1024, "artifact_inventory_limit")
        result[member.relative_to(directory).as_posix()] = sha(member.read_bytes())
    require(result, "artifact_payload_empty")
    return result


def source_identity(source: Path, plugin: Path, commit: str, manifest_path: Path | None = None,
                    manifest_sha: str | None = None, extra_sources: tuple[Path, ...] = (),
                    exclude_plugin_manifest: bool = False) -> dict:
    required = [source / "scripts/install-openclaw-image-studio.py", source / "scripts/openclaw-keychain-secretref.sh",
                *sorted((source / "ops/openclaw-image-studio").glob("*"))]
    required.extend(extra_sources)
    plugin_members = bounded_files(plugin)
    if exclude_plugin_manifest:
        require("manifest.json" in plugin_members, "plugin_artifact_manifest_required")
        plugin_members.pop("manifest.json")
    required.extend(source / "openclaw-plugins/aiworker-image-command" / name for name in plugin_members)
    if manifest_path is not None:
        require(manifest_sha is not None and re.fullmatch(r"[a-f0-9]{64}", manifest_sha) is not None,
                "artifact_manifest_digest_required")
        raw = private_file(manifest_path)
        require(sha(raw) == manifest_sha, "artifact_manifest_digest_mismatch")
        manifest = json.loads(raw)
        require(set(manifest) == {"schema", "sourceCommit", "sourceRepository", "artifactRoot", "files"}
                and manifest["schema"] == "aiworker-openclaw-image-studio-artifact/v1"
                and manifest["sourceCommit"] == commit and manifest["sourceRepository"] == SOURCE_REPOSITORY,
                "artifact_manifest_identity_invalid")
        artifact_root = safe_path(Path(manifest["artifactRoot"]), file=False)
        require(not manifest_path.is_relative_to(artifact_root), "artifact_manifest_must_be_external")
        actual = bounded_files(artifact_root)
        declared = manifest["files"]
        require(isinstance(declared, dict) and declared == actual, "artifact_manifest_members_or_digest_mismatch")
        for name in actual:
            require(not any(part in {".git", ".PhoenixBrain", "node_modules", "__pycache__"}
                            for part in Path(name).parts), "artifact_private_or_runtime_member_rejected")
        artifact_required = [*required[:-len(plugin_members)], *(plugin / name for name in plugin_members)]
        require(all(path.is_relative_to(artifact_root) and path.relative_to(artifact_root).as_posix() in actual
                    for path in artifact_required), "artifact_required_dependency_missing")
        return {"mode": "audited_artifact", "sourceRepository": SOURCE_REPOSITORY,
                "sourceCommit": commit, "manifestSha256": manifest_sha,
                "payloadInventorySha256": sha(encoded(actual)), "pluginInventorySha256": sha(encoded(plugin_members))}
    require(manifest_sha is None, "artifact_manifest_path_required")
    git_env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    def git(*arguments: str) -> bytes:
        result = subprocess.run(["/usr/bin/git", "-C", str(source), *arguments], env=git_env,
                                capture_output=True, timeout=30)
        require(result.returncode == 0, "canonical_git_probe_failed")
        return result.stdout
    git_root = safe_path(Path(git("rev-parse", "--show-toplevel").decode().strip()), file=False)
    require(git("rev-parse", "HEAD").decode().strip() == commit, "canonical_git_commit_mismatch")
    remote = git("remote", "get-url", "origin").decode().strip()
    require(remote in {SOURCE_REPOSITORY, SOURCE_REPOSITORY + ".git", "git@github.com:MAKingljx/video-autoworker.git"},
            "canonical_git_remote_mismatch")
    require(all(path.is_relative_to(git_root) for path in required), "canonical_dependency_outside_git")
    members = {}
    for path in required:
        safe_path(path, file=True)
        relative = path.relative_to(git_root).as_posix()
        committed = git("show", f"{commit}:{relative}")
        require(path.read_bytes() == committed, "canonical_source_drift")
        members[relative] = sha(committed)
    for name, digest in plugin_members.items():
        require(digest == members[(source / "openclaw-plugins/aiworker-image-command" / name).relative_to(git_root).as_posix()],
                "installed_plugin_source_mismatch")
    return {"mode": "canonical_git", "sourceRepository": SOURCE_REPOSITORY, "sourceCommit": commit,
            "payloadInventorySha256": sha(encoded(members)), "pluginInventorySha256": sha(encoded(plugin_members))}


def loopback_url(value: object, *, provider: bool = False) -> str:
    require(isinstance(value, str), "loopback_endpoint_required")
    parsed = urlparse(value)
    require(parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port is not None
            and parsed.username is None and parsed.password is None and not parsed.query
            and not parsed.fragment and parsed.path == ("/v1" if provider else ""), "loopback_endpoint_required")
    return value


def provider_config(value: object) -> dict:
    require(isinstance(value, dict) and set(value) <= {"provider", "modelParameters", "thinkingDefault"}
            and "provider" in value, "model_provider_shape_invalid")
    provider = value["provider"]
    require(isinstance(provider, dict) and set(provider) <= PROVIDER_KEYS, "provider_field_rejected")
    loopback_url(provider.get("baseUrl"), provider=True)
    require(provider.get("api") == "openai-completions", "provider_api_invalid")
    require(provider.get("apiKey", "not-needed") == "not-needed"
            and provider.get("auth", "api-key") == "api-key", "secret_provider_rejected")
    require(provider.get("request", {}) in ({}, {"allowPrivateNetwork": True}), "provider_request_rejected")
    models = provider.get("models")
    require(isinstance(models, list) and len(models) == 1 and isinstance(models[0], dict), "one_chat_model_required")
    model = models[0]
    require(set(model) <= MODEL_KEYS and model.get("id") == "default_model", "chat_model_shape_invalid")
    require(isinstance(model.get("contextWindow"), int) and 4096 <= model["contextWindow"] <= 1_000_000,
            "chat_context_invalid")
    require(isinstance(model.get("maxTokens"), int) and 128 <= model["maxTokens"] <= 32768,
            "chat_output_invalid")
    require(model.get("input") in (["text"], ["text", "image"]), "chat_inputs_invalid")
    require(isinstance(model.get("reasoning"), bool), "chat_reasoning_invalid")
    require(set(model.get("cost", {})) <= {"input", "output", "cacheRead", "cacheWrite"}, "chat_cost_invalid")
    require(set(model.get("compat", {})) <= {"supportsTools", "thinkingFormat", "supportsDeveloperRole",
            "supportsReasoningEffort", "supportsUsageInStreaming", "maxTokensField"}, "chat_compat_invalid")
    params = value.get("modelParameters", {})
    require(isinstance(params, dict) and set(params) <= {"temperature", "top_p", "max_tokens", "chat_template_kwargs"},
            "model_parameters_rejected")
    template = params.get("chat_template_kwargs", {})
    require(isinstance(template, dict) and set(template) <= {"enable_thinking", "thinking", "preserve_thinking",
            "reasoning_effort"}, "model_template_parameters_rejected")
    thinking = value.get("thinkingDefault", "off")
    require(thinking in {"off", "minimal", "low", "medium", "high", "xhigh"}, "thinking_default_invalid")
    # Only explicit public fields enter the new profile, never old sessions/auth.
    return copy.deepcopy({"provider": provider, "modelParameters": params, "thinkingDefault": thinking})


def profile_config(home: Path, port: int, plugin: Path, endpoint: str, model: dict) -> dict:
    require(isinstance(port, int) and 1024 <= port <= 65425, "gateway_port_invalid")
    loopback_url(endpoint)
    require(endpoint == "http://127.0.0.1:18095", "image_service_endpoint_contract_mismatch")
    value = json.loads((ROOT / "ops/openclaw-image-studio/profile.template.json").read_text())
    workspace = home / "ai-worker/workspaces" / PROFILE
    state = home / f".openclaw-{PROFILE}"
    value["gateway"]["port"] = port
    value["gateway"]["auth"]["token"] = {"source": "exec", "provider": "image-studio-keychain", "id": "gateway-token"}
    value["secrets"] = {"providers": {"image-studio-keychain": {
        "source": "exec", "command": str(home / "ai-worker/bin/aiworker-openclaw-keychain-secretref"),
        "args": [TOKEN_ACCOUNT, TOKEN_SERVICE, str(home / "Library/Keychains/login.keychain-db")],
        "jsonOnly": False, "trustedDirs": [str(home / "ai-worker/bin")], "passEnv": ["HOME"],
        "timeoutMs": 10000, "maxOutputBytes": 4096,
    }}}
    value["models"] = {"mode": "merge", "providers": {"qwen36-tools-local": model["provider"]}}
    defaults = value["agents"]["defaults"]
    defaults.update({"workspace": str(workspace), "thinkingDefault": model["thinkingDefault"],
                     "models": {"qwen36-tools-local/default_model": {"params": model["modelParameters"]}}})
    value["agents"]["entries"][PROFILE].update({"workspace": str(workspace), "agentDir": str(state / "agents/image-studio/agent")})
    value["plugins"]["load"] = {"paths": [str(plugin)]}
    return value


def check_port_ranges(home: Path, port: int) -> list[dict]:
    ranges = []
    for state in sorted(home.glob(".openclaw-*")):
        if state.name == f".openclaw-{PROFILE}":
            continue
        config = state / "openclaw.json"
        if not config.exists():
            continue
        safe_path(config, file=True)
        try:
            base = json.loads(config.read_bytes()).get("gateway", {}).get("port")
        except (ValueError, TypeError):
            raise InstallError("existing_profile_config_invalid") from None
        require(isinstance(base, int) and 1 <= base <= 65425, "existing_profile_port_unknown")
        require(port + 110 < base or base + 110 < port, "derived_port_range_overlap")
        ranges.append({"profile": state.name[10:], "base": base, "last": base + 110})
    return ranges


def cli_environment(home: Path, node: Path) -> dict:
    # No previous bot/channel/provider credentials or override variables enter
    # the isolated install, even when an operator's shell exports them.
    env = {key: os.environ[key] for key in ("LANG", "LC_ALL", "TZ", "TMPDIR") if key in os.environ}
    env.update({"HOME": str(home), "PATH": f"{node.parent}:/usr/bin:/bin:/usr/sbin:/sbin",
                "OPENCLAW_LAUNCHD_LABEL": LABEL, "OPENCLAW_PROFILE": PROFILE,
                "OPENCLAW_STATE_DIR": str(home / f".openclaw-{PROFILE}"),
                "OPENCLAW_CONFIG_PATH": str(home / f".openclaw-{PROFILE}/openclaw.json")})
    return env


def run(command: list[str], env: dict, *, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess:
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
    if check:
        # CLI diagnostics may contain credentials/config. Never echo raw output.
        require(result.returncode == 0, "component_command_failed")
    return result


def live_ports(port: int) -> set[int]:
    result = subprocess.run(["/usr/sbin/lsof", "-nP", f"-iTCP:{port}-{port + 110}", "-sTCP:LISTEN", "-Fn"],
                            capture_output=True, text=True, timeout=15)
    require(result.returncode in {0, 1} and not result.stderr.strip(), "port_probe_failed")
    return {int(match.group(1)) for line in result.stdout.splitlines()
            if (match := re.search(r":(\d+)$", line))}


def security_interactive_input(arguments: list[str]) -> str:
    # EOF ends security -i. A trailing 'quit' is an unknown command and can
    # report failure even after the preceding credential write succeeded.
    return ' '.join(shlex.quote(value) for value in arguments) + '\n'


def keychain_token(home: Path, *, create: bool) -> str | None:
    """Use one fixed trusted actor; a new password travels only through stdin.

    H1's default SecKeychainAddGenericPassword ACL asked for unavailable GUI
    interaction (-25308). The approved security actor has an explicit new-item
    ACL and also performs readback; Python is not granted additional trust.
    """
    require(platform.system() == "Darwin", "macos_keychain_required")
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainOpen.restype = ctypes.c_int32
    security.SecKeychainGetStatus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    security.SecKeychainGetStatus.restype = ctypes.c_int32
    keychain = ctypes.c_void_p()
    status = security.SecKeychainOpen(str(home / "Library/Keychains/login.keychain-db").encode(), ctypes.byref(keychain))
    require(status == 0, f"keychain_open_failed_osstatus_{status}")
    bits = ctypes.c_uint32()
    status = security.SecKeychainGetStatus(keychain, ctypes.byref(bits))
    require(status == 0, f"keychain_status_failed_osstatus_{status}")
    # GetStatus reflects this process's audit/login session. On H1 the same
    # keychain is unavailable over SSH (2) but unlocked in the authenticated GUI
    # LaunchAgent context (7); do not label that as a global user-lock failure.
    require(bits.value & 1 != 0, "keychain_unavailable_in_current_session_use_authenticated_gui_context")
    keychain_path = str(home / "Library/Keychains/login.keychain-db")
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    def read_actor():
        result = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", TOKEN_ACCOUNT,
            "-s", TOKEN_SERVICE, "-w", keychain_path], env=env, capture_output=True, text=True, timeout=30)
        if result.returncode == 44:  # errSecItemNotFound (-25300) as security(1)'s exit status.
            return None
        require(result.returncode == 0, f"keychain_read_failed_osstatus_{-25308 if result.returncode == 36 else result.returncode}")
        token = result.stdout.strip()
        require(re.fullmatch(r"[a-f0-9]{64}", token) is not None, "existing_gateway_token_invalid")
        return token
    existing = read_actor()
    if existing is not None:
        return existing
    if not create:
        return None
    require(bits.value & 4 != 0, "keychain_not_writable_in_current_session_use_authenticated_gui_context")
    token = secrets.token_hex(32)
    # No -U/update option, no unlock command, no old item/ACL mutation. security
    # -i may echo the command; all output is captured and never forwarded.
    command = security_interactive_input(["add-generic-password", "-a", TOKEN_ACCOUNT,
        "-s", TOKEN_SERVICE, "-w", token, "-T", "/usr/bin/security", keychain_path])
    result = subprocess.run(["/usr/bin/security", "-i"], input=command, env=env,
                            capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, f"keychain_create_failed_osstatus_{-25308 if result.returncode == 36 else result.returncode}")
    require(read_actor() == token, "keychain_create_readback_failed")
    return token


def create_file(path: Path, data: bytes) -> None:
    safe_path(path.parent, file=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    require(private_file(path) == data, "file_readback_failed")


@contextmanager
def installation_lock(path: Path):
    safe_path(path.parent, file=False)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise InstallError("image_studio_installation_locked") from None
    identity = os.fstat(fd)
    with os.fdopen(fd, "wb") as out:
        out.write(encoded({"pid": os.getpid(), "profile": PROFILE}))
    try:
        yield
    finally:
        current = path.lstat()
        require((current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino), "installation_lock_changed")
        path.unlink()


def advance_receipt(path: Path, old: dict, changes: dict) -> dict:
    require(private_file(path) == encoded(old), "installation_receipt_changed")
    updated = dict(old, **changes)
    temporary = path.parent / f".install-receipt.{os.getpid()}.json"
    create_file(temporary, encoded(updated))
    require(private_file(path) == encoded(old), "installation_receipt_changed")
    os.replace(temporary, path)
    require(private_file(path) == encoded(updated), "installation_receipt_readback_failed")
    return updated


def verify_installed_service(plist: Path, state: Path, config: bytes) -> dict:
    installed = plistlib.loads(owned_public_file(plist))
    require(isinstance(installed, dict), "installed_service_shape_invalid")
    service_env = installed.get("EnvironmentVariables", {})
    require(isinstance(service_env, dict), "installed_service_env_invalid")
    arguments = installed.get("ProgramArguments", [])
    native_hashes = {}
    require(isinstance(arguments, list) and all(isinstance(arg, str) for arg in arguments), "service_arguments_invalid")
    # Current official launchd implementations may keep environment in a private
    # file. Parse its generated exports; never source/execute it during inspection.
    native_wrapper = state / "service-env" / f"{LABEL}-env-wrapper.sh"
    native_env = state / "service-env" / f"{LABEL}.env"
    if arguments[:3] == ["/bin/sh", str(native_wrapper), str(native_env)]:
        expected = b'#!/bin/sh\nset -eu\nenv_file="$1"\nshift\nif [ -f "$env_file" ]; then\n  . "$env_file"\nfi\nexec "$@"\n'
        require(private_file(native_wrapper) == expected and stat.S_IMODE(native_wrapper.stat().st_mode) == 0o700,
                "native_service_wrapper_mismatch")
        raw = private_file(native_env)
        parsed = {}
        for line in raw.decode().splitlines():
            if not line or line.startswith("#"):
                continue
            match = re.fullmatch(r"export ([A-Z_][A-Z_0-9]*)=(.*)", line)
            require(match is not None, "native_service_env_invalid")
            values = shlex.split(match.group(2))
            require(len(values) == 1, "native_service_env_invalid")
            quoted = "'" + values[0].replace("'", "'\\''") + "'"
            require(quoted == match.group(2) and match.group(1) not in parsed, "native_service_env_invalid")
            parsed[match.group(1)] = values[0]
        service_env = dict(service_env, **parsed)
        native_hashes = {"environmentSha256": sha(raw), "environmentWrapperSha256": sha(expected)}
        arguments = arguments[3:]
    require(installed.get("Label") == LABEL and service_env.get("OPENCLAW_PROFILE") == PROFILE,
            "installed_service_identity_mismatch")
    require(not any(key in service_env for key in ("OPENCLAW_GATEWAY_TOKEN", "GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD")),
            "service_embedded_secret_rejected")
    require(str(state) == service_env.get("OPENCLAW_STATE_DIR")
            and str(state / "openclaw.json") == service_env.get("OPENCLAW_CONFIG_PATH"), "installed_service_state_mismatch")
    require(private_file(state / "openclaw.json") == config, "installed_config_drift")
    port = json.loads(config)["gateway"]["port"]
    require(service_env.get("OPENCLAW_GATEWAY_PORT") == str(port) and "gateway" in arguments
            and "--port" in arguments and arguments.index("--port") + 1 < len(arguments)
            and arguments[arguments.index("--port") + 1] == str(port), "installed_service_port_mismatch")
    require(not any(arg in {"--token", "--password", "--allow-unconfigured"} for arg in arguments), "service_secret_or_bypass_argument_rejected")
    return {"launchAgentSha256": sha(owned_public_file(plist)), **native_hashes}


def verify_prepared_adoption(home: Path, previous: str, receipt: dict, payload: dict,
                             state: Path, workspace: Path, plist: Path, source: dict) -> dict:
    require(receipt.get("schema") == SCHEMA and receipt.get("profile") == PROFILE
        and receipt.get("sourceCommit") == previous and receipt.get("currentState") == "PAYLOAD_PREPARED"
        and receipt.get("sourceEvidence", {}).get("sourceCommit") == previous
        and receipt.get("sourceEvidence", {}).get("mode") == "canonical_git" and receipt.get("feishuEnabled") is False,
        "known_prepared_profile_required")
    before = {"openclaw.json": private_file(state / "openclaw.json"),
        "AGENTS.md": private_file(workspace / "AGENTS.md"), "IDENTITY.md": private_file(workspace / "IDENTITY.md")}
    require({name: sha(raw) for name, raw in before.items()} == receipt.get("payloadSha256"), "prepared_profile_payload_drift")
    require(not plist.exists() and not live_ports(receipt["gatewayPort"]), "prepared_profile_already_active")
    status = run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
        {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}, check=False)
    require(status.returncode != 0 and ("Could not find service" in status.stderr or "Could not find specified service" in status.stderr),
        "prepared_profile_launchagent_absence_unproven")
    previous_config = json.loads(before["openclaw.json"])
    paths = previous_config.get("plugins", {}).get("load", {}).get("paths")
    expected_previous_plugin = home / "ai-worker/services/image-generation/releases" / previous / "openclaw-plugins/aiworker-image-command"
    require(paths == [str(expected_previous_plugin)] and sha(encoded(bounded_files(expected_previous_plugin)))
        == receipt["sourceEvidence"].get("pluginInventorySha256") == source.get("pluginInventorySha256"), "prepared_plugin_source_drift")
    previous_config["plugins"]["load"]["paths"] = json.loads(payload["openclaw.json"])["plugins"]["load"]["paths"]
    require(encoded(previous_config) == payload["openclaw.json"]
        and before["AGENTS.md"] == payload["AGENTS.md"] and before["IDENTITY.md"] == payload["IDENTITY.md"],
        "prepared_adoption_changes_outside_plugin_location")
    return before


def verified_profile_backup(home: Path, files: dict[str, bytes]) -> Path:
    backup_root = home / "ai-worker/backups/openclaw-image-studio"
    safe_path(backup_root)
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = backup_root / f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{time.time_ns()}"
    backup.mkdir(mode=0o700)
    for name, raw in files.items():
        create_file(backup / name, raw)
    manifest = {"schema": "aiworker-image-studio-recovery/v1", "files": {name: sha(raw) for name, raw in files.items()}}
    create_file(backup / "manifest.json", encoded(manifest))
    histories = sorted(backup_root.iterdir(), key=lambda entry: entry.name)
    for directory in histories:
        saved = json.loads(private_file(directory / "manifest.json"))
        require(saved.get("schema") == manifest["schema"] and set(saved["files"]) == set(files)
            and bounded_files(directory) == {**saved["files"], "manifest.json": sha(private_file(directory / "manifest.json"))},
            "prepared_recovery_integrity_failed")
    for directory in histories[:-2]:
        shutil.rmtree(directory)
    return backup


def adopt_prepared(home: Path, receipt_file: Path, receipt: dict, before: dict, payload: dict,
                   state: Path, workspace: Path, commit: str, source: dict) -> dict:
    backup = verified_profile_backup(home, dict(before, **{"install-receipt.json": encoded(receipt)}))
    for name, replacement in payload.items():
        path = state / name if name == "openclaw.json" else workspace / name
        require(private_file(path) == before[name], "prepared_adoption_cas_failed")
        if replacement == before[name]:
            continue
        temporary = path.parent / f".{path.name}.adopt-{os.getpid()}"
        create_file(temporary, replacement)
        require(private_file(path) == before[name], "prepared_adoption_cas_failed")
        os.replace(temporary, path)
        require(private_file(path) == replacement, "prepared_adoption_readback_failed")
    return advance_receipt(receipt_file, receipt, {"sourceCommit": commit, "sourceEvidence": source,
        "payloadSha256": {name: sha(raw) for name, raw in payload.items()}, "previousSourceCommit": receipt["sourceCommit"],
        "recoveryBackup": str(backup), "errorCode": None, "nextAction": "validate_config_then_install_service"})


def plugin_artifact(home: Path, plugin: Path, *, standalone_commit: str | None = None) -> dict:
    if standalone_commit is not None:
        require(plugin == home / "ai-worker/services/openclaw-image-command/releases" / standalone_commit,
                "immutable_plugin_release_path_required")
        manifest_path, artifact_root = plugin / "manifest.json", plugin
        raw = owned_public_file(manifest_path)
        manifest = json.loads(raw)
        require(set(manifest) == {"schema", "sourceCommit", "repository", "files"}
            and manifest["schema"] == "aiworker-openclaw-image-command-artifact/v1"
            and manifest["sourceCommit"] == standalone_commit and manifest["repository"] == SOURCE_REPOSITORY,
            "plugin_artifact_identity_invalid")
        members = bounded_files(plugin)
        package_members = dict(members)
        package_members.pop("manifest.json")
    elif plugin.parent.name == "openclaw-plugins" and plugin.name == "aiworker-image-command":
        artifact_root = plugin.parent.parent
        require(artifact_root.parent == home / "ai-worker/services/image-generation/releases"
            and re.fullmatch(r"[a-f0-9]{40}", artifact_root.name) is not None, "previous_plugin_release_path_invalid")
        manifest_path = artifact_root / "manifest.json"
        raw = owned_public_file(manifest_path)
        manifest = json.loads(raw)
        require(manifest.get("schema") == "aiworker-image-service-artifact/v1"
            and manifest.get("sourceCommit") == artifact_root.name
            and manifest.get("sourceRepository") == SOURCE_REPOSITORY, "previous_plugin_manifest_identity_invalid")
        members, package_members = bounded_files(artifact_root), bounded_files(plugin)
    else:
        require(plugin.parent == home / "ai-worker/services/openclaw-image-command/releases"
            and re.fullmatch(r"[a-f0-9]{40}", plugin.name) is not None, "previous_plugin_release_path_invalid")
        return plugin_artifact(home, plugin, standalone_commit=plugin.name)
    require(isinstance(manifest.get("files"), dict) and members == {**manifest["files"], "manifest.json": sha(raw)},
            "plugin_artifact_members_or_digest_drift")
    require(json.loads(owned_public_file(plugin / "openclaw.plugin.json")).get("id") == "aiworker-image-command",
            "plugin_identity_invalid")
    return {"sourceCommit": manifest["sourceCommit"], "manifestSha256": sha(raw),
        "artifactTreeSha256": sha(encoded(members)), "pluginTreeSha256": sha(encoded(package_members)),
        "pluginRoot": str(plugin)}


def profile_process_identity(home: Path, port: int) -> int:
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    job = run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], env)
    match = re.search(r"^\s*pid = ([0-9]+)\s*$", job.stdout, re.MULTILINE)
    require(match is not None, "image_profile_launchagent_pid_unknown")
    pid = int(match.group(1))
    listeners = run(["/usr/sbin/lsof", "-nP", f"-tiTCP:{port}", "-sTCP:LISTEN"], env).stdout.split()
    require(listeners == [str(pid)], "image_profile_listener_not_owned_launchagent")
    return pid


def profile_idle(binary: Path, env: dict) -> dict:
    result = run([str(binary), "--profile", PROFILE, "gateway", "call", "status", "--json"], env)
    value = json.loads(result.stdout)
    require(isinstance(value, dict), "image_profile_status_shape_invalid")
    # 2026.9.2's real status counters; absent activeSessionCount is not zero.
    counters = value.get("tasks", {})
    status = counters.get("byStatus", {}) if isinstance(counters, dict) else {}
    require(isinstance(counters, dict) and type(counters.get("active")) is int and counters["active"] == 0
        and isinstance(status, dict) and all(type(status.get(key)) is int and status[key] == 0 for key in ("queued", "running")),
        "image_profile_idle_unproven")
    require(value.get("degradedPlugins") == [] and value.get("degradedSecretOwners") == [], "image_profile_runtime_degraded")
    health = run([str(binary), "--profile", PROFILE, "health", "--json"], env)
    return {"healthSha256": sha(health.stdout.encode()), "statusSha256": sha(result.stdout.encode()),
        "activity": {"active": 0, "queued": 0, "running": 0}}


def update_plugin_only(args, home: Path, plugin: Path, binary: Path, node: Path, env: dict,
                       node_version: str) -> int:
    state, workspace = home / f".openclaw-{PROFILE}", home / "ai-worker/workspaces" / PROFILE
    receipt_path = home / "ai-worker/state/openclaw-image-studio/install-receipt.json"
    config_path, plist = state / "openclaw.json", home / "Library/LaunchAgents" / f"{LABEL}.plist"
    receipt = json.loads(private_file(receipt_path))
    require(receipt.get("schema") == SCHEMA and receipt.get("profile") == PROFILE
        and receipt.get("currentState") == "SERVICE_HEALTHY_FEISHU_DISABLED" and receipt.get("feishuEnabled") is False,
        "healthy_owned_image_profile_required")
    require(receipt.get("runtime") == {"openclaw": args.expected_openclaw_version, "node": node_version}, "image_profile_runtime_drift")
    before = {"openclaw.json": private_file(config_path), "AGENTS.md": private_file(workspace / "AGENTS.md"),
              "IDENTITY.md": private_file(workspace / "IDENTITY.md")}
    require({name: sha(raw) for name, raw in before.items()} == receipt.get("payloadSha256"), "image_profile_payload_drift")
    config = json.loads(before["openclaw.json"])
    require(config.get("channels") == {} and config.get("agents", {}).get("entries", {}).keys() == {PROFILE}
        and config.get("gateway", {}).get("port") == args.gateway_port, "image_profile_boundary_drift")
    require(verify_installed_service(plist, state, before["openclaw.json"]) == receipt.get("serviceEvidence"), "image_profile_service_drift")
    paths = config.get("plugins", {}).get("load", {}).get("paths")
    require(isinstance(paths, list) and len(paths) == 1, "one_owned_image_plugin_required")
    old_plugin = safe_path(Path(paths[0]), file=False)
    old_artifact = plugin_artifact(home, old_plugin)
    recorded_old = receipt.get("pluginArtifact")
    if recorded_old is not None:
        require(old_artifact == recorded_old, "installed_plugin_artifact_drift")
    else:
        require(old_artifact["pluginTreeSha256"] == receipt.get("sourceEvidence", {}).get("pluginInventorySha256"),
                "installed_plugin_source_drift")
    new_artifact = plugin_artifact(home, plugin, standalone_commit=args.source_commit)
    source = source_identity(ROOT, plugin, args.source_commit, exclude_plugin_manifest=True)
    pid = profile_process_identity(home, args.gateway_port)
    token = keychain_token(home, create=False)
    require(token is not None, "gateway_secret_missing")
    health_env = dict(env, OPENCLAW_GATEWAY_TOKEN=token)
    idle = profile_idle(binary, health_env)
    if str(plugin) == paths[0]:
        require(recorded_old == new_artifact and receipt.get("pluginSourceEvidence") == source, "plugin_update_source_drift")
        print(json.dumps({"currentState": "UNCHANGED_HEALTHY_FEISHU_DISABLED", "profile": PROFILE}))
        return 0
    config["plugins"]["load"]["paths"] = [str(plugin)]
    replacement = encoded(config)
    original = json.loads(before["openclaw.json"])
    config["plugins"]["load"]["paths"] = original["plugins"]["load"]["paths"]
    require(config == original, "plugin_update_changes_outside_load_path")
    print(json.dumps({"currentState": "PLUGIN_UPDATE_READY", "profile": PROFILE, "gatewayPort": args.gateway_port,
        "pluginSourceCommit": args.source_commit, "pluginTreeSha256": new_artifact["pluginTreeSha256"], "feishuEnabled": False}))
    if args.dry_run:
        return 0
    with installation_lock(receipt_path.parent.parent / ".openclaw-image-studio-install.lock"):
        require(private_file(receipt_path) == encoded(receipt) and private_file(config_path) == before["openclaw.json"],
                "plugin_update_cas_changed")
        require(profile_process_identity(home, args.gateway_port) == pid, "plugin_update_gateway_pid_changed")
        profile_idle(binary, health_env)
        require(plugin_artifact(home, old_plugin) == old_artifact
            and plugin_artifact(home, plugin, standalone_commit=args.source_commit) == new_artifact,
            "plugin_update_artifact_changed")
        # Reuse the verified profile recovery object (config/workspace/receipt)
        # without adopting another install commit or writing unchanged workspace.
        backup = verified_profile_backup(home, {**before, "install-receipt.json": encoded(receipt)})
        temporary = config_path.parent / f".openclaw.plugin-update-{os.getpid()}.json"
        create_file(temporary, replacement)
        require(private_file(config_path) == before["openclaw.json"], "plugin_update_config_cas_changed")
        os.replace(temporary, config_path)
        require(private_file(config_path) == replacement, "plugin_update_config_readback_failed")
        try:
            run([str(binary), "--profile", PROFILE, "config", "validate"], env)
            try:
                after_validate_pid = profile_process_identity(home, args.gateway_port)
            except InstallError:
                after_validate_pid = None  # Official config watcher may be restarting.
            for _ in range(3):
                if after_validate_pid != pid:
                    break
                time.sleep(0.2)
                try:
                    after_validate_pid = profile_process_identity(home, args.gateway_port)
                except InstallError:
                    after_validate_pid = None
            restart_method = "official_config_watcher"
            if after_validate_pid == pid:
                profile_idle(binary, health_env)
                run([str(binary), "--profile", PROFILE, "gateway", "restart", "--json"], env)
                restart_method = "official_gateway_restart"
            deadline = time.monotonic() + args.startup_timeout
            while True:
                try:
                    health = profile_idle(binary, health_env)
                    new_pid = profile_process_identity(home, args.gateway_port)
                    require(new_pid != pid, "plugin_update_fresh_restart_unproven")
                    break
                except (InstallError, OSError, ValueError, subprocess.SubprocessError):
                    require(time.monotonic() < deadline, "plugin_update_health_failed")
                    time.sleep(1)
            service = verify_installed_service(plist, state, replacement)
            require(plugin_artifact(home, plugin, standalone_commit=args.source_commit) == new_artifact
                and private_file(config_path) == replacement, "plugin_update_postrestart_drift")
            require(all(private_file(workspace / name) == before[name] for name in ("AGENTS.md", "IDENTITY.md")), "plugin_update_workspace_drift")
            receipt = advance_receipt(receipt_path, receipt, {"originalInstallSourceCommit": receipt.get("originalInstallSourceCommit", receipt["sourceCommit"]),
                "pluginSourceCommit": args.source_commit, "pluginSourceEvidence": source, "pluginArtifact": new_artifact,
                "payloadSha256": {**receipt["payloadSha256"], "openclaw.json": sha(replacement)}, "serviceEvidence": service,
                "healthEvidenceSha256": health["healthSha256"], "recoveryBackup": str(backup), "errorCode": None,
                "pluginUpdateEvidence": {"previousGatewayPid": pid, "gatewayPid": new_pid, "restartMethod": restart_method,
                    "statusSha256": health["statusSha256"]},
                "nextAction": "configure_dedicated_feishu_app_when_user_ready"})
        except (InstallError, OSError, ValueError, subprocess.SubprocessError) as error:
            code = str(error) if isinstance(error, InstallError) else "plugin_update_probe_or_io_failed"
            advance_receipt(receipt_path, receipt, {"currentState": "PLUGIN_UPDATE_NEEDS_INSPECTION", "errorCode": code,
                "recoveryBackup": str(backup), "nextAction": "inspect_only_image_studio_update_and_verified_recovery"})
            raise
    print(json.dumps({"currentState": receipt["currentState"], "profile": PROFILE, "pluginSourceCommit": args.source_commit,
        "gatewayPid": new_pid, "feishuEnabled": False}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--resume", action="store_true", help="Continue one matching, owned incomplete installation.")
    parser.add_argument("--adopt-prepared", action="store_true", help="Move a known inactive prepared profile to identical new plugin source.")
    parser.add_argument("--update-plugin-only", action="store_true", help="Update only one owned healthy image profile's immutable image plugin.")
    parser.add_argument("--previous-source-commit")
    parser.add_argument("--gateway-port", type=int, default=19289)
    parser.add_argument("--image-endpoint", default="http://127.0.0.1:18095")
    parser.add_argument("--plugin-root", required=True, type=Path)
    parser.add_argument("--model-provider-file", type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--expected-openclaw-version", required=True)
    parser.add_argument("--artifact-manifest", type=Path,
                        help="Optional private, externally pinned manifest instead of canonical Git source.")
    parser.add_argument("--artifact-sha256", help="Expected SHA-256 supplied by the verified release controller.")
    parser.add_argument("--startup-timeout", type=int, default=90)
    args = parser.parse_args(argv)
    require(not args.update_plugin_only or not any((args.resume, args.adopt_prepared, args.previous_source_commit,
        args.artifact_manifest, args.artifact_sha256, args.model_provider_file)), "plugin_update_mode_options_invalid")
    require(args.update_plugin_only or args.model_provider_file is not None, "model_provider_file_required")
    require(not args.resume or args.apply, "resume_requires_apply")
    require(not args.adopt_prepared or not args.resume, "prepared_adoption_mode_invalid")
    require(bool(args.previous_source_commit) == args.adopt_prepared, "prepared_adoption_previous_commit_required")
    if args.previous_source_commit:
        require(re.fullmatch(r"[a-f0-9]{40}", args.previous_source_commit) is not None
            and args.previous_source_commit != args.source_commit, "prepared_adoption_previous_commit_invalid")
    home = safe_path(Path.home(), file=False)
    require(platform.system() == "Darwin", "macos_required")
    require(re.fullmatch(r"[a-f0-9]{40}", args.source_commit) is not None, "source_commit_invalid")
    require(10 <= args.startup_timeout <= 3600, "startup_timeout_invalid")
    plugin = safe_path(args.plugin_root, file=False)
    require(plugin.is_relative_to(home / "ai-worker/services"), "managed_plugin_path_required")
    manifest = json.loads((plugin / "openclaw.plugin.json").read_bytes())
    require(manifest.get("id") == "aiworker-image-command", "plugin_identity_invalid")
    if not args.update_plugin_only:
        source = source_identity(ROOT, plugin, args.source_commit, args.artifact_manifest, args.artifact_sha256)
        model = provider_config(json.loads(private_file(args.model_provider_file)))
        config = profile_config(home, args.gateway_port, plugin, args.image_endpoint, model)
    binary, node = home / "ai-worker/bin/openclaw", home / "ai-worker/node/current/bin/node"
    require(binary.is_file() and os.access(binary, os.X_OK) and node.is_file() and os.access(node, os.X_OK),
            "managed_openclaw_runtime_missing")
    require(binary.resolve().is_relative_to(home / "ai-worker") and node.resolve().is_relative_to(home / "ai-worker"),
            "runtime_target_outside_managed_root")
    wrapper = home / "ai-worker/bin/aiworker-openclaw-keychain-secretref"
    require(sha(private_file(wrapper)) == sha((ROOT / "scripts/openclaw-keychain-secretref.sh").read_bytes())
            and stat.S_IMODE(wrapper.stat().st_mode) == 0o700, "keychain_wrapper_mismatch")
    env = cli_environment(home, node)
    version = run([str(binary), "--version"], env).stdout.strip()
    require(re.search(rf"\b{re.escape(args.expected_openclaw_version)}\b", version) is not None,
            "openclaw_version_mismatch")
    node_version = run([str(node), "--version"], env).stdout.strip()
    if args.update_plugin_only:
        return update_plugin_only(args, home, plugin, binary, node, env, node_version)
    state, workspace = home / f".openclaw-{PROFILE}", home / "ai-worker/workspaces" / PROFILE
    receipt_dir = home / "ai-worker/state/openclaw-image-studio"
    receipt_path = receipt_dir / "install-receipt.json"
    plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    for target in (state, workspace, receipt_dir, plist):
        safe_path(target)
    payload = {"openclaw.json": encoded(config), "AGENTS.md": (ROOT / "ops/openclaw-image-studio/AGENTS.md").read_bytes(),
               "IDENTITY.md": (ROOT / "ops/openclaw-image-studio/IDENTITY.md").read_bytes()}
    hashes = {name: sha(data) for name, data in payload.items()}
    ranges = check_port_ranges(home, args.gateway_port)
    existing = receipt_path.exists()
    receipt = None
    if existing:
        receipt = json.loads(private_file(receipt_path))
        if args.adopt_prepared:
            before = verify_prepared_adoption(home, args.previous_source_commit, receipt, payload, state, workspace, plist, source)
            if args.dry_run:
                print(json.dumps({"currentState": "PREPARED_ADOPTION_READY", "profile": PROFILE, "feishuEnabled": False}))
                return 0
            with installation_lock(receipt_dir.parent / ".openclaw-image-studio-install.lock"):
                require(private_file(receipt_path) == encoded(receipt), "prepared_receipt_changed")
                verify_prepared_adoption(home, args.previous_source_commit, receipt, payload, state, workspace, plist, source)
                receipt = adopt_prepared(home, receipt_path, receipt, before, payload, state, workspace, args.source_commit, source)
        require(receipt.get("schema") == SCHEMA and receipt.get("profile") == PROFILE
                and receipt.get("sourceCommit") == args.source_commit and receipt.get("payloadSha256") == hashes
                and receipt.get("sourceEvidence") == source
                and receipt.get("currentState") in {"PAYLOAD_PREPARED", "CONFIG_VALID", "SERVICE_INSTALLED_NEEDS_HEALTH",
                    "SERVICE_HEALTHY_FEISHU_DISABLED"}, "existing_installation_mismatch")
        require(private_file(state / "openclaw.json") == payload["openclaw.json"]
                and all(private_file(workspace / name) == payload[name] for name in ("AGENTS.md", "IDENTITY.md")),
                "existing_payload_drift")
        if receipt["currentState"] in {"SERVICE_INSTALLED_NEEDS_HEALTH", "SERVICE_HEALTHY_FEISHU_DISABLED"}:
            require(verify_installed_service(plist, state, payload["openclaw.json"]) == receipt.get("serviceEvidence"), "existing_service_drift")
        else:
            require(not plist.exists() and not live_ports(args.gateway_port), "partial_service_state_unknown")
        if receipt["currentState"] == "SERVICE_HEALTHY_FEISHU_DISABLED":
            token = keychain_token(home, create=False)
            require(token is not None, "gateway_secret_missing")
            health_env = dict(env, OPENCLAW_GATEWAY_TOKEN=token)
            run([str(binary), "--profile", PROFILE, "health", "--json"], health_env)
            print(json.dumps({"currentState": "UNCHANGED_HEALTHY_FEISHU_DISABLED", "profile": PROFILE}))
            return 0
        require(args.resume or args.adopt_prepared, "owned_incomplete_install_requires_resume")
    else:
        require(not args.adopt_prepared, "prepared_adoption_requires_existing_receipt")
        require(not any(target.exists() for target in (state, workspace, receipt_dir, plist)), "new_target_must_be_absent")
        require(not live_ports(args.gateway_port), "gateway_or_derived_port_busy")
    print(json.dumps({"currentState": "PREFLIGHT_READY", "profile": PROFILE, "gatewayPort": args.gateway_port,
        "derivedLastPort": args.gateway_port + 110, "existingRanges": ranges, "feishuEnabled": False,
        "openclawVersion": args.expected_openclaw_version, "nodeVersion": node_version}))
    if args.dry_run:
        return 0
    # No broad overwrite or force option. Partial failures are preserved for diagnosis.
    lock = receipt_dir.parent / ".openclaw-image-studio-install.lock"
    with installation_lock(lock):
        if not existing:
            require(not any(target.exists() for target in (state, workspace, receipt_dir, plist)), "new_target_changed")
            for directory in (state, workspace, receipt_dir):
                safe_path(directory.parent)
                directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                directory.mkdir(mode=0o700)
            for name, data in payload.items():
                create_file(state / name if name == "openclaw.json" else workspace / name, data)
            receipt = {"schema": SCHEMA, "profile": PROFILE, "sourceCommit": args.source_commit,
                "currentState": "PAYLOAD_PREPARED", "errorCode": None, "nextAction": "validate_config_then_install_service",
                "gatewayPort": args.gateway_port, "derivedLastPort": args.gateway_port + 110,
                "runtime": {"openclaw": args.expected_openclaw_version, "node": node_version}, "payloadSha256": hashes,
                "sourceEvidence": source,
                "feishuEnabled": False, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            create_file(receipt_path, encoded(receipt))
        try:
            token = keychain_token(home, create=True)
            require(token is not None, "gateway_secret_missing")
            if receipt["currentState"] == "PAYLOAD_PREPARED":
                run([str(binary), "--profile", PROFILE, "config", "validate"], env)
                receipt = advance_receipt(receipt_path, receipt, {"currentState": "CONFIG_VALID", "errorCode": None})
            if receipt["currentState"] == "CONFIG_VALID":
                check_port_ranges(home, args.gateway_port)
                require(not live_ports(args.gateway_port) and not plist.exists(), "gateway_or_service_target_changed")
                run([str(binary), "--profile", PROFILE, "gateway", "install", "--port", str(args.gateway_port), "--json"], env)
                service_evidence = verify_installed_service(plist, state, payload["openclaw.json"])
                receipt = advance_receipt(receipt_path, receipt, {"currentState": "SERVICE_INSTALLED_NEEDS_HEALTH",
                    "serviceEvidence": service_evidence, "nextAction": "verify_gateway_health", "errorCode": None})
            health_env = dict(env, OPENCLAW_GATEWAY_TOKEN=token)
            deadline = time.monotonic() + args.startup_timeout
            while True:
                health = run([str(binary), "--profile", PROFILE, "health", "--json"], health_env, check=False, timeout=15)
                if health.returncode == 0:
                    break
                require(time.monotonic() < deadline, "gateway_health_failed")
                time.sleep(1)
            verify_installed_service(plist, state, payload["openclaw.json"])
            receipt = advance_receipt(receipt_path, receipt, {"currentState": "SERVICE_HEALTHY_FEISHU_DISABLED",
                "errorCode": None, "nextAction": "configure_dedicated_feishu_app_when_user_ready",
                "healthEvidenceSha256": sha(health.stdout.encode())})
        except (InstallError, ValueError, OSError, subprocess.SubprocessError) as error:
            code = str(error) if isinstance(error, InstallError) else "installation_probe_or_io_failed"
            advance_receipt(receipt_path, receipt, {"errorCode": code,
                "nextAction": "inspect_owned_installation_then_resume_if_identity_is_proven"})
            raise
    print(json.dumps({"currentState": receipt["currentState"], "profile": PROFILE, "gatewayPort": args.gateway_port,
                      "receipt": str(receipt_path), "feishuEnabled": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InstallError, ValueError, OSError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, InstallError) else "installation_probe_or_io_failed"
        print(json.dumps({"currentState": "INCOMPLETE", "errorCode": code,
                          "nextAction": "inspect_only_image_studio_owned_targets_before_recovery"}), file=sys.stderr)
        raise SystemExit(1)

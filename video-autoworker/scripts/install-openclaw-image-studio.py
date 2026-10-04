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
                    manifest_sha: str | None = None, extra_sources: tuple[Path, ...] = ()) -> dict:
    required = [source / "scripts/install-openclaw-image-studio.py", source / "scripts/openclaw-keychain-secretref.sh",
                *sorted((source / "ops/openclaw-image-studio").glob("*"))]
    required.extend(extra_sources)
    plugin_members = bounded_files(plugin)
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


def keychain_token(home: Path, *, create: bool) -> str | None:
    """Use Security.framework so the secret never appears in argv or files."""
    require(platform.system() == "Darwin", "macos_keychain_required")
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainOpen.restype = ctypes.c_int32
    security.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
        ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainAddGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
        ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
    security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    keychain = ctypes.c_void_p()
    status = security.SecKeychainOpen(str(home / "Library/Keychains/login.keychain-db").encode(), ctypes.byref(keychain))
    require(status == 0, "keychain_open_failed")
    account, service = TOKEN_ACCOUNT.encode(), TOKEN_SERVICE.encode()
    length, data = ctypes.c_uint32(), ctypes.c_void_p()
    status = security.SecKeychainFindGenericPassword(keychain, len(service), service, len(account), account,
                                                    ctypes.byref(length), ctypes.byref(data), None)
    if status == 0:
        try:
            token = ctypes.string_at(data, length.value).decode()
        finally:
            security.SecKeychainItemFreeContent(None, data)
        require(re.fullmatch(r"[a-f0-9]{64}", token) is not None, "existing_gateway_token_invalid")
        return token
    require(status == -25300, "keychain_read_failed")  # errSecItemNotFound only.
    if not create:
        return None
    token = secrets.token_hex(32)
    raw = token.encode()
    status = security.SecKeychainAddGenericPassword(keychain, len(service), service, len(account), account,
                                                   len(raw), raw, None)
    require(status == 0, "keychain_create_failed")  # No update/replace API exists here.
    require(keychain_token(home, create=False) == token, "keychain_readback_failed")
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--resume", action="store_true", help="Continue one matching, owned incomplete installation.")
    parser.add_argument("--gateway-port", type=int, default=19289)
    parser.add_argument("--image-endpoint", default="http://127.0.0.1:18095")
    parser.add_argument("--plugin-root", required=True, type=Path)
    parser.add_argument("--model-provider-file", required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--expected-openclaw-version", required=True)
    parser.add_argument("--artifact-manifest", type=Path,
                        help="Optional private, externally pinned manifest instead of canonical Git source.")
    parser.add_argument("--artifact-sha256", help="Expected SHA-256 supplied by the verified release controller.")
    parser.add_argument("--startup-timeout", type=int, default=90)
    args = parser.parse_args(argv)
    require(not args.resume or args.apply, "resume_requires_apply")
    home = safe_path(Path.home(), file=False)
    require(platform.system() == "Darwin", "macos_required")
    require(re.fullmatch(r"[a-f0-9]{40}", args.source_commit) is not None, "source_commit_invalid")
    require(10 <= args.startup_timeout <= 3600, "startup_timeout_invalid")
    plugin = safe_path(args.plugin_root, file=False)
    require(plugin.is_relative_to(home / "ai-worker/services"), "managed_plugin_path_required")
    manifest = json.loads((plugin / "openclaw.plugin.json").read_bytes())
    require(manifest.get("id") == "aiworker-image-command", "plugin_identity_invalid")
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
        require(args.resume, "owned_incomplete_install_requires_resume")
    else:
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

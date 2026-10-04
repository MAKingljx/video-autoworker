"""Verify boundaries of the independent profile installer without touching macOS services."""
import copy
import ctypes
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/install-openclaw-image-studio.py"
SPEC = importlib.util.spec_from_file_location("image_profile_install", SCRIPT)
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


def public_model():
    return {"provider": {"baseUrl": "http://127.0.0.1:18091/v1", "api": "openai-completions",
        "apiKey": "not-needed", "auth": "api-key", "request": {"allowPrivateNetwork": True},
        "models": [{"id": "default_model", "name": "Local chat", "reasoning": False,
                    "input": ["text", "image"], "contextWindow": 262144, "maxTokens": 4096,
                    "compat": {"supportsTools": True, "thinkingFormat": "qwen-chat-template"}}]},
        "modelParameters": {"chat_template_kwargs": {"enable_thinking": False}}, "thinkingDefault": "off"}


class ProfileInstallTests(unittest.TestCase):
    def test_profile_isolated_secretref_channels_closed_and_tools_narrow(self):
        config = install.profile_config(Path("/Users/h1"), 19289,
            Path("/Users/h1/ai-worker/services/image/plugin"), "http://127.0.0.1:18095",
            install.provider_config(public_model()))
        self.assertEqual(config["channels"], {})
        self.assertEqual(config["session"]["dmScope"], "per-account-channel-peer")
        self.assertEqual(config["gateway"]["bind"], "loopback")
        self.assertEqual(config["gateway"]["auth"]["token"]["source"], "exec")
        self.assertNotIn("token", config["secrets"]["providers"]["image-studio-keychain"])
        agent = config["agents"]["entries"]["image-studio"]
        self.assertEqual(list(config["agents"]["entries"]), ["image-studio"])
        self.assertEqual(agent["workspace"], "/Users/h1/ai-worker/workspaces/image-studio")
        self.assertEqual(agent["agentDir"], "/Users/h1/.openclaw-image-studio/agents/image-studio/agent")
        self.assertEqual(agent["tools"]["alsoAllow"], ["aiworker_generate_image"])
        self.assertIn("exec", agent["tools"]["deny"])
        self.assertFalse(config["browser"]["enabled"])
        self.assertFalse(config["cron"]["enabled"])
        self.assertEqual(config["agents"]["defaults"]["thinkingDefault"], "off")
        self.assertFalse(config["models"]["providers"]["qwen36-tools-local"]["models"][0]["reasoning"])

    def test_provider_rejects_secret_and_external_network_fields(self):
        for mutate in [lambda p: p["provider"].update(apiKey="actual-secret"),
                       lambda p: p["provider"].update(headers={"Authorization": "secret"}),
                       lambda p: p["provider"].update(baseUrl="https://provider.example/v1"),
                       lambda p: p["provider"]["models"][0].update(apiKey="secret"),
                       lambda p: p["modelParameters"].update(authorization="secret"),
                       lambda p: p["modelParameters"]["chat_template_kwargs"].update(secret="secret")]:
            with self.subTest(mutate=mutate):
                candidate = public_model()
                mutate(candidate)
                with self.assertRaises(install.InstallError):
                    install.provider_config(candidate)

    def test_provider_copy_cannot_modify_original(self):
        value = public_model()
        before = copy.deepcopy(value)
        copied = install.provider_config(value)
        copied["provider"]["models"][0]["contextWindow"] = 8192
        self.assertEqual(value, before)

    def test_entire_derived_range_conflicts_are_detected_even_with_browser_disabled(self):
        with tempfile.TemporaryDirectory() as task_dir:
            home = Path(task_dir).resolve()
            state = home / ".openclaw-existing"
            state.mkdir()
            (state / "openclaw.json").write_text(json.dumps({"gateway": {"port": 19180}}))
            with self.assertRaisesRegex(install.InstallError, "derived_port_range_overlap"):
                install.check_port_ranges(home, 19289)
            ranges = install.check_port_ranges(home, 19300)
            self.assertEqual(ranges, [{"profile": "existing", "base": 19180, "last": 19290}])

    def test_invalid_existing_profile_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as task_dir:
            home = Path(task_dir).resolve()
            state = home / ".openclaw-existing"
            state.mkdir()
            (state / "openclaw.json").write_text("{")
            with self.assertRaisesRegex(install.InstallError, "existing_profile_config_invalid"):
                install.check_port_ranges(home, 19289)

    def test_existing_file_and_symlink_never_overwritten(self):
        with tempfile.TemporaryDirectory() as task_dir:
            root = Path(task_dir).resolve()
            path = root / "owned.json"
            install.create_file(path, b"original")
            with self.assertRaises(FileExistsError):
                install.create_file(path, b"replacement")
            self.assertEqual(path.read_bytes(), b"original")
            (root / "alias").symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(install.InstallError, "symlink_target_rejected"):
                install.safe_path(root / "alias/new.json")
            path.chmod(0o644)
            with self.assertRaisesRegex(install.InstallError, "private_file_required"):
                install.private_file(path)

    def test_parent_profile_environment_removed_and_new_identity_explicit(self):
        with patch.dict(os.environ, {"OPENCLAW_PROFILE": "gpt-main", "OPENCLAW_STATE_DIR": "/other",
             "OPENCLAW_GATEWAY_TOKEN": "secret", "GATEWAY_TOKEN": "secret", "NODE_OPTIONS": "--inspect",
             "FEISHU_APP_SECRET": "another-bot-secret", "OPENAI_API_KEY": "another-provider-secret"}):
            env = install.cli_environment(Path("/Users/h1"), Path("/Users/h1/ai-worker/node/current/bin/node"))
        self.assertEqual(env["OPENCLAW_PROFILE"], "image-studio")
        self.assertEqual(env["OPENCLAW_STATE_DIR"], "/Users/h1/.openclaw-image-studio")
        self.assertEqual(env["OPENCLAW_CONFIG_PATH"], "/Users/h1/.openclaw-image-studio/openclaw.json")
        self.assertEqual(env["OPENCLAW_LAUNCHD_LABEL"], "ai.openclaw.image-studio")
        self.assertNotIn("OPENCLAW_GATEWAY_TOKEN", env)
        self.assertNotIn("GATEWAY_TOKEN", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("FEISHU_APP_SECRET", env)
        self.assertNotIn("OPENAI_API_KEY", env)

    def test_endpoint_cannot_embed_credentials_or_other_path(self):
        for endpoint in ["http://localhost:18095", "http://127.0.0.1:18095/", "http://127.0.0.1:18095?x=1",
                         "http://secret@127.0.0.1:18095", "http://0.0.0.0:18095"]:
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(install.InstallError):
                    install.loopback_url(endpoint)

    def test_keychain_existing_secret_never_written_or_replaced(self):
        framework = FakeSecurity("a" * 64)
        with patch.object(install.platform, "system", return_value="Darwin"), patch.object(install.ctypes, "CDLL", return_value=framework), \
             patch.object(install.subprocess, "run", side_effect=framework.security_actor):
            self.assertEqual(install.keychain_token(Path("/Users/h1"), create=True), "a" * 64)
        self.assertEqual(framework.add_count, 0)

    def test_keychain_only_item_not_found_can_create_and_create_is_read_back(self):
        framework = FakeSecurity(None)
        with patch.object(install.platform, "system", return_value="Darwin"), patch.object(install.ctypes, "CDLL", return_value=framework), \
             patch.object(install.subprocess, "run", side_effect=framework.security_actor):
            token = install.keychain_token(Path("/Users/h1"), create=True)
        self.assertRegex(token, "^[a-f0-9]{64}$")
        self.assertEqual(framework.value, token)
        self.assertEqual(framework.add_count, 1)
        framework = FakeSecurity(None, status=-25293)
        with patch.object(install.platform, "system", return_value="Darwin"), patch.object(install.ctypes, "CDLL", return_value=framework), \
             patch.object(install.subprocess, "run", side_effect=framework.security_actor):
            with self.assertRaisesRegex(install.InstallError, "keychain_read_failed_osstatus"):
                install.keychain_token(Path("/Users/h1"), create=True)
        self.assertEqual(framework.add_count, 0)

    def test_inaccessible_session_keychain_stops_before_read_or_creation_without_retry(self):
        framework = FakeSecurity(None)
        framework.bits = 2
        with patch.object(install.platform, "system", return_value="Darwin"), patch.object(install.ctypes, "CDLL", return_value=framework), \
             patch.object(install.subprocess, "run") as actor:
            with self.assertRaisesRegex(install.InstallError, "keychain_unavailable_in_current_session_use_authenticated_gui_context"):
                install.keychain_token(Path("/Users/h1"), create=True)
        actor.assert_not_called()

    def test_new_token_only_stdin_and_fixed_security_actor_acl(self):
        framework = FakeSecurity(None)
        with patch.object(install.platform, "system", return_value="Darwin"), patch.object(install.ctypes, "CDLL", return_value=framework), \
             patch.object(install.subprocess, "run", side_effect=framework.security_actor):
            token = install.keychain_token(Path("/Users/h1"), create=True)
        create_call = [call for call in framework.calls if call[0] == ["/usr/bin/security", "-i"]][0]
        self.assertNotIn(token, " ".join(create_call[0]))
        words = shlex.split(create_call[1]["input"].splitlines()[0])
        self.assertEqual(words[words.index("-T") + 1], "/usr/bin/security")
        self.assertNotIn("-U", words)
        self.assertEqual(words[words.index("-w") + 1], token)
        self.assertTrue(create_call[1]["capture_output"])

    def test_complete_install_and_repeated_apply_preserve_existing_files_and_token(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(install.main(fixture.arguments("--apply")), 0)
                before = fixture.managed_bytes()
                calls_before = list(fixture.commands)
                self.assertEqual(install.main(fixture.arguments("--apply")), 0)
            self.assertEqual(fixture.managed_bytes(), before)
            self.assertEqual(fixture.keychain_creates, 1)
            install_calls = [c for c in fixture.commands if "install" in c]
            self.assertEqual(len(install_calls), 1)
            self.assertFalse(any("--force" in c for c in fixture.commands))
            self.assertLess(next(i for i, c in enumerate(calls_before) if "validate" in c),
                            next(i for i, c in enumerate(calls_before) if "install" in c))
            receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_text())
            self.assertEqual(receipt["currentState"], "SERVICE_HEALTHY_FEISHU_DISABLED")
            self.assertFalse(receipt["feishuEnabled"])
            self.assertNotIn("a" * 64, json.dumps(receipt))

    def test_offline_config_failure_leaves_owned_receipt_then_resume_without_overwrite(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            fixture.fail_validation = True
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(install.InstallError):
                    install.main(fixture.arguments("--apply"))
                self.assertFalse(any("install" in c for c in fixture.commands))
                before = (fixture.home / ".openclaw-image-studio/openclaw.json").read_bytes()
                receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_text())
                self.assertEqual(receipt["currentState"], "PAYLOAD_PREPARED")
                self.assertEqual(receipt["errorCode"], "component_command_failed")
                fixture.fail_validation = False
                with self.assertRaisesRegex(install.InstallError, "owned_incomplete_install_requires_resume"):
                    install.main(fixture.arguments("--apply"))
                self.assertEqual(install.main(fixture.arguments("--apply") + ["--resume"]), 0)
            self.assertEqual((fixture.home / ".openclaw-image-studio/openclaw.json").read_bytes(), before)
            self.assertEqual(fixture.keychain_creates, 1)
            self.assertFalse((fixture.home / "ai-worker/state/.openclaw-image-studio-install.lock").exists())

    def test_occupied_target_dry_run_does_not_create_files_or_secret(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            target = fixture.home / ".openclaw-image-studio"
            target.mkdir()
            (target / "unrelated").write_text("preserve")
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(install.InstallError, "new_target_must_be_absent"):
                    install.main(fixture.arguments("--dry-run"))
            self.assertEqual((target / "unrelated").read_text(), "preserve")
            self.assertFalse((target / "openclaw.json").exists())
            self.assertEqual(fixture.keychain_creates, 0)

    def test_service_health_failure_resumes_without_second_install(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            fixture.fail_health = True
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(install.time, "monotonic", side_effect=[0, 11]):
                    with self.assertRaisesRegex(install.InstallError, "gateway_health_failed"):
                        install.main(fixture.arguments("--apply") + ["--startup-timeout", "10"])
                receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_text())
                self.assertEqual(receipt["currentState"], "SERVICE_INSTALLED_NEEDS_HEALTH")
                self.assertEqual(receipt["errorCode"], "gateway_health_failed")
                fixture.fail_health = False
                self.assertEqual(install.main(fixture.arguments("--apply") + ["--resume"]), 0)
            self.assertEqual(len([c for c in fixture.commands if "install" in c]), 1)
            self.assertEqual(fixture.keychain_creates, 1)

    def test_existing_config_drift_rejects_resume_without_overwriting(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(install.main(fixture.arguments("--apply")), 0)
                config = fixture.home / ".openclaw-image-studio/openclaw.json"
                value = json.loads(config.read_text())
                value["channels"] = {"feishu": {"enabled": False}}
                config.write_bytes(install.encoded(value))
                with self.assertRaisesRegex(install.InstallError, "existing_payload_drift"):
                    install.main(fixture.arguments("--apply") + ["--resume"])
            self.assertEqual(json.loads(config.read_text())["channels"], {"feishu": {"enabled": False}})

    def test_pinned_artifact_requires_exact_members_and_bytes(self):
        with tempfile.TemporaryDirectory() as task_dir:
            base = Path(task_dir).resolve()
            source, plugin, manifest = artifact_fixture(base)
            expected = install.sha(manifest.read_bytes())
            evidence = install.source_identity(source, plugin, "b" * 40, manifest, expected)
            self.assertEqual(evidence["mode"], "audited_artifact")
            (plugin / "index.js").write_text("changed implementation")
            with self.assertRaisesRegex(install.InstallError, "artifact_manifest_members_or_digest_mismatch"):
                install.source_identity(source, plugin, "b" * 40, manifest, expected)

    def test_unpinned_or_foreign_artifact_cannot_claim_source_commit(self):
        with tempfile.TemporaryDirectory() as task_dir:
            base = Path(task_dir).resolve()
            source, plugin, manifest = artifact_fixture(base)
            with self.assertRaisesRegex(install.InstallError, "artifact_manifest_digest_required"):
                install.source_identity(source, plugin, "b" * 40, manifest)
            with self.assertRaisesRegex(install.InstallError, "artifact_manifest_digest_mismatch"):
                install.source_identity(source, plugin, "b" * 40, manifest, "d" * 64)
            value = json.loads(manifest.read_text())
            value["sourceRepository"] = "https://github.com/other/project"
            manifest.write_bytes(install.encoded(value))
            with self.assertRaisesRegex(install.InstallError, "artifact_manifest_identity_invalid"):
                install.source_identity(source, plugin, "b" * 40, manifest, install.sha(manifest.read_bytes()))

    def test_canonical_probe_rejects_wrong_commit_even_if_valid_format(self):
        with tempfile.TemporaryDirectory() as task_dir:
            base = Path(task_dir).resolve()
            source, plugin, manifest = artifact_fixture(base)
            def fake_git(command, **kwargs):
                if "--show-toplevel" in command:
                    stdout = (str(source) + "\n").encode()
                else:
                    stdout = ("a" * 40 + "\n").encode()
                return subprocess.CompletedProcess(command, 0, stdout, b"")
            with patch.object(install.subprocess, "run", side_effect=fake_git):
                with self.assertRaisesRegex(install.InstallError, "canonical_git_commit_mismatch"):
                    install.source_identity(source, plugin, "b" * 40)

    def test_native_launchagent_environment_is_read_not_executed_and_rejects_embedded_secret(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            state = fixture.home / ".openclaw-image-studio"
            state.mkdir(mode=0o700)
            config = install.encoded(install.profile_config(fixture.home, 19289, fixture.plugin,
                "http://127.0.0.1:18095", install.provider_config(public_model())))
            install.create_file(state / "openclaw.json", config)
            env_dir = state / "service-env"
            env_dir.mkdir(mode=0o700)
            wrapper = env_dir / "ai.openclaw.image-studio-env-wrapper.sh"
            wrapper.write_bytes(b'#!/bin/sh\nset -eu\nenv_file="$1"\nshift\nif [ -f "$env_file" ]; then\n  . "$env_file"\nfi\nexec "$@"\n')
            wrapper.chmod(0o700)
            env = env_dir / "ai.openclaw.image-studio.env"
            content = "\n".join("export " + key + "='" + value + "'" for key, value in {
                "OPENCLAW_PROFILE": "image-studio", "OPENCLAW_STATE_DIR": str(state),
                "OPENCLAW_CONFIG_PATH": str(state / "openclaw.json"), "OPENCLAW_GATEWAY_PORT": "19289"}.items()) + "\n"
            install.create_file(env, content.encode())
            plist = fixture.home / "Library/LaunchAgents/ai.openclaw.image-studio.plist"
            value = {"Label": install.LABEL, "ProgramArguments": ["/bin/sh", str(wrapper), str(env), "node", "entry.js", "gateway", "--port", "19289"]}
            plist.write_bytes(plistlib.dumps(value))
            plist.chmod(0o644)  # Official generated plist is public; env remains 0600.
            evidence = install.verify_installed_service(plist, state, config)
            self.assertEqual(evidence["environmentSha256"], install.sha(content.encode()))
            env.write_bytes((content + "export OPENCLAW_GATEWAY_TOKEN='" + "a" * 64 + "'\n").encode())
            with self.assertRaisesRegex(install.InstallError, "service_embedded_secret_rejected"):
                install.verify_installed_service(plist, state, config)

    def test_known_inactive_prepared_profile_adopts_same_plugin_without_replacing_state(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture = InstallFixture(Path(task_dir).resolve())
            old_plugin = fixture.home / ("ai-worker/services/image-generation/releases/" + "b" * 40) / "openclaw-plugins/aiworker-image-command"
            old_plugin.mkdir(parents=True, mode=0o700)
            (old_plugin / "openclaw.plugin.json").write_bytes((fixture.plugin / "openclaw.plugin.json").read_bytes())
            fixture.plugin = old_plugin
            fixture.fail_validation = True
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(install.InstallError):
                    install.main(fixture.arguments("--apply"))
                state = fixture.home / ".openclaw-image-studio"
                identity = (state.stat().st_dev, state.stat().st_ino)
                new_plugin = fixture.home / ("ai-worker/services/image-generation/releases/" + "d" * 40) / "openclaw-plugins/aiworker-image-command"
                new_plugin.mkdir(parents=True, mode=0o700)
                (new_plugin / "openclaw.plugin.json").write_bytes((old_plugin / "openclaw.plugin.json").read_bytes())
                fixture.plugin = new_plugin
                fixture.fail_validation = False
                args = fixture.arguments("--apply", commit="d" * 40) + ["--adopt-prepared", "--previous-source-commit", "b" * 40]
                self.assertEqual(install.main(args), 0)
            self.assertEqual((state.stat().st_dev, state.stat().st_ino), identity)
            receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_bytes())
            self.assertEqual(receipt["sourceCommit"], "d" * 40)
            self.assertEqual(receipt["previousSourceCommit"], "b" * 40)
            self.assertTrue(Path(receipt["recoveryBackup"]).exists())
            self.assertEqual(fixture.keychain_creates, 1)
            self.assertEqual(len([command for command in fixture.commands if "install" in command]), 1)


class FakeFunction:
    def __init__(self, callback):
        self.callback = callback

    def __call__(self, *args):
        return self.callback(*args)


class FakeSecurity:
    def __init__(self, value, status=-25300):
        self.value, self.status, self.add_count, self.buffers = value, status, 0, []
        self.bits, self.calls = 7, []
        self.SecKeychainOpen = FakeFunction(self.open)
        self.SecKeychainGetStatus = FakeFunction(self.get_status)
        self.SecKeychainFindGenericPassword = FakeFunction(self.find)
        self.SecKeychainAddGenericPassword = FakeFunction(self.add)
        self.SecKeychainItemFreeContent = FakeFunction(lambda *args: 0)

    def open(self, path, output):
        ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = 123
        return 0

    def get_status(self, keychain, output):
        ctypes.cast(output, ctypes.POINTER(ctypes.c_uint32))[0] = self.bits
        return 0

    def security_actor(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command == ["/usr/bin/security", "-i"]:
            words = shlex.split(kwargs["input"].splitlines()[0])
            self.value = words[words.index("-w") + 1]
            self.add_count += 1
            return subprocess.CompletedProcess(command, 0, kwargs["input"], "")
        if self.value is None:
            return subprocess.CompletedProcess(command, 44 if self.status == -25300 else 51, "", "not found or inaccessible")
        return subprocess.CompletedProcess(command, 0, self.value + "\n", "")

    def find(self, keychain, slen, service, alen, account, length, data, item):
        if self.value is None:
            return self.status
        raw = self.value.encode()
        buffer = ctypes.create_string_buffer(raw)
        self.buffers.append(buffer)
        ctypes.cast(length, ctypes.POINTER(ctypes.c_uint32))[0] = len(raw)
        ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(buffer)
        return 0

    def add(self, keychain, slen, service, alen, account, length, data, item):
        self.add_count += 1
        self.value = ctypes.string_at(data, length).decode()
        return 0


class InstallFixture:
    def __init__(self, home):
        self.home, self.commands, self.keychain_creates = home, [], 0
        self.secret = None
        self.fail_validation = False
        self.fail_health = False
        self.plugin = home / "ai-worker/services/image/plugin"
        for directory in [self.plugin, home / "ai-worker/bin", home / "ai-worker/node/current/bin",
                          home / "Library/LaunchAgents", home / "ai-worker/state"]:
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        (self.plugin / "openclaw.plugin.json").write_text(json.dumps({"id": "aiworker-image-command"}))
        for path in [home / "ai-worker/bin/openclaw", home / "ai-worker/node/current/bin/node"]:
            path.write_text("unused fake executable")
            path.chmod(0o700)
        wrapper = home / "ai-worker/bin/aiworker-openclaw-keychain-secretref"
        wrapper.write_bytes((install.ROOT / "scripts/openclaw-keychain-secretref.sh").read_bytes())
        wrapper.chmod(0o700)
        self.provider = home / "provider.json"
        self.provider.write_text(json.dumps(public_model()))
        self.provider.chmod(0o600)

    def arguments(self, mode, *, commit="b" * 40):
        return [mode, "--plugin-root", str(self.plugin), "--model-provider-file", str(self.provider),
                "--source-commit", commit, "--expected-openclaw-version", "2026.9.2"]

    @contextlib.contextmanager
    def patches(self):
        with patch.object(install.Path, "home", return_value=self.home), \
             patch.object(install.platform, "system", return_value="Darwin"), \
             patch.object(install, "run", side_effect=self.run), \
             patch.object(install, "keychain_token", side_effect=self.keychain), \
             patch.object(install, "live_ports", return_value=set()), \
             patch.object(install, "source_identity", side_effect=lambda source, plugin, commit, *args: {"mode": "canonical_git", "sourceCommit": commit,
                 "payloadInventorySha256": "c" * 64, "pluginInventorySha256": install.sha(install.encoded(install.bounded_files(plugin)))}):
            yield

    def keychain(self, home, *, create):
        if create and self.secret is None:
            self.secret = "a" * 64
            self.keychain_creates += 1
        return self.secret

    def run(self, command, env, *, check=True, timeout=120):
        self.commands.append(command)
        if command[:2] == ["/bin/launchctl", "print"]:
            return subprocess.CompletedProcess(command, 113, "", "Could not find service")
        stdout, code = "{}", 0
        if "--version" in command:
            stdout = "OpenClaw 2026.9.2"
        if command[1:] == ["--version"] and command[0].endswith("/node"):
            stdout = "v22.22.3"
        if "validate" in command and self.fail_validation:
            if check:
                raise install.InstallError("component_command_failed")
            code = 1
        if "health" in command and self.fail_health:
            code = 1
        if "install" in command:
            installed = {"Label": install.LABEL, "EnvironmentVariables": {
                "OPENCLAW_PROFILE": install.PROFILE,
                "OPENCLAW_GATEWAY_PORT": "19289",
                "OPENCLAW_STATE_DIR": str(self.home / ".openclaw-image-studio"),
                "OPENCLAW_CONFIG_PATH": str(self.home / ".openclaw-image-studio/openclaw.json")},
                "ProgramArguments": [str(self.home / "ai-worker/node/current/bin/node"), "entry.js", "gateway", "--port", "19289"]}
            install.create_file(self.home / "Library/LaunchAgents/ai.openclaw.image-studio.plist", plistlib.dumps(installed))
        return subprocess.CompletedProcess(command, code, stdout, "")

    def managed_bytes(self):
        return {str(path): path.read_bytes() for base in [self.home / ".openclaw-image-studio",
                  self.home / "ai-worker/workspaces/image-studio", self.home / "ai-worker/state/openclaw-image-studio",
                  self.home / "Library/LaunchAgents"] for path in base.rglob("*") if path.is_file()}


def artifact_fixture(base):
    source = base / "payload"
    plugin = source / "openclaw-plugins/aiworker-image-command"
    for directory in [source / "scripts", source / "ops/openclaw-image-studio", plugin]:
        directory.mkdir(parents=True, mode=0o700)
    for relative in ["scripts/install-openclaw-image-studio.py", "scripts/openclaw-keychain-secretref.sh",
                     "ops/openclaw-image-studio/profile.template.json", "ops/openclaw-image-studio/AGENTS.md",
                     "ops/openclaw-image-studio/IDENTITY.md", "openclaw-plugins/aiworker-image-command/index.js"]:
        (source / relative).write_text("declared payload")
    manifest = base / "manifest.json"
    manifest.write_bytes(install.encoded({"schema": "aiworker-openclaw-image-studio-artifact/v1",
        "sourceRepository": install.SOURCE_REPOSITORY, "sourceCommit": "b" * 40,
        "artifactRoot": str(source), "files": install.bounded_files(source)}))
    manifest.chmod(0o600)
    return source, plugin, manifest


if __name__ == "__main__":
    unittest.main()

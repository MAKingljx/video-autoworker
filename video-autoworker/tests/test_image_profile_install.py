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
    @unittest.skipUnless(os.path.exists('/usr/bin/security'), 'Requires macOS security CLI')
    def test_real_interactive_cli_ends_at_eof_without_false_failure(self):
        # Read-only help exercises the actual transport without creating items.
        result = subprocess.run(['/usr/bin/security', '-i'],
                                input=install.security_interactive_input(['help']),
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)

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

    def test_plugin_only_update_changes_only_path_and_preserves_install_source_and_keychain(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture, new_plugin = plugin_update_fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()), patch.object(install.time, "sleep"):
                install.main(fixture.arguments("--apply"))
                state = fixture.home / ".openclaw-image-studio"
                before = json.loads((state / "openclaw.json").read_bytes())
                workspace = {name: (fixture.home / "ai-worker/workspaces/image-studio" / name).read_bytes() for name in ("AGENTS.md", "IDENTITY.md")}
                self.assertEqual(install.main(fixture.plugin_arguments("--apply", new_plugin)), 0)
            after = json.loads((state / "openclaw.json").read_bytes())
            self.assertEqual(after["plugins"]["load"]["paths"], [str(new_plugin)])
            after["plugins"]["load"]["paths"] = before["plugins"]["load"]["paths"]
            self.assertEqual(after, before)
            receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_bytes())
            self.assertEqual(receipt["sourceCommit"], "b" * 40)
            self.assertEqual(receipt["originalInstallSourceCommit"], "b" * 40)
            self.assertEqual(receipt["pluginSourceCommit"], "d" * 40)
            self.assertEqual(receipt["pluginArtifact"]["pluginRoot"], str(new_plugin))
            self.assertEqual(receipt["currentState"], "SERVICE_HEALTHY_FEISHU_DISABLED")
            self.assertEqual(fixture.keychain_creates, 1)
            restarts = [command for command in fixture.commands if "restart" in command]
            self.assertEqual(restarts, [[str(fixture.home / "ai-worker/bin/openclaw"), "--profile", "image-studio", "gateway", "restart", "--json"]])
            self.assertTrue(all((fixture.home / "ai-worker/workspaces/image-studio" / name).read_bytes() == raw for name, raw in workspace.items()))

    def test_plugin_update_reuses_fresh_official_watcher_restart_without_second_restart(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture, new_plugin = plugin_update_fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()), patch.object(install.time, "sleep"):
                install.main(fixture.arguments("--apply"))
                fixture.watcher_restart = True
                install.main(fixture.plugin_arguments("--apply", new_plugin))
            self.assertFalse(any("restart" in command for command in fixture.commands))
            receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_bytes())
            self.assertEqual(receipt["pluginUpdateEvidence"]["restartMethod"], "official_config_watcher")

    def test_plugin_update_rejects_config_old_package_drift_and_busy_profile(self):
        for scenario, error in [("config", "image_profile_payload_drift"), ("package", "plugin_artifact_members_or_digest_drift"),
                                ("busy", "image_profile_idle_unproven")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as task_dir:
                fixture, new_plugin = plugin_update_fixture(Path(task_dir).resolve())
                with fixture.patches(), contextlib.redirect_stdout(io.StringIO()), patch.object(install.time, "sleep"):
                    install.main(fixture.arguments("--apply"))
                    if scenario == "config":
                        config = fixture.home / ".openclaw-image-studio/openclaw.json"
                        config.write_bytes(config.read_bytes() + b" ")
                    elif scenario == "package":
                        (fixture.plugin / "openclaw.plugin.json").write_text('{"id":"aiworker-image-command","changed":true}')
                    else:
                        fixture.active_tasks = 1
                    with self.assertRaisesRegex(install.InstallError, error):
                        install.main(fixture.plugin_arguments("--apply", new_plugin))
                self.assertFalse(any("restart" in command for command in fixture.commands))

    def test_plugin_update_dry_run_never_changes_configuration_or_creates_backup(self):
        with tempfile.TemporaryDirectory() as task_dir:
            fixture, new_plugin = plugin_update_fixture(Path(task_dir).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"))
                before = fixture.managed_bytes()
                install.main(fixture.plugin_arguments("--dry-run", new_plugin))
            self.assertEqual(fixture.managed_bytes(), before)
            self.assertFalse((fixture.home / "ai-worker/backups/openclaw-image-studio").exists())


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
        self.gateway_pid, self.active_tasks, self.watcher_restart = None, 0, False
        self.core_version = "2026.9.2"
        self.node24 = None
        self.next_launch_pid = 200
        self.active_work = {key: 0 for key in ("rootRequests", "cronRuns", "sessionMutations", "terminalPersistence", "lifecycleWrites")}
        self.bridge_changes, self.bridge_calls = {}, []
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

    def plugin_arguments(self, mode, plugin):
        return [mode, "--update-plugin-only", "--plugin-root", str(plugin), "--source-commit", "d" * 40,
                "--expected-openclaw-version", "2026.9.2"]

    @contextlib.contextmanager
    def patches(self):
        with patch.object(install.Path, "home", return_value=self.home), \
             patch.object(install.platform, "system", return_value="Darwin"), \
             patch.object(install, "run", side_effect=self.run), \
             patch.object(install, "keychain_token", side_effect=self.keychain), \
             patch.object(install, "live_ports", return_value=set()), \
             patch.object(install, "source_identity", side_effect=lambda source, plugin, commit, *args, **kwargs: {"mode": "canonical_git", "sourceCommit": commit,
                 "payloadInventorySha256": "c" * 64, "pluginInventorySha256": install.sha(install.encoded({name: digest for name, digest in install.bounded_files(plugin).items()
                 if not (kwargs.get("exclude_plugin_manifest") and name == "manifest.json")}))}):
            yield

    def keychain(self, home, *, create):
        if create and self.secret is None:
            self.secret = "a" * 64
            self.keychain_creates += 1
        return self.secret

    def run(self, command, env, *, check=True, timeout=120):
        self.commands.append(command)
        if command[:2] == ["/bin/launchctl", "bootout"]:
            self.gateway_pid = None
            return subprocess.CompletedProcess(command, 0, "", "")
        if command[:2] == ["/bin/launchctl", "bootstrap"]:
            self.gateway_pid = self.next_launch_pid
            self.next_launch_pid += 1
            return subprocess.CompletedProcess(command, 0, "", "")
        if command[:2] == ["/bin/launchctl", "print"]:
            return subprocess.CompletedProcess(command, 113, "", "Could not find service") if self.gateway_pid is None else subprocess.CompletedProcess(command, 0, f"\tpid = {self.gateway_pid}\n", "")
        if command[0] == "/usr/sbin/lsof":
            return subprocess.CompletedProcess(command, 0, str(self.gateway_pid) + "\n", "")
        stdout, code = "{}", 0
        if "status" in command:
            stdout = json.dumps({"tasks": {"active": self.active_tasks, "byStatus": {"queued": 0, "running": 0}},
                                 "degradedPlugins": [], "degradedSecretOwners": []})
        if "--version" in command:
            stdout = "OpenClaw " + self.core_version
        if command[1:] == ["--version"] and command[0].endswith("/node"):
            stdout = "v24.21.0" if self.node24 is not None and command[0] == str(self.node24) else "v22.22.3"
        if "validate" in command and self.fail_validation:
            if check:
                raise install.InstallError("component_command_failed")
            code = 1
        if "validate" in command and self.watcher_restart and self.gateway_pid is not None:
            self.gateway_pid += 1
        if "restart" in command:
            self.gateway_pid += 1
        if "health" in command and self.fail_health:
            code = 1
        if "install" in command:
            self.gateway_pid = 123
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

    def migrate_current_runtime(self):
        """Simulate the already-completed official migration, not an install action."""
        state = self.home / ".openclaw-image-studio"
        workspace = self.home / "ai-worker/workspaces/image-studio"
        receipt_file = self.home / "ai-worker/state/openclaw-image-studio/install-receipt.json"
        receipt = json.loads(receipt_file.read_bytes())
        for name in ("AGENTS.md", "IDENTITY.md"):
            (workspace / name).write_bytes(("historical " + name + "\n").encode())
            receipt["payloadSha256"][name] = install.sha((workspace / name).read_bytes())
        receipt_file.write_bytes(install.encoded(receipt))
        config = json.loads((state / "openclaw.json").read_bytes())
        config["meta"] = {"lastTouchedVersion": "2026.9.9"}
        (state / "openclaw.json").write_bytes(install.encoded(config))
        self.core_version = "2026.9.9"
        core = self.home / "ai-worker/services/openclaw-runtime/releases/2026.9.9/install/lib/node_modules/openclaw"
        self.node24 = self.home / "ai-worker/services/openclaw-runtime/runtimes/node-v24.21.0-darwin-arm64/bin/node"
        self.node24.parent.mkdir(parents=True, mode=0o700)
        (core / "dist").mkdir(parents=True, mode=0o700)
        for path, content in [(self.node24, b"verified Node24 fixture"), (core / "dist/index.js", b"gateway fixture"),
                              (core / "openclaw.mjs", b"CLI fixture"),
                              (core / "package.json", install.encoded({"name": "openclaw", "version": self.core_version}))]:
            path.write_bytes(content)
            path.chmod(0o700)
        cli = core / ".aiworker-cli-entry.sh"
        cli.write_text('#!/bin/sh\nset -eu\nexec ' + shlex.quote(str(self.node24)) + " "
                       + shlex.quote(str(core / "openclaw.mjs")) + ' "$@"\n')
        cli.chmod(0o700)
        binary = self.home / "ai-worker/bin/openclaw"
        binary.unlink()
        binary.symlink_to(cli)
        plist = self.home / "Library/LaunchAgents/ai.openclaw.image-studio.plist"
        value = plistlib.loads(plist.read_bytes())
        value["EnvironmentVariables"]["NODE_OPTIONS"] = ""
        value["ProgramArguments"] = [str(self.node24), "--max-old-space-size=131072", str(core / "dist/index.js"),
                                    "gateway", "--port", "19289"]
        plist.write_bytes(plistlib.dumps(value))

    def adoption_arguments(self, mode, plugin, *, instructions=True, restore=False):
        args = self.plugin_arguments(mode, plugin)
        args[args.index("2026.9.2")] = self.core_version
        config = self.home / ".openclaw-image-studio/openclaw.json"
        plist = self.home / "Library/LaunchAgents/ai.openclaw.image-studio.plist"
        args += ["--adopt-current-runtime", "--expected-current-config-sha256", install.sha(config.read_bytes()),
                 "--expected-current-plist-sha256", install.sha(plist.read_bytes())]
        if instructions:
            args += ["--update-workspace-instructions"]
        if restore:
            args += ["--restore-plugin-update"]
        return args

    def gateway_operation(self, home, binary, node, env, runtime, operation):
        self.bridge_calls.append(operation)
        if operation == "secret-check":
            return {"secretReady": True}
        if operation == "restart":
            self.gateway_pid += 1
            return {"restarted": True}
        value = {"runtimeVersion": self.core_version, "activeWork": copy.deepcopy(self.active_work), "writeCustodyCount": 0,
            "modelRuntime": {"degraded": False, "pendingAgents": []},
            "childRuntime": {"execPath": str(self.node24), "available": True},
            "degradedPlugins": [], "degradedSecretOwners": [], "healthOk": not self.fail_health,
            "statusSha256": "1" * 64, "healthSha256": "2" * 64}
        value.update(copy.deepcopy(self.bridge_changes))
        return value


class CurrentRuntimeAdoptionTests(unittest.TestCase):
    def test_optional_cold_start_model_runtime_does_not_claim_inference_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, plugin = plugin_update_fixture(Path(directory).resolve())
            def cold_gateway(*arguments):
                value=fixture.gateway_operation(*arguments)
                if arguments[-1] not in {"restart", "secret-check"}:value.pop("modelRuntime",None)
                return value
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()), patch.object(install.time,"sleep"):
                install.main(fixture.arguments("--apply"));fixture.migrate_current_runtime()
                with patch.object(install,"current_gateway_operation",side_effect=cold_gateway):
                    self.assertEqual(install.main(fixture.adoption_arguments("--apply",plugin)),0)
            receipt=json.loads((fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json').read_bytes())
            self.assertFalse(receipt['runtimeEvidence']['modelRuntimeReported'])
            self.assertFalse(receipt['runtimeEvidence']['modelInferenceValidated'])
            self.assertEqual(receipt['currentState'],'SERVICE_HEALTHY_FEISHU_DISABLED')

    def test_adopts_verified_node24_and_updates_only_plugin_and_same_commit_instructions(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, plugin = plugin_update_fixture(Path(directory).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()), patch.object(install.time, "sleep"):
                install.main(fixture.arguments("--apply"))
                fixture.migrate_current_runtime()
                before = json.loads((fixture.home / ".openclaw-image-studio/openclaw.json").read_bytes())
                business_node = (fixture.home / "ai-worker/node/current/bin/node").read_bytes()
                with patch.object(install, "current_gateway_operation", side_effect=fixture.gateway_operation), \
                     patch.object(install, "keychain_token", side_effect=AssertionError("legacy keychain path used")):
                    self.assertEqual(install.main(fixture.adoption_arguments("--apply", plugin)), 0)
            after = json.loads((fixture.home / ".openclaw-image-studio/openclaw.json").read_bytes())
            self.assertEqual(after["plugins"]["load"]["paths"], [str(plugin)])
            after["plugins"]["load"]["paths"] = before["plugins"]["load"]["paths"]
            self.assertEqual(after, before)
            self.assertEqual((fixture.home / "ai-worker/node/current/bin/node").read_bytes(), business_node)
            receipt = json.loads((fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json").read_bytes())
            self.assertEqual(receipt["runtime"], {"openclaw": "2026.9.9", "node": "v24.21.0"})
            self.assertEqual(receipt["originalInstallRuntime"], {"openclaw": "2026.9.2", "node": "v22.22.3"})
            self.assertEqual(receipt["runtimeEvidence"]["nodePath"], str(fixture.node24))
            self.assertEqual(receipt["runtimeEvidence"]["authorityScope"], "image-studio")
            self.assertEqual(receipt["workspaceSourceCommit"], "d" * 40)
            self.assertEqual(receipt["sourceCommit"], "b" * 40)
            self.assertEqual(receipt["currentState"], "SERVICE_HEALTHY_FEISHU_DISABLED")
            for name in ("AGENTS.md", "IDENTITY.md"):
                self.assertEqual((fixture.home / "ai-worker/workspaces/image-studio" / name).read_bytes(),
                                 (install.ROOT / "ops/openclaw-image-studio" / name).read_bytes())
            self.assertIn("restart", fixture.bridge_calls)
            self.assertEqual(fixture.keychain_creates, 1)

    def test_dry_run_adoption_is_read_only_and_legacy_runtime_guard_stays_strict(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, plugin = plugin_update_fixture(Path(directory).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"))
                fixture.migrate_current_runtime()
                before = fixture.managed_bytes()
                with patch.object(install, "current_gateway_operation", side_effect=fixture.gateway_operation):
                    self.assertEqual(install.main(fixture.adoption_arguments("--dry-run", plugin)), 0)
                legacy_args = fixture.plugin_arguments("--dry-run", plugin)
                legacy_args[legacy_args.index("2026.9.2")] = "2026.9.9"
                with self.assertRaisesRegex(install.InstallError, "image_profile_runtime_drift"):
                    install.main(legacy_args)
            self.assertEqual(fixture.managed_bytes(), before)
            self.assertFalse((fixture.home / "ai-worker/backups/openclaw-image-studio").exists())

    def test_fresh_fingerprint_runtime_path_and_package_guards_are_not_bypassed(self):
        for scenario, error in [("fingerprint", "current_runtime_fingerprint_mismatch"),
                                ("node-argument", "current_runtime_node_argument_invalid"),
                                ("package", "current_runtime_package_version_invalid"),
                                ("receipt-evidence", "image_profile_original_install_evidence_invalid"),
                                ("workspace", "image_profile_workspace_drift")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                fixture, plugin = plugin_update_fixture(Path(directory).resolve())
                with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                    install.main(fixture.arguments("--apply"))
                    fixture.migrate_current_runtime()
                    if scenario == "node-argument":
                        plist = fixture.home / "Library/LaunchAgents/ai.openclaw.image-studio.plist"
                        value = plistlib.loads(plist.read_bytes())
                        value["ProgramArguments"].insert(1, "--require=/outside/inject.js")
                        plist.write_bytes(plistlib.dumps(value))
                    elif scenario == "package":
                        core = fixture.home / "ai-worker/services/openclaw-runtime/releases/2026.9.9/install/lib/node_modules/openclaw"
                        (core / "package.json").write_bytes(install.encoded({"name": "openclaw", "version": "2026.9.2"}))
                    elif scenario == "workspace":
                        (fixture.home / "ai-worker/workspaces/image-studio/AGENTS.md").write_text("unrelated local edit")
                    elif scenario == "receipt-evidence":
                        receipt_file = fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json"
                        value = json.loads(receipt_file.read_bytes())
                        value["runtime"] = None
                        receipt_file.write_bytes(install.encoded(value))
                    args = fixture.adoption_arguments("--apply", plugin)
                    if scenario == "fingerprint":
                        args[args.index("--expected-current-config-sha256") + 1] = "0" * 64
                    before = fixture.managed_bytes()
                    with patch.object(install, "current_gateway_operation", side_effect=fixture.gateway_operation), \
                         self.assertRaisesRegex(install.InstallError, error):
                        install.main(args)
                self.assertEqual(fixture.managed_bytes(), before)
                self.assertNotIn("restart", fixture.bridge_calls)

    def test_current_idle_requires_all_real_99_counters_and_live_child_binding(self):
        for change, error in [
            ({"activeWork": {}}, "image_profile_idle_unproven"),
            ({"activeWork": {"rootRequests": 0}}, "image_profile_idle_unproven"),
            ({"writeCustodyCount": None}, "image_profile_idle_unproven"),
            ({"runtimeVersion": "2026.9.2"}, "image_profile_live_runtime_mismatch"),
            ({"childRuntime": {"execPath": "/outside/node", "available": True}}, "image_profile_live_runtime_mismatch"),
            ({"modelRuntime": {"degraded": False, "pendingAgents": ["busy"]}}, "image_profile_runtime_degraded"),
            ({"modelRuntime": None}, "image_profile_runtime_degraded"),
            ({"modelRuntime": {"degraded": True, "pendingAgents": []}}, "image_profile_runtime_degraded"),
            ({"degradedPlugins": ["bad-plugin"]}, "image_profile_runtime_degraded"),
            ({"healthOk": False}, "image_profile_runtime_unhealthy"),
        ]:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                fixture, plugin = plugin_update_fixture(Path(directory).resolve())
                with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                    install.main(fixture.arguments("--apply"))
                    fixture.migrate_current_runtime()
                    fixture.bridge_changes = change
                    before = fixture.managed_bytes()
                    with patch.object(install, "current_gateway_operation", side_effect=fixture.gateway_operation), \
                         self.assertRaisesRegex(install.InstallError, error):
                        install.main(fixture.adoption_arguments("--apply", plugin))
                self.assertEqual(fixture.managed_bytes(), before)

    def test_failed_partial_update_restores_config_workspace_and_adopted_receipt_together(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, plugin = plugin_update_fixture(Path(directory).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()), patch.object(install.time, "sleep"):
                install.main(fixture.arguments("--apply"))
                fixture.migrate_current_runtime()
                state = fixture.home / ".openclaw-image-studio"
                workspace = fixture.home / "ai-worker/workspaces/image-studio"
                before = {"openclaw.json": (state / "openclaw.json").read_bytes(),
                    "AGENTS.md": (workspace / "AGENTS.md").read_bytes(), "IDENTITY.md": (workspace / "IDENTITY.md").read_bytes()}
                with patch.object(install, "current_gateway_operation", side_effect=fixture.gateway_operation), \
                     patch.object(install, "keychain_token", side_effect=AssertionError("legacy keychain path used")):
                    fixture.fail_validation = True
                    with self.assertRaisesRegex(install.InstallError, "component_command_failed"):
                        install.main(fixture.adoption_arguments("--apply", plugin))
                    receipt_path = fixture.home / "ai-worker/state/openclaw-image-studio/install-receipt.json"
                    failed = json.loads(receipt_path.read_bytes())
                    self.assertEqual(failed["currentState"], "PLUGIN_UPDATE_NEEDS_INSPECTION")
                    # Simulate a crash after only one workspace file was replaced.
                    (state / "openclaw.json").write_bytes(before["openclaw.json"])
                    (workspace / "IDENTITY.md").write_bytes(before["IDENTITY.md"])
                    fixture.fail_validation = False
                    self.assertEqual(install.main(fixture.adoption_arguments("--apply", plugin, instructions=False, restore=True)), 0)
                restored = json.loads(receipt_path.read_bytes())
                self.assertEqual(restored["currentState"], "SERVICE_HEALTHY_FEISHU_DISABLED")
                self.assertEqual(restored["runtime"], {"openclaw": "2026.9.9", "node": "v24.21.0"})
                self.assertEqual(restored["originalInstallRuntime"]["openclaw"], "2026.9.2")
                self.assertEqual((state / "openclaw.json").read_bytes(), before["openclaw.json"])
                self.assertEqual((workspace / "AGENTS.md").read_bytes(), before["AGENTS.md"])
                self.assertEqual((workspace / "IDENTITY.md").read_bytes(), before["IDENTITY.md"])
                self.assertEqual(restored["payloadSha256"], {name: install.sha(raw) for name, raw in before.items()})
                self.assertLessEqual(len(list((fixture.home / "ai-worker/backups/openclaw-image-studio").iterdir())), 2)

    def test_restore_rejects_unrelated_postfailure_workspace_edits_without_stopping_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, plugin = plugin_update_fixture(Path(directory).resolve())
            with fixture.patches(), contextlib.redirect_stdout(io.StringIO()):
                install.main(fixture.arguments("--apply"))
                fixture.migrate_current_runtime()
                with patch.object(install, "current_gateway_operation", side_effect=fixture.gateway_operation):
                    fixture.fail_validation = True
                    with self.assertRaises(install.InstallError):
                        install.main(fixture.adoption_arguments("--apply", plugin))
                    (fixture.home / "ai-worker/workspaces/image-studio/AGENTS.md").write_text("external edit after failure")
                    before = fixture.managed_bytes()
                    calls = len(fixture.commands)
                    with self.assertRaisesRegex(install.InstallError, "plugin_restore_external_payload_drift"):
                        install.main(fixture.adoption_arguments("--apply", plugin, instructions=False, restore=True))
                self.assertEqual(fixture.managed_bytes(), before)
                self.assertFalse(any(command[:2] == ["/bin/launchctl", "bootout"] for command in fixture.commands[calls:]))

    def test_shared_secretref_adapter_keeps_actual_token_out_of_python_argv_and_output(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            state = home / ".openclaw-image-studio"
            state.mkdir(mode=0o700)
            install.create_file(state / "openclaw.json", install.encoded({"gateway": {"port": 19289}}))
            node = home / "node24"
            env = install.cli_environment(home, node)
            with patch.object(install, "run", return_value=subprocess.CompletedProcess([], 0, '{"secretReady":true}', '')) as command:
                self.assertEqual(install.current_gateway_operation(home, home / "openclaw", node, env,
                    {"coreRoot": str(home / "core")}, "secret-check"), {"secretReady": True})
            argv = command.call_args.args[0]
            self.assertEqual(argv[:3], [str(node), "--input-type=module", "-e"])
            self.assertIn("resolveGatewayTokenFromConfigPath", argv[3])
            self.assertNotIn("a" * 64, " ".join(argv))
            self.assertNotIn("OPENCLAW_GATEWAY_TOKEN", env)


class AppliedPluginResumeTests(unittest.TestCase):
    @contextlib.contextmanager
    def applied_failure(self, directory, *, native_binding=False):
        fixture,plugin=plugin_update_fixture(Path(directory).resolve())
        with fixture.patches(),contextlib.redirect_stdout(io.StringIO()),patch.object(install.time,'sleep'), \
                patch.object(install,'current_gateway_operation',side_effect=fixture.gateway_operation):
            install.main(fixture.arguments('--apply'));fixture.migrate_current_runtime()
            if native_binding:prepare_native_service(fixture)
            fixture.fail_validation=True
            with self.assertRaisesRegex(install.InstallError,'component_command_failed'):
                install.main(fixture.adoption_arguments('--apply',plugin))
            fixture.fail_validation=False
            # The repair only seals an already completed official restart.
            fixture.gateway_pid+=1
            source={'mode':'canonical_git','sourceRepository':install.SOURCE_REPOSITORY,'sourceCommit':'d'*40}
            controller={'mode':'canonical_git','sourceRepository':install.SOURCE_REPOSITORY,'sourceCommit':'e'*40}
            with patch.object(install,'resume_source_evidence',return_value=(source,controller)) as verify:
                yield fixture,plugin,verify

    def resume_args(self,fixture,plugin,mode='--apply'):
        return fixture.adoption_arguments(mode,plugin,instructions=False)+[
            '--resume','--controller-source-commit','e'*40]

    def test_resume_seals_existing_target_with_separate_controller_without_payload_writes_or_restart(self):
        with tempfile.TemporaryDirectory() as directory,self.applied_failure(directory) as (fixture,plugin,verify):
            before=fixture.managed_bytes();calls=len(fixture.commands);bridges=len(fixture.bridge_calls)
            self.assertEqual(install.main(self.resume_args(fixture,plugin,'--dry-run')),0)
            self.assertEqual(fixture.managed_bytes(),before)
            self.assertEqual(install.main(self.resume_args(fixture,plugin)),0)
            after=fixture.managed_bytes();receipt_path=str(fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json')
            self.assertEqual({p:v for p,v in after.items()if p!=receipt_path},{p:v for p,v in before.items()if p!=receipt_path})
            receipt=json.loads(after[receipt_path])
            self.assertEqual(receipt['currentState'],'SERVICE_HEALTHY_FEISHU_DISABLED')
            self.assertEqual(receipt['pluginSourceCommit'],'d'*40)
            self.assertEqual(receipt['pluginResumeEvidence']['controllerSourceEvidence']['sourceCommit'],'e'*40)
            self.assertFalse(receipt['pluginResumeEvidence']['modelInferenceValidated'])
            self.assertTrue(receipt['pluginResumeEvidence']['resumedWithoutPayloadWritesOrRestart'])
            self.assertNotIn('restart',fixture.bridge_calls[bridges:])
            self.assertFalse(any('restart'in command or 'bootstrap'in command or 'bootout'in command
                                 for command in fixture.commands[calls:]))
            self.assertEqual(len(list((fixture.home/'ai-worker/backups/openclaw-image-studio').iterdir())),1)
            self.assertEqual(verify.call_args.args[-2:],('d'*40,'e'*40))

    def test_resume_rejects_target_backup_artifact_pid_and_activity_drift(self):
        for scenario,error in [('workspace','plugin_resume_target_payload_drift'),
                ('backup','plugin_resume_backup_integrity_failed'),('artifact','plugin_artifact_members_or_digest_drift'),
                ('same-pid','plugin_update_fresh_restart_unproven'),('busy','image_profile_idle_unproven'),
                ('plan','plugin_resume_plan_mismatch')]:
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory, \
                    self.applied_failure(directory) as (fixture,plugin,verify):
                receipt_path=fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json'
                receipt=json.loads(receipt_path.read_bytes())
                if scenario=='workspace':(fixture.home/'ai-worker/workspaces/image-studio/AGENTS.md').write_text('outside edit')
                elif scenario=='backup':(Path(receipt['recoveryBackup'])/'AGENTS.md').write_text('damaged backup')
                elif scenario=='artifact':(plugin/'index.js').write_text('tampered immutable artifact')
                elif scenario=='same-pid':fixture.gateway_pid=receipt['pluginUpdatePlan']['previousGatewayPid']
                elif scenario=='busy':fixture.active_work['rootRequests']=1
                elif scenario=='plan':
                    receipt['pluginUpdatePlan']['targetSourceCommit']='f'*40
                    receipt_path.write_bytes(install.encoded(receipt))
                before=fixture.managed_bytes();commands=len(fixture.commands)
                with self.assertRaisesRegex(install.InstallError,error):install.main(self.resume_args(fixture,plugin))
                self.assertEqual(fixture.managed_bytes(),before)
                self.assertFalse(any('restart'in c or 'bootout'in c or 'bootstrap'in c for c in fixture.commands[commands:]))

    def test_legacy_prepared_plan_can_resume_from_adopted_backup_pid(self):
        with tempfile.TemporaryDirectory() as directory,self.applied_failure(directory) as (fixture,plugin,verify):
            path=fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json'
            receipt=json.loads(path.read_bytes())
            for key in ['previousGatewayPid','targetPluginArtifact','workspaceInstructionsUpdated']:
                receipt['pluginUpdatePlan'].pop(key)
            path.write_bytes(install.encoded(receipt))
            self.assertEqual(install.main(self.resume_args(fixture,plugin)),0)
            saved=json.loads(path.read_bytes());self.assertEqual(saved['pluginSourceCommit'],'d'*40)

    def test_resume_rejects_payload_change_after_health_probe_before_sealing(self):
        with tempfile.TemporaryDirectory() as directory,self.applied_failure(directory) as (fixture,plugin,verify):
            original=fixture.gateway_operation
            def mutate(*args):
                value=original(*args)
                (fixture.home/'ai-worker/workspaces/image-studio/AGENTS.md').write_text('concurrent edit')
                return value
            path=fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json';before=path.read_bytes()
            with patch.object(install,'current_gateway_operation',side_effect=mutate), \
                    self.assertRaisesRegex(install.InstallError,'plugin_resume_cas_changed'):
                install.main(self.resume_args(fixture,plugin))
            self.assertEqual(path.read_bytes(),before)

    def test_controller_override_is_not_allowed_outside_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture,plugin=plugin_update_fixture(Path(directory).resolve())
            with fixture.patches(),self.assertRaisesRegex(install.InstallError,'plugin_resume_controller_option_invalid'):
                install.main(fixture.plugin_arguments('--dry-run',plugin)+['--controller-source-commit','e'*40])

    def test_resume_accepts_only_verified_official_plist_and_wrapper_migration(self):
        with tempfile.TemporaryDirectory() as directory,self.applied_failure(directory,native_binding=True) as (fixture,plugin,verify):
            path=fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json'
            failed=json.loads(path.read_bytes());plan=copy.deepcopy(failed['pluginUpdatePlan'])
            backup=install.bounded_files(Path(failed['recoveryBackup']))
            migrate_official_service(fixture)
            plist=fixture.home/'Library/LaunchAgents/ai.openclaw.image-studio.plist'
            actual=plist.read_bytes()
            self.assertEqual(install.main(self.resume_args(fixture,plugin)),0)
            saved=json.loads(path.read_bytes());migration=saved['pluginResumeEvidence']['officialServiceMigration']
            self.assertEqual(saved['pluginUpdatePlan'],plan)
            self.assertEqual(install.bounded_files(Path(failed['recoveryBackup'])),backup)
            self.assertEqual(plist.read_bytes(),actual)
            self.assertEqual(saved['serviceEvidence']['launchAgentSha256'],install.sha(actual))
            self.assertTrue(migration['environmentUnchanged']);self.assertFalse(migration['serviceFilesRewrittenByController'])
            self.assertEqual(set(migration['changes']),{'official_environment_wrapper_header_validation',
                'official_stderr_merged_into_supervisor_log'})

    def test_restore_keeps_current_official_service_files_while_restoring_payload_cohort(self):
        with tempfile.TemporaryDirectory() as directory,self.applied_failure(directory,native_binding=True) as (fixture,plugin,verify):
            path=fixture.home/'ai-worker/state/openclaw-image-studio/install-receipt.json'
            failed=json.loads(path.read_bytes());migrate_official_service(fixture)
            plist=fixture.home/'Library/LaunchAgents/ai.openclaw.image-studio.plist';raw=plist.read_bytes()
            self.assertEqual(install.main(fixture.adoption_arguments('--apply',plugin,instructions=False,restore=True)),0)
            saved=json.loads(path.read_bytes());self.assertEqual(plist.read_bytes(),raw)
            self.assertEqual(saved['serviceEvidence']['launchAgentSha256'],install.sha(raw))
            self.assertIn('officialServiceMigration',saved['lastPluginRestore'])
            for name,pathpart in [('openclaw.json',fixture.home/'.openclaw-image-studio/openclaw.json'),
                                  ('AGENTS.md',fixture.home/'ai-worker/workspaces/image-studio/AGENTS.md')]:
                self.assertEqual(pathpart.read_bytes(),(Path(failed['recoveryBackup'])/name).read_bytes())


def prepare_native_service(fixture):
    state=fixture.home/'.openclaw-image-studio';folder=state/'service-env';folder.mkdir(mode=0o700)
    plist=fixture.home/'Library/LaunchAgents/ai.openclaw.image-studio.plist';value=plistlib.loads(plist.read_bytes())
    wrapper=folder/'ai.openclaw.image-studio-env-wrapper.sh';wrapper.write_bytes(install.LEGACY_ENV_WRAPPER);wrapper.chmod(0o700)
    envfile=folder/'ai.openclaw.image-studio.env'
    quote=lambda text:"'"+text.replace("'","'\\''")+"'"
    envfile.write_text(install.ENV_FILE_HEADER+'\n'+''.join('export '+k+'='+quote(v)+'\n'for k,v in value['EnvironmentVariables'].items()))
    envfile.chmod(0o600);value['EnvironmentVariables']={}
    value['ProgramArguments']=['/bin/sh',str(wrapper),str(envfile),*value['ProgramArguments']]
    value['StandardOutPath']=str(fixture.home/'Library/Logs/openclaw/gateway-image-studio.log')
    value['StandardErrorPath']='/dev/null';value['WorkingDirectory']=str(state)
    value.update(RunAtLoad=True,KeepAlive=True,ExitTimeOut=20,ProcessType='Interactive',ThrottleInterval=10,Umask=63,StandardInPath='/dev/null')
    plist.write_bytes(plistlib.dumps(value))


def migrate_official_service(fixture):
    plist=fixture.home/'Library/LaunchAgents/ai.openclaw.image-studio.plist';value=plistlib.loads(plist.read_bytes())
    value['StandardErrorPath']=value['StandardOutPath'];plist.write_bytes(plistlib.dumps(value))
    (fixture.home/'.openclaw-image-studio/service-env/ai.openclaw.image-studio-env-wrapper.sh').write_bytes(install.CURRENT_ENV_WRAPPER)


class NativeServiceTransitionTests(unittest.TestCase):
    def test_known_wrapper_bytes_and_only_the_official_transition_are_accepted(self):
        self.assertEqual(install.sha(install.LEGACY_ENV_WRAPPER),'08abc38cdc39727ed8580697adac8004bbac7ee7647c9d3d3c96a7fe403cf75a')
        self.assertEqual(install.sha(install.CURRENT_ENV_WRAPPER),'67d5fd3def731eb5f63bc67ddce5ea45fcb1e06d3266ad1a2cfefa8031dda8fd')
        cases=[('wrapper','native_service_wrapper_mismatch'),('env','image_profile_service_drift'),
            ('stderr','image_profile_service_log_transition_invalid'),('policy','image_profile_service_transition_not_owned'),
            ('header','native_service_env_header_invalid')]
        for scenario,error in cases:
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory:
                fixture,_=plugin_update_fixture(Path(directory).resolve())
                with fixture.patches(),contextlib.redirect_stdout(io.StringIO()):
                    install.main(fixture.arguments('--apply'));fixture.migrate_current_runtime();prepare_native_service(fixture)
                    state=fixture.home/'.openclaw-image-studio';plist=fixture.home/'Library/LaunchAgents/ai.openclaw.image-studio.plist'
                    config=(state/'openclaw.json').read_bytes();before=install.verify_installed_service(plist,state,config)
                    migrate_official_service(fixture)
                    if scenario=='wrapper':(state/'service-env/ai.openclaw.image-studio-env-wrapper.sh').write_bytes(install.CURRENT_ENV_WRAPPER+b'echo custom\n')
                    elif scenario in {'env','header'}:
                        envfile=state/'service-env/ai.openclaw.image-studio.env';raw=envfile.read_text()
                        envfile.write_text(raw+"export EXTRA='value'\n" if scenario=='env'else raw.replace(install.ENV_FILE_HEADER,'# custom header'))
                    elif scenario in {'stderr','policy'}:
                        value=plistlib.loads(plist.read_bytes())
                        if scenario=='stderr':value['StandardErrorPath']='/outside/log'
                        else:value['Umask']=0
                        plist.write_bytes(plistlib.dumps(value))
                    with self.assertRaisesRegex(install.InstallError,error):
                        install.verify_owned_service_transition(fixture.home,plist,state,config,before,{'openclaw':'2026.9.9'})


class ResumeSourceEvidenceTests(unittest.TestCase):
    def test_real_git_binds_old_target_and_new_controller_bytes_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory).resolve();root=base/'canonical';root.mkdir();plugin=base/'installed';plugin.mkdir()
            def git(*args):
                result=subprocess.run(['/usr/bin/git','-C',str(root),*args],capture_output=True,text=True,check=True)
                return result.stdout.strip()
            git('init','--quiet');git('config','user.name','Image installer test');git('config','user.email','installer-test@example.invalid')
            git('remote','add','origin',install.SOURCE_REPOSITORY+'.git')
            members={name:b'controller v1\n' for name in ['scripts/install-openclaw-image-studio.py',
                'scripts/openclaw-keychain-secretref.sh','scripts/lib/openclaw-secret-reference.mjs']}
            members.update({'openclaw-plugins/aiworker-image-command/index.js':b'export default {}\n',
                'ops/openclaw-image-studio/AGENTS.md':b'accepted target instructions\n',
                'ops/openclaw-image-studio/IDENTITY.md':b'accepted target identity\n'})
            for name,data in members.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            git('add','.');git('commit','--quiet','-m','target fixture');target_commit=git('rev-parse','HEAD')
            (plugin/'index.js').write_bytes(members['openclaw-plugins/aiworker-image-command/index.js'])
            (plugin/'manifest.json').write_text('{}')
            controller=root/'scripts/install-openclaw-image-studio.py';controller.write_bytes(b'controller repair v2\n')
            git('add','scripts/install-openclaw-image-studio.py');git('commit','--quiet','-m','controller repair fixture')
            controller_commit=git('rev-parse','HEAD')
            target={name:members['ops/openclaw-image-studio/'+name]for name in ['AGENTS.md','IDENTITY.md']}
            source,evidence=install.resume_source_evidence(root,plugin,target,target_commit,controller_commit)
            self.assertEqual(source['sourceCommit'],target_commit);self.assertEqual(evidence['sourceCommit'],controller_commit)
            self.assertNotEqual(target_commit,controller_commit)
            with self.assertRaisesRegex(install.InstallError,'controller_commit_mismatch'):
                install.resume_source_evidence(root,plugin,target,target_commit,target_commit)
            (plugin/'index.js').write_text('tampered target')
            with self.assertRaisesRegex(install.InstallError,'committed_source_drift'):
                install.resume_source_evidence(root,plugin,target,target_commit,controller_commit)
            (plugin/'index.js').write_bytes(members['openclaw-plugins/aiworker-image-command/index.js'])
            controller.write_text('uncommitted controller edit')
            with self.assertRaisesRegex(install.InstallError,'committed_source_drift'):
                install.resume_source_evidence(root,plugin,target,target_commit,controller_commit)
            controller.write_bytes(b'controller repair v2\n');git('remote','set-url','origin','https://example.invalid/unrelated.git')
            with self.assertRaisesRegex(install.InstallError,'canonical_git_remote_mismatch'):
                install.resume_source_evidence(root,plugin,target,target_commit,controller_commit)


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


def plugin_update_fixture(home):
    fixture = InstallFixture(home)
    old_release = home / ("ai-worker/services/image-generation/releases/" + "b" * 40)
    old_plugin = old_release / "openclaw-plugins/aiworker-image-command"
    old_plugin.mkdir(parents=True, mode=0o700)
    (old_plugin / "openclaw.plugin.json").write_bytes((fixture.plugin / "openclaw.plugin.json").read_bytes())
    old_manifest = {"schema": "aiworker-image-service-artifact/v1", "sourceCommit": "b" * 40,
        "sourceRepository": install.SOURCE_REPOSITORY, "files": install.bounded_files(old_release)}
    install.create_file(old_release / "manifest.json", install.encoded(old_manifest))
    fixture.plugin = old_plugin
    new_plugin = home / ("ai-worker/services/openclaw-image-command/releases/" + "d" * 40)
    new_plugin.mkdir(parents=True, mode=0o700)
    (new_plugin / "openclaw.plugin.json").write_bytes((old_plugin / "openclaw.plugin.json").read_bytes())
    (new_plugin / "index.js").write_text("export default api => {}")
    new_manifest = {"schema": "aiworker-openclaw-image-command-artifact/v1", "sourceCommit": "d" * 40,
        "repository": install.SOURCE_REPOSITORY, "files": install.bounded_files(new_plugin)}
    install.create_file(new_plugin / "manifest.json", install.encoded(new_manifest))
    return fixture, new_plugin


if __name__ == "__main__":
    unittest.main()

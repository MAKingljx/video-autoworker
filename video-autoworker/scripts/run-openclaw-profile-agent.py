#!/usr/bin/env python3
"""Run a profile CLI turn using the existing single SecretRef adapter.

Use the authenticated GUI service session on macOS when its Keychain requires
that context. Tokens stay in memory and the child environment, never argv/files.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['gpt-main', 'qwen-current', 'qwen-weixin-new', 'image-studio'], required=True)
    parser.add_argument('--agent', required=True)
    parser.add_argument('--message-file', type=Path, required=True)
    parser.add_argument('--result-file', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9-]{1,64}', args.agent):
        raise ValueError('profile_agent_invalid')
    message_path = args.message_file.resolve(strict=True)
    st = message_path.stat()
    if not message_path.is_file() or st.st_uid != os.getuid() or st.st_mode & 0o077 or not 0 < st.st_size <= 64 * 1024:
        raise ValueError('private_message_file_required')
    output = args.result_file
    if not output.is_absolute() or output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ValueError('new_private_result_path_required')
    home = Path.home()
    root = Path(__file__).resolve().parents[1]
    # Reuse the same central SecretRef contract used by existing profiles.
    resolved = subprocess.run([str(home / 'ai-worker/node/current/bin/node'),
                              str(root / 'scripts/lib/openclaw-secret-reference.mjs'),
                              str(home / ('.openclaw-' + args.profile) / 'openclaw.json')],
                             capture_output=True, text=True, timeout=15)
    token = resolved.stdout.strip()
    if resolved.returncode or not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('profile_secretref_unavailable_in_current_session')
    result = subprocess.run([str(home / 'ai-worker/bin/openclaw'), '--profile', args.profile,
                             'agent', '--agent', args.agent, '--message', message_path.read_text(), '--json'],
                            env=dict(os.environ, OPENCLAW_GATEWAY_TOKEN=token), capture_output=True, text=True)
    if token in result.stdout:
        raise ValueError('profile_response_secret_leak_blocked')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as target:
        target.write(result.stdout)
    print(json.dumps({'profile': args.profile, 'agent': args.agent,
                      'currentState': 'TURN_COMPLETED' if result.returncode == 0 else 'TURN_FAILED',
                      'errorCode': None if result.returncode == 0 else 'profile_agent_exit_' + str(result.returncode),
                      'resultFile': str(output)}))
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())

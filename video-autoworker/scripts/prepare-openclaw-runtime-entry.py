#!/usr/bin/env python3
"""Prepare a CLI entry using an isolated Node runtime; never switch live services."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess


def owned_file(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path:
        raise ValueError('runtime_file_identity_invalid')
    stat = path.stat()
    if not path.is_file() or stat.st_uid != os.getuid() or stat.st_mode & 0o022:
        raise ValueError('runtime_file_owner_or_mode_invalid')
    return path


def prepare(node, package_root, expected_version):
    node = owned_file(node)
    package_root = Path(package_root)
    manifest = owned_file(package_root / 'package.json')
    entry = owned_file(package_root / 'openclaw.mjs')
    package = json.loads(manifest.read_text())
    if package.get('name') != 'openclaw' or package.get('version') != expected_version:
        raise ValueError('runtime_package_identity_invalid')
    # Keep the entry beside the real upstream manifest so SDK discovery retains
    # the package identity. This adds our launcher without modifying npm dist.
    target = package_root / '.aiworker-cli-entry.sh'
    content = ('#!/bin/sh\nset -eu\nexec ' + shlex.quote(str(node)) + ' '
               + shlex.quote(str(entry)) + ' "$@"\n').encode()
    if target.exists() or target.is_symlink():
        if owned_file(target).read_bytes() != content:
            raise ValueError('runtime_entry_conflict')
    else:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
    result = subprocess.run([str(target), '--version'], text=True, capture_output=True,
                            timeout=30, check=True)
    if 'OpenClaw ' + expected_version not in result.stdout:
        raise ValueError('runtime_entry_version_invalid')
    return {'currentState': 'PREPARED_NOT_ACTIVE', 'errorCode': None,
            'nextAction': 'validate_then_switch_authorized_services',
            'entry': str(target), 'node': str(node), 'version': expected_version,
            'entrySha256': hashlib.sha256(content).hexdigest(),
            'packageJsonSha256': hashlib.sha256(manifest.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--package-root', required=True)
    parser.add_argument('--expected-version', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.node, args.package_root, args.expected_version)))

#!/usr/bin/env python3
"""Install and operate the one daily, user-owned SQLite backup LaunchAgent."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('database_backup', Path(__file__).with_name('database-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
LABEL = 'ai.aiworker.database-backup'


def render(config_path, log_directory, python_path=None, script_path=None):
    return {
        'Label': LABEL,
        'ProgramArguments': [str(python_path or Path(sys.executable).resolve()), '-B',
                             str(script_path or Path(__file__).with_name('database-backup.py').resolve()),
                             'run', '--config', str(config_path)],
        'RunAtLoad': True,
        'StartCalendarInterval': {'Hour': 3, 'Minute': 30},
        # A failed run or a machine unavailable at the daily window catches up
        # without a second scheduler. Successful days immediately return current.
        'StartInterval': 3600,
        'ProcessType': 'Background',
        'LowPriorityIO': True,
        'Nice': 10,
        'Umask': 0o077,
        'StandardOutPath': str(log_directory / 'database-backup.log'),
        'StandardErrorPath': str(log_directory / 'database-backup.error.log'),
        'EnvironmentVariables': {'PYTHONDONTWRITEBYTECODE': '1'},
    }


def service_key():
    return f'gui/{os.getuid()}/{LABEL}'


def launch_status():
    result = subprocess.run(['/bin/launchctl', 'print', service_key()], capture_output=True, text=True)
    details = {}
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            key, _, value = line.strip().partition(' = ')
            if key in ['state', 'pid', 'last exit code']:
                details[key] = value
    return {'loaded': result.returncode == 0, **details}


def read_plist(path):
    if not path.exists():
        return None
    backup.private_path(path)
    with path.open('rb') as stream:
        value = plistlib.load(stream)
    if value.get('Label') != LABEL:
        raise ValueError('backup_service_plist_scope_invalid')
    return value


def install(config_path, log_directory, launch_directory, replace=False):
    config = json.loads(backup.private_path(config_path).read_text())
    backup.validate_config(config, create=True)
    log_directory = backup.physical_path(log_directory)
    log_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup.private_path(log_directory, directory=True)
    for name in ['database-backup.log', 'database-backup.error.log']:
        log = log_directory / name
        if log.exists() or log.is_symlink():
            backup.private_path(log)
        else:
            with log.open('xb'):
                log.chmod(0o600)
    launch_directory = backup.physical_path(launch_directory)
    launch_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if launch_directory.stat().st_uid != os.getuid() or launch_directory.stat().st_mode & 0o022:
        raise ValueError('backup_service_launch_directory_unsafe')
    path = launch_directory / (LABEL + '.plist')
    expected = render(config_path, log_directory)
    prior = read_plist(path)
    if prior == expected:
        return {'state': 'installed', 'changed': False, 'plist': str(path)}
    if prior and not replace:
        raise ValueError('backup_service_replace_required')
    if prior:
        arguments = prior.get('ProgramArguments', [])
        if len(arguments) < 3 or Path(arguments[2]).name != 'database-backup.py':
            raise ValueError('backup_service_previous_owner_invalid')
        previous = log_directory / 'database-backup.previous.plist'
        if previous.exists():
            backup.private_path(previous)
        shutil.copyfile(path, previous)
        previous.chmod(0o600)
    pending = path.with_name('.' + path.name + '.pending')
    if pending.exists():
        raise ValueError('backup_service_install_interrupted')
    try:
        with pending.open('xb') as stream:
            os.chmod(pending, 0o600)
            plistlib.dump(expected, stream, sort_keys=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        backup.sync_directory(path.parent)
        if read_plist(path) != expected:
            raise ValueError('backup_service_install_readback_failed')
    finally:
        if pending.exists():
            pending.unlink()
    return {'state': 'installed', 'changed': True, 'plist': str(path), 'started': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['install', 'start', 'stop', 'status'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--log-directory', required=True)
    parser.add_argument('--launch-agents-directory', default=str(Path.home()/'Library/LaunchAgents'))
    parser.add_argument('--replace', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    config_path = backup.private_path(args.config)
    config = backup.validate_config(json.loads(config_path.read_text()))
    logs = backup.physical_path(args.log_directory)
    launch_directory = backup.physical_path(args.launch_agents_directory)
    path = launch_directory / (LABEL + '.plist')
    if args.command == 'install':
        result = install(config_path, logs, launch_directory, args.replace)
    elif args.command == 'status':
        # Status must not create directories, logs, lock files or a LaunchAgent.
        result = {'installed': read_plist(path) is not None, 'service': launch_status(),
                  'backups': [backup.status(source) for source in config['sources']]}
    else:
        if read_plist(path) != render(config_path, logs):
            raise ValueError('backup_service_installation_mismatch')
        loaded = launch_status()['loaded']
        if args.command == 'start' and not loaded:
            subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(path)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif args.command == 'stop' and loaded:
            subprocess.run(['/bin/launchctl', 'bootout', service_key()], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        after = launch_status()
        if after['loaded'] != (args.command == 'start'):
            raise ValueError('backup_service_state_readback_failed')
        result = {'state': 'started' if after['loaded'] else 'stopped', 'service': after}
    print(json.dumps({'schema': backup.SCHEMA, 'label': LABEL, 'result': result}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'schema': backup.SCHEMA, 'state': 'failed', 'errorCode': str(exc),
                          'nextAction': 'inspect_backup_service'}), file=sys.stderr)
        sys.exit(1)

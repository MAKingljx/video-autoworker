#!/usr/bin/env python3
"""Private, consistent SQLite recovery points with one cross-directory inventory.

Live databases are read-only. Legacy recovery objects enter rotation only through
an explicit hash-bound import; unknown files are never adopted or deleted.
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
import time
import uuid

SCHEMA = 'video-autoworker-database-backup/v1'
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
SNAPSHOT = re.compile(r'^snapshot-[0-9T-]+-[a-f0-9]{8}\.db$')
RPO_SECONDS = 24 * 60 * 60


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def physical_path(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('backup_path_not_physical')
    return path


def private_path(path, directory=False):
    path = physical_path(path)
    entry = path.lstat()
    if entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise ValueError('backup_path_not_private')
    if directory and not stat.S_ISDIR(entry.st_mode):
        raise ValueError('backup_directory_invalid')
    if not directory and (not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1):
        raise ValueError('backup_file_invalid')
    return path


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_json(path, value):
    if path.exists():
        private_path(path)
    pending = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.partial')
    try:
        with pending.open('x', encoding='utf-8') as stream:
            os.chmod(pending, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        sync_directory(path.parent)
    finally:
        if pending.exists():
            pending.unlink()


def readonly_db(path, immutable=False):
    suffix = '?mode=ro' + ('&immutable=1' if immutable else '')
    db = sqlite3.connect(path.as_uri() + suffix, uri=True, timeout=10)
    db.execute('PRAGMA query_only=ON')
    return db


def verify_snapshot(path):
    private_path(path)
    with closing(readonly_db(path, immutable=True)) as db:
        check = db.execute('PRAGMA quick_check').fetchall()
        if check != [('ok',)]:
            raise ValueError('backup_integrity_failed')
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
        counts = {}
        for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            counts[name] = db.execute(f'SELECT COUNT(*) FROM {quoted}').fetchone()[0]
    return {'quickCheck': 'ok', 'schemaSha256': hashlib.sha256(json.dumps(schema).encode()).hexdigest(),
            'tableCounts': counts, 'bytes': path.stat().st_size, 'sha256': digest(path)}


def validate_config(value, create=False):
    if value.get('schema') != SCHEMA or not isinstance(value.get('sources'), list) or not value['sources']:
        raise ValueError('backup_config_invalid')
    names, databases, roots = set(), set(), []
    for source in value['sources']:
        if not NAME.fullmatch(source.get('name', '')) or source['name'] in names:
            raise ValueError('backup_source_name_invalid')
        names.add(source['name'])
        database = private_path(source['database'])
        root = physical_path(source['directory'])
        if database in databases or database == root or root in database.parents:
            raise ValueError('backup_source_destination_overlap')
        if any(root == other or root in other.parents or other in root.parents for other in roots):
            raise ValueError('backup_inventory_overlap')
        databases.add(database)
        roots.append(root)
        if create:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.exists():
            private_path(root, directory=True)
    return value


def due_day(now=None):
    now = now or dt.datetime.now().astimezone()
    scheduled = now.replace(hour=3, minute=30, second=0, microsecond=0)
    return (scheduled if now >= scheduled else scheduled - dt.timedelta(days=1)).date().isoformat()


def source_fingerprint(database):
    members = []
    for path in [database, Path(str(database) + '-wal')]:
        if not path.exists():
            members.append(None)
            continue
        s = private_path(path).stat()
        members.append(None if path != database and s.st_size == 0
                       else [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns])
    return hashlib.sha256(json.dumps(members).encode()).hexdigest()


@contextmanager
def source_lock(source):
    root = private_path(source['directory'], directory=True)
    lock_path = root / '.backup.lock'
    lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        private_path(lock_path)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(lock)


def recovery_path(source, item, require_exists=True):
    external = item.get('external')
    if external:
        path = private_path(external['path']) if require_exists else physical_path(external['path'])
        if path == Path(source['database']) or path.parent == Path(source['database']).parent:
            raise ValueError('backup_legacy_source_overlap')
        if external.get('format') not in ['sqlite', 'sqlite-tar']:
            raise ValueError('backup_legacy_format_invalid')
        return path
    filename = item.get('file', '')
    if not SNAPSHOT.fullmatch(filename):
        raise ValueError('backup_receipt_file_invalid')
    path = Path(source['directory']) / filename
    return private_path(path) if require_exists else physical_path(path)


def retirement_path(origin):
    return origin.with_name('retired-' + origin.name + '.json')


def is_verified_retirement(source, origin, expected_sha256):
    marker = retirement_path(origin)
    if not marker.exists():
        return False
    item = json.loads(private_path(marker).read_text())
    return (item.get('schema') == SCHEMA and item.get('state') == 'retired'
            and item.get('source') == source['name'] and item.get('oldSha256') == expected_sha256)


def inventory(source):
    root = physical_path(source['directory'])
    if not root.exists():
        return []
    private_path(root, directory=True)
    records = []
    for receipt in sorted(root.glob('snapshot-*.json')):
        private_path(receipt)
        item = json.loads(receipt.read_text())
        if item.get('schema') != SCHEMA or item.get('source') != source['name']:
            raise ValueError('backup_receipt_scope_invalid')
        if item.get('sourceIdentity', {}).get('pathSha256') != hashlib.sha256(source['database'].encode()).hexdigest():
            raise ValueError('backup_receipt_database_mismatch')
        path = recovery_path(source, item, require_exists=False)
        expected = item.get('external', {}).get('sha256') or item.get('validation', {}).get('sha256')
        if not path.exists() and is_verified_retirement(source, path, expected):
            continue
        private_path(path)
        if digest(path) != expected:
            raise ValueError('backup_existing_digest_mismatch')
        records.append((receipt, item))
    return sorted(records, key=lambda pair: pair[1]['completedAt'], reverse=True)


def consistent_copy(origin, destination):
    with destination.open('xb'):
        os.chmod(destination, 0o600)
    with closing(readonly_db(origin)) as src, closing(sqlite3.connect(destination)) as dst:
        src.backup(dst, pages=256, sleep=0.05)
    with destination.open('rb') as stream:
        os.fsync(stream.fileno())
    return verify_snapshot(destination)


def tar_members(archive):
    members = archive.getmembers()
    names = [m.name for m in members]
    if len(set(names)) != len(names) or len(members) > 100_000:
        raise ValueError('backup_archive_members_invalid')
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise ValueError('backup_archive_member_unsafe')
    return members


def tar_database_copy(origin, external, destination):
    member_name = external.get('databaseMember', '')
    if not member_name or PurePosixPath(member_name).name not in ['database.sqlite', 'mission-control.db']:
        raise ValueError('backup_archive_database_member_invalid')
    with tempfile.TemporaryDirectory(prefix='.restore-sqlite-', dir=destination.parent) as temporary:
        temporary_path = Path(temporary)
        temporary_path.chmod(0o700)
        database = temporary_path / 'database.sqlite'
        with tarfile.open(origin, 'r:*') as archive:
            members = tar_members(archive)
            by_name = {m.name: m for m in members}
            if member_name not in by_name or not by_name[member_name].isfile() or by_name[member_name].size < 512:
                raise ValueError('backup_archive_database_missing')
            # Rebuild SQLite's committed view with the archived WAL. Extracting
            # only the main database silently loses committed WAL transactions.
            for suffix in ['', '-wal']:
                member = by_name.get(member_name + suffix)
                if member is None:
                    continue
                target = Path(str(database) + suffix)
                with target.open('xb') as dst, archive.extractfile(member) as src:
                    os.chmod(target, 0o600)
                    shutil.copyfileobj(src, dst)
        # Shared memory is a cache: SQLite rebuilds it only in this isolated dir.
        return consistent_copy(database, destination)


def preserve_archive_assets(origin, external):
    destination = origin.with_name('n8n-runtime-assets.tar.gz')
    member = external['databaseMember']
    excluded = {member, member + '-wal', member + '-shm'}
    expected = {}
    def member_digest(archive, entry):
        if entry.isdir():
            return ['directory', entry.mode]
        h = hashlib.sha256()
        with archive.extractfile(entry) as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        return [entry.size, entry.mode, h.hexdigest()]
    with tarfile.open(origin, 'r:*') as original:
        members = tar_members(original)
        for entry in members:
            name = PurePosixPath(entry.name).name
            if entry.isfile() and (name.endswith(('.sqlite', '.sqlite3', '.db', '-wal', '-shm'))):
                if entry.name not in excluded and entry.size:
                    raise ValueError('backup_archive_extra_database_requires_review')
                excluded.add(entry.name)
        kept = [m for m in members if m.name not in excluded]
        for entry in kept:
            expected[entry.name] = member_digest(original, entry)
        if not destination.exists():
            pending = destination.with_name('.' + destination.name + '.partial')
            if pending.exists():
                raise ValueError('backup_asset_preservation_interrupted')
            try:
                with pending.open('xb') as stream:
                    os.chmod(pending, 0o600)
                    with tarfile.open(fileobj=stream, mode='w:gz') as output:
                        for entry in kept:
                            output.addfile(entry, original.extractfile(entry) if entry.isfile() else None)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(pending, destination)
                sync_directory(destination.parent)
            finally:
                if pending.exists():
                    pending.unlink()
    private_path(destination)
    with tarfile.open(destination, 'r:*') as saved:
        actual = {entry.name: member_digest(saved, entry) for entry in tar_members(saved)}
    if actual != expected or excluded.intersection(actual):
        raise ValueError('backup_asset_preservation_mismatch')
    return {'file': destination.name, 'sha256': digest(destination), 'members': len(actual),
            'memberManifestSha256': hashlib.sha256(json.dumps(actual, sort_keys=True).encode()).hexdigest()}


def rotate(source):
    records = inventory(source)
    for receipt, old in records[2:]:
        origin = recovery_path(source, old)
        external = old.get('external')
        assets = None
        if external and external['format'] == 'sqlite-tar':
            assets = preserve_archive_assets(origin, external)
        elif verify_snapshot(origin) != old['validation']:
            raise ValueError('backup_retirement_validation_mismatch')
        expected = old.get('external', {}).get('sha256') or old['validation']['sha256']
        if digest(origin) != expected:
            raise ValueError('backup_retirement_source_changed')
        # Retirement evidence records only metadata. Existing environment files
        # and legacy manifests remain in place; no unknown asset is removed.
        retirement = {'schema': SCHEMA, 'state': 'retired', 'source': source['name'],
                      'retiredAt': time.time(), 'oldSha256': digest(origin),
                      'replacements': [item.get('external', {}).get('sha256') or item['validation']['sha256']
                                       for _, item in records[:2]], 'preservedAssets': assets}
        save_json(retirement_path(origin), retirement)
        origin.unlink()
        receipt.unlink()
        sync_directory(origin.parent)
        sync_directory(receipt.parent)
    # A crash after unlinking the retired object but before its inventory
    # receipt is removed is recoverable without counting a nonexistent copy.
    for receipt in Path(source['directory']).glob('snapshot-*.json'):
        item = json.loads(private_path(receipt).read_text())
        origin = recovery_path(source, item, require_exists=False)
        expected = item.get('external', {}).get('sha256') or item['validation']['sha256']
        if not origin.exists() and is_verified_retirement(source, origin, expected):
            receipt.unlink()
    return len(inventory(source))


def import_legacy(source, plan):
    if plan.get('schema') != SCHEMA or plan.get('source') != source['name'] or not isinstance(plan.get('entries'), list):
        raise ValueError('backup_legacy_plan_invalid')
    with source_lock(source):
        records = inventory(source)
        known = {item.get('external', {}).get('path'): item for _, item in records if item.get('external')}
        results = []
        for entry in plan['entries']:
            origin = physical_path(entry['path'])
            if not origin.exists() and is_verified_retirement(source, origin, entry.get('sha256')):
                results.append({'source': source['name'], 'state': 'already_retired'})
                continue
            private_path(origin)
            private_path(origin.parent, directory=True)
            if origin == Path(source['database']) or origin.parent == Path(source['database']).parent:
                raise ValueError('backup_legacy_source_overlap')
            if digest(origin) != entry.get('sha256'):
                raise ValueError('backup_legacy_digest_mismatch')
            if entry['path'] in known:
                if known[entry['path']]['external'] != entry:
                    raise ValueError('backup_legacy_import_conflict')
                results.append({'source': source['name'], 'state': 'already_imported'})
                continue
            completed = entry.get('completedAt')
            if not isinstance(completed, (int, float)) or completed <= 0 or completed > time.time():
                raise ValueError('backup_legacy_date_invalid')
            if entry.get('format') == 'sqlite':
                if Path(str(origin) + '-wal').exists():
                    raise ValueError('backup_legacy_sqlite_has_wal')
                validation = verify_snapshot(origin)
            elif entry.get('format') == 'sqlite-tar':
                with tempfile.TemporaryDirectory(prefix='.legacy-verify-', dir=source['directory']) as temporary:
                    validation = tar_database_copy(origin, entry, Path(temporary) / 'verified.db')
            else:
                raise ValueError('backup_legacy_format_invalid')
            if digest(origin) != entry['sha256']:
                raise ValueError('backup_legacy_source_changed')
            name = 'snapshot-' + dt.datetime.fromtimestamp(completed, dt.timezone.utc).strftime('%Y-%m-%dT%H-%M-%S') + '-' + entry['sha256'][:8]
            item = {'schema': SCHEMA, 'source': source['name'], 'external': entry,
                    'scheduledDay': dt.datetime.fromtimestamp(completed).date().isoformat(), 'completedAt': completed,
                    'sourceIdentity': {'pathSha256': hashlib.sha256(source['database'].encode()).hexdigest()},
                    'validation': validation, 'importedAt': time.time()}
            receipt = Path(source['directory']) / (name + '.json')
            if receipt.exists():
                raise ValueError('backup_legacy_receipt_conflict')
            save_json(receipt, item)
            known[entry['path']] = item
            results.append({'source': source['name'], 'state': 'imported', 'quickCheck': 'ok'})
        # Import registers and verifies; the next successful live snapshot owns
        # retirement, after a fresh recoverable replacement exists.
        return {'source': source['name'], 'imported': results, 'retained': len(inventory(source))}


def snapshot(source, force=False, if_changed=False):
    root, database = Path(source['directory']), Path(source['database'])
    with source_lock(source):
        records = inventory(source)
        if len(records) > 2:
            rotate(source)
            records = inventory(source)
        day = due_day()
        before_fingerprint = source_fingerprint(database)
        if if_changed and records and records[0][1].get('sourceFingerprint') == before_fingerprint:
            return {'source': source['name'], 'state': 'current', 'reason': 'source_unchanged', 'nextAction': 'continue_deployment'}
        if not force and not if_changed and records and records[0][1]['scheduledDay'] >= day:
            return {'source': source['name'], 'state': 'current', 'nextAction': 'wait_for_next_schedule',
                    'latestCompletedAt': records[0][1]['completedAt']}
        started = time.monotonic()
        source_before = private_path(database).stat()
        name = 'snapshot-' + dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H-%M-%S') + '-' + uuid.uuid4().hex[:8]
        pending, destination = root / (name + '.partial'), root / (name + '.db')
        try:
            validation = consistent_copy(database, pending)
            source_after = database.stat()
            if (source_before.st_dev, source_before.st_ino) != (source_after.st_dev, source_after.st_ino):
                raise ValueError('backup_source_identity_changed')
            after_fingerprint = source_fingerprint(database)
            os.replace(pending, destination)
            item = {'schema': SCHEMA, 'source': source['name'], 'file': destination.name,
                    'scheduledDay': day, 'completedAt': time.time(),
                    'sourceIdentity': {'dev': source_before.st_dev, 'ino': source_before.st_ino,
                                       'pathSha256': hashlib.sha256(str(database).encode()).hexdigest()},
                    # A changing source remains safe to restore, but cannot
                    # satisfy a later skip-if-unchanged deployment check.
                    'sourceFingerprint': before_fingerprint if before_fingerprint == after_fingerprint else None,
                    'elapsedSeconds': round(time.monotonic()-started, 3), 'validation': validation}
            save_json(root / (name + '.json'), item)
            retained = rotate(source)
            return {'source': source['name'], 'state': 'verified', 'file': str(destination),
                    'elapsedSeconds': item['elapsedSeconds'], 'retained': retained,
                    'sha256': validation['sha256'], 'nextAction': 'wait_for_next_schedule'}
        finally:
            if pending.exists():
                pending.unlink()


def restore_drill(source, destination):
    destination = physical_path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('backup_restore_requires_new_path')
    if destination == Path(source['database']) or destination.parent == Path(source['database']).parent:
        raise ValueError('backup_restore_must_be_isolated')
    private_path(destination.parent, directory=True)
    with source_lock(source):
        records = inventory(source)
        if not records:
            raise ValueError('backup_restore_source_missing')
        _, item = records[0]
        origin = recovery_path(source, item)
        started = time.monotonic()
        external = item.get('external')
        if external and external['format'] == 'sqlite-tar':
            restored = tar_database_copy(origin, external, destination)
        else:
            with destination.open('xb') as output, origin.open('rb') as input_file:
                os.chmod(destination, 0o600)
                shutil.copyfileobj(input_file, output)
                output.flush()
                os.fsync(output.fileno())
            restored = verify_snapshot(destination)
        if restored != item['validation']:
            raise ValueError('backup_restore_verification_failed')
        return {'source': source['name'], 'state': 'restore_verified', 'path': str(destination),
                'elapsedSeconds': round(time.monotonic()-started, 3), 'sourceAgeSeconds': round(time.time()-item['completedAt']),
                'sha256': restored['sha256'], 'tables': len(restored['tableCounts']), 'productionModified': False}


def status(source):
    items = inventory(source)
    latest = items[0][1] if items else None
    age = max(0, time.time() - latest['completedAt']) if latest else None
    return {'source': source['name'], 'count': len(items), 'historyLimit': 2,
            'state': 'missing' if not latest else 'overdue' if age > RPO_SECONDS else 'current',
            'latestCompletedAt': latest['completedAt'] if latest else None,
            'ageSeconds': round(age) if age is not None else None, 'rpoTargetSeconds': RPO_SECONDS,
            'due': not latest or latest['scheduledDay'] < due_day(),
            'nextAction': 'run_backup' if not latest or age > RPO_SECONDS else 'wait_for_next_schedule'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['run', 'status', 'restore-drill', 'import-legacy'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--if-changed', action='store_true')
    parser.add_argument('--source')
    parser.add_argument('--destination')
    parser.add_argument('--plan')
    args = parser.parse_args()
    os.umask(0o077)
    config = validate_config(json.loads(private_path(args.config).read_text()), create=args.command != 'status')
    sources = [s for s in config['sources'] if not args.source or s['name'] == args.source]
    if not sources:
        raise ValueError('backup_source_unknown')
    if args.command == 'run':
        result, failed = [], False
        for source in sources:
            try:
                result.append(snapshot(source, args.force, args.if_changed))
            except Exception as exc:
                failed = True
                result.append({'source': source['name'], 'state': 'failed', 'errorCode': str(exc), 'nextAction': 'inspect_backup_failure'})
        print(json.dumps({'schema': SCHEMA, 'result': result}, ensure_ascii=False))
        return 1 if failed else 0
    if args.command == 'restore-drill':
        if len(sources) != 1 or not args.destination:
            raise ValueError('backup_drill_scope_required')
        result = restore_drill(sources[0], args.destination)
    elif args.command == 'import-legacy':
        if len(sources) != 1 or not args.plan:
            raise ValueError('backup_legacy_scope_required')
        result = import_legacy(sources[0], json.loads(private_path(args.plan).read_text()))
    else:
        result = [status(source) for source in sources]
    print(json.dumps({'schema': SCHEMA, 'result': result}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({'schema': SCHEMA, 'state': 'failed', 'errorCode': str(exc), 'nextAction': 'inspect_backup_failure'}), file=sys.stderr)
        sys.exit(1)

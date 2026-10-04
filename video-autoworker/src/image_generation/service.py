"""Durable local image jobs around the existing pinned Qwen generator.

This component owns image jobs only. It does not write video tasks, media
selection pointers, or learning results. No platform owns a second queue.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import struct
import subprocess
import threading
import time
import uuid


HEX = re.compile(r'^[a-f0-9]{64}$')
JOB = re.compile(r'^[a-f0-9]{32}$')
TERMINAL = ('GENERATED_PENDING_REVIEW', 'FAILED', 'CANCELLED', 'RECONCILE_REQUIRED')
MAX_INPUT = 20 * 1024 * 1024


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


@dataclass(frozen=True)
class Configuration:
    state_root: Path
    output_root: Path
    reference_roots: tuple
    backend_script: Path
    backend_python: Path
    profiles_file: Path
    source_commit: str


class ImageJobs:
    def __init__(self, config):
        os.umask(0o077)
        self.config = config
        config.state_root.mkdir(parents=True, mode=0o700, exist_ok=True)
        config.output_root.mkdir(parents=True, mode=0o700, exist_ok=True)
        if config.state_root.is_symlink() or config.output_root.is_symlink():
            raise ValueError('image_runtime_root_invalid')
        self.db_path = config.state_root / 'jobs.sqlite'
        if self.db_path.is_symlink():
            raise ValueError('image_database_invalid')
        with self.db() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS image_jobs (
              job_id TEXT PRIMARY KEY, scope TEXT NOT NULL,
              request_key TEXT NOT NULL, payload_sha TEXT NOT NULL,
              payload_json TEXT NOT NULL, state TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              error_code TEXT, result_json TEXT,
              UNIQUE(scope, request_key))''')
        self.db_path.chmod(0o600)
        spec = importlib.util.spec_from_file_location('aiworker_image_backend', config.backend_script)
        self.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.backend)
        self.profiles = json.loads(config.profiles_file.read_text())
        self.backend_sha = sha(config.backend_script.read_bytes())
        self.profiles_sha = sha(config.profiles_file.read_bytes())
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.lock = None

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def check_scope(self, scope):
        if not isinstance(scope, str) or not HEX.fullmatch(scope):
            raise ValueError('image_scope_invalid')

    def reference(self, value, scope):
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError('image_reference_invalid')
        path = Path(value).resolve(strict=True)
        if not any(path.is_relative_to(root.resolve(strict=True)) for root in self.config.reference_roots):
            raise ValueError('image_reference_outside_allowed_roots')
        if path.is_relative_to(self.config.output_root.resolve(strict=True)):
            # The shared cover root contains private job artifacts too. Reusing
            # one as a reference must retain the same session ownership.
            job_id = path.relative_to(self.config.output_root.resolve(strict=True)).parts[0]
            self.row(job_id, scope)
        if path.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
            raise ValueError('image_reference_format_invalid')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_INPUT:
                raise ValueError('image_reference_size_invalid')
            data = source.read(MAX_INPUT + 1)
            after = os.fstat(source.fileno())
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise ValueError('image_reference_changed')
        # The model does full decoding. Reject unrelated files before acceptance.
        if not (data.startswith(b'\x89PNG\r\n\x1a\n') or data.startswith(b'\xff\xd8\xff')
                or (data.startswith(b'RIFF') and data[8:12] == b'WEBP')):
            raise ValueError('image_reference_format_invalid')
        return {'source': str(path), 'sha256': sha(data), 'suffix': path.suffix.lower()}, data

    def normalize(self, request):
        allowed = {'scope', 'requestKey', 'prompt', 'design', 'images', 'width', 'height', 'steps', 'guidance', 'seed'}
        if not isinstance(request, dict) or set(request) - allowed:
            raise ValueError('image_request_invalid')
        self.check_scope(request.get('scope'))
        if not isinstance(request.get('requestKey'), str) or not HEX.fullmatch(request['requestKey']):
            raise ValueError('image_request_key_invalid')
        if ('prompt' in request) == ('design' in request):
            raise ValueError('image_prompt_or_design_required')
        if 'design' in request:
            self.backend.cover_design_prompt(request['design'], self.profiles)
            limit = self.profiles['profiles'][request['design']['profile']]['maximum_reference_images']
        else:
            prompt = request['prompt']
            if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode('utf-8')) > 16 * 1024 or '\x00' in prompt:
                raise ValueError('image_prompt_invalid')
            limit = 3
        images = request.get('images')
        if not isinstance(images, list) or not 1 <= len(images) <= limit:
            raise ValueError('image_reference_count_invalid')
        defaults = {'width': 1280, 'height': 720, 'steps': 40, 'guidance': 4, 'seed': 301}
        values = {key: request.get(key, default) for key, default in defaults.items()}
        for key in ('width', 'height'):
            if type(values[key]) is not int or not 512 <= values[key] <= 2048 or values[key] % 16:
                raise ValueError('image_dimensions_invalid')
        if type(values['steps']) is not int or not 1 <= values['steps'] <= 60:
            raise ValueError('image_steps_invalid')
        if type(values['seed']) is not int or not 0 <= values['seed'] < 2**31:
            raise ValueError('image_seed_invalid')
        if type(values['guidance']) not in (int, float) or not 1 <= values['guidance'] <= 8:
            raise ValueError('image_guidance_invalid')
        references = [self.reference(value, request['scope']) for value in images]
        payload = {**values, 'references': [r[0] for r in references],
                   'execution': {'sourceCommit': self.config.source_commit,
                                 'backendSha256': self.backend_sha, 'profilesSha256': self.profiles_sha},
                   **({key: request[key] for key in ('prompt', 'design') if key in request})}
        return payload, [r[1] for r in references]

    def submit(self, request):
        payload, data = self.normalize(request)
        payload_sha = sha(canonical(payload).encode())
        job_id = uuid.uuid4().hex
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM image_jobs WHERE scope=? AND request_key=?',
                             (request['scope'], request['requestKey'])).fetchone()
            if old:
                if old['payload_sha'] != payload_sha:
                    raise ValueError('image_idempotency_conflict')
                return {**self.present(old), 'duplicate': True}
            pending = db.execute("SELECT count(*) FROM image_jobs WHERE state IN ('QUEUED','RUNNING','CANCEL_REQUESTED')").fetchone()[0]
            if pending >= 16:
                raise ValueError('image_queue_full')
            folder = self.config.output_root / job_id
            folder.mkdir(mode=0o700)
            for index, (record, content) in enumerate(zip(payload['references'], data)):
                private_write(folder / ('reference-' + str(index) + record['suffix']), content)
            key = 'design' if 'design' in payload else 'prompt'
            content = canonical(payload[key]).encode() if key == 'design' else payload[key].encode()
            private_write(folder / ('input.json' if key == 'design' else 'prompt.txt'), content)
            now = stamp()
            db.execute('INSERT INTO image_jobs VALUES (?,?,?,?,?,?,?,?,NULL,NULL)',
                       (job_id, request['scope'], request['requestKey'], payload_sha,
                        canonical(payload), 'QUEUED', now, now))
        self.wake.set()
        return self.get(job_id, request['scope'])

    def row(self, job_id, scope):
        self.check_scope(scope)
        if not isinstance(job_id, str) or not JOB.fullmatch(job_id):
            raise ValueError('image_job_invalid')
        with self.db() as db:
            row = db.execute('SELECT * FROM image_jobs WHERE job_id=? AND scope=?', (job_id, scope)).fetchone()
        if not row:
            raise ValueError('image_job_not_found')
        return row

    def folder(self, job_id):
        folder = self.config.output_root / job_id
        if not JOB.fullmatch(job_id) or folder.is_symlink():
            raise ValueError('image_job_path_invalid')
        return folder

    def present(self, row):
        execution = json.loads(row['payload_json'])['execution']
        result = {'jobId': row['job_id'], 'currentState': row['state'],
                  'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
                  'errorCode': row['error_code'], **execution,
                  'nextAction': 'review_image' if row['state'] == 'GENERATED_PENDING_REVIEW' else
                      'inspect_and_reconcile' if row['state'] == 'RECONCILE_REQUIRED' else
                      'inspect_error' if row['state'] == 'FAILED' else
                      'none' if row['state'] == 'CANCELLED' else 'wait_or_query_status'}
        if row['result_json']:
            saved = json.loads(row['result_json'])
            result.update({key: saved[key] for key in ('output', 'outputSha256', 'outputBytes', 'width', 'height', 'elapsedSeconds', 'postProcessing') if key in saved})
        if row['state'] in ('RUNNING', 'CANCEL_REQUESTED'):
            intent = self.folder(row['job_id']) / 'image.intent.json'
            try:
                progress = json.loads(intent.read_text())
                result.update({key: progress[key] for key in ('completedSteps', 'totalSteps', 'elapsedSeconds') if key in progress})
            except (OSError, ValueError):
                pass
        return result

    def get(self, job_id, scope):
        return self.present(self.row(job_id, scope))

    def list(self, scope):
        self.check_scope(scope)
        with self.db() as db:
            rows = db.execute('SELECT * FROM image_jobs WHERE scope=? ORDER BY created_at DESC LIMIT 20', (scope,)).fetchall()
        return {'jobs': [self.present(row) for row in rows]}

    def cancel(self, job_id, scope):
        self.row(job_id, scope)
        with self.db() as db:
            db.execute("UPDATE image_jobs SET state=CASE WHEN state='QUEUED' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END, updated_at=? WHERE job_id=? AND scope=? AND state IN ('QUEUED','RUNNING')", (stamp(), job_id, scope))
        self.wake.set()
        return self.get(job_id, scope)

    def result(self, row):
        folder = self.folder(row['job_id'])
        receipt_path = folder / 'image.receipt.json'
        output = folder / 'image.png'
        if receipt_path.is_symlink() or output.is_symlink():
            raise ValueError('image_result_path_invalid')
        result = json.loads(receipt_path.read_text())
        with output.open('rb') as source:
            data = source.read(40 * 1024 * 1024 + 1)
        payload = json.loads(row['payload_json'])
        if (len(data) > 40 * 1024 * 1024 or result.get('currentState') != 'GENERATED_PENDING_REVIEW'
                or result.get('output') != str(output) or result.get('outputSha256') != sha(data)
                or result.get('repository') != self.backend.REPOSITORY
                or result.get('revision') != self.backend.REVISION
                or result.get('outputBytes') != len(data) or result.get('postProcessing') is not False
                or data[:8] != b'\x89PNG\r\n\x1a\n' or len(data) < 24
                or struct.unpack('>II', data[16:24]) != (payload['width'], payload['height'])):
            raise ValueError('image_result_integrity_failed')
        from PIL import Image
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format != 'PNG' or image.size != (payload['width'], payload['height']):
                    raise ValueError('image_result_integrity_failed')
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
        except (OSError, SyntaxError) as error:
            raise ValueError('image_result_decode_failed') from error
        return result, data

    def image(self, job_id, scope):
        row = self.row(job_id, scope)
        if row['state'] != 'GENERATED_PENDING_REVIEW':
            raise ValueError('image_result_not_ready')
        result, data = self.result(row)
        if canonical(result) != row['result_json']:
            raise ValueError('image_result_receipt_changed')
        return data

    def settle(self, row, state, error=None, result=None):
        with self.db() as db:
            db.execute("UPDATE image_jobs SET state=?,error_code=?,result_json=?,updated_at=? WHERE job_id=? AND state IN ('RUNNING','CANCEL_REQUESTED')",
                       (state, error, canonical(result) if result else None, stamp(), row['job_id']))

    def recover(self):
        # A vanished worker is not permission to rerun a costly side effect.
        with self.db() as db:
            rows = db.execute("SELECT * FROM image_jobs WHERE state IN ('RUNNING','CANCEL_REQUESTED')").fetchall()
        for row in rows:
            try:
                result, _ = self.result(row)
                self.settle(row, 'GENERATED_PENDING_REVIEW', result=result)
            except (OSError, ValueError, KeyError):
                self.settle(row, 'RECONCILE_REQUIRED', 'image_worker_interrupted')

    def run_one(self):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM image_jobs WHERE state='QUEUED' ORDER BY created_at LIMIT 1").fetchone()
            if not row:
                return False
            db.execute("UPDATE image_jobs SET state='RUNNING',updated_at=? WHERE job_id=? AND state='QUEUED'", (stamp(), row['job_id']))
        payload = json.loads(row['payload_json'])
        folder = self.folder(row['job_id'])
        command = [str(self.config.backend_python), str(self.config.backend_script), 'generate', '--wait-for-model',
                   '--output', str(folder / 'image.png'), '--images',
                   *[str(folder / ('reference-' + str(i) + r['suffix'])) for i, r in enumerate(payload['references'])]]
        if 'design' in payload:
            command += ['--design-file', str(folder / 'input.json'), '--profiles-file', str(self.config.profiles_file)]
        else:
            command += ['--prompt-file', str(folder / 'prompt.txt')]
        for key in ('width', 'height', 'steps', 'guidance', 'seed'):
            command += ['--' + key, str(payload[key])]
        process = None
        try:
            expected_execution = {'sourceCommit': self.config.source_commit,
                                  'backendSha256': self.backend_sha, 'profilesSha256': self.profiles_sha}
            if payload['execution'] != expected_execution:
                self.settle(row, 'RECONCILE_REQUIRED', 'image_job_runtime_changed')
                return True
            if (sha(self.config.backend_script.read_bytes()) != self.backend_sha
                    or sha(self.config.profiles_file.read_bytes()) != self.profiles_sha):
                raise ValueError('image_backend_source_changed')
            fd = os.open(folder / 'generator.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as log:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                cancelled = False
                while process.poll() is None:
                    current = self.row(row['job_id'], row['scope'])
                    if current['state'] == 'CANCEL_REQUESTED' or self.stopping.is_set():
                        cancelled = True
                        self.stop_process(process)
                        break
                    self.stopping.wait(0.5)
            # If completion raced cancellation, keep the verified native result.
            if process.returncode == 0:
                result, _ = self.result(row)
                self.settle(row, 'GENERATED_PENDING_REVIEW', result=result)
            elif cancelled:
                self.settle(row, 'CANCELLED', 'image_generation_cancelled')
            else:
                self.settle(row, 'FAILED', 'image_generator_exit_' + str(process.returncode))
        except Exception:
            if process and process.poll() is None:
                self.stop_process(process)
            self.settle(row, 'FAILED', 'image_generation_execution_failed')
        return True

    @staticmethod
    def stop_process(process):
        # Only the owned child process group. Process exit may race cancellation.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()

    def start(self):
        self.lock = (self.config.state_root / 'service.lock').open('a')
        os.fchmod(self.lock.fileno(), 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.recover()
        def worker():
            while not self.stopping.is_set():
                if not self.run_one():
                    self.wake.wait(1)
                    self.wake.clear()
        self.thread = threading.Thread(target=worker, name='image-job-worker', daemon=True)
        self.thread.start()

    def close(self):
        self.stopping.set()
        self.wake.set()
        if self.thread:
            self.thread.join()
        if self.lock:
            self.lock.close()

    def health(self):
        healthy = bool(self.thread and self.thread.is_alive())
        with self.db() as db:
            counts = {row[0]: row[1] for row in db.execute('SELECT state,count(*) FROM image_jobs GROUP BY state')}
            # Health is read through the application's own SQLite connection.
            # External cold read-only WAL opens need not create journal files.
            integrity = db.execute('PRAGMA quick_check').fetchone()[0]
        ready = healthy and integrity == 'ok'
        return {'currentState': 'READY' if ready else 'WORKER_UNAVAILABLE',
                'errorCode': None if ready else 'image_worker_unavailable' if not healthy else 'image_database_integrity_failed',
                'nextAction': 'none' if healthy else 'inspect_worker',
                'sourceCommit': self.config.source_commit, 'concurrency': 1,
                'counts': counts, 'databaseIntegrity': integrity,
                'databaseIdentity': {'device': self.db_path.stat().st_dev, 'inode': self.db_path.stat().st_ino}}

"""Durable local image jobs around the existing pinned Qwen generator.

This component owns image jobs only. It does not write video tasks, media
selection pointers, or learning results. No platform owns a second queue.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import base64
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
WORKER_ERROR = re.compile(r'^(?:protected|image_protected|image_ocr|image_stage_cache)_[a-z0-9_]{1,80}$')
TERMINAL = ('GENERATED_PENDING_REVIEW', 'FAILED', 'CANCELLED', 'RECONCILE_REQUIRED')
MAX_INPUT = 20 * 1024 * 1024
MAX_PROTECTED_INPUT = 40 * 1024 * 1024
MAX_OUTPUT = 40 * 1024 * 1024
MAX_INSPECTION_JSON = 6 * 1024 * 1024
WORKER_OWNER_ENV = 'AIWORKER_IMAGE_JOB_OWNER'


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

    def reference(self, value, scope, maximum=MAX_INPUT):
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
            if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
                raise ValueError('image_reference_size_invalid')
            data = source.read(maximum + 1)
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
        allowed = {'scope', 'requestKey', 'prompt', 'design', 'protected', 'images', 'width', 'height', 'steps', 'guidance', 'seed'}
        if not isinstance(request, dict) or set(request) - allowed:
            raise ValueError('image_request_invalid')
        self.check_scope(request.get('scope'))
        if not isinstance(request.get('requestKey'), str) or not HEX.fullmatch(request['requestKey']):
            raise ValueError('image_request_key_invalid')
        if sum(key in request for key in ('prompt', 'design', 'protected')) != 1:
            raise ValueError('image_prompt_or_design_required')
        protected = 'protected' in request
        if protected:
            if 'width' in request or 'height' in request:
                raise ValueError('image_protected_native_dimensions_required')
            limit = 1
        elif 'design' in request:
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
        if not protected:
            for key in ('width', 'height'):
                if type(values[key]) is not int or not 512 <= values[key] <= 2048 or values[key] % 16:
                    raise ValueError('image_dimensions_invalid')
        if type(values['steps']) is not int or not 1 <= values['steps'] <= 60:
            raise ValueError('image_steps_invalid')
        if type(values['seed']) is not int or not 0 <= values['seed'] < 2**31:
            raise ValueError('image_seed_invalid')
        if type(values['guidance']) not in (int, float) or not 1 <= values['guidance'] <= 8:
            raise ValueError('image_guidance_invalid')
        if protected and len(images) != 1:
            raise ValueError('image_protected_single_source_required')
        references = [self.reference(value, request['scope'], MAX_PROTECTED_INPUT if protected else MAX_INPUT) for value in images]
        protected_spec = None
        protected_execution = {}
        if protected:
            from .protected_cover import normalize_protected, implementation_digest
            protected_spec, (values['width'], values['height']) = normalize_protected(request['protected'], references[0][1])
            protected_execution = {'protectedSourceSha256': implementation_digest()}
        payload = {**values, 'references': [r[0] for r in references],
                   'execution': {'sourceCommit': self.config.source_commit,
                                 'backendSha256': self.backend_sha, 'profilesSha256': self.profiles_sha,
                                 **protected_execution},
                   **({key: request[key] for key in ('prompt', 'design') if key in request}),
                   **({'protected': protected_spec} if protected else {})}
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
            key = 'protected' if 'protected' in payload else 'design' if 'design' in payload else 'prompt'
            content = payload[key].encode() if key == 'prompt' else canonical(payload[key]).encode()
            private_write(folder / ('prompt.txt' if key == 'prompt' else 'input.json'), content)
            if key == 'protected':
                cache = self.select_stage_cache(db, request['scope'], payload, data[0], folder)
                if cache['assets']:
                    private_write(folder / 'stage-cache.json', canonical(cache).encode())
            now = stamp()
            db.execute('INSERT INTO image_jobs VALUES (?,?,?,?,?,?,?,?,NULL,NULL)',
                       (job_id, request['scope'], request['requestKey'], payload_sha,
                        canonical(payload), 'QUEUED', now, now))
        self.wake.set()
        return self.get(job_id, request['scope'])

    def reference_lineage(self, payload, scope, *, db=None):
        """Follow only sealed protected application outputs, never cache links."""
        if db is None:
            with self.db() as connection:
                return self.reference_lineage(payload, scope, db=connection)
        self.check_scope(scope)
        reference = payload['references'][0]
        visited = set()
        output_root = self.config.output_root.resolve(strict=True)
        while True:
            if (not isinstance(reference, dict) or not isinstance(reference.get('source'), str)
                    or not isinstance(reference.get('sha256'), str)):
                raise ValueError('image_stage_cache_lineage_reference_invalid')
            path = Path(reference['source'])
            if (not path.is_absolute() or '..' in path.parts or not HEX.fullmatch(reference['sha256'])):
                raise ValueError('image_stage_cache_lineage_reference_invalid')
            try:relative = path.relative_to(output_root)
            except ValueError:
                # Accepted references are canonical filesystem paths, while a
                # configured root may use an OS alias such as /var -> /private/var.
                try:relative = path.relative_to(self.config.output_root)
                except ValueError:return reference['sha256']
            if (len(relative.parts) != 2 or not JOB.fullmatch(relative.parts[0])
                    or relative.parts[1] != 'image.png'):
                raise ValueError('image_stage_cache_lineage_reference_invalid')
            job_id = relative.parts[0]
            if job_id in visited:raise ValueError('image_stage_cache_lineage_cycle')
            if len(visited) >= 8:raise ValueError('image_stage_cache_lineage_too_deep')
            visited.add(job_id)
            parent = db.execute('SELECT * FROM image_jobs WHERE job_id=? AND scope=?', (job_id, scope)).fetchone()
            if not parent or parent['state'] != 'GENERATED_PENDING_REVIEW' or not parent['result_json']:
                raise ValueError('image_stage_cache_lineage_parent_invalid')
            previous = json.loads(parent['payload_json']);saved = json.loads(parent['result_json'])
            folder = self.folder(job_id);owned_output = folder / 'image.png'
            if (not isinstance(previous.get('protected'), dict) or sha(canonical(previous).encode()) != parent['payload_sha']
                    or saved.get('currentState') != 'GENERATED_PENDING_REVIEW'
                    or saved.get('postProcessing') is not True or saved.get('output') != str(owned_output)
                    or saved.get('outputSha256') != reference['sha256']
                    or saved.get('sourceFileSha256') != previous['references'][0]['sha256']):
                raise ValueError('image_stage_cache_lineage_parent_invalid')
            receipt = folder / 'image.receipt.json'
            snapshot = folder / ('reference-0' + previous['references'][0]['suffix'])
            if (any(member.is_symlink() or not member.is_file() for member in (owned_output, receipt, snapshot))
                    or not 0 < owned_output.stat().st_size <= MAX_OUTPUT
                    or not 0 < receipt.stat().st_size <= 1024 * 1024
                    or not 0 < snapshot.stat().st_size <= MAX_PROTECTED_INPUT
                    or canonical(json.loads(receipt.read_bytes())) != parent['result_json']):
                raise ValueError('image_stage_cache_lineage_parent_changed')
            data = owned_output.read_bytes()
            if (sha(data) != reference['sha256'] or saved.get('outputBytes') != len(data)
                    or sha(snapshot.read_bytes()) != previous['references'][0]['sha256']):
                raise ValueError('image_stage_cache_lineage_parent_changed')
            reference = previous['references'][0]

    def compatible_cache_source(self, row, payload, *, allow_lineage=False, db=None):
        """Reuse execution inputs, never another session's task or payload."""
        previous = json.loads(row['payload_json'])
        if (row['state'] not in TERMINAL or 'protected' not in previous
                or sha(canonical(previous).encode()) != row['payload_sha']
                or any(previous[key] != payload[key] for key in ('steps', 'guidance', 'seed'))
                or any(previous['execution'][key] != payload['execution'][key]
                       for key in ('backendSha256', 'profilesSha256'))):
            raise ValueError('image_stage_cache_source_incompatible')
        if allow_lineage:
            if ((previous['width'], previous['height']) != (payload['width'], payload['height'])
                    or self.reference_lineage(previous, row['scope'], db=db) != self.reference_lineage(payload, row['scope'], db=db)):
                raise ValueError('image_stage_cache_source_incompatible')
        elif previous['references'][0]['sha256'] != payload['references'][0]['sha256']:
            raise ValueError('image_stage_cache_source_incompatible')
        return previous

    def erasure_material_source(self, row, payload, entry, *, db=None):
        previous = self.compatible_cache_source(row, payload, allow_lineage=True, db=db)
        target = re.fullmatch(r'erase_([1-4])', entry['stage'])
        source = re.fullmatch(r'erase_([1-4])', entry['sourceStage'])
        if (entry.get('selectionMode') != 'erasure-material' or not target or not source
                or int(target[1]) > len(payload['protected']['eraseRegions'])
                or int(source[1]) > len(previous['protected']['eraseRegions'])):
            raise ValueError('image_stage_cache_erasure_material_source_invalid')
        region = payload['protected']['eraseRegions'][int(target[1]) - 1]
        if previous['protected']['eraseRegions'][int(source[1]) - 1] != region:
            raise ValueError('image_stage_cache_erasure_material_source_invalid')
        from .protected_cover import erase_context
        from PIL import Image
        # Only shared crop geometry is needed here; real reference pixels are
        # independently checked by the material selector, worker and verifier.
        _, context = erase_context(Image.new('RGB', (payload['width'], payload['height'])), region)
        local = {**region, 'x': region['x'] - context['x'], 'y': region['y'] - context['y']}
        if entry.get('referenceRegion') != local:
            raise ValueError('image_stage_cache_erasure_material_region_invalid')
        return previous

    @staticmethod
    def lettering_identity(layer):
        # Placement is applied after native glyph generation and is verified
        # against the current photo/ROI. It is not a model-input fingerprint.
        return {'text': layer['text'], 'style': layer.get('style')}

    @classmethod
    def protected_generation_identity(cls, spec):
        return {'schema': spec['schema'], 'eraseRegions': spec['eraseRegions'],
                'textLayers': [cls.lettering_identity(layer) for layer in spec['textLayers']]}

    def complete_line_source(self, row, payload, entry):
        """A failed native sheet is material for fresh verification, not a pass."""
        previous = self.compatible_cache_source(row, payload)
        target = re.fullmatch(r'text_layer_([0-3])_attempt_1', entry['stage'])
        source = re.fullmatch(r'text_layer_([0-3])_attempt_[12]', entry['sourceStage'])
        if (entry.get('selectionMode') != 'complete-line' or not target or not source
                or target[1] != source[1]
                or int(target[1]) >= len(payload['protected']['textLayers'])
                or row['state'] != 'FAILED'
                or row['error_code'] != 'protected_generated_text_mismatch'
                or self.protected_generation_identity(previous['protected']) !=
                   self.protected_generation_identity(payload['protected'])):
            raise ValueError('image_stage_cache_complete_line_source_invalid')
        return previous

    def stage_cache(self, row, *, result=None):
        """Bind private execution references back to same-scope SQLite rows."""
        from .stage_cache import validate_stage_cache
        path = self.folder(row['job_id']) / 'stage-cache.json'
        if path.is_symlink():raise ValueError('image_stage_cache_path_invalid')
        if not path.exists():
            if result is not None and result.get('stageCacheSha256') is not None:
                raise ValueError('image_stage_cache_receipt_changed')
            return None, None
        if not path.is_file() or not 0 < path.stat().st_size <= 256 * 1024:
            raise ValueError('image_stage_cache_file_invalid')
        raw = path.read_bytes();digest = sha(raw)
        if result is not None and result.get('stageCacheSha256') != digest:
            raise ValueError('image_stage_cache_receipt_changed')
        manifest = validate_stage_cache(json.loads(raw), path.parent)
        payload = json.loads(row['payload_json'])
        for entry in manifest['assets']:
            source = self.row(entry['sourceJobId'], row['scope'])
            if source['payload_sha'] != entry['sourcePayloadSha256']:
                raise ValueError('image_stage_cache_source_payload_changed')
            if entry.get('selectionMode') == 'erasure-material':
                self.erasure_material_source(source, payload, entry)
            elif entry.get('selectionMode') == 'complete-line':
                self.complete_line_source(source, payload, entry)
            else:
                self.compatible_cache_source(source, payload)
                if entry['stage'].startswith('text_layer_') and (
                        source['state'] != 'GENERATED_PENDING_REVIEW' or not source['result_json']):
                    raise ValueError('image_stage_cache_text_not_sealed')
        return manifest, digest

    def select_stage_cache(self, db, scope, payload, source_bytes, folder):
        """Bounded, read-only discovery of already completed native stages."""
        from .protected_cover import (source_image, erase_context, erasure_prompt,
                                      font_prompt, _verify_asset_reference)
        from .stage_cache import cached_asset_paths, erasure_reference_matches, read_cached_asset
        manifest = {'schema': 'aiworker-protected-stage-cache/v1', 'assets': []}
        candidates = db.execute(
            "SELECT * FROM image_jobs WHERE scope=? AND state IN ('GENERATED_PENDING_REVIEW','FAILED','CANCELLED','RECONCILE_REQUIRED') AND json_type(payload_json,'$.protected')='object' ORDER BY created_at DESC,job_id DESC LIMIT 12",
            (scope,)).fetchall()
        compatible = [];erasure_compatible = []
        for row in candidates:
            try:
                previous = self.compatible_cache_source(row, payload)
                compatible.append((row, previous));erasure_compatible.append((row, previous))
            except (ValueError, KeyError, IndexError):pass
            if not any(item[0]['job_id'] == row['job_id'] for item in erasure_compatible):
                try:erasure_compatible.append((row, self.compatible_cache_source(row, payload, allow_lineage=True, db=db)))
                except (OSError, ValueError, KeyError, IndexError):pass
        original = source_image(source_bytes)

        def native_entry(path, target, *, text=False, selection_mode=None, reference_region=None, allow_lineage=False):
            path = Path(path)
            relative = path.relative_to(self.config.output_root)
            if (len(relative.parts) != 4 or not JOB.fullmatch(relative.parts[0])
                    or relative.parts[1] != 'stages' or relative.parts[3] != 'model.png'):
                raise ValueError('image_stage_cache_native_path_invalid')
            owner = db.execute('SELECT * FROM image_jobs WHERE job_id=? AND scope=?',
                               (relative.parts[0], scope)).fetchone()
            if not owner:raise ValueError('image_stage_cache_scope_invalid')
            self.compatible_cache_source(owner, payload, allow_lineage=allow_lineage, db=db)
            if text and selection_mode is None and (
                    owner['state'] != 'GENERATED_PENDING_REVIEW' or not owner['result_json']):
                raise ValueError('image_stage_cache_text_not_sealed')
            for member in (path, path.with_suffix('.receipt.json'), *path.parents):
                if member.is_symlink():raise ValueError('image_stage_cache_native_path_invalid')
                if member == self.config.output_root:break
            proof_path = path.with_suffix('.receipt.json')
            if (not path.is_file() or not 0 < path.stat().st_size <= MAX_OUTPUT
                    or not proof_path.is_file() or not 0 < proof_path.stat().st_size <= 256 * 1024):
                raise ValueError('image_stage_cache_native_file_invalid')
            entry = {'stage': target, 'sourceJobId': owner['job_id'], 'sourceStage': relative.parts[2],
                     'sourcePayloadSha256': owner['payload_sha'], 'sha256': sha(path.read_bytes()),
                     'receiptSha256': sha(proof_path.read_bytes())}
            if selection_mode is not None:
                entry['selectionMode'] = selection_mode
                if selection_mode == 'erasure-material':
                    entry['referenceRegion'] = reference_region
                    self.erasure_material_source(owner, payload, entry, db=db)
                else:self.complete_line_source(owner, payload, entry)
            image, proof = read_cached_asset(entry, folder)
            if (proof.get('repository') != self.backend.REPOSITORY or proof.get('revision') != self.backend.REVISION
                    or proof.get('precision') != 'BF16' or proof.get('offline') is not True
                    or proof.get('postProcessing') is not False
                    or not isinstance(proof.get('componentDtypes'), dict)
                    or set(proof.get('componentDtypes', {}).values()) != {'torch.bfloat16'}
                    or any(proof.get(key) != payload[key] for key in ('steps', 'guidance', 'seed'))
                    or not all(512 <= side <= 2048 and side % 16 == 0 for side in image.size)):
                raise ValueError('image_stage_cache_native_runtime_invalid')
            return entry, image

        def erasure_path(row, stage):
            own = self.folder(row['job_id']) / 'stages' / stage / 'model.png'
            if own.exists():return own
            cache, _ = self.stage_cache(row)
            if cache:
                for path, entry in cached_asset_paths(cache, self.folder(row['job_id'])).items():
                    if entry['stage'] == stage:return Path(path)
            raise ValueError('image_stage_cache_stage_missing')

        for index, region in enumerate(payload['protected']['eraseRegions']):
            crop, context = erase_context(original, region)
            local = {**region, 'x': region['x'] - context['x'], 'y': region['y'] - context['y']}
            choices = []
            for row, old in erasure_compatible:
                try:
                    old_index = old['protected']['eraseRegions'].index(region)
                    path = erasure_path(row, 'erase_' + str(old_index + 1))
                    try:
                        entry, _ = native_entry(path, 'erase_' + str(index + 1))
                        _verify_asset_reference({'path': str(path)}, crop, erasure_prompt(local))
                    except (ValueError, KeyError, IndexError):
                        entry, _ = native_entry(path, 'erase_' + str(index + 1),
                            selection_mode='erasure-material', reference_region=local, allow_lineage=True)
                        from PIL import Image
                        with Image.open(path.with_name('reference.png')) as native_reference:
                            if not erasure_reference_matches(native_reference, crop, local):
                                raise ValueError('image_stage_cache_erasure_reference_changed')
                    owner = db.execute('SELECT created_at FROM image_jobs WHERE job_id=? AND scope=?',
                                       (entry['sourceJobId'], scope)).fetchone()
                    choices.append((owner['created_at'], entry['sourceJobId'], entry))
                except (OSError, ValueError, KeyError, IndexError):pass
            if choices:manifest['assets'].append(max(choices, key=lambda value: value[:2])[2])

        for index, layer in enumerate(payload['protected']['textLayers']):
            target = 'text_layer_' + str(index) + '_attempt_1'
            for row, old in compatible:
                if row['state'] != 'GENERATED_PENDING_REVIEW' or not row['result_json']:continue
                try:
                    old_index = [self.lettering_identity(value) for value in old['protected']['textLayers']].index(
                        self.lettering_identity(layer))
                    result, _ = self.result(row)
                    if canonical(result) != row['result_json']:
                        raise ValueError('image_result_receipt_changed')
                    selected = result['selectedLetteringAssets'][old_index]
                    path = Path(selected['path'])
                    entry, image = native_entry(path, target, text=True)
                    if entry['sha256'] != selected['sha256']:
                        raise ValueError('image_stage_cache_selected_asset_changed')
                    from PIL import Image
                    _verify_asset_reference({'path': str(path)}, Image.new('RGB', image.size, (255, 0, 255)),
                                            font_prompt(layer, False))
                    manifest['assets'].append(entry);break
                except (OSError, ValueError, KeyError, IndexError):pass
            if any(entry['stage'] == target for entry in manifest['assets']):continue
            # Only the latest completed native attempt of an otherwise exact
            # failed request may supply a sheet. Its rows still have to pass
            # fresh component selection, OCR and final-ROI verification.
            for row, old in compatible:
                if (row['state'] != 'FAILED' or row['error_code'] != 'protected_generated_text_mismatch'
                        or self.protected_generation_identity(old['protected']) !=
                           self.protected_generation_identity(payload['protected'])):continue
                for attempt in (2, 1):
                    try:
                        path = (self.folder(row['job_id']) / 'stages' /
                                ('text_layer_' + str(index) + '_attempt_' + str(attempt)) / 'model.png')
                        entry, image = native_entry(path, target, text=True, selection_mode='complete-line')
                        from PIL import Image
                        _verify_asset_reference({'path': str(path)}, Image.new('RGB', image.size, (255, 0, 255)),
                                                path.with_name('prompt.txt').read_text())
                        manifest['assets'].append(entry);break
                    except (OSError, ValueError, KeyError, IndexError):pass
                if any(entry['stage'] == target for entry in manifest['assets']):break
        return manifest

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
        payload = json.loads(row['payload_json'])
        execution = payload['execution']
        result = {'jobId': row['job_id'], 'currentState': row['state'],
                  'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
                  'errorCode': row['error_code'], **execution,
                  'nextAction': 'review_image' if row['state'] == 'GENERATED_PENDING_REVIEW' else
                      'inspect_and_reconcile' if row['state'] == 'RECONCILE_REQUIRED' else
                      'inspect_error' if row['state'] == 'FAILED' else
                      'none' if row['state'] == 'CANCELLED' else 'wait_or_query_status'}
        if 'protected' in payload:
            result['mode'] = 'protected'
        if row['result_json']:
            saved = json.loads(row['result_json'])
            result.update({key: saved[key] for key in ('output', 'outputSha256', 'outputBytes', 'width', 'height', 'elapsedSeconds', 'postProcessing') if key in saved})
            if 'protected' in payload and isinstance(saved.get('photoProtection'), dict):
                proof = saved['photoProtection']
                result['photoProtection'] = {key: proof[key] for key in (
                    'outsideChangedPixels', 'protectedPixels', 'changedPixels', 'sourceWidth', 'sourceHeight'
                ) if type(proof.get(key)) is int and proof[key] >= 0}
            if 'protected' in payload and isinstance(saved.get('textValidation'), dict):
                proof = saved['textValidation']
                summary = {}
                if type(proof.get('matched')) is bool:
                    summary['matched'] = proof['matched']
                for key, expected in (('engine', 'apple-vision'), ('mode', 'normalized_text_sequence')):
                    if proof.get(key) == expected:
                        summary[key] = expected
                if (proof.get('engine') == 'not-applicable' and proof.get('matched') is True
                        and type(proof.get('expectedCount')) is int and proof['expectedCount'] == 0
                        and type(proof.get('observedCount')) is int and proof['observedCount'] == 0):
                    summary['engine'] = 'not-applicable'
                for key in ('expectedCount', 'observedCount'):
                    if type(proof.get(key)) is int and 0 <= proof[key] <= 32:
                        summary[key] = proof[key]
                result['textValidation'] = summary
        if row['state'] in ('RUNNING', 'CANCEL_REQUESTED'):
            intent = self.folder(row['job_id']) / 'image.intent.json'
            try:
                progress = json.loads(intent.read_text())
                result.update({key: progress[key] for key in ('completedSteps', 'totalSteps', 'elapsedSeconds') if key in progress})
                if isinstance(progress.get('stage'), str) and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', progress['stage']):
                    result['stage'] = progress['stage']
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

    def result(self, row, *, verify_current_composition=False):
        folder = self.folder(row['job_id'])
        receipt_path = folder / 'image.receipt.json'
        output = folder / 'image.png'
        if receipt_path.is_symlink() or output.is_symlink():
            raise ValueError('image_result_path_invalid')
        result = json.loads(receipt_path.read_text())
        with output.open('rb') as source:
            data = source.read(MAX_OUTPUT + 1)
        payload = json.loads(row['payload_json'])
        protected = 'protected' in payload
        if (len(data) > MAX_OUTPUT or result.get('currentState') != 'GENERATED_PENDING_REVIEW'
                or result.get('output') != str(output) or result.get('outputSha256') != sha(data)
                or result.get('repository') != self.backend.REPOSITORY
                or result.get('revision') != self.backend.REVISION
                or result.get('outputBytes') != len(data)
                or result.get('postProcessing') is not protected
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
        if protected:
            from .protected_cover import verify_protected_result
            source = folder / ('reference-0' + payload['references'][0]['suffix'])
            if source.is_symlink() or sha(source.read_bytes()) != payload['references'][0]['sha256']:
                raise ValueError('image_protected_source_changed')
            if result.get('protectedSourceSha256') != payload['execution']['protectedSourceSha256']:
                raise ValueError('image_protected_implementation_receipt_changed')
            stage_cache, _ = self.stage_cache(row, result=result)
            verify_protected_result(source, output, payload['protected'], result,
                                    strict_live=verify_current_composition, stage_cache=stage_cache)
        return result, data

    def image(self, job_id, scope):
        row = self.row(job_id, scope)
        if row['state'] != 'GENERATED_PENDING_REVIEW':
            raise ValueError('image_result_not_ready')
        result, data = self.result(row)
        if canonical(result) != row['result_json']:
            raise ValueError('image_result_receipt_changed')
        return data

    def inspection(self, job_id, scope):
        """Return only owned source/result previews; never accept arbitrary paths."""
        row = self.row(job_id, scope)
        if row['state'] != 'GENERATED_PENDING_REVIEW':
            raise ValueError('image_result_not_ready')
        result, data = self.result(row)
        if canonical(result) != row['result_json']:
            raise ValueError('image_result_receipt_changed')
        payload = json.loads(row['payload_json'])
        source = self.folder(job_id) / ('reference-0' + payload['references'][0]['suffix'])
        if source.is_symlink():
            raise ValueError('image_inspection_source_invalid')
        original = source.read_bytes()
        if len(original) > MAX_PROTECTED_INPUT or sha(original) != payload['references'][0]['sha256']:
            raise ValueError('image_inspection_source_changed')
        from PIL import Image, ImageOps
        try:
            for maximum in (1024, 768, 512):
                images = []
                for role, raw in (('source', original), ('result', data)):
                    with Image.open(io.BytesIO(raw)) as decoded:
                        if decoded.width * decoded.height > 24 * 1024 * 1024 or max(decoded.size) > 8192:
                            raise ValueError('image_inspection_dimensions_invalid')
                        image = ImageOps.exif_transpose(decoded).convert('RGB')
                        image.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
                        buffer = io.BytesIO()
                        image.save(buffer, format='PNG')
                        preview = buffer.getvalue()
                        images.append({'role': role, 'mimeType': 'image/png',
                                       'data': base64.b64encode(preview).decode('ascii'),
                                       'sha256': sha(preview), 'width': image.width, 'height': image.height})
                response = {'jobId': job_id, 'currentState': row['state'], 'images': images}
                if (all(len(base64.b64decode(item['data'])) <= 2 * 1024 * 1024 for item in images)
                        and len(canonical(response).encode()) <= MAX_INSPECTION_JSON):
                    return response
        except (OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise ValueError('image_inspection_decode_failed') from error
        raise ValueError('image_inspection_too_large')

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
                payload = json.loads(row['payload_json'])
                if 'protected' in payload:
                    # This result has not yet been sealed in SQLite. Recovery
                    # is a first acceptance, not a historical read, so it must
                    # still use the exact renderer admitted for this job.
                    from .protected_cover import implementation_digest
                    if payload['execution']['protectedSourceSha256'] != implementation_digest():
                        self.settle(row, 'RECONCILE_REQUIRED', 'image_job_runtime_changed')
                        continue
                result, _ = self.result(row, verify_current_composition=True)
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
        protected = 'protected' in payload
        if protected:
            command = [str(self.config.backend_python), '-m', 'image_generation.protected_worker',
                       '--spec-file', str(folder / 'input.json'),
                       '--source', str(folder / ('reference-0' + payload['references'][0]['suffix'])),
                       '--output', str(folder / 'image.png'), '--backend-script', str(self.config.backend_script)]
        else:
            command = [str(self.config.backend_python), str(self.config.backend_script), 'generate', '--wait-for-model',
                       '--output', str(folder / 'image.png'), '--images',
                       *[str(folder / ('reference-' + str(i) + r['suffix'])) for i, r in enumerate(payload['references'])]]
            if 'design' in payload:
                command += ['--design-file', str(folder / 'input.json'), '--profiles-file', str(self.config.profiles_file)]
            else:
                command += ['--prompt-file', str(folder / 'prompt.txt')]
        for key in (('steps', 'guidance', 'seed') if protected else ('width', 'height', 'steps', 'guidance', 'seed')):
            command += ['--' + key, str(payload[key])]
        process = None
        owner = None
        outcome = None
        cancelled = False
        try:
            expected_execution = {'sourceCommit': self.config.source_commit,
                                  'backendSha256': self.backend_sha, 'profilesSha256': self.profiles_sha}
            if protected:
                from .protected_cover import implementation_digest
                expected_execution['protectedSourceSha256'] = implementation_digest()
            if payload['execution'] != expected_execution:
                self.settle(row, 'RECONCILE_REQUIRED', 'image_job_runtime_changed')
                return True
            if protected:
                _, cache_sha = self.stage_cache(row)
                if cache_sha:
                    command += ['--stage-cache-file', str(folder / 'stage-cache.json'),
                                '--stage-cache-sha256', cache_sha]
            if (sha(self.config.backend_script.read_bytes()) != self.backend_sha
                    or sha(self.config.profiles_file.read_bytes()) != self.profiles_sha):
                raise ValueError('image_backend_source_changed')
            fd = os.open(folder / 'generator.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as log:
                env = os.environ.copy()
                owner_nonce = uuid.uuid4().hex
                env[WORKER_OWNER_ENV] = owner_nonce
                if protected:
                    env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1])
                    env['PYTHONDONTWRITEBYTECODE'] = '1'
                    env['AIWORKER_IMAGE_OCR_CACHE'] = str(self.config.state_root / 'vision-ocr-cache')
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True, env=env)
                owner = self.claim_process_group(process, owner_nonce)
                while process.poll() is None:
                    current = self.row(row['job_id'], row['scope'])
                    if current['state'] == 'CANCEL_REQUESTED' or self.stopping.is_set():
                        cancelled = True
                        self.stop_process(process, owner)
                        break
                    self.stopping.wait(0.5)
            # If completion raced cancellation, keep the verified native result.
            if process.returncode == 0:
                result, _ = self.result(row, verify_current_composition=True)
                outcome = ('GENERATED_PENDING_REVIEW', None, result)
            elif cancelled:
                outcome = ('CANCELLED', 'image_generation_cancelled', None)
            else:
                error_code = 'image_generator_exit_' + str(process.returncode)
                if protected:
                    try:
                        intent = json.loads((folder / 'image.intent.json').read_text())
                        candidate = intent.get('errorCode')
                        if isinstance(candidate, str) and WORKER_ERROR.fullmatch(candidate):
                            error_code = candidate
                    except (OSError, ValueError):
                        pass
                outcome = ('FAILED', error_code, None)
        except Exception as error:
            if process and process.poll() is None:
                try:
                    self.stop_process(process, owner)
                except ValueError:
                    # A Popen leader is still ours even when a descendant's
                    # group identity cannot be proved. Never kill an unknown
                    # group to compensate for a failed ownership probe.
                    self.stop_leader(process)
            code = str(error)
            if not protected or not WORKER_ERROR.fullmatch(code):
                code = 'image_generation_execution_failed'
            outcome = ('FAILED', code, None)
        finally:
            if process is not None:
                try:
                    if owner is None:
                        owner = self.claim_process_group(process, owner_nonce)
                    self.cleanup_process_group(owner)
                    self.stop_leader(process)  # reap the leader even on BaseException
                except (OSError, ValueError, subprocess.SubprocessError):
                    if process.poll() is None:
                        self.stop_leader(process)
                    outcome = ('RECONCILE_REQUIRED', 'image_worker_group_cleanup_unproven', None)
            if outcome is not None:
                self.settle(row, outcome[0], outcome[1], outcome[2])
        return True

    @staticmethod
    def stop_leader(process):
        """Stop only the Popen handle when no wider group proof is available."""
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    @staticmethod
    def live_group_members(pgid):
        if type(pgid) is not int or pgid <= 1 or pgid == os.getpgrp():
            raise ValueError('image_worker_group_identity_invalid')
        report = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid=,uid=,stat='],
                                capture_output=True, text=True, errors='replace', timeout=10)
        if report.returncode != 0 or len(report.stdout) > 2 * 1024 * 1024:
            raise ValueError('image_worker_group_inspection_failed')
        members = []
        for line in report.stdout.splitlines():
            if not line.strip():
                continue
            fields = line.split()
            if (len(fields) != 4 or not all(value.isdecimal() for value in fields[:2])
                    or not re.fullmatch(r'-?[0-9]+', fields[2])):
                raise ValueError('image_worker_group_inspection_failed')
            pid, group, uid = map(int, fields[:3])
            # Zombies hold no model lock or live computation and may await
            # reaping by launchd/init after their worker parent has exited.
            if group == pgid and not fields[3].startswith('Z'):
                members.append((pid, uid))
        return members

    @classmethod
    def owned_group_members(cls, owner):
        pgid = owner['pgid']
        members = cls.live_group_members(pgid)
        proved = []
        marker = re.compile(r'(?:^|\s)' + re.escape(WORKER_OWNER_ENV + '=' + owner['nonce']) + r'(?=\s|$)')
        for pid, uid in members:
            try:
                if uid != owner['uid'] or os.getpgid(pid) != pgid or os.getsid(pid) != pgid:
                    raise ValueError('image_worker_group_owner_changed')
            except ProcessLookupError:
                continue
            report = subprocess.run(['/bin/ps', 'eww', '-p', str(pid), '-o', 'command='],
                                    capture_output=True, text=True, errors='replace', timeout=10)
            if report.returncode != 0 or len(report.stdout) > 2 * 1024 * 1024 or not marker.search(report.stdout):
                if pid not in {member[0] for member in cls.live_group_members(pgid)}:
                    continue  # exited or became a resource-free zombie
                raise ValueError('image_worker_group_owner_unproven')
            proved.append(pid)
        return proved

    @classmethod
    def claim_process_group(cls, process, nonce):
        # start_new_session=True is fixed at the sole Popen call above. Its
        # PID is the expected PGID/SID, and this per-job marker is inherited by
        # its model/OCR descendants. It is never a model-supplied PID.
        owner = {'pgid': process.pid, 'uid': os.getuid(), 'nonce': nonce}
        cls.owned_group_members(owner)
        return owner

    @classmethod
    def cleanup_process_group(cls, owner):
        if owner is None:
            return
        if not cls.owned_group_members(owner):
            return
        try:
            os.killpg(owner['pgid'], signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + 5
        while cls.owned_group_members(owner):
            if time.monotonic() >= deadline:
                # Re-prove the remaining membership immediately before the
                # stronger signal. No service group or another CLI's group.
                if cls.owned_group_members(owner):
                    try:
                        os.killpg(owner['pgid'], signal.SIGKILL)
                    except ProcessLookupError:
                        return
                final_deadline = time.monotonic() + 3
                while cls.owned_group_members(owner):
                    if time.monotonic() >= final_deadline:
                        raise ValueError('image_worker_group_cleanup_failed')
                    time.sleep(.05)
                return
            time.sleep(.05)

    @classmethod
    def stop_process(cls, process, owner):
        cls.cleanup_process_group(owner)
        cls.stop_leader(process)

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

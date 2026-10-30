"""Real isolated HTTP/job/child-process checks; no model or production writes."""
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from image_generation.service import Configuration, ImageJobs, canonical
from PIL import Image

spec = importlib.util.spec_from_file_location('image_http_adapter', ROOT / 'scripts/aiworker-image-service.py')
http_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http_module)

FAKE = '''import argparse, hashlib, json, pathlib, struct, time, subprocess, sys
from PIL import Image
REPOSITORY='Qwen/Qwen-Image-Edit-2511'
REVISION='6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'
def cover_design_prompt(*args): return 'test-design'
if __name__ == '__main__':
 p=argparse.ArgumentParser();p.add_argument('action');p.add_argument('--output');p.add_argument('--width',type=int);p.add_argument('--height',type=int)
 args,_=p.parse_known_args()
 output=pathlib.Path(args.output)
 prompt=(output.parent/'prompt.txt').read_text() if (output.parent/'prompt.txt').exists() else ''
 if prompt=='slow': time.sleep(60)
 if prompt=='fail': raise SystemExit(7)
 if prompt.startswith('orphan-'):
  child_code="import fcntl,os,pathlib,time,sys;root=pathlib.Path(sys.argv[1]);f=(root/'fixture-model.lock').open('a');fcntl.flock(f,fcntl.LOCK_EX);(root/'orphan.pid').write_text(str(os.getpid()));(root/'owned-ready').write_text('ready');time.sleep(60)"
  subprocess.Popen([sys.executable,'-c',child_code,str(output.parent)])
  deadline=time.monotonic()+5
  while not (output.parent/'owned-ready').exists():
   if time.monotonic()>deadline:raise RuntimeError('fixture_child_start_failed')
   time.sleep(.01)
  if prompt=='orphan-fail':raise SystemExit(9)
  if prompt=='orphan-invalid':
   output.write_bytes(b'invalid fixture output');raise SystemExit(0)
 Image.new('RGB',(args.width,args.height),'navy').save(output,format='PNG')
 data=output.read_bytes()
 result={'currentState':'GENERATED_PENDING_REVIEW','repository':REPOSITORY,'revision':REVISION,'output':str(output),'outputSha256':hashlib.sha256(data).hexdigest(),'outputBytes':len(data),'postProcessing':False,'width':args.width,'height':args.height}
 output.with_suffix('.receipt.json').write_text(json.dumps(result))
'''


class ImageJobTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.refs = self.root / 'refs'
        self.refs.mkdir()
        self.reference = self.refs / 'frame.png'
        self.reference.write_bytes(b'\x89PNG\r\n\x1a\n' + b'original')
        self.backend = self.root / 'backend.py'
        self.backend.write_text(FAKE)
        self.profiles = self.root / 'profiles.json'
        self.profiles.write_text((ROOT / 'ops/image-generation/qwen-image-edit-2511/cover-design-profiles.json').read_text())
        self.config = Configuration(self.root / 'state', self.root / 'output', (self.refs, self.root / 'output'),
                                    self.backend, Path(sys.executable), self.profiles, 'a' * 40)
        self.jobs = ImageJobs(self.config)
        self.request = {'scope': 'a' * 64, 'requestKey': 'b' * 64,
                        'prompt': '完整中文封面测试', 'creativeRedraw': True,
                        'images': [str(self.reference)]}

    def tearDown(self):
        self.jobs.close()
        self.temp.cleanup()

    def test_deduplication_and_conflict_do_not_create_second_output(self):
        first = self.jobs.submit(self.request)
        duplicate = self.jobs.submit(self.request)
        self.assertEqual(first['jobId'], duplicate['jobId'])
        self.assertTrue(duplicate['duplicate'])
        with self.assertRaisesRegex(ValueError, 'idempotency_conflict'):
            self.jobs.submit({**self.request, 'prompt': '另一个要求'})
        self.assertEqual(len(list(self.config.output_root.iterdir())), 1)

    def test_scope_and_reference_boundaries(self):
        receipt = self.jobs.submit(self.request)
        with self.assertRaisesRegex(ValueError, 'job_not_found'):
            self.jobs.get(receipt['jobId'], 'c' * 64)
        outside = self.root / 'secret.png'
        outside.write_bytes(self.reference.read_bytes())
        linked = self.refs / 'escape.png'
        linked.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'outside_allowed_roots'):
            self.jobs.submit({**self.request, 'images': [str(linked)]})
        with self.assertRaisesRegex(ValueError, 'request_invalid'):
            self.jobs.submit({**self.request, 'output': '/arbitrary/path'})

    def test_full_frame_redraw_requires_explicit_confirmation(self):
        omitted={key:value for key,value in self.request.items() if key!='creativeRedraw'}
        with self.assertRaisesRegex(ValueError,'creative_redraw_confirmation_required'):
            self.jobs.submit(omitted)
        protected=self.protected_request()
        with self.assertRaisesRegex(ValueError,'creative_redraw_not_allowed_for_protected'):
            self.jobs.submit({**protected,'creativeRedraw':True})

    def test_snapshot_and_queued_cancel(self):
        receipt = self.jobs.submit(self.request)
        copy = self.config.output_root / receipt['jobId'] / 'reference-0.png'
        expected = copy.read_bytes()
        self.reference.write_bytes(b'changed-original')
        self.assertEqual(copy.read_bytes(), expected)
        self.assertEqual(self.jobs.cancel(receipt['jobId'], self.request['scope'])['currentState'], 'CANCELLED')
        self.assertFalse(self.jobs.run_one())

    def test_actual_child_success_and_result_tamper(self):
        receipt = self.jobs.submit(self.request)
        self.assertTrue(self.jobs.run_one())
        result = self.jobs.get(receipt['jobId'], self.request['scope'])
        self.assertEqual(result['currentState'], 'GENERATED_PENDING_REVIEW')
        data = self.jobs.image(receipt['jobId'], self.request['scope'])
        self.assertEqual(hashlib.sha256(data).hexdigest(), result['outputSha256'])
        Path(result['output']).write_bytes(data + b'tamper')
        with self.assertRaisesRegex(ValueError, 'integrity_failed'):
            self.jobs.image(receipt['jobId'], self.request['scope'])

    def test_generator_failure_is_terminal_without_retry(self):
        receipt = self.jobs.submit({**self.request, 'prompt': 'fail'})
        self.jobs.run_one()
        result = self.jobs.get(receipt['jobId'], self.request['scope'])
        self.assertEqual(result['currentState'], 'FAILED')
        self.assertEqual(result['errorCode'], 'image_generator_exit_7')
        self.assertFalse(self.jobs.run_one())

    def test_running_cancel_and_single_service(self):
        receipt = self.jobs.submit({**self.request, 'prompt': 'slow'})
        self.jobs.start()
        self.assertEqual(self.jobs.health()['databaseIntegrity'], 'ok')
        deadline = time.monotonic() + 5
        while self.jobs.get(receipt['jobId'], self.request['scope'])['currentState'] == 'QUEUED' and time.monotonic() < deadline:
            time.sleep(0.01)
        other = ImageJobs(self.config)
        try:
            with self.assertRaises(BlockingIOError):
                other.start()
        finally:
            other.close()
        self.jobs.cancel(receipt['jobId'], self.request['scope'])
        while self.jobs.get(receipt['jobId'], self.request['scope'])['currentState'] == 'CANCEL_REQUESTED' and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.jobs.get(receipt['jobId'], self.request['scope'])['currentState'], 'CANCELLED')

    def test_interruption_requires_reconcile_not_automatic_generation(self):
        receipt = self.jobs.submit(self.request)
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING' WHERE job_id=?", (receipt['jobId'],))
        self.jobs.recover()
        self.assertEqual(self.jobs.get(receipt['jobId'], self.request['scope'])['currentState'], 'RECONCILE_REQUIRED')
        self.assertFalse(self.jobs.run_one())

    def test_completed_receipt_recovers_after_worker_interruption(self):
        receipt = self.jobs.submit(self.request)
        self.jobs.run_one()
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING',result_json=NULL WHERE job_id=?", (receipt['jobId'],))
        self.jobs.recover()
        self.assertEqual(self.jobs.get(receipt['jobId'], self.request['scope'])['currentState'], 'GENERATED_PENDING_REVIEW')
        self.assertFalse(self.jobs.run_one())

    def test_job_source_stays_bound_to_acceptance_after_component_update(self):
        receipt = self.jobs.submit(self.request)
        config = Configuration(self.config.state_root, self.config.output_root, self.config.reference_roots,
                               self.backend, Path(sys.executable), self.profiles, 'f' * 40)
        updated = ImageJobs(config)
        try:
            self.assertEqual(updated.get(receipt['jobId'], self.request['scope'])['sourceCommit'], 'a' * 40)
        finally:
            updated.close()

    def test_real_http_acceptance_listing_and_origin_guard(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), http_module.handler_type(self.jobs))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        direct = build_opener(ProxyHandler({})).open
        try:
            request = Request(base + '/v1/jobs', data=canonical(self.request).encode(), headers={'Content-Type': 'application/json'})
            with direct(request) as response:
                self.assertEqual(response.status, 202)
                receipt = json.load(response)
            with direct(base + '/v1/jobs?scope=' + self.request['scope']) as response:
                jobs = json.load(response)['jobs']
            self.assertEqual(jobs[0]['jobId'], receipt['jobId'])
            self.assertNotIn('prompt', jobs[0])
            request.add_header('Origin', 'https://untrusted.example')
            with self.assertRaises(HTTPError) as error:
                direct(request)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def protected_request(self):
        Image.new('RGB', (1920, 1080), 'navy').save(self.reference)
        return {'scope': self.request['scope'], 'requestKey': self.request['requestKey'],
                'images': [str(self.reference)], 'protected': {
                    'schema': 'aiworker-protected-cover/v1',
                    'eraseRegions': [{'x': 100, 'y': 100, 'width': 24, 'height': 24}]}}

    def protected_candidate(self, accepted, *, ocr=None):
        """A synthetic native patch tests acceptance, never text generation."""
        from image_generation.protected_worker import build_protected
        fixture_spec = importlib.util.spec_from_file_location('protected_job_fixtures', ROOT / 'tests/test_protected_cover.py')
        fixtures = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixtures)
        folder = self.jobs.folder(accepted['jobId'])
        output = folder / 'image.png'
        runner = fixtures.FixtureRunner()
        runner.repository, runner.revision = self.jobs.backend.REPOSITORY, self.jobs.backend.REVISION
        options = {'ocr': ocr} if ocr else {}
        if (folder / 'stage-cache.json').exists():
            options['stage_cache'] = json.loads((folder / 'stage-cache.json').read_text())
        receipt = build_protected(folder / 'input.json', folder / 'reference-0.png', output, runner, **options)
        return receipt, output

    def cache_source(self, *, completed=False, text=False, retry_text=False):
        request = {**self.protected_request(), 'steps': 30}
        if text:
            request['protected']['textLayers'] = [{'text': '北极驯鹿人',
                'box': {'x': 900, 'y': 40, 'width': 600, 'height': 160}, 'align': 'left'}]
        accepted = self.jobs.submit(request)
        def ocr(path):
            wrong = retry_text and 'text_layer_0_attempt_1' in str(path)
            return {'lines': [{'text': '错误' if wrong else '北极驯鹿人'}]}
        result, output = self.protected_candidate(accepted, ocr=ocr if text else None)
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING' WHERE job_id=?", (accepted['jobId'],))
        self.jobs.settle(self.jobs.row(accepted['jobId'], request['scope']),
                         'GENERATED_PENDING_REVIEW' if completed else 'FAILED',
                         None if completed else 'protected_generated_text_mismatch',
                         result if completed else None)
        return request, accepted, result, output

    def complete_protected_request(self, request):
        accepted = self.jobs.submit(request)
        receipt, output = self.protected_candidate(accepted)
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING' WHERE job_id=?", (accepted['jobId'],))
        self.jobs.settle(self.jobs.row(accepted['jobId'], request['scope']), 'GENERATED_PENDING_REVIEW', result=receipt)
        return accepted, receipt, output

    def erasure_material_chain(self):
        original = {**self.protected_request(), 'steps': 30}
        original['protected']['eraseRegions'].append({'x': 1000, 'y': 700, 'width': 24, 'height': 24})
        parent = self.complete_protected_request(original)
        repair = {**original, 'images': [str(parent[2])], 'requestKey': 'c' * 64,
                  'protected': {'schema': 'aiworker-protected-cover/v1',
                                'eraseRegions': [original['protected']['eraseRegions'][1]]}}
        child = self.complete_protected_request(repair)
        return original, parent, child

    def test_erasure_material_reuses_latest_native_owner_across_protected_lineage_and_indexes(self):
        request, parent, child = self.erasure_material_chain()
        root_sha = hashlib.sha256(self.reference.read_bytes()).hexdigest()
        child_payload = json.loads(self.jobs.row(child[0]['jobId'], request['scope'])['payload_json'])
        self.assertEqual(self.jobs.reference_lineage(child_payload, request['scope']), root_sha)
        # A newer cancelled job referencing an old patch must not outrank the
        # genuinely newer native repair made by the child job.
        referrer = self.jobs.submit({**request, 'requestKey': 'd' * 64})
        path = self.jobs.folder(referrer['jobId']) / 'stage-cache.json'
        cache = json.loads(path.read_text())
        original_asset = parent[1]['assets'][1]
        parent_row = self.jobs.row(parent[0]['jobId'], request['scope'])
        cache['assets'][1] = {'stage': 'erase_2', 'sourceJobId': parent[0]['jobId'], 'sourceStage': 'erase_2',
            'sourcePayloadSha256': parent_row['payload_sha'], 'sha256': original_asset['sha256'],
            'receiptSha256': original_asset['receiptSha256']}
        path.write_text(canonical(cache));self.jobs.cancel(referrer['jobId'], request['scope'])
        accepted = self.jobs.submit({**request, 'requestKey': 'e' * 64})
        row = self.jobs.row(accepted['jobId'], request['scope']);cache, _ = self.jobs.stage_cache(row)
        first, second = cache['assets']
        self.assertEqual(first['sourceJobId'], parent[0]['jobId'])
        self.assertEqual((second['stage'], second['sourceStage'], second['sourceJobId']),
                         ('erase_2', 'erase_1', child[0]['jobId']))
        self.assertEqual(second['selectionMode'], 'erasure-material')
        self.assertEqual(second['referenceRegion'], {'x': 244, 'y': 244, 'width': 24, 'height': 24})
        self.assertEqual(second['sha256'], child[1]['assets'][0]['sha256'])

    def test_erasure_material_allows_prompt_changes_but_checks_outside_reference_pixels(self):
        request, parent, child = self.erasure_material_chain()
        from image_generation.protected_cover import erasure_prompt
        old_prompt = erasure_prompt
        with patch('image_generation.protected_cover.erasure_prompt', side_effect=lambda region: old_prompt(region) + ' New implementation wording.'):
            accepted = self.jobs.submit({**request, 'requestKey': 'd' * 64})
        cache, _ = self.jobs.stage_cache(self.jobs.row(accepted['jobId'], request['scope']))
        self.assertTrue(all(entry['selectionMode'] == 'erasure-material' for entry in cache['assets']))
        self.assertEqual(cache['assets'][1]['sourceJobId'], child[0]['jobId'])
        # Keep the synthetic native proof internally consistent while changing
        # one context pixel outside the permitted ROI: selection must reject it.
        folder = child[2].parent / 'stages' / 'erase_1'
        with Image.open(folder / 'reference.png') as image:changed = image.copy()
        changed.putpixel((0, 0), (255, 0, 0));changed.save(folder / 'reference.png')
        proof_path = folder / 'model.receipt.json';proof = json.loads(proof_path.read_text())
        proof['inputs'][1]['sha256'] = hashlib.sha256((folder / 'reference.png').read_bytes()).hexdigest()
        proof_path.write_text(json.dumps(proof))
        accepted = self.jobs.submit({**request, 'requestKey': 'e' * 64})
        cache, _ = self.jobs.stage_cache(self.jobs.row(accepted['jobId'], request['scope']))
        self.assertEqual(cache['assets'][1]['sourceJobId'], parent[0]['jobId'])

    def test_erasure_material_readback_rejects_wrong_rectangle_region_or_lineage(self):
        request, parent, child = self.erasure_material_chain()
        accepted = self.jobs.submit({**request, 'requestKey': 'd' * 64})
        row = self.jobs.row(accepted['jobId'], request['scope']);path = self.jobs.folder(accepted['jobId']) / 'stage-cache.json'
        raw = path.read_bytes();cache = json.loads(raw)
        cache['assets'][1]['referenceRegion']['x'] += 1
        path.write_text(canonical(cache))
        with self.assertRaisesRegex(ValueError, 'material_region_invalid'):
            self.jobs.stage_cache(row)
        path.write_bytes(raw);cache = json.loads(raw);cache['assets'][1]['stage'] = 'erase_1';cache['assets'] = cache['assets'][1:]
        path.write_text(canonical(cache))
        with self.assertRaisesRegex(ValueError, 'material_source_invalid'):
            self.jobs.stage_cache(row)
        path.write_bytes(raw)
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET scope=? WHERE job_id=?', ('f' * 64, parent[0]['jobId']))
        with self.assertRaisesRegex(ValueError, '(job_not_found|lineage_parent_invalid)'):
            self.jobs.stage_cache(row)
        with self.assertRaisesRegex(ValueError, 'lineage_parent_invalid'):
            self.jobs.reference_lineage(json.loads(self.jobs.row(child[0]['jobId'], request['scope'])['payload_json']), request['scope'])

    def test_erasure_material_cannot_cross_distinct_original_photos_with_identical_crop_context(self):
        request, _, child = self.erasure_material_chain()
        other = self.refs / 'other-original.png'
        with Image.open(self.reference) as image:different = image.copy()
        different.putpixel((0, 0), (255, 0, 0));different.save(other)
        foreign = self.complete_protected_request({**request, 'requestKey': 'd' * 64, 'images': [str(other)],
            'protected': {'schema': 'aiworker-protected-cover/v1',
                          'eraseRegions': [request['protected']['eraseRegions'][1]]}})
        accepted = self.jobs.submit({**request, 'requestKey': 'e' * 64})
        row = self.jobs.row(accepted['jobId'], request['scope']);path = self.jobs.folder(accepted['jobId']) / 'stage-cache.json'
        cache = json.loads(path.read_bytes())
        self.assertEqual(cache['assets'][1]['sourceJobId'], child[0]['jobId'])
        foreign_row = self.jobs.row(foreign[0]['jobId'], request['scope'])
        cache['assets'][1].update(sourceJobId=foreign[0]['jobId'], sourceStage='erase_1',
            sourcePayloadSha256=foreign_row['payload_sha'], sha256=foreign[1]['assets'][0]['sha256'],
            receiptSha256=foreign[1]['assets'][0]['receiptSha256'])
        path.write_text(canonical(cache))
        with self.assertRaisesRegex(ValueError, 'source_incompatible'):
            self.jobs.stage_cache(row)

    def test_material_lineage_rejects_raw_parents_wrong_hash_and_changed_sealed_output(self):
        request, parent, child = self.erasure_material_chain()
        payload = json.loads(self.jobs.row(child[0]['jobId'], request['scope'])['payload_json'])
        wrong = json.loads(json.dumps(payload));wrong['references'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'lineage_parent_invalid'):
            self.jobs.reference_lineage(wrong, request['scope'])
        parent[2].write_bytes(parent[2].read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'lineage_parent_changed'):
            self.jobs.reference_lineage(payload, request['scope'])
        # A successful creative/raw image is still not a protected-photo parent.
        raw = self.jobs.submit({**self.request, 'requestKey': 'd' * 64});self.jobs.run_one()
        raw_result = self.jobs.get(raw['jobId'], request['scope'])
        protected = {**request, 'requestKey': 'e' * 64, 'images': [raw_result['output']],
            'protected': {'schema': 'aiworker-protected-cover/v1',
                          'eraseRegions': [request['protected']['eraseRegions'][0]]}}
        raw_parent_payload, _ = self.jobs.normalize(protected)
        with self.assertRaisesRegex(ValueError, 'lineage_parent_invalid'):
            self.jobs.reference_lineage(raw_parent_payload, request['scope'])

    def test_material_lineage_stops_cycles_and_more_than_eight_protected_hops(self):
        request = {**self.protected_request(), 'steps': 30}
        Image.new('RGB', (1920, 1080), (77, 110, 25)).save(self.reference)
        original_sha = hashlib.sha256(self.reference.read_bytes()).hexdigest()
        first = self.complete_protected_request(request)
        self.assertEqual(first[1]['outputSha256'], original_sha)
        source = self.jobs.row(first[0]['jobId'], request['scope']);cyclic = json.loads(source['payload_json'])
        cyclic['references'][0]['source'] = str(first[2])
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET payload_json=?,payload_sha=? WHERE job_id=?',
                (canonical(cyclic), hashlib.sha256(canonical(cyclic).encode()).hexdigest(), first[0]['jobId']))
        with self.assertRaisesRegex(ValueError, 'lineage_cycle'):
            self.jobs.reference_lineage(cyclic, request['scope'])
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET payload_json=?,payload_sha=? WHERE job_id=?',
                       (source['payload_json'], source['payload_sha'], first[0]['jobId']))
        current = first
        for index in range(2, 10):
            current = self.complete_protected_request({**request, 'requestKey': format(index, '064x'), 'images': [str(current[2])]})
            probe = {**json.loads(self.jobs.row(current[0]['jobId'], request['scope'])['payload_json']),
                     'references': [{'source': str(current[2]), 'sha256': current[1]['outputSha256'], 'suffix': '.png'}]}
            if index == 8:self.assertEqual(self.jobs.reference_lineage(probe, request['scope']), original_sha)
        with self.assertRaisesRegex(ValueError, 'lineage_too_deep'):
            self.jobs.reference_lineage(probe, request['scope'])

    def native_text_attempt(self, accepted, layer_index, attempt):
        fixture_spec = importlib.util.spec_from_file_location('image_cache_sheet_fixtures', ROOT / 'tests/test_protected_cover.py')
        fixtures = importlib.util.module_from_spec(fixture_spec);fixture_spec.loader.exec_module(fixtures)
        runner = fixtures.FixtureRunner()
        runner.repository, runner.revision = self.jobs.backend.REPOSITORY, self.jobs.backend.REVISION
        folder = self.jobs.folder(accepted['jobId']) / 'stages' / ('text_layer_' + str(layer_index) + '_attempt_' + str(attempt))
        folder.mkdir(parents=True)
        runner(folder, Image.new('RGB', (2048, 768), (255, 0, 255)),
               'A historical native lettering sample sheet.', 2048, 768, lambda *_: None)
        return folder / 'model.png'

    def test_failed_task_reuses_erasure_and_explicit_sheet_without_changing_payload_identity(self):
        request, old, _, _ = self.cache_source(text=True)
        before = self.jobs.row(old['jobId'], request['scope'])
        next_request = {**request, 'requestKey': 'c' * 64}
        accepted = self.jobs.submit(next_request)
        folder = self.jobs.folder(accepted['jobId']);path = folder / 'stage-cache.json'
        manifest = json.loads(path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual([(entry['stage'], entry['sourceJobId'], entry['sourceStage']) for entry in manifest['assets']],
                         [('erase_1', old['jobId'], 'erase_1'),
                          ('text_layer_0_attempt_1', old['jobId'], 'text_layer_0_attempt_1')])
        self.assertNotIn('selectionMode', manifest['assets'][0])
        self.assertEqual(manifest['assets'][1]['selectionMode'], 'complete-line')
        self.assertEqual(manifest['assets'][0]['sourcePayloadSha256'], before['payload_sha'])
        after = self.jobs.row(accepted['jobId'], request['scope'])
        self.assertEqual((before['payload_json'], before['payload_sha']), (after['payload_json'], after['payload_sha']))
        original = path.read_bytes()
        with patch.object(self.jobs, 'select_stage_cache', side_effect=AssertionError('duplicate cannot select again')):
            duplicate = self.jobs.submit(next_request)
        self.assertTrue(duplicate['duplicate']);self.assertEqual(duplicate['jobId'], accepted['jobId'])
        self.assertEqual(path.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, 'request_invalid'):
            self.jobs.submit({**next_request, 'cache': manifest})

    def test_failed_sheet_prefers_latest_complete_native_attempt_with_original_proof(self):
        request, old, _, _ = self.cache_source(text=True)
        latest = self.native_text_attempt(old, 0, 2)
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        sheet = cache['assets'][1]
        self.assertEqual((sheet['selectionMode'], sheet['sourceStage']), ('complete-line', 'text_layer_0_attempt_2'))
        self.assertEqual(sheet['sha256'], hashlib.sha256(latest.read_bytes()).hexdigest())
        self.assertEqual(sheet['receiptSha256'], hashlib.sha256(latest.with_suffix('.receipt.json').read_bytes()).hexdigest())
        # A missing native receipt is not a completed attempt; fall back to the
        # earlier complete source without changing the failed source job.
        latest.with_suffix('.receipt.json').unlink()
        accepted = self.jobs.submit({**request, 'requestKey': 'd' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual(cache['assets'][1]['sourceStage'], 'text_layer_0_attempt_1')
        self.assertEqual(self.jobs.get(old['jobId'], request['scope'])['currentState'], 'FAILED')

    def test_failed_sheet_can_reuse_glyphs_for_new_position_and_alignment(self):
        request, old, _, _ = self.cache_source(text=True)
        changed = json.loads(json.dumps(request));changed['requestKey'] = 'c' * 64
        changed['protected']['textLayers'][0].update(align='center', box={'x': 820, 'y': 20, 'width': 720, 'height': 150})
        accepted = self.jobs.submit(changed)
        row = self.jobs.row(accepted['jobId'], request['scope'])
        cache, _ = self.jobs.stage_cache(row)
        self.assertEqual(cache['assets'][1]['sourceJobId'], old['jobId'])
        self.assertEqual(cache['assets'][1]['selectionMode'], 'complete-line')
        current = json.loads(row['payload_json'])['protected']['textLayers'][0]
        self.assertEqual((current['box'], current['align']), (changed['protected']['textLayers'][0]['box'], 'center'))

    def test_failed_sheet_rejects_changed_generation_semantics(self):
        request, _, _, _ = self.cache_source(text=True)
        for index, kind in enumerate(('text', 'style', 'erasure', 'layer_count')):
            changed = json.loads(json.dumps(request));changed['requestKey'] = format(index + 1, '064x')
            if kind == 'text':changed['protected']['textLayers'][0]['text'] = '北极驯鹿故事'
            elif kind == 'style':changed['protected']['textLayers'][0]['style'] = 'New ivory lettering.'
            elif kind == 'erasure':changed['protected']['eraseRegions'][0]['x'] = 101
            else:changed['protected']['textLayers'].append({'text': '逐鹿而生',
                'box': {'x': 900, 'y': 260, 'width': 600, 'height': 100}})
            with self.subTest(kind=kind):
                accepted = self.jobs.submit(changed)
                path = self.jobs.folder(accepted['jobId']) / 'stage-cache.json'
                entries = json.loads(path.read_text())['assets'] if path.exists() else []
                self.assertFalse(any(entry['stage'].startswith('text_layer_') for entry in entries))

    def test_failed_sheet_rejects_other_failure_reason_and_other_scope(self):
        request, old, _, _ = self.cache_source(text=True)
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET error_code=? WHERE job_id=?', ('protected_text_row_count_invalid', old['jobId']))
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual([entry['stage'] for entry in cache['assets']], ['erase_1'])
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET error_code=? WHERE job_id=?', ('protected_generated_text_mismatch', old['jobId']))
        accepted = self.jobs.submit({**request, 'scope': 'e' * 64, 'requestKey': 'd' * 64})
        self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())

    def test_failed_sheet_readback_rechecks_mode_layer_failure_and_generation_semantics(self):
        request, old, _, _ = self.cache_source(text=True)
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        row = self.jobs.row(accepted['jobId'], request['scope']);path = self.jobs.folder(accepted['jobId']) / 'stage-cache.json'
        original = path.read_bytes();manifest = json.loads(original)
        self.assertEqual(self.jobs.stage_cache(row)[0], manifest)
        manifest['assets'][1].pop('selectionMode');path.write_text(canonical(manifest))
        with self.assertRaisesRegex(ValueError, 'text_not_sealed'):
            self.jobs.stage_cache(row)
        path.write_bytes(original)
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET error_code=? WHERE job_id=?', ('protected_text_row_count_invalid', old['jobId']))
        with self.assertRaisesRegex(ValueError, 'complete_line_source_invalid'):
            self.jobs.stage_cache(row)
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET error_code=? WHERE job_id=?', ('protected_generated_text_mismatch', old['jobId']))
        self.native_text_attempt(old, 1, 1)
        manifest = json.loads(original);manifest['assets'][1]['sourceStage'] = 'text_layer_1_attempt_1'
        path.write_text(canonical(manifest))
        with self.assertRaisesRegex(ValueError, '(entry_invalid|source_invalid)'):
            self.jobs.stage_cache(row)
        path.write_bytes(original)
        source = self.jobs.row(old['jobId'], request['scope']);changed = json.loads(source['payload_json'])
        changed['protected']['textLayers'][0]['style'] = 'A different material.'
        changed_sha = hashlib.sha256(canonical(changed).encode()).hexdigest()
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET payload_json=?,payload_sha=? WHERE job_id=?',
                       (canonical(changed), changed_sha, old['jobId']))
        manifest = json.loads(original)
        for entry in manifest['assets']:entry['sourcePayloadSha256'] = changed_sha
        path.write_text(canonical(manifest))
        with self.assertRaisesRegex(ValueError, 'complete_line_source_invalid'):
            self.jobs.stage_cache(row)

    def test_stage_cache_is_scope_parameter_and_native_proof_isolated(self):
        request, old, _, output = self.cache_source()
        for index, change in enumerate(({'scope': 'd' * 64}, {'steps': 31}, {'guidance': 3.5}, {'seed': 302})):
            with self.subTest(change=change):
                accepted = self.jobs.submit({**request, **change, 'requestKey': str(index + 1) * 64})
                self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())
                self.jobs.cancel(accepted['jobId'], request['scope'] if 'scope' not in change else change['scope'])
        native = output.parent / 'stages' / 'erase_1' / 'model.png'
        native.write_bytes(native.read_bytes() + b'changed')
        accepted = self.jobs.submit({**request, 'requestKey': 'e' * 64})
        self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())
        self.assertEqual(self.jobs.get(old['jobId'], request['scope'])['currentState'], 'FAILED')

    def test_cache_requires_matching_photo_backend_and_profiles_fingerprints(self):
        request, _, _, _ = self.cache_source()
        for attribute, key in (('backend_sha', 'c'), ('profiles_sha', 'd')):
            with self.subTest(attribute=attribute), patch.object(self.jobs, attribute, 'f' * 64):
                accepted = self.jobs.submit({**request, 'requestKey': key * 64})
                self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())
                self.jobs.cancel(accepted['jobId'], request['scope'])
        Image.new('RGB', (1920, 1080), 'olive').save(self.reference)
        accepted = self.jobs.submit({**request, 'requestKey': 'e' * 64})
        self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())

    def test_malformed_native_dtype_metadata_is_a_cache_miss(self):
        request, _, _, output = self.cache_source()
        proof_path = output.parent / 'stages' / 'erase_1' / 'model.receipt.json'
        proof = json.loads(proof_path.read_text());proof['componentDtypes'] = None
        proof_path.write_text(json.dumps(proof))
        accepted = self.jobs.submit({**request, 'requestKey': 'e' * 64})
        self.assertEqual(accepted['currentState'], 'QUEUED')
        self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())

    def test_only_latest_twelve_terminal_tasks_are_considered_for_cache(self):
        request, old, _, _ = self.cache_source()
        for index in range(12):
            unrelated = json.loads(json.dumps(request))
            unrelated['protected']['eraseRegions'][0]['x'] = 400
            accepted = self.jobs.submit({**unrelated, 'requestKey': format(index + 1, '064x')})
            self.jobs.cancel(accepted['jobId'], request['scope'])
        accepted = self.jobs.submit({**request, 'requestKey': 'f' * 64})
        self.assertFalse((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').exists())
        self.assertEqual(self.jobs.get(old['jobId'], request['scope'])['currentState'], 'FAILED')

    def test_raw_tasks_do_not_consume_the_protected_cache_discovery_limit(self):
        request, old, _, _ = self.cache_source()
        for index in range(12):
            accepted = self.jobs.submit({**self.request, 'requestKey': format(index + 1, '064x')})
            self.jobs.cancel(accepted['jobId'], request['scope'])
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual([entry['sourceJobId'] for entry in cache['assets']], [old['jobId']])

    def test_completed_text_cache_requires_sealed_selected_asset_exact_layer_and_first_prompt(self):
        request, old, result, _ = self.cache_source(completed=True, text=True)
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual([entry['stage'] for entry in cache['assets']], ['erase_1', 'text_layer_0_attempt_1'])
        self.assertEqual(cache['assets'][1]['sourceJobId'], old['jobId'])
        self.assertEqual(cache['assets'][1]['sha256'], result['selectedLetteringAssets'][0]['sha256'])
        changed = json.loads(json.dumps(request))
        changed['requestKey'] = 'd' * 64
        changed['protected']['textLayers'][0]['style'] = 'A newly requested ivory finish.'
        accepted = self.jobs.submit(changed)
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual([entry['stage'] for entry in cache['assets']], ['erase_1'])

    def test_completed_exact_text_cache_ignores_placement_but_still_requires_sealed_success(self):
        request, old, _, _ = self.cache_source(completed=True, text=True)
        changed = json.loads(json.dumps(request));changed['requestKey'] = 'c' * 64
        changed['protected']['textLayers'][0].update(align='center', box={'x': 820, 'y': 20, 'width': 720, 'height': 150})
        accepted = self.jobs.submit(changed)
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual(cache['assets'][1]['sourceJobId'], old['jobId'])
        self.assertNotIn('selectionMode', cache['assets'][1])

    def test_retry_lettering_prompt_is_not_reused_as_a_new_first_attempt(self):
        request, _, result, _ = self.cache_source(completed=True, text=True, retry_text=True)
        self.assertEqual(result['textValidation']['assetAttempts'], 2)
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual([entry['stage'] for entry in cache['assets']], ['erase_1'])

    def test_modified_completed_receipt_cannot_authorize_reusing_its_lettering(self):
        request, _, result, output = self.cache_source(completed=True, text=True)
        result['unsealedExtra'] = True
        output.with_suffix('.receipt.json').write_text(json.dumps(result))
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        cache = json.loads((self.jobs.folder(accepted['jobId']) / 'stage-cache.json').read_text())
        self.assertEqual([entry['stage'] for entry in cache['assets']], ['erase_1'])

    def test_cache_readback_checks_file_hash_source_scope_and_sqlite_payload(self):
        request, old, _, _ = self.cache_source()
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        row = self.jobs.row(accepted['jobId'], request['scope'])
        path = self.jobs.folder(accepted['jobId']) / 'stage-cache.json';raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        cache, read_digest = self.jobs.stage_cache(row, result={'stageCacheSha256': digest})
        self.assertEqual(read_digest, digest)
        with self.assertRaisesRegex(ValueError, 'cache_receipt_changed'):
            self.jobs.stage_cache(row, result={'stageCacheSha256': '0' * 64})
        cache['assets'][0]['sourcePayloadSha256'] = 'f' * 64
        path.write_text(canonical(cache))
        with self.assertRaisesRegex(ValueError, 'source_payload_changed'):
            self.jobs.stage_cache(row)
        path.write_bytes(raw)
        with self.jobs.db() as db:
            db.execute('UPDATE image_jobs SET scope=? WHERE job_id=?', ('d' * 64, old['jobId']))
        with self.assertRaisesRegex(ValueError, 'job_not_found'):
            self.jobs.stage_cache(row)

    def test_cached_worker_command_and_result_are_bound_to_the_private_manifest(self):
        request, _, _, _ = self.cache_source()
        accepted = self.jobs.submit({**request, 'requestKey': 'c' * 64})
        path = self.jobs.folder(accepted['jobId']) / 'stage-cache.json'
        expected_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        result, output = self.protected_candidate(accepted)
        class Finished:
            returncode = 0
            def poll(self):return 0
            def wait(self, timeout=None):return 0
        with patch('image_generation.service.subprocess.Popen', return_value=Finished()) as launch, \
             patch.object(self.jobs, 'claim_process_group', return_value=None), \
             patch.object(self.jobs, 'cleanup_process_group'):
            self.jobs.run_one()
        command = launch.call_args.args[0]
        self.assertEqual(command[command.index('--stage-cache-file') + 1], str(path))
        self.assertEqual(command[command.index('--stage-cache-sha256') + 1], expected_sha)
        self.assertEqual(result['stageCacheSha256'], expected_sha)
        self.assertEqual(self.jobs.get(accepted['jobId'], request['scope'])['currentState'], 'GENERATED_PENDING_REVIEW')
        self.assertEqual(self.jobs.image(accepted['jobId'], request['scope']), output.read_bytes())
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'cache_receipt_changed'):
            self.jobs.image(accepted['jobId'], request['scope'])

    def test_protected_source_dimensions_and_single_queue_idempotency(self):
        request = self.protected_request()
        first = self.jobs.submit(request)
        self.assertEqual(self.jobs.submit(request)['jobId'], first['jobId'])
        self.assertEqual(first['mode'], 'protected')
        payload = json.loads(self.jobs.row(first['jobId'], request['scope'])['payload_json'])
        self.assertEqual((payload['width'], payload['height']), (1920, 1080))
        self.assertEqual(len(payload['references']), 1)
        self.assertIn('protectedSourceSha256', payload['execution'])
        self.assertTrue((self.jobs.folder(first['jobId']) / 'input.json').is_file())
        self.assertFalse((self.jobs.folder(first['jobId']) / 'prompt.txt').exists())
        with self.assertRaisesRegex(ValueError, 'native_dimensions_required'):
            self.jobs.submit({**request, 'width': 1280})
        with self.assertRaisesRegex(ValueError, 'prompt_or_design_required'):
            self.jobs.submit({**request, 'prompt': 'ambiguous'})

    def test_erasure_only_projection_preserves_strict_not_applicable_text_validation(self):
        request, accepted, result, _ = self.cache_source(completed=True)
        row = self.jobs.row(accepted['jobId'], request['scope'])
        self.assertEqual(self.jobs.present(row)['textValidation'], {
            'matched': True, 'engine': 'not-applicable', 'mode': 'normalized_text_sequence',
            'expectedCount': 0, 'observedCount': 0})
        for change in ({'matched': False}, {'expectedCount': 1}, {'observedCount': 1},
                       {'expectedCount': False}, {'observedCount': False}, {'engine': 'unknown'}):
            with self.subTest(change=change):
                altered = json.loads(json.dumps(result));altered['textValidation'].update(change)
                projected = self.jobs.present({**dict(row), 'result_json': canonical(altered)})['textValidation']
                self.assertNotEqual(projected.get('engine'), 'not-applicable')

    def test_invalid_protected_region_fails_before_creating_job(self):
        request = self.protected_request()
        request['protected']['eraseRegions'][0]['x'] = 1920
        with self.assertRaisesRegex(ValueError, 'protected_region'):
            self.jobs.submit(request)
        self.assertFalse(list(self.config.output_root.iterdir()))
        self.assertEqual(self.jobs.list(request['scope'])['jobs'], [])

    def test_protected_dispatch_uses_same_worker_and_independent_pixel_verification(self):
        request = self.protected_request()
        accepted = self.jobs.submit(request)
        receipt, output = self.protected_candidate(accepted)
        class Finished:
            returncode = 0
            def poll(self): return 0
            def wait(self, timeout=None): return 0
        with patch('image_generation.service.subprocess.Popen', return_value=Finished()) as launch, \
             patch.object(self.jobs, 'claim_process_group', return_value=None), \
             patch.object(self.jobs, 'cleanup_process_group'), \
             patch.object(self.jobs, 'result', wraps=self.jobs.result) as accepted_result:
            self.jobs.run_one()
        self.assertEqual(accepted_result.call_args.kwargs, {'verify_current_composition': True})
        command = launch.call_args.args[0]
        self.assertIn('image_generation.protected_worker', command)
        self.assertIn('--spec-file', command)
        self.assertNotIn('--width', command)
        self.assertNotIn('--height', command)
        self.assertEqual(launch.call_args.kwargs['env']['PYTHONPATH'], str(ROOT / 'src'))
        self.assertEqual(launch.call_args.kwargs['env']['AIWORKER_IMAGE_OCR_CACHE'], str(self.config.state_root / 'vision-ocr-cache'))
        result = self.jobs.get(accepted['jobId'], request['scope'])
        self.assertEqual(result['currentState'], 'GENERATED_PENDING_REVIEW')
        self.assertEqual(result['photoProtection']['outsideChangedPixels'], 0)
        self.assertTrue(result['textValidation']['matched'])
        self.assertEqual(hashlib.sha256(self.jobs.image(accepted['jobId'], request['scope'])).hexdigest(), receipt['outputSha256'])
        # A forged output digest cannot hide mutation outside edit regions.
        with Image.open(output) as image:
            altered = image.copy()
        altered.putpixel((10, 10), (255, 0, 0))
        altered.save(output)
        data = output.read_bytes()
        receipt.update(outputSha256=hashlib.sha256(data).hexdigest(), outputBytes=len(data))
        output.with_suffix('.receipt.json').write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, 'protected_photo_pixels_changed'):
            self.jobs.image(accepted['jobId'], request['scope'])

    def test_sealed_protected_images_survive_renderer_changes_but_not_receipt_tampering(self):
        request = self.protected_request()
        accepted = self.jobs.submit(request)
        receipt, output = self.protected_candidate(accepted)
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING' WHERE job_id=?", (accepted['jobId'],))
        self.jobs.recover()
        self.assertEqual(self.jobs.get(accepted['jobId'], request['scope'])['currentState'], 'GENERATED_PENDING_REVIEW')
        with patch('image_generation.protected_cover.erasure_prompt', side_effect=AssertionError('new renderer must not run')):
            self.assertEqual(self.jobs.image(accepted['jobId'], request['scope']), output.read_bytes())
            self.assertEqual(self.jobs.inspection(accepted['jobId'], request['scope'])['jobId'], accepted['jobId'])
        # Even an irrelevant new field violates the sealed database receipt.
        receipt['unsealedExtra'] = True
        output.with_suffix('.receipt.json').write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, 'receipt_changed'):
            self.jobs.image(accepted['jobId'], request['scope'])
        with self.assertRaisesRegex(ValueError, 'receipt_changed'):
            self.jobs.inspection(accepted['jobId'], request['scope'])

    def test_unsealed_protected_recovery_cannot_bypass_current_renderer_verification(self):
        request = self.protected_request()
        accepted = self.jobs.submit(request)
        self.protected_candidate(accepted)
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING' WHERE job_id=?", (accepted['jobId'],))
        with patch.object(self.jobs, 'result', wraps=self.jobs.result) as recovered_result:
            self.jobs.recover()
        self.assertEqual(recovered_result.call_args.kwargs, {'verify_current_composition': True})
        self.assertEqual(self.jobs.get(accepted['jobId'], request['scope'])['currentState'], 'GENERATED_PENDING_REVIEW')

    def test_unsealed_protected_recovery_after_renderer_change_requires_reconciliation(self):
        request = self.protected_request()
        accepted = self.jobs.submit(request)
        self.protected_candidate(accepted)
        with self.jobs.db() as db:
            db.execute("UPDATE image_jobs SET state='RUNNING' WHERE job_id=?", (accepted['jobId'],))
        with patch('image_generation.protected_cover.implementation_digest', return_value='f' * 64), \
             patch.object(self.jobs, 'result', wraps=self.jobs.result) as recovered_result:
            self.jobs.recover()
        recovered_result.assert_not_called()
        result = self.jobs.get(accepted['jobId'], request['scope'])
        self.assertEqual((result['currentState'], result['errorCode']), ('RECONCILE_REQUIRED', 'image_job_runtime_changed'))

    def test_protected_implementation_drift_does_not_start_model(self):
        request = self.protected_request()
        accepted = self.jobs.submit(request)
        with patch('image_generation.protected_cover.implementation_digest', return_value='f' * 64), \
             patch('image_generation.service.subprocess.Popen') as launch:
            self.jobs.run_one()
        launch.assert_not_called()
        self.assertEqual(self.jobs.get(accepted['jobId'], request['scope'])['currentState'], 'RECONCILE_REQUIRED')

    def test_owned_inspection_is_bounded_hashed_read_only_and_scope_isolated(self):
        Image.new('RGB', (1920, 1080), 'olive').save(self.reference)
        accepted = self.jobs.submit(self.request)
        self.jobs.run_one()
        before = self.jobs.row(accepted['jobId'], self.request['scope'])['result_json']
        result = self.jobs.inspection(accepted['jobId'], self.request['scope'])
        self.assertEqual(result['jobId'], accepted['jobId'])
        self.assertEqual([image['role'] for image in result['images']], ['source', 'result'])
        self.assertLessEqual(len(canonical(result).encode()), 6 * 1024 * 1024)
        for image in result['images']:
            data = base64.b64decode(image['data'], validate=True)
            self.assertEqual(hashlib.sha256(data).hexdigest(), image['sha256'])
            self.assertLessEqual(len(data), 2 * 1024 * 1024)
            self.assertLessEqual(max(image['width'], image['height']), 1024)
            self.assertEqual(struct.unpack('>II', data[16:24]), (image['width'], image['height']))
        self.assertEqual(self.jobs.row(accepted['jobId'], self.request['scope'])['result_json'], before)
        self.assertFalse((self.jobs.folder(accepted['jobId']) / 'inspection.png').exists())
        with self.assertRaisesRegex(ValueError, 'job_not_found'):
            self.jobs.inspection(accepted['jobId'], 'c' * 64)
        self.reference.write_bytes(b'original external file changed')
        self.assertEqual(self.jobs.inspection(accepted['jobId'], self.request['scope'])['images'], result['images'])

    def test_inspection_http_and_unready_result_fail_without_exposing_other_scope(self):
        Image.new('RGB', (1280, 720), 'olive').save(self.reference)
        accepted = self.jobs.submit(self.request)
        with self.assertRaisesRegex(ValueError, 'not_ready'):
            self.jobs.inspection(accepted['jobId'], self.request['scope'])
        self.jobs.run_one()
        server = ThreadingHTTPServer(('127.0.0.1', 0), http_module.handler_type(self.jobs))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port) + '/v1/jobs/' + accepted['jobId'] + '/inspection?scope='
        direct = build_opener(ProxyHandler({})).open
        try:
            with direct(base + self.request['scope']) as response:
                value = json.load(response)
                self.assertEqual({a['role'] for a in value['images']}, {'source', 'result'})
            with self.assertRaises(HTTPError) as error:
                direct(base + 'c' * 64)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_orphaned_grandchild_is_cleaned_after_success_failure_and_verifier_exception(self):
        other_code = '''import fcntl,pathlib,sys,time
root=pathlib.Path(sys.argv[1]);deadline=time.monotonic()+10
while not (root/'owned-ready').exists():
 if time.monotonic()>deadline:raise SystemExit(3)
 time.sleep(.01)
with (root/'fixture-model.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 (root/'other-acquired').write_text('ready')
 time.sleep(60)
'''
        for index, (prompt, expected) in enumerate([
                ('orphan-success', 'GENERATED_PENDING_REVIEW'),
                ('orphan-fail', 'FAILED'), ('orphan-invalid', 'FAILED')]):
            with self.subTest(prompt=prompt):
                request = {**self.request, 'requestKey': str(index + 1) * 64, 'prompt': prompt}
                accepted = self.jobs.submit(request)
                folder = self.jobs.folder(accepted['jobId'])
                env = os.environ.copy()
                env['AIWORKER_IMAGE_JOB_OWNER'] = 'unrelated-model-caller'
                other = subprocess.Popen([sys.executable, '-c', other_code, str(folder)],
                                         env=env, start_new_session=True)
                try:
                    self.jobs.run_one()
                    result = self.jobs.get(accepted['jobId'], request['scope'])
                    self.assertEqual(result['currentState'], expected)
                    child = int((folder / 'orphan.pid').read_text())
                    deadline = time.monotonic() + 3
                    while not (folder / 'other-acquired').exists() and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertTrue((folder / 'other-acquired').exists(), 'owned grandchild must release the shared model lock')
                    self.assertIsNone(other.poll(), 'another model caller in its own group must survive')
                    report = subprocess.run(['/bin/ps', '-p', str(child), '-o', 'stat='], capture_output=True, text=True)
                    self.assertTrue(report.returncode != 0 or report.stdout.strip().startswith('Z'))
                    with (folder / 'fixture-model.lock').open('a') as lock:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    if other.poll() is None:
                        other.terminate()
                    other.wait(timeout=5)

    def test_unproven_group_never_receives_group_signal(self):
        with patch.object(ImageJobs, 'owned_group_members', side_effect=ValueError('owner unproven')), \
             patch('image_generation.service.os.killpg') as kill:
            with self.assertRaises(ValueError):
                self.jobs.cleanup_process_group({'pgid': 999999, 'uid': os.getuid(), 'nonce': 'test'})
        kill.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'identity_invalid'):
            self.jobs.live_group_members(os.getpgrp())

    def test_process_snapshot_accepts_unrelated_negative_system_uid(self):
        report = subprocess.CompletedProcess([], 0, '837 837 -2 S\n999999 999999 501 S\n', '')
        with patch('image_generation.service.subprocess.run', return_value=report):
            self.assertEqual(self.jobs.live_group_members(999999), [(999999, 501)])

    def test_unproven_cleanup_cannot_be_reported_as_successful_generation(self):
        accepted = self.jobs.submit(self.request)
        with patch.object(self.jobs, 'cleanup_process_group', side_effect=ValueError('owner unproven')):
            self.jobs.run_one()
        result = self.jobs.get(accepted['jobId'], self.request['scope'])
        self.assertEqual(result['currentState'], 'RECONCILE_REQUIRED')
        self.assertEqual(result['errorCode'], 'image_worker_group_cleanup_unproven')
        self.assertFalse(self.jobs.run_one())
        with self.assertRaisesRegex(ValueError, 'not_ready'):
            self.jobs.image(accepted['jobId'], self.request['scope'])


if __name__ == '__main__':
    unittest.main()

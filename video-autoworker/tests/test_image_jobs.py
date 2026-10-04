"""Real isolated HTTP/job/child-process checks; no model or production writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from image_generation.service import Configuration, ImageJobs, canonical

spec = importlib.util.spec_from_file_location('image_http_adapter', ROOT / 'scripts/aiworker-image-service.py')
http_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http_module)

FAKE = '''import argparse, hashlib, json, pathlib, struct, time
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
        self.config = Configuration(self.root / 'state', self.root / 'output', (self.refs,),
                                    self.backend, Path(sys.executable), self.profiles, 'a' * 40)
        self.jobs = ImageJobs(self.config)
        self.request = {'scope': 'a' * 64, 'requestKey': 'b' * 64,
                        'prompt': '完整中文封面测试', 'images': [str(self.reference)]}

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


if __name__ == '__main__':
    unittest.main()

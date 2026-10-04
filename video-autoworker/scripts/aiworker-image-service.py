#!/usr/bin/env python3
"""Loopback adapter for the single application-owned image job service."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import signal
import sys
import threading
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from image_generation.service import Configuration, ImageJobs


def handler_type(jobs):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # No prompts, paths, scope keys, or session identifiers in logs.

        def send(self, status, value, mime='application/json'):
            data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def dispatch(self):
            try:
                if self.client_address[0] != '127.0.0.1' or self.headers.get('Origin'):
                    raise ValueError('image_loopback_request_required')
                url = urlparse(self.path)
                query = parse_qs(url.query, strict_parsing=True)
                if self.command == 'GET' and url.path == '/healthz':
                    health = jobs.health()
                    return self.send(200 if health['currentState'] == 'READY' else 503, health)
                scope = query.get('scope', [None])[0]
                body = None
                if self.command == 'POST':
                    if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                        raise ValueError('image_json_required')
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 64 * 1024:
                        raise ValueError('image_request_size_invalid')
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise ValueError('image_request_invalid')
                    scope = body.get('scope')
                if url.path == '/v1/jobs':
                    if self.command == 'POST':
                        return self.send(202, jobs.submit(body))
                    return self.send(200, jobs.list(scope))
                parts = url.path.strip('/').split('/')
                if len(parts) in (3, 4) and parts[:2] == ['v1', 'jobs']:
                    job_id = parts[2]
                    if self.command == 'GET' and len(parts) == 3:
                        return self.send(200, jobs.get(job_id, scope))
                    if self.command == 'GET' and len(parts) == 4 and parts[3] == 'image':
                        return self.send(200, jobs.image(job_id, scope), 'image/png')
                    if self.command == 'POST' and len(parts) == 4 and parts[3] == 'cancel' and set(body) == {'scope'}:
                        return self.send(200, jobs.cancel(job_id, scope))
                self.send(404, {'errorCode': 'image_route_not_found'})
            except (ValueError, OSError, KeyError) as error:
                code = str(error) if isinstance(error, ValueError) else 'image_request_resource_unavailable'
                self.send(404 if code == 'image_job_not_found' else 409 if 'conflict' in code else 400,
                          {'errorCode': code, 'nextAction': 'correct_request_or_inspect_status'})

        do_GET = dispatch
        do_POST = dispatch
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config_path = Path(args.config).resolve(strict=True)
    raw = json.loads(config_path.read_text())
    if raw['listenHost'] != '127.0.0.1' or type(raw['listenPort']) is not int:
        raise ValueError('image_service_loopback_config_required')
    config = Configuration(**{key: Path(raw[key]) for key in (
        'state_root', 'output_root', 'backend_script', 'backend_python', 'profiles_file')},
        reference_roots=tuple(Path(p) for p in raw['reference_roots']), source_commit=raw['source_commit'])
    jobs = ImageJobs(config)
    server = ThreadingHTTPServer(('127.0.0.1', raw['listenPort']), handler_type(jobs))
    server.daemon_threads = True
    def stop(*_args):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        jobs.start()
        server.serve_forever()
    finally:
        server.server_close()
        jobs.close()


if __name__ == '__main__':
    main()

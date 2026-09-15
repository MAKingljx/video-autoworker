#!/usr/bin/env python3
"""Run upstream MLX on an isolated test port with process-local memory telemetry."""
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", required=True)
    p.add_argument("--port", type=int, default=18096)
    p.add_argument("--cache-size", type=int, default=8)
    p.add_argument("--max-gib", type=int, default=300)
    args = p.parse_args()
    if args.port == 18092:
        p.error("Production port is forbidden for the guarded test server")
    import mlx.core as mx

    def monitor():
        while True:
            rss = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())]).strip()) * 1024
            active, cached, peak = mx.get_active_memory(), mx.get_cache_memory(), mx.get_peak_memory()
            event = {"event": "memory", "pid": os.getpid(), "rssBytes": rss,
                     "metalActiveBytes": active, "metalCacheBytes": cached,
                     "metalPeakBytes": peak, "unixTime": time.time()}
            print(json.dumps(event), flush=True)
            if max(rss, active + cached) >= args.max_gib * 1024**3:
                print(json.dumps({"event": "memory_guard_stop", "limitGiB": args.max_gib}), flush=True)
                os.kill(os.getpid(), signal.SIGTERM)
                return
            time.sleep(5)

    threading.Thread(target=monitor, daemon=True).start()
    sys.argv = ["mlx_lm.server", "--model", args.model, "--host", "127.0.0.1",
                "--port", str(args.port), "--max-tokens", "512",
                "--prompt-cache-size", str(args.cache_size), "--prompt-cache-bytes", "128GB",
                "--decode-concurrency", "1", "--prompt-concurrency", "1",
                "--chat-template-args", '{"enable_thinking":true,"thinking":true,"reasoning_effort":"medium"}']
    from mlx_lm.server import main as serve
    serve()


if __name__ == "__main__":
    main()

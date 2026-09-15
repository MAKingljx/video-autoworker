#!/usr/bin/env python3
"""用无业务内容的输入测量本地文本服务；不会执行工具或发送聊天消息。"""
import argparse
import json
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--pairs", type=int, default=2048,
                    help="alpha beta 重复次数；以服务返回的 prompt_tokens 为准")
parser.add_argument("--label", default="qwen-context-benchmark")
parser.add_argument("--port", type=int, default=18092)
parser.add_argument("--max-tokens", type=int, default=192)
args = parser.parse_args()
if not 1 <= args.pairs <= 499000 or not 1 <= args.max_tokens <= 4096:
    parser.error("pairs 必须为 1..499000，max-tokens 必须为 1..4096")

# 每次 label 不同可避免前缀缓存；比较相同输入时需同时核对 cached_tokens。
prompt = (args.label + "：以下均为无业务含义的测速填充文本。\n"
          + " alpha beta" * args.pairs
          + "\n请忽略填充文本，用中文依次写出从一到五十的数字，用逗号分隔。")
payload = {
    "model": "default_model", "messages": [{"role": "user", "content": prompt}],
    "stream": True, "stream_options": {"include_usage": True},
    "max_tokens": args.max_tokens, "temperature": 0,
    "chat_template_kwargs": {"enable_thinking": True, "thinking": True,
                             "preserve_thinking": True, "reasoning_effort": "medium"},
}
request = urllib.request.Request(
    f"http://127.0.0.1:{args.port}/v1/chat/completions",
    data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
start = time.monotonic()
first = answer_first = usage = finish = None
with urllib.request.urlopen(request, timeout=900) as response:
    for raw in response:
        if not raw.startswith(b"data: "):
            continue
        body = raw[6:].strip()
        if body == b"[DONE]":
            break
        event = json.loads(body)
        if event.get("usage"):
            usage = event["usage"]
        for choice in event.get("choices", []):
            delta = choice.get("delta", {})
            if any(delta.get(key) for key in ("content", "reasoning_content", "reasoning")):
                if first is None:
                    first = time.monotonic()
            if delta.get("content") and answer_first is None:
                answer_first = time.monotonic()
            if choice.get("finish_reason"):
                finish = choice["finish_reason"]
end = time.monotonic()
if first is None or usage is None or finish is None:
    raise RuntimeError("未取得完整生成与计量证据")
print(json.dumps({
    "case": args.label, "firstTokenSeconds": round(first - start, 3),
    "firstAnswerSeconds": round(answer_first - start, 3) if answer_first else None,
    "totalSeconds": round(end - start, 3), "finishReason": finish, "usage": usage,
    "approxCompletionTokensPerSecond": round(usage["completion_tokens"] / max(end - first, .001), 2),
}, ensure_ascii=False))

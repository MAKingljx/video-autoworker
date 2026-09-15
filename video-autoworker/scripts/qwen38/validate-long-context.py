#!/usr/bin/env python3
"""Synthetic streaming retrieval/cache acceptance; no business tools or messages."""
import argparse
import hashlib
import json
import time
import urllib.request


def fixture(tokenizer, target, label):
    values = {k: str(int(hashlib.sha256((label + k).encode()).hexdigest()[:8], 16) % 900000 + 100000)
              for k in ("A", "B", "C")}

    def build(pairs):
        sizes = [pairs // 20, pairs * 9 // 20, pairs * 9 // 20]
        sizes.append(pairs - sum(sizes))
        text = label + "\n这是合成检索测试。填充词无实际含义，请从下文找到三条记录。\n"
        for i, n in enumerate(sizes):
            text += " alpha beta" * n
            if i < 3:
                key = "ABC"[i]
                text += f"\n独立记录：KEY_{key}={values[key]}。\n"
        text += '\n请返回三个KEY对应的值，仅输出JSON对象，键为A、B、C，值为字符串。'
        return [{"role": "user", "content": text}]

    options = dict(tokenize=True, add_generation_prompt=True, enable_thinking=True,
                   thinking=True, preserve_thinking=True, reasoning_effort="medium")
    pairs = target // 2
    for _ in range(6):
        messages = build(pairs)
        encoded = tokenizer.apply_chat_template(messages, **options)
        token_ids = encoded["input_ids"] if hasattr(encoded, "keys") else encoded
        count = len(token_ids)
        if target - 2 <= count <= target:
            return messages, count, values
        pairs += (target - count) // 2
    raise RuntimeError(f"Unable to construct requested token count: {count}/{target}")


def request(port, messages, count, expected, label, output_tokens, cancel_after):
    payload = {
        "model": "default_model", "messages": messages, "stream": True,
        "stream_options": {"include_usage": True}, "max_tokens": output_tokens,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": True, "thinking": True,
                                 "preserve_thinking": True, "reasoning_effort": "medium"},
    }
    encoded = json.dumps(payload).encode()
    print(json.dumps({"event": "start", "case": label, "inputTokensLocal": count,
                      "requestSha256": hashlib.sha256(encoded).hexdigest(),
                      "bytes": len(encoded)}), flush=True)
    started = last_report = time.monotonic()
    first = first_answer = None
    usage = finish = None
    answer = ""
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions",
                                 data=encoded, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as response:
        for raw in response:
            now = time.monotonic()
            if cancel_after and now - started >= cancel_after:
                print(json.dumps({"event": "cancelled_client", "case": label,
                                  "seconds": round(now - started, 3)}), flush=True)
                return
            if now - last_report >= 20:
                print(json.dumps({"event": "heartbeat", "case": label,
                                  "seconds": round(now - started, 1)}), flush=True)
                last_report = now
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
                if any(delta.get(k) for k in ("content", "reasoning", "reasoning_content")) and first is None:
                    first = now
                if delta.get("content"):
                    if first_answer is None:
                        first_answer = now
                    answer += delta["content"]
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
    ended = time.monotonic()
    try:
        clean = answer.strip()
        if clean.startswith("```"):
            clean = clean.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        got = json.loads(clean)
        correct = isinstance(got, dict) and {k: str(v) for k, v in got.items()} == expected
    except (ValueError, IndexError):
        correct = False
    result = {"event": "result", "case": label, "inputTokensLocal": count,
              "firstTokenSeconds": round(first - started, 3) if first else None,
              "firstAnswerSeconds": round(first_answer - started, 3) if first_answer else None,
              "totalSeconds": round(ended - started, 3), "usage": usage,
              "finishReason": finish, "retrievalCorrect": correct, "answer": answer,
              "expected": expected,
              "approxTokensPerSecond": round(usage["completion_tokens"] / max(ended - first, .001), 2)
              if first and usage else None}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if not usage or usage["prompt_tokens"] != count or finish != "stop" or not correct:
        raise RuntimeError("Acceptance failed; inspect emitted result, do not claim full-context success")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", type=int, default=18096)
    p.add_argument("--model-dir", required=True)
    p.add_argument("--input-tokens", type=int, default=4096)
    p.add_argument("--output-tokens", type=int, default=512)
    p.add_argument("--label", required=True)
    p.add_argument("--cases", default="A")
    p.add_argument("--cancel-after", type=float, default=0)
    args = p.parse_args()
    if args.input_tokens < 512 or args.input_tokens + args.output_tokens > 1000000:
        p.error("Input and reserved output must fit the 1M context")
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.model_dir, local_files_only=True)
    for case in args.cases.split(","):
        label = args.label + ":" + case
        messages, count, expected = fixture(tokenizer, args.input_tokens, label)
        request(args.port, messages, count, expected, label, args.output_tokens, args.cancel_after)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Check real-model cache reuse against isolated data from the project read chain."""
import argparse
import json
import re
import time
import urllib.request
from pathlib import Path


def generate(messages, port):
    payload = {
        "model": "default_model", "messages": messages, "stream": True,
        "stream_options": {"include_usage": True}, "max_tokens": 512, "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": True, "thinking": True,
                                 "preserve_thinking": True, "reasoning_effort": "medium"},
    }
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions",
                                 data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    start = time.monotonic()
    first = visible = usage = finish = None
    answer = reasoning = ""
    with urllib.request.urlopen(req, timeout=180) as response:
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
                think = delta.get("reasoning_content") or delta.get("reasoning") or ""
                content = delta.get("content") or ""
                if (think or content) and first is None:
                    first = time.monotonic()
                if content and visible is None:
                    visible = time.monotonic()
                answer += content
                reasoning += think
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
    end = time.monotonic()
    if first is None or not usage or finish != "stop":
        raise RuntimeError(f"Incomplete model response: finish={finish}, usage={usage}")
    assistant = {"role": "assistant", "content": answer, "reasoning_content": reasoning}
    receipt = {"firstTokenSeconds": round(first - start, 3),
               "firstAnswerSeconds": round(visible - start, 3) if visible else None,
               "totalSeconds": round(end - start, 3), "usage": usage,
               "finishReason": finish, "answer": answer}
    return assistant, receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fixture", required=True)
    p.add_argument("--project-background", required=True)
    p.add_argument("--port", type=int, default=18092)
    args = p.parse_args()
    fixture = json.loads(Path(args.fixture).read_text())
    assert fixture["noStoreVerified"] and fixture["readCount"] >= 5
    system = {"role": "system", "content": (
        "你正在为Video AutoWorker提供中文项目问答。以下是实际项目的公开背景。"
        "每轮工具资料都来自隔离验收副本，不是生产状态。以本轮最新读取的资料为准，"
        "不要沿用旧对话中已经过时的事实。reviewed=false或候选不算已确认事实。"
        "只用一句话回答主要冲突；资料未确认时明确说待审核，不暴露内部ID。\n\n"
        + Path(args.project_background).read_text())}
    first_context = second_context = None
    first_assistant = second_assistant = None
    for case in fixture["cases"]:
        user = {"role": "user", "content": (
            "问题：这个验收副本作品目前已确认的主要冲突是什么？\n本轮重新读取的最新工具结果：\n"
            + json.dumps(case["toolResult"], ensure_ascii=False, separators=(",", ":")))}
        label = case["label"]
        if label == "v1":
            messages = first_context = [system, user]
        elif label == "v1_repeat":
            messages = first_context
        elif label == "v2":
            messages = second_context = [*first_context, first_assistant, user]
        elif label == "v2_repeat":
            messages = second_context
        else:
            messages = [*second_context, second_assistant, user]
        assistant, receipt = generate(messages, args.port)
        if label == "v1":
            first_assistant = assistant
        if label == "v2":
            second_assistant = assistant
        answer = receipt["answer"]
        passed = (case["expectedTerm"] in answer if case["expectedReviewed"]
                  else bool(re.search("候选|待审核|未确认|未审核", answer)))
        cached = receipt["usage"].get("prompt_tokens_details", {}).get("cached_tokens", 0)
        if label != "v1":
            passed = passed and cached > 0
        print(json.dumps({"case": label, "passed": passed, **receipt}, ensure_ascii=False), flush=True)
        if not passed:
            raise RuntimeError(f"Freshness/cache acceptance failed: {label}")


if __name__ == "__main__":
    main()

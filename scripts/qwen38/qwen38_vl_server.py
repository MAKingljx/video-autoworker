#!/usr/bin/env python3
"""OpenAI-compatible Qwen3.8 visual runtime for the AI-worker Mac node.

The text-only MLX conversion intentionally remains on port 18092.  This
process loads the original Qwen3.8 multimodal safetensors directory with the
Transformers MPS backend so the visual tower, projector, image processor and
video processor stay together as one reproducible runtime.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import logging
import os
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image

LOG = logging.getLogger("aiworker.qwen38.vl")
logging.basicConfig(
    level=os.environ.get("QWEN38_VL_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

MODEL_DIR = Path(os.environ.get("QWEN38_VL_MODEL_DIR", "~/models/Qwen3.8-27B")).expanduser()
MODEL_ID = os.environ.get("QWEN38_VL_MODEL_ID", "qwen38-27b-vl")
DEVICE = os.environ.get("QWEN38_VL_DEVICE", "mps")
DEFAULT_MAX_NEW_TOKENS = int(os.environ.get("QWEN38_VL_MAX_NEW_TOKENS", "1024"))
MAX_NEW_TOKENS = int(os.environ.get("QWEN38_VL_MAX_NEW_TOKENS_HARD", "4096"))
MAX_IMAGES = int(os.environ.get("QWEN38_VL_MAX_IMAGES", "8"))
MAX_VIDEO_BYTES = int(os.environ.get("QWEN38_VL_MAX_VIDEO_BYTES", str(1024 * 1024 * 1024)))
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("QWEN38_VL_REQUEST_TIMEOUT_SECONDS", "900"))
DEFAULT_REASONING_EFFORT = os.environ.get("QWEN38_VL_DEFAULT_REASONING_EFFORT", "xhigh").strip().lower()
REASONING_EFFORTS = {"low", "medium", "xhigh"}
AIWORKER_STAGES = {"vision", "chapter", "final"}


class RuntimeState:
    def __init__(self) -> None:
        self.processor: Any = None
        self.model: Any = None
        self.loaded_at: float | None = None
        self.load_error: str | None = None
        self.request_lock = asyncio.Lock()


STATE = RuntimeState()


def _safe_error(error: BaseException) -> str:
    return f"{type(error).__name__}: {str(error)[:800]}"


def _boolean_value(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalised = str(value).strip().lower()
    if normalised in {"1", "true", "yes", "on"}:
        return True
    if normalised in {"0", "false", "no", "off"}:
        return False
    raise ValueError("enable_thinking 必须是布尔值")


def _reasoning_settings(payload: dict[str, Any]) -> tuple[bool, str | None]:
    raw_effort = str(payload.get("reasoning_effort", DEFAULT_REASONING_EFFORT)).strip().lower()
    if raw_effort in {"off", "none", "disabled"}:
        return False, None
    # OpenAI-compatible clients commonly use high; this model template calls
    # its highest supported level xhigh.
    if raw_effort == "high":
        raw_effort = "xhigh"
    if raw_effort not in REASONING_EFFORTS:
        raise ValueError("reasoning_effort 必须是 off、low、medium、high 或 xhigh")
    enabled = _boolean_value(payload.get("enable_thinking"), True)
    return (enabled, raw_effort if enabled else None)


def _aiworker_stage(payload: dict[str, Any]) -> str:
    stage = str(payload.get("aiworker_stage", "other")).strip().lower()
    return stage if stage in AIWORKER_STAGES else "other"


def _load_runtime() -> None:
    if not (MODEL_DIR / "config.json").is_file():
        raise RuntimeError(f"模型目录缺少 config.json：{MODEL_DIR}")

    import torch
    from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration

    if DEVICE == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("当前 PyTorch 没有可用的 MPS 设备")

    config = json.loads((MODEL_DIR / "config.json").read_text(encoding="utf-8"))
    if not config.get("vision_config"):
        raise RuntimeError("原始 Qwen3.8 配置没有 vision_config，拒绝启动视觉服务")
    if "image_token_id" not in config or "video_token_id" not in config:
        raise RuntimeError("原始 Qwen3.8 配置缺少图片/视频 token，拒绝启动视觉服务")

    LOG.info("loading processor model_dir=%s device=%s", MODEL_DIR, DEVICE)
    processor = AutoProcessor.from_pretrained(str(MODEL_DIR), local_files_only=True)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        str(MODEL_DIR),
        local_files_only=True,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    model.to(DEVICE)
    model.eval()
    STATE.processor = processor
    STATE.model = model
    STATE.loaded_at = time.time()
    STATE.load_error = None
    LOG.info("Qwen3.8 visual runtime ready model=%s device=%s", MODEL_ID, DEVICE)


def _require_runtime() -> tuple[Any, Any]:
    if STATE.processor is None or STATE.model is None:
        detail = STATE.load_error or "视觉模型仍在加载"
        raise HTTPException(status_code=503, detail=detail)
    return STATE.processor, STATE.model


def _decode_data_url(value: str) -> bytes:
    header, separator, payload = value.partition(",")
    if not separator or ";base64" not in header.lower():
        raise ValueError("仅支持 base64 data URL")
    try:
        return base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("data URL 的 base64 无效") from error


def _local_path(value: str) -> Path:
    parsed = urlparse(value)
    if parsed.scheme == "file":
        path = Path(unquote(parsed.path)).expanduser()
    elif parsed.scheme:
        raise ValueError("视觉服务只允许 data URL、file URL 或本机绝对路径")
    else:
        path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("本地视觉输入必须是绝对路径")
    return path


def _image_from_value(value: Any) -> Image.Image:
    if isinstance(value, Image.Image):
        return value.convert("RGB")
    if not isinstance(value, str):
        raise ValueError("图片输入必须是 data URL、file URL 或本机绝对路径")
    if value.startswith("data:"):
        return Image.open(io.BytesIO(_decode_data_url(value))).convert("RGB")
    path = _local_path(value)
    if not path.is_file():
        raise ValueError(f"图片文件不存在：{path}")
    return Image.open(path).convert("RGB")


def _content_value(item: dict[str, Any], key: str, nested_key: str) -> Any:
    value = item.get(key)
    if isinstance(value, dict):
        return value.get(nested_key)
    return value


def _normalise_messages(messages: Any) -> tuple[list[dict[str, Any]], list[Image.Image], list[Any], list[Path]]:
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages 不能为空数组")
    normalised: list[dict[str, Any]] = []
    images: list[Image.Image] = []
    videos: list[Any] = []
    temporary_files: list[Path] = []

    try:
        for raw_message in messages:
            if not isinstance(raw_message, dict):
                raise ValueError("message 必须是对象")
            role = str(raw_message.get("role", "user")).strip() or "user"
            raw_content = raw_message.get("content", "")
            if isinstance(raw_content, str):
                normalised.append({"role": role, "content": raw_content})
                continue
            if not isinstance(raw_content, list):
                raise ValueError("message.content 必须是字符串或数组")

            content: list[dict[str, Any]] = []
            for item in raw_content:
                if not isinstance(item, dict):
                    raise ValueError("message.content 项必须是对象")
                kind = str(item.get("type", "")).strip()
                if kind == "text":
                    content.append({"type": "text", "text": str(item.get("text", ""))})
                    continue
                if kind in {"image", "image_url"}:
                    value = item.get("image") if kind == "image" else _content_value(item, "image_url", "url")
                    images.append(_image_from_value(value))
                    if len(images) > MAX_IMAGES:
                        raise ValueError(f"单次请求图片数量不能超过 {MAX_IMAGES}")
                    content.append({"type": "image"})
                    continue
                if kind in {"video", "video_url"}:
                    value = item.get("video") if kind == "video" else _content_value(item, "video_url", "url")
                    if not isinstance(value, str):
                        raise ValueError("视频输入必须是本机路径或 data URL")
                    if value.startswith("data:"):
                        payload = _decode_data_url(value)
                        if len(payload) > MAX_VIDEO_BYTES:
                            raise ValueError("视频 data URL 超过大小限制")
                        fd, temp_name = tempfile.mkstemp(prefix="qwen38-vl-", suffix=".mp4")
                        os.close(fd)
                        temp = Path(temp_name)
                        temp.write_bytes(payload)
                        temporary_files.append(temp)
                        value = str(temp)
                    path = _local_path(value)
                    if not path.is_file():
                        raise ValueError(f"视频文件不存在：{path}")
                    if path.stat().st_size > MAX_VIDEO_BYTES:
                        raise ValueError("视频文件超过大小限制")
                    videos.append(str(path))
                    content.append({"type": "video"})
                    continue
                raise ValueError(f"不支持的视觉内容类型：{kind or '空'}")
            normalised.append({"role": role, "content": content})
    except Exception:
        for path in temporary_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                LOG.warning("无法清理临时视频文件：%s", path)
        raise

    if not any(message.get("role") == "user" for message in normalised):
        raise ValueError("至少需要一条 user 消息")
    return normalised, images, videos, temporary_files


def _move_to_device(value: Any, device: str) -> Any:
    return value.to(device) if hasattr(value, "to") else value


def _answer_from_request(payload: dict[str, Any]) -> tuple[str, dict[str, int], dict[str, Any]]:
    processor, model = _require_runtime()
    messages, images, videos, temporary_files = _normalise_messages(payload.get("messages"))
    try:
        if not any(
            isinstance(message.get("content"), str) and message.get("content", "").strip()
            or any(item.get("type") == "text" and str(item.get("text", "")).strip() for item in message.get("content", []))
            for message in messages
        ):
            last = next(message for message in reversed(messages) if message.get("role") == "user")
            content = last.get("content")
            if isinstance(content, list):
                content.append({"type": "text", "text": "请描述当前图片或视频画面。"})
            else:
                last["content"] = "请描述当前图片或视频画面。"

        thinking_enabled, reasoning_effort = _reasoning_settings(payload)
        template_options: dict[str, Any] = {"enable_thinking": thinking_enabled}
        if reasoning_effort:
            template_options["reasoning_effort"] = reasoning_effort
        prompt = processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            **template_options,
        )
        inputs = processor(
            text=[prompt],
            images=images or None,
            videos=videos or None,
            padding=True,
            return_tensors="pt",
        )
        inputs = {key: _move_to_device(value, DEVICE) for key, value in inputs.items()}
        requested = payload.get("max_tokens", payload.get("max_new_tokens", DEFAULT_MAX_NEW_TOKENS))
        try:
            max_new_tokens = max(1, min(int(requested), MAX_NEW_TOKENS))
        except (TypeError, ValueError):
            max_new_tokens = DEFAULT_MAX_NEW_TOKENS

        import torch

        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        prompt_tokens = int(inputs["input_ids"].shape[1])
        generated = output[:, prompt_tokens:]
        answer = processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
        answer = answer.replace("<|im_end|>", "").strip()
        if not answer:
            raise RuntimeError("视觉模型返回空内容")
        prompt_count = int(inputs["input_ids"].numel())
        completion_count = int(generated.numel())
        usage = {
            "prompt_tokens": prompt_count,
            "completion_tokens": completion_count,
            "total_tokens": prompt_count + completion_count,
        }
        generation = {
            "thinking_enabled": thinking_enabled,
            "reasoning_effort": reasoning_effort or "off",
            "max_new_tokens": max_new_tokens,
        }
        return answer, usage, generation
    finally:
        for path in temporary_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                LOG.warning("无法清理临时视频文件：%s", path)


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        _load_runtime()
    except Exception as error:  # noqa: BLE001 - startup must expose the real failure
        STATE.load_error = _safe_error(error)
        LOG.exception("Qwen3.8 visual runtime failed to load")
        raise
    yield


app = FastAPI(title="AI-worker Qwen3.8 Vision", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok" if STATE.model is not None else "loading",
        "model": MODEL_ID,
        "modelDirectory": str(MODEL_DIR),
        "device": DEVICE,
        "vision": True,
        "video": True,
        "reasoningEfforts": ["off", "low", "medium", "xhigh"],
        "defaultReasoningEffort": DEFAULT_REASONING_EFFORT,
        "loadedAt": STATE.loaded_at,
        "loadError": STATE.load_error,
    }


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    _require_runtime()
    return {
        "object": "list",
        "data": [{
            "id": MODEL_ID,
            "object": "model",
            "owned_by": "aiworker",
            "input": ["text", "image", "video"],
            "capabilities": ["text", "vision", "video", "structured-output"],
        }],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    started = time.time()
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    request_model = str(payload.get("model", MODEL_ID)).strip()
    if request_model and request_model != MODEL_ID and request_model != "default_model":
        raise HTTPException(status_code=400, detail=f"不支持的模型：{request_model}")
    stage = _aiworker_stage(payload)
    try:
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
            async with STATE.request_lock:
                queue_wait_ms = round((time.time() - started) * 1_000)
                inference_started = time.time()
                answer, usage, generation = await asyncio.to_thread(_answer_from_request, payload)
                inference_ms = round((time.time() - inference_started) * 1_000)
    except asyncio.TimeoutError as error:
        raise HTTPException(status_code=504, detail="视觉模型请求超时") from error
    except HTTPException:
        raise
    except (ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - return bounded diagnostic detail
        LOG.exception("visual completion failed")
        raise HTTPException(status_code=502, detail=_safe_error(error)) from error

    LOG.info(
        "visual completion stage=%s thinking=%s max_new_tokens=%s queue_wait_ms=%s "
        "inference_ms=%s prompt_tokens=%s completion_tokens=%s",
        stage,
        generation["reasoning_effort"],
        generation["max_new_tokens"],
        queue_wait_ms,
        inference_ms,
        usage["prompt_tokens"],
        usage["completion_tokens"],
    )

    response_body = {
        "id": f"chatcmpl-qwen38-vl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": answer},
            "finish_reason": "stop",
        }],
        "usage": usage,
        "aiworker_metrics": {
            "stage": stage,
            **generation,
            "queue_wait_ms": queue_wait_ms,
            "inference_ms": inference_ms,
        },
        "system_fingerprint": f"qwen38-vl-{int(started)}",
    }
    if not payload.get("stream"):
        return JSONResponse(response_body)

    chunk_id = response_body["id"]
    created = response_body["created"]

    async def events():
        yield "data: " + json.dumps({
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": MODEL_ID,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": answer},
                "finish_reason": None,
            }],
        }, ensure_ascii=False) + "\n\n"
        yield "data: " + json.dumps({
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": MODEL_ID,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("QWEN38_VL_HOST", "127.0.0.1"),
        port=int(os.environ.get("QWEN38_VL_PORT", "18094")),
        log_level=os.environ.get("QWEN38_VL_LOG_LEVEL", "info").lower(),
    )

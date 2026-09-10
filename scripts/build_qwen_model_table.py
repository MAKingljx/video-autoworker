#!/usr/bin/env python3
"""Build a current Qwen downloadable model table from official Hugging Face metadata."""

from __future__ import annotations

import csv
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs"
CSV_PATH = OUT_DIR / "qwen-downloadable-models-2026.csv"
MD_PATH = OUT_DIR / "qwen-downloadable-models-2026.md"
JSON_PATH = OUT_DIR / "qwen-downloadable-models-2026.json"

HF_AUTHOR_API = "https://huggingface.co/api/models?author=Qwen&limit=500&sort=lastModified&direction=-1&full=false"
HF_MODEL_API = "https://huggingface.co/api/models/Qwen/{model_id}?blobs=true"
HF_MODEL_URL = "https://huggingface.co/Qwen/{model_id}"
MS_MODEL_URL = "https://modelscope.cn/models/Qwen/{model_id}"

WEIGHT_EXTENSIONS = (
    ".safetensors",
    ".bin",
    ".gguf",
    ".pt",
    ".pth",
    ".ckpt",
    ".onnx",
    ".npz",
    ".msgpack",
)

SKIP_SUFFIXES = (
    ".index.json",
    ".md",
    ".txt",
    ".json",
    ".model",
    ".tiktoken",
)

FAMILY_ORDER = {
    "Qwen3.6": 10,
    "Qwen3.5": 20,
    "Qwen3": 30,
    "Qwen3-Next": 40,
    "Qwen3-Coder": 50,
    "Qwen3-VL": 60,
    "Qwen3-Omni": 70,
    "Qwen3-Embedding/Reranker": 80,
    "Qwen3-ASR/TTS": 90,
    "Qwen-Image": 100,
}


def get_json(url: str, retries: int = 3) -> Any:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AI-worker-qwen-table/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError) as err:
            last_err = err
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_err}")


def include_model(model_id: str) -> bool:
    if model_id.startswith("SAE-"):
        return False
    return model_id.startswith("Qwen3") or model_id.startswith("Qwen-Image")


def family_for(model_id: str) -> str:
    if model_id.startswith("Qwen3.6"):
        return "Qwen3.6"
    if model_id.startswith("Qwen3.5"):
        return "Qwen3.5"
    if model_id.startswith("Qwen3-Coder"):
        return "Qwen3-Coder"
    if model_id.startswith("Qwen3-Next"):
        return "Qwen3-Next"
    if model_id.startswith("Qwen3-VL-Embedding") or model_id.startswith("Qwen3-VL-Reranker"):
        return "Qwen3-Embedding/Reranker"
    if model_id.startswith("Qwen3-VL"):
        return "Qwen3-VL"
    if model_id.startswith("Qwen3-Omni"):
        return "Qwen3-Omni"
    if model_id.startswith("Qwen3-Embedding") or model_id.startswith("Qwen3-Reranker"):
        return "Qwen3-Embedding/Reranker"
    if model_id.startswith("Qwen3-ASR") or model_id.startswith("Qwen3-TTS") or model_id.startswith("Qwen3-ForcedAligner"):
        return "Qwen3-ASR/TTS"
    if model_id.startswith("Qwen-Image"):
        return "Qwen-Image"
    return "Qwen3"


def task_type(model_id: str, pipeline_tag: str | None) -> str:
    if model_id.startswith("Qwen3.6") or model_id.startswith("Qwen3.5"):
        return "文本/对话"
    if "Embedding" in model_id:
        return "向量/检索"
    if "Reranker" in model_id:
        return "重排"
    if model_id.startswith("Qwen3-Coder"):
        return "代码"
    if model_id.startswith("Qwen3-VL"):
        return "视觉语言"
    if model_id.startswith("Qwen3-Omni"):
        return "全模态"
    if model_id.startswith("Qwen3-ASR") or "ForcedAligner" in model_id:
        return "语音识别/对齐"
    if model_id.startswith("Qwen3-TTS"):
        return "语音合成"
    if model_id.startswith("Qwen-Image"):
        return "图像生成/编辑"
    return "文本/对话"


def format_for(model_id: str) -> str:
    flags: list[str] = []
    for marker in ("FP8", "GPTQ-Int4", "GPTQ-Int8", "AWQ", "GGUF", "MLX-4bit", "MLX-6bit", "MLX-8bit", "MLX-bf16"):
        if marker in model_id:
            flags.append(marker)
    if "Base" in model_id:
        flags.append("Base")
    if "Instruct" in model_id:
        flags.append("Instruct")
    if "Thinking" in model_id:
        flags.append("Thinking")
    if "Captioner" in model_id:
        flags.append("Captioner")
    if not flags:
        flags.append("官方默认权重")
    return " / ".join(flags)


def parse_params(model_id: str) -> tuple[str, str]:
    active = ""
    active_match = re.search(r"-A(\d+(?:\.\d+)?)B", model_id)
    if active_match:
        active = f"{active_match.group(1)}B"
    total_match = re.search(r"(?<!A)(\d+(?:\.\d+)?)B", model_id)
    total = f"{total_match.group(1)}B" if total_match else ""
    if not active and total:
        active = total
    return total, active


def sum_weight_size(model_detail: dict[str, Any]) -> tuple[int, int]:
    total = 0
    count = 0
    for sibling in model_detail.get("siblings", []):
        name = sibling.get("rfilename", "")
        lower = name.lower()
        size = sibling.get("size")
        if size is None:
            continue
        if lower.endswith(SKIP_SUFFIXES):
            continue
        if lower.endswith(WEIGHT_EXTENSIONS):
            total += int(size)
            count += 1
    if total == 0 and model_detail.get("usedStorage"):
        total = int(model_detail["usedStorage"])
    return total, count


def gib(num_bytes: int) -> float:
    return num_bytes / (1024**3)


def feasibility(size_gib: float | None, model_id: str, memory_gb: int) -> str:
    if size_gib is None:
        return "待实测"
    if "GGUF" in model_id:
        return "按所选GGUF量化文件评估"
    if "MLX" in model_id:
        if size_gib <= memory_gb * 0.72:
            return "推荐/可行"
        if size_gib <= memory_gb * 0.86:
            return "边缘可行"
        return "不建议"
    if size_gib <= memory_gb * 0.58:
        return "可行"
    if size_gib <= memory_gb * 0.72:
        return "谨慎可行"
    if size_gib <= memory_gb * 0.84:
        return "边缘/不建议生产"
    return "不建议"


def notes_for(model_id: str, size_gib: float | None) -> str:
    notes: list[str] = []
    if re.search(r"-A\d+(?:\.\d+)?B", model_id):
        notes.append("MoE，总参数大但每 token 激活较小")
    if "GGUF" in model_id:
        notes.append("仓库常含多个量化文件，实际只需下载目标量化")
    if "MLX" in model_id:
        notes.append("更适合 Apple Silicon / MLX")
    if "FP8" in model_id:
        notes.append("低显存/高吞吐部署优先")
    if "GPTQ" in model_id or "AWQ" in model_id:
        notes.append("量化推理版")
    if model_id.startswith("Qwen-Image"):
        notes.append("非文本 token 服务主力，按图像任务评估")
    if size_gib and size_gib > 700:
        notes.append("超大权重，优先集群/多卡")
    return "；".join(notes)


def markdown_table(rows: list[dict[str, str]]) -> str:
    headers = [
        "系列",
        "模型名称",
        "类型",
        "权重格式",
        "下载大小(GiB)",
        "总参数",
        "激活参数",
        "Mac Studio 512GB 可行性",
        "Mac Studio 1TB 可行性",
        "下载地址",
        "备注",
    ]
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        vals = [
            row["系列"],
            row["模型名称"],
            row["类型"],
            row["权重格式"],
            row["下载大小(GiB)"],
            row["总参数"],
            row["激活参数"],
            row["Mac Studio 512GB 可行性"],
            row["Mac Studio 1TB 可行性"],
            f"[HF]({row['HF下载地址']}) / [ModelScope]({row['ModelScope下载地址']})",
            row["备注"],
        ]
        escaped = [str(v).replace("|", "\\|").replace("\n", " ") for v in vals]
        lines.append("| " + " | ".join(escaped) + " |")
    return "\n".join(lines)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    models = get_json(HF_AUTHOR_API)
    selected = [m for m in models if include_model(m["modelId"].split("/", 1)[1])]
    selected.sort(
        key=lambda m: (
            FAMILY_ORDER.get(family_for(m["modelId"].split("/", 1)[1]), 999),
            m["modelId"].split("/", 1)[1].lower(),
        )
    )

    rows: list[dict[str, str]] = []
    raw_details: dict[str, Any] = {}
    for idx, model in enumerate(selected, 1):
        model_id = model["modelId"].split("/", 1)[1]
        detail = get_json(HF_MODEL_API.format(model_id=model_id))
        raw_details[model_id] = {
            "sha": detail.get("sha"),
            "lastModified": detail.get("lastModified"),
            "usedStorage": detail.get("usedStorage"),
            "safetensors": detail.get("safetensors"),
        }
        size_bytes, weight_file_count = sum_weight_size(detail)
        size = gib(size_bytes) if size_bytes else None
        total, active = parse_params(model_id)
        row = {
            "系列": family_for(model_id),
            "模型名称": model_id,
            "类型": task_type(model_id, model.get("pipeline_tag")),
            "权重格式": format_for(model_id),
            "下载大小(GiB)": f"{size:.2f}" if size is not None else "未知",
            "权重文件数": str(weight_file_count),
            "总参数": total or "未标注",
            "激活参数": active or "未标注",
            "Mac Studio 512GB 可行性": feasibility(size, model_id, 512),
            "Mac Studio 1TB 可行性": feasibility(size, model_id, 1024),
            "HF下载地址": HF_MODEL_URL.format(model_id=model_id),
            "ModelScope下载地址": MS_MODEL_URL.format(model_id=model_id),
            "最后更新": str(detail.get("lastModified") or model.get("lastModified") or ""),
            "备注": notes_for(model_id, size),
        }
        rows.append(row)
        time.sleep(0.05)

    fields = [
        "系列",
        "模型名称",
        "类型",
        "权重格式",
        "下载大小(GiB)",
        "权重文件数",
        "总参数",
        "激活参数",
        "Mac Studio 512GB 可行性",
        "Mac Studio 1TB 可行性",
        "HF下载地址",
        "ModelScope下载地址",
        "最后更新",
        "备注",
    ]
    with CSV_PATH.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    summary: dict[str, int] = {}
    for row in rows:
        summary[row["系列"]] = summary.get(row["系列"], 0) + 1

    md = [
        "# Qwen 官方可下载模型表（2026-05）",
        "",
        "## 口径说明",
        "",
        "- 数据源：Hugging Face 官方 `Qwen` 组织模型元数据；国内下载地址按 ModelScope 官方 Qwen 命名空间同步链接给出。",
        "- 下载大小：按 Hugging Face 仓库中权重文件合计估算，主要统计 `.safetensors/.bin/.gguf/.pt/.pth/.onnx` 等文件，不含 README、配置、tokenizer 等小文件。",
        "- GGUF 仓库通常包含多个量化文件，表中大小为仓库内 GGUF 文件合计；实际部署通常只下载其中一个量化文件。",
        "- 激活参数：Dense 模型等于总参数；MoE 模型按名称中的 `AxxB` 记录每 token 激活参数，例如 `35B-A3B` 表示总参数约 35B、激活约 3B。",
        "- Mac Studio 可行性：按统一内存容量做粗估，未计入长上下文 KV cache、并发、框架开销和吞吐要求；最终仍需实测。",
        "",
        "## 系列统计",
        "",
    ]
    for family, count in sorted(summary.items(), key=lambda kv: FAMILY_ORDER.get(kv[0], 999)):
        md.append(f"- {family}: {count} 个")
    md.extend(["", "## 明细表", "", markdown_table(rows), ""])
    MD_PATH.write_text("\n".join(md), encoding="utf-8")

    JSON_PATH.write_text(
        json.dumps({"rows": rows, "raw_details": raw_details}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"rows={len(rows)}")
    print(CSV_PATH)
    print(MD_PATH)
    print(JSON_PATH)


if __name__ == "__main__":
    main()

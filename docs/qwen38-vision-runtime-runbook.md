# Qwen3.8-27B Vision 运行与升级手册

本手册是 Qwen3.8 视觉运行时的固定操作入口。它把模型文件、服务、OpenClaw、n8n 路由、验证和回滚拆成稳定边界，后续升级只替换受控运行时，不把权重、凭据、数据库或运行日志放进 Git。

## 生产拓扑

| 组件 | 固定值 | 说明 |
| --- | --- | --- |
| 节点 | `heisenbergs-1` | 默认本地模型节点 |
| 原始权重 | `~/models/Qwen3.8-27B` | 保留 `vision_config`、图片/视频 token 和预处理配置 |
| 运行时 | `~/ai-worker/lib/qwen38/qwen38_vl_server.py` | Transformers + MPS，无状态 OpenAI-compatible 服务 |
| 服务 | `http://127.0.0.1:18094/v1` | 仅 loopback，模型 ID `qwen38-27b-vl` |
| LaunchAgent | `ai.aiworker.qwen38-vl-server` | 服务自启动与保活 |
| OpenClaw provider | `qwen38-vl-local/qwen38-27b-vl` | profile `qwen-current` 的显式视觉 provider，别名 `qwen38-vl` |
| n8n 路由 | `local-qwen38-vl-direct` | 视频 binding `2` 的主视觉路由 |
| n8n 回退 | `local-qwen36-direct` | Qwen3.8 不可用时的同任务回退 |
| 原有服务 | `127.0.0.1:18093` | Stable Diffusion 图片生成，禁止占用或替换 |

Qwen3.8 文本/工具运行时仍独立使用 `127.0.0.1:18092/v1` 和 `qwen38-local`。文本模型切换与视觉路由切换是两个独立动作，不要把 OpenClaw 的文本模型切换当成视频链路切换。

## 固定升级顺序

在远端真实仓库 `~/Documents/Phoenix/video-autoworker` 的对应提交上执行，先确认 `node`、模型目录和端口，再按以下顺序操作：

```sh
cd ~/Documents/Phoenix/video-autoworker
bash scripts/install-model-routes.sh --sync-resources --sync-routes
QWEN38_VL_SOURCE_ROOT="$PWD" ~/ai-worker/bin/aiworker-qwen38-vl-upgrade
```

`aiworker-qwen38-vl-upgrade` 是后续模型升级的固定入口。它按“运行文件备份与
doctor → 启动 → 直接视觉测试 → OpenClaw provider 校验 → n8n binding 2 校验或切换 →
状态复核”的顺序执行；每个边界各自生成恢复点，不把模型权重、凭据、数据库或日志
写入仓库。若 binding 已是 `local-qwen38-vl-direct` 且回退仍为 `local-qwen36-direct`，
入口只读核对并跳过 n8n 写入；只有路由实际变化才会备份并更新 binding。单独排障时仍可使用
同目录下的 doctor/start/status/stop/test 子命令。

每次安装都会先在 `~/ai-worker/backups/qwen38-vl-runtime/` 生成恢复点；只有 doctor、直接图片测试、OpenClaw 图片测试、路由校验和视频整链验收全部通过后，才把运行时、OpenClaw 和路由恢复点标记为已验证。固定入口随后只保留每个恢复点家族最近两个已验证版本；失败或中断的恢复点不标记、不自动删除，便于排障和回滚。

## 验收门

1. `doctor` 必须确认原始权重、`vision_config`、视频预处理文件和 Python 依赖存在。
2. `status` 必须显示 18094 loopback listener、模型 ID 和 `health=ok`。
3. 直接图片测试必须得到非空回答，不能只验证 HTTP 200。
4. OpenClaw 图片测试必须使用完整模型 ID `qwen38-vl-local/qwen38-27b-vl`，并实际返回视觉结论；
   短别名 `qwen38-vl` 仅作人工选择别名，不作为图片能力探测依据。
5. `route-switch status` 必须显示 binding `2` 的 `vision.routeId=local-qwen38-vl-direct`、回退为 `local-qwen36-direct`。
6. 用一段真实视频走 `prepare -> Whisper audio / Qwen3.8 vision -> finalize`；父任务与四个阶段均成功，输出非空且 `memoryMode=none`。
7. 视频链路验收前，3017 的 `/api/n8n/workflows` 必须是 HTTP 200；若返回 `Authentication required`，先检查 standalone 是否绑定 `127.0.0.1` 并加载仓库 `.env.local`，不得重提视频任务。

## 汇总超时保护

Qwen3.8 视觉服务会把 `<think>...</think>` 与最终答案一起返回。视频片段 checkpoint
只保存 `</think>` 之后的可见答案，章节和整片汇总也使用独立的有界 `max_tokens`（默认
`1024`，上限 `2048`）以及最多 `600` 秒的请求窗口。这样最终汇总不会因为把内部推理
全文再次送回模型而超过 n8n 的回调窗口；章节 checkpoint 和 `final-summary.json` 仍
支持同一 task ID 失败后恢复，不会重新执行已经成功的音频/视觉阶段。

可按节点性能在运行环境中调整，但不应把上限扩大到无界：

```sh
export AIWORKER_VIDEO_SYNTHESIS_MAX_TOKENS=1024
export AIWORKER_VIDEO_SYNTHESIS_TIMEOUT_SECONDS=600
```

## 回滚

发生模型加载、视觉请求或整链验收失败时，保留原 task ID 和媒体，不重提任务，按顺序执行：

```sh
~/ai-worker/bin/aiworker-qwen38-vl-route-switch qwen36
~/ai-worker/bin/aiworker-qwen38-vl-stop
~/ai-worker/bin/aiworker-qwen38-vl-status
```

若是运行时文件升级失败，从最近一个已验证的 `qwen38-vl-runtime` 恢复点恢复 `~/ai-worker/lib/qwen38`、`~/ai-worker/bin/aiworker-qwen38-vl-*` 和 LaunchAgent，再启动 Qwen3.6 生产视觉服务。18093 图片生成服务始终独立保留。

## 边界

- 视觉服务只接受本机绝对路径、`file://` 或 data URL，不暴露公网。
- 视频任务由持久化全局 video lane 串行执行；不能为测试启动假 Gateway，也不能并行复制多个真实任务来代替整链证据。
- 视觉节点使用 `memoryMode=none`；模型输出不写入 OpenClaw 长期记忆。
- OpenClaw 状态和结果必须通过 `aiworker_analyze_video` 正式接口读取，不能扫描 SQLite、n8n execution、媒体目录或旧 `bot-learning` 文件。

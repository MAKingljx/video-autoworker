# Resolve 受管执行器

应用的任务表、批准计划和调度器继续负责业务状态。此目录仅实现 DaVinci Resolve 设备适配器，接收同一应用服务发送的结构化请求。它不自行规划、接单、重试、派生队列或修改 Resolve 数据库。

## 连接与权限

`resolve_executor.py` 只监听指定状态目录中的 `executor.sock`。状态目录必须属于当前用户且权限为 0700，socket 为 0600，服务端使用系统 peer credential 核验相同 UID。目录和 socket 不允许符号链接；固定文件锁保证每个目录只有一个服务实例。程序不开放 TCP，也不接收脚本正文或 shell 命令。

`scripts/resolve-executor-service.py` 的 `plan` 只输出安装清单；`install` 根据准确 Python、状态目录、输出根和节点 ID 安装当前用户 LaunchAgent。已有不同配置不会被覆盖或停止；正常更新先由拥有该安装的发布流程排空、停止，再安装已审核配置。`status` 只读取 LaunchAgent 和 socket 存在性，不把这些当作 Resolve API 可用的证明。

Resolve 必须在同一 GUI 用户会话中运行，官方脚本 API 必须实际可连接。`inspect` 回读版本、Studio 状态、工程、当前时间线和指纹。进程身份绑定 Resolve PID、启动时间、UID 与本次执行器 incarnation；改变进程或重启执行器后，旧写请求失效，原操作只能对账。

2026-10-08 H1 只读核验时，已安装 Resolve 21.1 SDK，Resolve 进程存在，但外部 Python `scriptapp("Resolve")` 返回空。该观察说明受管执行器尚不能据此宣称生产可用；启用设置及独立测试工程验收由主部署任务处理。

## 同一协议和失败边界

TypeScript 的 `resolve-executor-protocol.ts` 与 Python 使用相同 schemaVersion=1 请求封套：`requestId`、`operationId`、`action`、`planJson`、`payload`。action 仅为 inspect、apply、status、cancel；payload 中的 operation 和预检 processIdentity 由应用服务生成。

计划 SHA 使用排序键的规范 JSON；操作绑定 task、plan、revision、phase、step 及规范 payload SHA。副作用前检查批准状态、节点、版本、工程指纹、目标归属及当前目标指纹。指定源时间线时额外检查原时间线内容指纹；未指定时采用独立空时间线模式。已注册媒体以 UniqueId 和实际文件 SHA 共同核对。未入池资产必须由应用计划绑定准确规范 sourcePathRef 和 contentSha256，再执行独立 import_media 步骤；不根据文件名猜匹配或搜索其他目录。导入结果只写操作收据，已批准计划保持不变。

每个写操作在第一次 Resolve 调用前落盘意图，写后保存读回证据。收据仅是跨进程失败恢复证据，不承载业务调度。收到重复 apply 或 status 时只对账；即使上次无结果、只追加了部分内容、客户端断开或执行器重启，也不会再次复制、追加或开渲染。无法证明完成时返回 unknown，由应用保留原操作并提示核对。

## 支持范围

- 新剪辑：base.timelineUniqueId缺省时执行create_timeline，调用CreateEmptyTimeline建立独立空时间线；仅配置新目标的计划帧率与00:00:00:00起点，回读内容为空、起点为0及实际帧率。不会复制或清空旧时间线。
- 复制：调用官方 `Timeline.DuplicateTimeline`，只创建由已批准计划命名的副本，比较源内容与副本内容。
- 媒体导入：同路径同 SHA 且唯一的媒体池项可以复用；否则记录导入前媒体 ID 集合，ImportMedia 后按准确路径及新增差集回读。未知结果只对账，不重复导入；后续追加从同 plan/task 导入收据解析媒体 ID。
- 剪辑与音乐：同一个 AppendToTimeline 路径处理 video、audio、av；左闭右开源区间转换为 SDK 的包含结束帧区间；timelineStartFrame是绝对recordFrame。仅支持实际源帧率和时间线帧率一致，遇到混合帧率明确拒绝，不伪造换算。可选 audioGainDb 通过官方 SetProperties 设置音量（-100至30 dB），音量启用状态与数值进入指纹和读回。逐步回读媒体、轨道、入点、持续帧数与已有条目，遇到占用区域、缺少轨道、媒体变化或帧率不一致时停止。
- 字幕：显式 `output.autoSubtitles=true` 使用官方 CreateSubtitlesFromAudio，在副本回读字幕条目，渲染启用 BurnIn。任意指定文字的字幕导入尚无已验证实现，不伪称支持；字幕内容准确性仍需成片审核。
- 渲染：queue_render 仅加载计划声明的现有 preset，为指定副本添加作业、返回并持久化 job ID；start_render 从同计划和任务的排队收据取得该 ID，只对 Ready 作业启动一次。输出限于指定根目录，拒绝覆盖文件或重复占用输出；应用统一轮询状态。启动结果未知但仍为 Ready 时明确等待核对，不自动重复启动。旧 render/preview 主动写路径已经移除。Complete 还须输出文件存在、非空并生成 SHA；最终时长、画面和音轨质量由成片验收检查。
- 取消：官方 StopRendering 是全局操作，不能保证只取消该任务，所以当前明确返回 `resolve_render_cancel_unsupported`，不停止其他作业。应用可取消未开始任务，正在渲染的任务保留真实状态。

## 验证范围

Python 测试使用明确的 SDK double 验证协议、保护、丢响应对账、源数据不变及异步渲染语义；Unix socket 测试使用真实本机 socket 验证 framing、权限和请求归属。它们都不替代真实 Resolve 中的独立工程、副本、剪辑区间、字幕、音乐、导出和原工程不变验收。

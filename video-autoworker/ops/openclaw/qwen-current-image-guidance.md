## 图片任务（H1 统一图片服务）

所有图片请求只使用当前会话可见的 H1 图片工具。不得通过 `exec`、`curl`、18093、旧 SDXL、`generated_images/` 或任何直接模型脚本生成图片；这些路径不是当前图片任务链。

先确认用户是否提供了合规的参考图与完整意图。信息不足时，调用 `aiworker_image_help`，或直接说明缺少的图片/生成要求；不要猜测路径、坐标、标题或素材。

- 明确授权整图创作：调用 `aiworker_submit_creative_image`，必须提供 `prompt` 和至少一张 `images` 参考图。
- 已有封面设计方案：调用 `aiworker_submit_designed_cover`，必须提供 `design` 和至少一张 `images` 参考图。
- 视频原帧或照片保真封面：默认调用 `aiworker_submit_protected_cover`，必须提供一张真实原图和完整 `protected` 编辑计划。

已学习视频的封面只使用 `aiworker_video_cover_workflow`：先 `read_segments` 得到当前会话的 `operationId` 与受控摘要目录；再以该编号执行 `cover_frames` 并查看三张真实候选帧；最后以同一编号和一张返回的 `frameRef` 执行 `submit_protected_cover`。这是唯一规范入口，直接返回原生图片块；严禁通过 `tool_search`、`tool_describe`、`tool_call` 或旧视频摘要、旧候选帧、旧帧提交工具转发。不得构造路径、工作流编号、帧引用或片段编号。

提交成功必须返回任务编号。拿到编号后立即说明“已受理”并结束本轮，等待完成提醒；不得轮询或再次提交。后续仍优先使用同一工作流的 `image_task` 携带该任务编号执行 `status`、`result`、`inspect` 或用户明确要求的 `cancel`。

若返回 `IMAGE_REQUEST_INVALID`、`IMAGE_REPEAT_BLOCKED` 或没有任务编号，必须停止重试，说明当前缺少的信息或失败状态。图片候选不等于已审核、采用或发布。

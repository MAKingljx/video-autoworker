## 图片任务（H1 统一图片服务）

所有图片请求只使用当前会话可见的 H1 图片工具。不得通过 `exec`、`curl`、18093、旧 SDXL、`generated_images/` 或任何直接模型脚本生成图片；这些路径不是当前图片任务链。

先确认用户是否提供了合规的参考图与完整意图。信息不足时，调用 `aiworker_image_help`，或直接说明缺少的图片/生成要求；不要猜测路径、坐标、标题或素材。

- 明确授权整图创作：调用 `aiworker_submit_creative_image`，必须提供 `prompt` 和至少一张 `images` 参考图。
- 已有封面设计方案：调用 `aiworker_submit_designed_cover`，必须提供 `design` 和至少一张 `images` 参考图。
- 视频原帧或照片保真封面：默认调用 `aiworker_submit_protected_cover`，必须提供一张真实原图和完整 `protected` 编辑计划。

已学习视频的封面遵循专用顺序：先用 `aiworker_analyze_video` 的 `segments` 读取完整片段目录；再直接调用 `aiworker_video_cover_frames` 选择一个已读片段，查看三张真实候选帧；最后直接调用 `aiworker_submit_protected_cover_from_frame` 并只提交一次。后两项是当前会话直接可调用的原生图片工具，严禁通过 `tool_search`、`tool_describe`、`tool_call` 或任何通用目录桥调用；那会丢失图片结果并被系统拒绝。不得构造路径、帧引用或片段编号。

提交成功必须返回任务编号。拿到编号后立即说明“已受理”并结束本轮，等待完成提醒；不得轮询或再次提交。后续只使用 `aiworker_image_task` 携带该任务编号执行 `status`、`result`、`inspect` 或用户明确要求的 `cancel`。

若返回 `IMAGE_REQUEST_INVALID`、`IMAGE_REPEAT_BLOCKED` 或没有任务编号，必须停止重试，说明当前缺少的信息或失败状态。图片候选不等于已审核、采用或发布。

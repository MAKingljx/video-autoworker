# 剪辑方案薄入口（本地候选，生产未启用）

本插件只连接现有 AI-worker 应用服务，不实现第二套剪辑状态机。当前生产没有 Studio 授权，正式API执行器和本插件均不安装启用；生产GPT继续沿用户已授权的达芬奇界面操作流程工作。此目录不代表生产具备正式API能力。

固定工具 `aiworker_edit_video` 只注册在 `gpt-main` profile 的 `main` agent。其余三个profile不获得工具。`inspect`读取真实节点能力，`evidence`按页读取已保存的成功学习证据，`propose`只保存validated候选，`status`和`result`读取唯一任务权威；`execute`也只查询人工批准状态，不创建任务、不批准方案。

模型入口不提供approve、取消、任意URL或授权覆盖。`approved:true`和人工reviewToken参数被拒绝；网页reviewToken从工具返回值剔除。插件不直接发送飞书消息或视频，不改变视频学习窗口，也不读取任意源文件。

网页候选组件只呈现目标、镜头依据、音量、字幕、导出设置和真实阶段。执行按钮要求正式能力已开放、Studio连接、操作者权限、完整方案及reviewToken；最终点击后重新读取当前版本，旧SHA拒绝确认。结果unknown单独标记待核对，不当作成功或自动重试。

将来具备Studio及明确安装授权后，可先在产品目录以Node22执行 `node scripts/install-aiworker-editing-plugin.mjs --mode prepare --source-commit <canonical-commit>`。prepare只读检查已固定canonical源码、SDK9.2、目标profile和权限，不更改配置或Gateway。apply与rollback是独立显式命令，当前不执行。

安装器只修改目标插件及main的精确工具授权，使用共享部署锁、原子配置CAS、限定组件恢复记录、回读和最多两个已验证历史版本。恢复记录不复制Gateway或模型凭据，不修改其他profile；安装成功仍为 `INSTALLED_PENDING_GATEWAY_VALIDATION`，由主流程使用官方配置校验和Gateway工具验收后才可报告生效。此候选未完成生产安装、模型真实工具调用或官方达芬奇API剪辑验收。

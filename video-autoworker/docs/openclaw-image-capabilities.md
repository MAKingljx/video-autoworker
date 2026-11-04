# OpenClaw 可插拔图片能力

图片生成只保留一套 H1 图片应用、任务队列和模型服务。OpenClaw profile 只作为薄入口：验证用户身份、接收图片请求并调用 `aiworker_generate_image`。它们不拥有单独的图片队列、模型进程、视频任务、剪辑权限或系统管理权限。

## 能力清单

`ops/openclaw/image-capability-attachments.json` 是唯一的图片入口声明。每一项固定声明：

- `profile`：允许接入的 OpenClaw 配置档；
- `agentId`：唯一允许获得工具的代理；
- `stateRoot` 与 `gatewayPort`：该入口的受控运行身份；
- `mediaRoot`：图片应用可以读取的唯一该入口媒体目录；
- `legacyScope`：仅历史 `image-studio` 使用，确保已受理图片任务仍能被原会话查询。

当前清单保留既有 `image-studio`，并声明首个复用入口 `qwen-current / second-original`。新增入口必须先经用户授权，新增一条完整声明并验证该入口的媒体目录；不能复制插件、工作区或图片服务。

## 安装与恢复

`scripts/install-openclaw-image-capability.mjs` 只接受清单内 profile。它会：

1. 核对 Git 提交、插件版本、profile、代理、配置与受控目录；
2. 先作只读干运行，再备份该 profile 的配置与旧插件树；
3. 使用 OpenClaw 官方插件安装，基于 Gateway 配置修订进行 CAS 更新；
4. 只加入图片插件和图片工具，重启该 profile；
5. 核对其它有效工具未变化、图片工具已由正确插件提供，并保留两份可恢复备份。

失败时只有在当前配置仍能证明仅发生了本组件变更时才恢复；否则保留 `RECONCILE_REQUIRED` 收据，不覆盖未知配置。

图片服务的 `reference_roots` 由同一清单派生。接入新入口而需要接收用户图片时，应在图片队列为空时定向更新图片服务；不得放开任意本机路径。

## 验收边界

每个新入口至少验证：插件已加载、有效工具中只有预期新增的图片工具、已有工具不变、图片任务按该入口独立会话范围受理与回读、完成提醒回到同一会话。生成成功、OCR 或保护像素校验不等同于封面最终采用；封面仍按保真和人工视觉审核规范处理。

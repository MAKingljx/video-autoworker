# AI-worker

AI-worker 根目录统一管理项目文档、工作规则、运维脚本和 Video AutoWorker 产品源码。GitHub 使用同一个仓库 `MAKingljx/video-autoworker`，保留原有提交历史。

产品目录保持 `video-autoworker/`，业务源码位于 `video-autoworker/src/`。开发、测试和构建从产品目录执行；根目录负责版本管理和项目治理。

```text
AI-worker/
├── .github/workflows/       仓库级 CI
├── AGENTS.md                项目协作规则
├── README.md
├── docs/                    公共架构与维护文档
├── scripts/                 本机辅助运维脚本
├── launch-agents/           无密钥服务模板
└── video-autoworker/        产品目录
    ├── package.json
    ├── pnpm-lock.yaml
    ├── src/
    ├── scripts/
    ├── ops/
    └── docs/
```

## 开发与构建

```sh
git clone https://github.com/MAKingljx/video-autoworker.git AI-worker
cd AI-worker/video-autoworker
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

构建使用产品目录中的 `.nvmrc` 和 `package.json` 声明的 Node、pnpm 版本。生产构建执行 `corepack pnpm build`，验证命令见[产品说明](video-autoworker/README.md)。CI、Docker 构建上下文及部署源校验均使用对应提交的产品目录。

## 版本与资料

源码历史以 Git 提交和发布标签恢复，不为每次迭代复制完整源码或制作整仓压缩包。临时验证工作树在任务结束后退役；部署中仍被引用的发布版本按恢复需要保留。

数据库、素材、索引、真实运行配置和密钥不由 Git 代替备份。依赖、缓存、日志、临时产物、原始运维记录及本机身份标记不进入仓库。每个运行资产恢复对象最多保留两个已验证历史版本，源数据和唯一恢复点继续保护。

飞书工作大脑使用同一 `PROJ-VIDEO-AUTOWORKER`，身份绑定以实际 AI-worker 根目录为准。本机连接信息及私有记录保留在本机，公共部署结论记录在[产品运维记录](video-autoworker/docs/operations/)。详见[目录与 Git 边界](docs/aiworker-directory-and-git-boundary.md)和[蓝绿维护手册](video-autoworker/docs/operations/blue-green-maintenance.md)。

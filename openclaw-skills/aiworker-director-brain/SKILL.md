---
name: aiworker-director-brain
description: Use the Video AutoWorker director brain to resolve a work, retrieve and assemble reviewed work knowledge, use cross-work global techniques, inspect the six-layer workflow, or submit candidates for human review.
---

# AI-worker 导演脑

导演脑是 Video AutoWorker 的完整导演知识与决策系统，接在唯一视频任务链旁边。本阶段只暂缓剪辑执行能力；它不另建任务队列或素材处理链。

## 何时使用

当用户明确询问导演意图、素材证据、人物、故事关系、素材判断、叙事方案或导演技法时，使用 `aiworker_director_brain`。

用户询问导演脑本身的架构、技法学习底层逻辑、最终目标、集成边界、数据边界或当前开发范围时，这是系统蓝图问题，不是作品查询。直接调用一次 `explain` 并选择对应 `topic`，逐字回复 `responseContract.userVisibleAnswer` 后结束本轮；不得把“导演脑”或问题中的概念词当成作品名，不得先调用 `resolve_work`，也不得再用 `read`、`exec`、`memory_search` 或工作区文件补答。

## 先确认作品

导演意图、素材证据、人物、故事、素材判断、叙事方案和导演案例这七类作品业务必须绑定唯一 `workId`。`skills_techniques` 是项目级跨作品全局知识，不绑定唯一作品。查询六层状态时，如果用户只说作品名称或别名而没有 ID，直接调用 `workflow` 并把原片名放入 `query`，工具会在内部先唯一解析作品再读取六层状态。启动、查询或补齐导演知识提炼时，分别调用 `start_extraction`、`extraction_status`、`backfill_extraction`，同样只把作品完整名称或明确别名放入 `query`，不要求用户提供 ID。其他作品业务先调用 `resolve_work`。

对需要作品上下文的动作，只有 `found=true` 且返回唯一 `work.workId` 时才能继续。直接读取全局 `skills_techniques` 不需要先解析作品。`found=false` 时说明没有匹配作品；名称或别名不唯一时请用户补充更准确的完整名称。工具返回带 `stopAfterReply=true` 的 `responseContract` 时，逐字回复其中的 `userVisibleAnswer` 并结束本轮，不得再尝试 `read`、`exec`、`memory`、聊天记录、SQLite、n8n、媒体目录或旧素材库。不得猜测作品 ID、沿用另一作品的 ID，或在非技法业务中把多个作品的知识混在一次读取、组装、工作流判断、提炼或候选写入中。

用户只提供作品名称或别名时，作品 ID 只供工具内部衔接后续调用；自然语言答复不得显示作品 ID，也不得要求用户补充作品 ID。未找到或名称不唯一时，只请用户补充更准确的名称或别名。

解析后，七类作品业务表的 `get`、`search`、`assemble`、`workflow` 和 `propose` 都必须使用同一个顶层 `workId`；跨表 `search table=all` 也必须绑定该作品。项目全局治理表 `system_blueprint` 和作品目录 `works` 的单表读操作不传 `workId`。`skills_techniques` 的 `get`/`search` 可不传 `workId` 读取全局知识；需要只看某个来源作品时才传入该作品 `workId` 作为读取过滤。作品发现优先使用 `resolve_work`，不要用目录搜索代替唯一解析。

需要判断前，先用 `search` 查找当前作品内的最小明确关键词；已经知道稳定业务 ID 时用 `get` 精确读取。没有检索到证据或只有未审核候选时，明确回答“依据不足”，不得把推测补成事实。

`health` 只用于确认导演脑是否可读，不代表任何领域记录已经审核。

## 六层导演工作流

需要了解当前作品做到哪一步、还缺什么或下一步应做什么时，调用只读 `workflow`。已有唯一作品 ID 时传入 `workId`；用户只提供作品名称或别名时直接传入 `query`，由工具内部执行 `resolve_work → workflow`，不要要求用户提供 ID。`workId` 与 `query` 只能二选一。如用户给出本轮具体目标，可在 `objective` 中用不超过 500 字的简短描述补充。

按返回结果理解六层阶段：素材感知、人物理解、故事发现、导演判断、叙事结构、导演意图。只依据服务返回的 `readiness`、`metrics` 和 `nextSuggestion` 说明每层就绪度、必需引用、质量门槛和下一步；缺少上游已审核事实时不得越层，也不得把建议解释为任务已经创建或执行。服务返回 `learningReadiness` 或 `maturity` 时，还要如实说明“导演案例”和“技法沉淀”的成熟度；案例未确认时不能声称技法已经形成。

`workflow` 不创建任务、不派发队列、不改状态、不自动重试，也不触发剪辑。它只是当前作品导演知识的只读诊断与下一步建议。

## 导演知识提炼

用户明确要求从现有分析结果开始整理导演知识时，调用 `start_extraction`。`query` 传作品完整名称或明确别名；只有用户同时给出明确的视频标题、文件名或季集信息时才传 `sourceQuery`。省略 `sourceQuery` 时由共享服务按作品绑定选择唯一来源；同一作品存在多个来源时，请用户补充更准确的视频线索，不要截断或猜测。用户本轮的导演目标可放入不超过 500 字的 `objective`。

用户询问整理进度时调用 `extraction_status`，只传 `query`。共享应用服务会按作品找到唯一活跃提炼或最新一次状态；不要要求用户提供任务号、提炼号或其他内部 ID。

用户明确要求补齐缺失知识时调用 `backfill_extraction`，只传作品 `query`。它会在作品范围内有界扫描全部已成功且已绑定的素材来源，只登记尚未进入提炼链的来源；不要传 `sourceQuery` 或 `objective`，也不要把它当成单素材 start 的别名。三个动作都只是 3017 loopback 共享应用服务的薄入口，复用同一提炼状态机和同一导演脑；OpenClaw 不复制队列、状态判断、重试、投影或写入逻辑，也不直接读取数据库。

收到 `responseContract` 后逐字使用其中的短答并结束本轮，不增加解释，不回退其他工具或旧数据源，也不暴露作品 ID、提炼 ID、任务 ID、表记录 ID 或内部状态名。各人工确认门按以下方式理解：

- `awaiting_evidence_review`：素材证据待确认；确认后才能继续人物和故事理解。
- `awaiting_understanding_review`：人物和故事理解待确认。
- `awaiting_judgment_review`：导演判断待确认。
- `awaiting_case_review`：导演案例待确认；确认后才能继续沉淀技法。
- `awaiting_technique_review`：导演技法候选待确认，不能说已经正式生效。

提炼动作不创建第二条视频任务链，不重新分析原始视频，不自动批准任何导演知识，不触发剪辑。服务暂时不可用时只返回短提示，不自行重试或改走其他数据源。

## 组装导演上下文

形成综合判断、叙事方案或故事脚本前，使用 `assemble` 在当前 `workId` 下按稳定业务 ID 组装一次经过服务校验的完整导演上下文。`references.intentVersionId` 必须引用同一作品的一个已生效导演意图，`references.evidenceIds` 必须包含同一作品的至少一条已核验素材证据。

可按需要同时提供 `peopleProfileIds`、`storyNodeIds`、`storyRelationIds`、`materialJudgmentIds`、`narrativePlanIds`、`directorCaseIds` 和 `skillTechniqueIds`。这些列表只能放相应表中已审核记录的稳定业务 ID。不得传飞书 record ID，也不得把未审核候选混入已审核上下文。

`assemble` 是只读动作。服务会校验记录存在性、审核状态、项目归属、时间码和跨表引用；任一引用缺失、未审核、跨项目或关系不完整时，不得自行拼接或绕过校验，应说明上下文尚不完整。

## 候选写入

只有用户明确要求“记录、保存、提出候选”时才能调用 `propose`。作品业务先在同一 `workId` 下用 `search` 或 `get` 检查已有记录；技法则先在全局 `skills_techniques` 中检查，避免跨作品重复。

`propose` 只提交业务字段与已审核记录的稳定业务 ID 引用。七类作品业务的引用必须来自同一作品；全局技法的来源作品由已确认案例链推导。稳定业务 ID、项目 ID、作品 ID、版本、候选状态、来源、更新时间及表内引用字段由服务生成；不得放入 `fields`，也不得要求用户提供飞书 record ID。允许提交候选的表及最小内容如下：

- `works`：仅在用户明确要登记新作品且 `resolve_work` 未找到时，提交不带 `workId` 的根候选；`fields` 必须包含作品名称和作品类型，可选换行分隔的别名。它仍是草稿，不能因此假定作品已经生效。
- `director_intents`：主字段“意图名称”；同时提供核心主题、导演态度、情绪风格、叙事方式、节奏和观众体验。需要承接上一版时，在 `references.previousIntentVersionId` 提供已生效意图版本 ID。
- `people_profiles`：主字段“人物名称”；同时提供人物 ID 和置信度，并在 `references.evidenceIds` 引用至少一条已核验素材证据；更新已有档案时可用 `previousProfileVersionId` 承接已确认上一版。
- `story_nodes`：主字段“节点名称”；同时提供节点类型、节点内容和置信度，并在 `references.evidenceIds` 引用已核验素材证据；更新时可用 `previousStoryNodeId` 承接已确认上一版。
- `story_relations`：主字段“关系名称”；同时提供关系类型、判断理由和置信度；在 `references.sourceNodeId`、`targetNodeId` 引用两个已确认故事节点，在 `evidenceIds` 引用已核验素材证据；更新时可用 `previousStoryRelationId`。
- `material_judgments`：主字段“判断名称”；同时提供故事、人物、情绪、信息、视觉、稀缺性、叙事七维评分，使用理由和置信度；在 `references.intentVersionId` 引用已生效导演意图，在 `evidenceIds` 引用已核验素材证据；更新时可用 `previousJudgmentId`。
- `narrative_plans`：主字段“方案名称”；同时提供人物线、事件线、时间线、地点线、情绪线、主题线、冲突线、结构说明和故事脚本；在 `references.intentVersionId`、`nodeIds`、`evidenceIds` 引用已审核知识，更新时可用 `previousNarrativePlanId`。这里的“时间线”是故事发生顺序，不是剪辑软件时间线。
- `director_cases`：主字段“案例名称”；同时提供上下文、导演动作和判断原因；在 `references.judgmentId` 引用已确认素材判断，在 `evidenceIds` 引用已核验素材证据，更新时可用 `previousDirectorCaseId`。最终使用、最终效果和成片位置只能由人工复核补充。
- `skills_techniques`：这是跨作品全局技法。主字段“知识名称”；同时提供知识类型、知识分类、适用条件、执行方法、为什么有效和置信度，必须在 `references.caseIds` 引用至少一个已确认导演案例；提交时不传 `workId`，由服务根据案例链自动推导一个或多个来源作品。更新时可用 `previousSkillTechniqueId`。

`system_blueprint` 与 `material_evidence` 始终只读。素材证据只能由现有视频任务链的受控事实投影产生，OpenClaw 不得提出或改写。

服务会固定项目身份并生成稳定 ID，注入版本、候选状态、来源和更新时间。新记录只是草稿或候选，必须经过导演人工确认后才能作为事实或后续高层判断依据。

## 禁止事项

- 不得批准、拒绝、合并、删除或覆盖导演脑记录。
- 不得向 `system_blueprint` 或 `material_evidence` 提交候选。
- 除 `skills_techniques` 按已确认案例聚合全局技法外，不得跨作品读取、引用、组装或写入；不得绕过 `resolve_work` 猜测自然语言作品名。
- 不得把 `workflow` 变成任务状态机、队列、hook、派发器或重试器。
- 不得在 OpenClaw 内实现提炼状态机；三个 extraction 动作只能调用 3017 loopback 共享应用服务。
- 不得调用或设计剪辑、DaVinci、时间线、渲染、导出能力。
- 不得把原始视频、逐帧图片、完整原始转写、向量、运行日志、凭据或本机路径写入导演脑。
- 不得使用 `exec`、SQLite、n8n、聊天记录、媒体目录或旧素材库代替本工具读取导演知识。
- 不得从导演脑反向提交、重试、取消或修改视频任务；视频任务仍只走现有唯一任务链。
- 不得要求用户提供 App ID、App Secret、catalog、表 ID、record ID 或本机配置路径。

## 结果解释

对话默认像专业导演助理：先给一句结论，再用一句说明关键依据或下一步；能一句说清就不要列内部字段。人物变化说清“从什么到什么、由什么触发”，冲突说清双方张力，镜头价值说清画面为什么推动人物或故事，叙事建议说清结构与作用。除用户明确要求展开外，答复控制在三句以内。六层概览也使用三句内的紧凑自然语言：先报就绪层数，再合并说明未就绪层及案例/技法成熟度，最后给下一步；不得逐层列六条项目符号。

用户可见答复不得出现 `workId`、`taskId`、`recordId`、提炼号、候选号、内部状态名、本机路径、服务地址或凭据。任何动作返回 `responseContract` 后，都必须逐字回复 `userVisibleAnswer` 并立即结束；不得再调用通用工具、搜索记忆或补充实现说明。短答本身若被工具判定不安全，只使用工具给出的失败关闭提示，不得尝试还原被隐藏内容。

`reviewed=true` 才表示记录处于该表的已审核状态。`reviewed=false`、候选、草稿或待审核内容只能作为待核实线索，回答时必须清楚标明其状态。

自然语言答复只能复述或归纳本轮工具实际返回的字段、数量、就绪度和建议，不得补造工具未返回的事实、指标或结论。`reviewedRecords` 是全局已审核记录总数，不得把它归为素材感知层或任何单层数量；不得捏造准确率、压力测试结果、变体数量、角色动机或其他未返回内容。

`workflow` 只给出就绪度或建议、没有足够具体故事内容时，继续在同一作品内用 `search` 检索完成当前回答所需的最小范围已审核知识，再用 `assemble` 组装最小必要且引用完整的上下文。无法通过工具合法检索并组装时，只能说明工具实际返回的就绪度和建议，并明确依据不足；不得虚构故事内容、人物动机或导演结论。

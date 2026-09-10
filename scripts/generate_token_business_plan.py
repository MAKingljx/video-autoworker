from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor as PPTColor
from pptx.enum.text import PP_ALIGN, MSO_AUTO_SIZE
from pptx.util import Inches as PPTInches
from pptx.util import Pt as PPTPt


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
TMP_DIR = ROOT / "tmp" / "docs"
TMP_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DIR.mkdir(parents=True, exist_ok=True)

REPORT_DATE = date(2026, 4, 29)
REPORT_TITLE = "中国国内开源大模型 Token 商业策划案"
REPORT_SUBTITLE = "按 2026-04-29 最新模型、价格与市场口径编制"

MD_PATH = DOCS_DIR / "china-open-model-token-business-plan-2026.md"
DOCX_PATH = DOCS_DIR / "china-open-model-token-business-plan-2026.docx"
PPTX_PATH = DOCS_DIR / "china-open-model-token-business-plan-2026.pptx"

BREAKEVEN_PNG = TMP_DIR / "breakeven_tokens.png"
REVENUE_PNG = TMP_DIR / "revenue_mix.png"
ARCH_PNG = TMP_DIR / "cluster_architecture.png"

PRIMARY = (18, 63, 116)
ACCENT = (230, 126, 34)
GREEN = (39, 174, 96)
TEXT = (36, 41, 46)
MUTED = (104, 115, 132)
LIGHT_BG = (246, 248, 251)
WHITE = (255, 255, 255)
LIGHT_BORDER = (216, 221, 227)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size, index=0 if not bold else 0)
            except Exception:
                continue
    return ImageFont.load_default()


TITLE_FONT = font(34, bold=True)
H1_FONT = font(28, bold=True)
H2_FONT = font(22, bold=True)
BODY_FONT = font(18)
SMALL_FONT = font(14)


SOURCES = [
    ("S1", "Qwen3.6 官方 GitHub（2026-04-29 仓库状态）", "https://github.com/QwenLM/Qwen3.6"),
    ("S2", "DeepSeek-V4 Preview 官方发布（2026-04-24）", "https://api-docs.deepseek.com/zh-cn/news/news260424"),
    ("S3", "GLM-5 官方 GitHub（2026-04-29 仓库状态）", "https://github.com/zai-org/GLM-5"),
    ("S4", "MiniMax-M2.7 官方 GitHub（2026-04-29 仓库状态）", "https://github.com/MiniMax-AI/MiniMax-M2.7"),
    ("S5", "Kimi-K2.5 官方 GitHub（2026-04-29 仓库状态）", "https://github.com/MoonshotAI/Kimi-K2.5"),
    ("S6", "Moonshot 平台首页与价格（2026-04-29 页面状态）", "https://platform.moonshot.ai/"),
    ("S7", "DeepSeek API Pricing（2026-04-29 页面状态）", "https://api-docs.deepseek.com/quick_start/pricing"),
    ("S8", "阿里云百炼模型价格页（2026-04-29 页面状态）", "https://help.aliyun.com/zh/model-studio/model-pricing"),
    ("S9", "MiniMax API Overview / Pricing（2026-04-29 页面状态）", "https://platform.minimax.io/docs/api-reference/api-overview"),
    ("S10", "中国信通院《中国综合算力指数报告（2025年）》", "https://www.caict.ac.cn/kxyj/qwfb/bps/202601/P020260127610983117398.pdf"),
    ("S11", "IDC: AI Price Wars Miss the Point", "https://www.idc.com/resource-center/blog/ai-price-wars-miss-the-point-the-real-battle-is-outcomes"),
    ("S12", "生成式人工智能服务管理暂行办法", "https://www.gov.cn/zhengce/zhengceku/202307/content_6891752.htm"),
    ("S13", "互联网信息服务管理办法", "https://www.gov.cn/gongbao/content/2001/content_60954.htm"),
    ("S14", "Bitdeer March 2026 Operations Update", "https://ir.bitdeer.com/news-releases/news-release-details/bitdeer-announces-march-2026-production-and-operations-update"),
    ("S15", "GLM Chat Models 定价页（2026-04-29 页面状态）", "https://docs.z.ai/api-reference/models/chat-models"),
    ("S16", "内蒙古首个绿电直供算力中心项目投运（2025-05-16）", "https://www.nmg.gov.cn/ztzl/tjlswdrw/nyzlzyjd/202505/t20250516_2723662.html"),
    ("S17", "国家数据局案例：和林格尔绿色可溯源零碳算力集群（2024-09-25）", "https://www.nda.gov.cn/sjj/zhuanti/ztdsjblh/ztxwfb/0925/20240925131014579442012_pc.html"),
    ("S18", "2024年中国绿色算力大会发布会：呼和浩特-北京/合肥 400G 全光网络", "https://www.nmg.gov.cn/zwgk/xwfb/fbh/zxfb_fbh/202406/t20240624_2528624.html"),
    ("S19", "北京市算力设施建设实施方案解读：北京至和林格尔往返时延不高于5毫秒", "https://www.beijing.gov.cn/gate/big5/www.beijing.gov.cn/ywdt/gzdt/202405/t20240512_3676003.html"),
]


EXEC_SUMMARY = [
    "截至 2026-04-29，如果你讨论的是“用 GPU 集群自建并出售 Token”，必须把“最新 API 模型”与“最新可自建开权重模型”分开看。最新国内相关开源/开放权重主线，已不再是上一代的 Qwen3、GLM-4、DeepSeek-R1，而是 Qwen3.6、DeepSeek-V4 Preview、GLM-5、MiniMax-M2.7、Kimi-K2.5；同时，Moonshot 平台最新 API 已经走到 K2.6。",
    "商业结论很明确：纯“通用公有 Token 零售”基本不值得做，因为 DeepSeek-V4-Flash、MiniMax-M2.7 等官方 API 已经把价格锚压得很低。你要卖的不能只是 Token，而必须是 Token + 专属实例 + 工作流 + SLA + 合规。",
    "最新模型环境下，最可做的不是“谁便宜卖文本生成”，而是四类收入：专属实例月费、行业工作流项目费、私有化/混合云交付费、Agent/知识库运维费。公有 API 更适合当获客入口，而不是利润中心。",
    "对挖矿/算力企业来说，真正可复用的优势仍然是电力、园区、机房、散热、上架和 7x24 运维，而不是 ASIC 矿机本体。这个结论没有变，但在 2026 年已经有更现实的参照：Bitdeer 这类矿业基础设施公司公开披露的 AI Cloud GPU 利用率和 ARR，证明“矿业基础设施 -> AI 云/AI 数据中心”是能跑通的，但前提是你卖的是高利用率、高可见性的长期合约，而不是散单机时 [S14]。",
    "如果机房落在内蒙古，尤其是和林格尔或乌兰察布这类算力集群节点，利润空间通常会更大，因为低成本绿电、直供试点、较凉爽气候和现成集群网络会同时改善 OPEX；但这个优势更适合专属实例、训练/批处理和面向京津冀的后端推理，不适合单点承接全国所有超低时延交互流量。",
]

OPPORTUNITY_POINTS = [
    "模型代际已经前移：截至 2026-04-29，你要看的不是 2025 年主流，而是 2026 年还能打的路线。最新自建主线是 Qwen3.6、DeepSeek-V4 Preview、GLM-5、MiniMax-M2.7、Kimi-K2.5；最新 API 侧则要把 Kimi K2.6、DeepSeek-V4-Flash/V4-Pro 一并纳入对标。",
    "客户需求也更清晰：不是只要大模型，而是要“国内部署、日志可审计、权限可控、成本可预测、可挂 SLA、可签合同”。这对算力企业反而是机会，因为基础设施、交付和运维是它们天然更擅长的部分。",
    "价格战已经白热化。DeepSeek-V4-Flash 的官方价格低到足以把“裸 Token 零售”挤压成高周转、低毛利生意；因此越是最新模型环境，越要避免把自己做成便宜 API 中转商 [S7][S9][S11]。",
]

PAIN_POINTS = [
    "企业侧痛点已经从“有没有模型可用”转到“有没有稳定、合规、可落地的模型服务”。客户怕的不是模型不够新，而是限流、价格波动、上下文不稳、审计缺失和知识库链路不完整。",
    "采购侧最怕“买了一堆 SDK 和模型名，最后没有人对结果负责”。因此你需要交付的不是单一端点，而是统一计费、配额、权限、日志、工单、账单和售后。",
    "算力企业转型时最大的错觉，是以为把 GPU 上架就算进入大模型市场。实际上，真正难的是模型路由、弹性并发、前缀缓存、租户隔离、Agent 工具链、内容安全和 BD 成单。",
    "如果模型比较口径不更新，就会误把上一代模型当成当前主力，导致产品选型、价格带、GPU 预算和客户话术全部滞后约 6 到 12 个月。",
]

MODEL_ROWS = [
    ["Qwen3.6", "2026-04-29", "是", "仓库给出 Transformers / vLLM / SGLang / Ollama 路线，35B-A3B 与 27B-A3B 适合自建 [S1]", "最适合做中文基础款和中档主力池"],
    ["DeepSeek-V4 Preview", "2026-04-24", "是", "官方同时放出 API 与开源权重，V4-Flash / V4-Pro，1M context [S2][S7]", "最新高端路线，但不适合打低价公有零售"],
    ["GLM-5 / 5.1", "2026-04-29", "是", "仓库直接给出 vLLM FP8 部署线索；官方价格页已到 GLM-5.1 [S3][S15]", "适合政企中文、Agent 与企业代码场景"],
    ["MiniMax-M2.7", "2026-04-29", "是", "官方仓库提供本地部署、Transformers / vLLM / SGLang [S4][S9]", "适合长上下文、高客单价专属池"],
    ["Kimi-K2.5", "2026-04-29", "是", "官方 GitHub 仓库仍是当前确认到的 Moonshot 开权重主线 [S5]", "适合工具调用与 Agent 增强，但要与 K2.6 API 区分"],
    ["Kimi K2.6", "2026-04-29", "否（本次仅确认 API 公开）", "Moonshot 平台首页已把 K2.6 列为最新 API 模型 [S6]", "可作为外部路由兜底，不应当写进自建 GPU 集群核心"],
]

API_PRICE_ROWS = [
    ["DeepSeek-V4-Flash", "2026-04-29", "$0.14 / 1M", "$0.28 / 1M", "1M context；极低价锚 [S7]", "说明纯公有 Token 零售竞争已非常残酷"],
    ["DeepSeek-V4-Pro", "2026-04-29", "$0.435 / 1M（优惠）", "$0.87 / 1M（优惠）", "官方注明优惠至 2026-05-31；标准价更高 [S7]", "高端推理可做专属，但不适合普惠散卖"],
    ["Qwen3.6-Plus", "2026-04-29", "￥2 / 1M（<=256K）", "￥12 / 1M（<=256K）", ">256K 区间价格抬升 [S8]", "国内企业常用价格锚，适合对标中文市场"],
    ["GLM-5.1", "2026-04-29", "$1.4 / 1M", "$4.4 / 1M", "官方页已列为当前对外模型之一 [S15]", "更偏高价值 B2B，而非低价入口"],
    ["MiniMax-M2.7", "2026-04-29", "$0.3 / 1M", "$1.2 / 1M", "204.8K context [S9]", "比很多人预期更低价，进一步压缩公有零售毛利"],
    ["Kimi K2.6", "2026-04-29", "$0.95 / 1M", "$4.0 / 1M", "Moonshot 平台首页公开价；缓存命中价更低 [S6]", "适合做高能力 API 对标，不适合误写成自建主力"],
]

WHY_TOKEN_HARD_POINTS = [
    "最新官方 API 价格已经足够低。DeepSeek-V4-Flash 和 MiniMax-M2.7 这种价格锚一旦存在，除非你的电力和利用率极端优秀，否则纯靠自建卖公有 Token 很难赚到足够毛利。",
    "客户买公有 Token 的切换成本很低，但买专属实例、买私有化交付、买知识库工作流和买 SLA 的切换成本很高。因此越通用的公有能力越容易被比价，越贴近流程和数据的能力越能保毛利。",
    "模型迭代速度太快。今天的主力可能 2 到 3 个月后就被更新模型盖掉，所以如果你的商业承诺是“卖某个模型名”，风险很大；更好的承诺应该是“卖稳定结果、稳定上下文、稳定工作流”。",
]

INNER_MONGOLIA_POINTS = [
    "可以，空间会更大，但前提是你做的是“电力敏感型”的算力生意。内蒙古更适合把低价稳定电力转换成更低的单位算力成本，而不是单纯把省下来的电费当作利润。",
    "截至 2025-05-16，内蒙古首个“绿电直供”算力中心项目已经投运。自治区政府公开信息显示，该项目装机 36 万千瓦、配储 6.48 万千瓦/25.92 万千瓦时，年发电量预计 7.6 亿千瓦时，且为数据中心新增负荷消纳 [S16]。",
    "国家数据局 2024-09-24 发布的案例提到，和林格尔零碳算力集群项目实施后，能源供应成本有望下降 30%，并已形成超 10000PFlops 的算力规模 [S17]。",
    "公开报道显示，呼和浩特数据中心园区当前大量算力供往京津冀，网络时延约 3 至 5 毫秒量级，且当地已建成至北京、合肥等地的 400G 全光网络；这意味着内蒙古适合做“京津冀前端 + 内蒙古后端”的架构，而不是完全脱离东部入口 [S18][S19]。",
    "但也要看到边界：产业配套和人才密度仍弱于北上深杭；如果你卖的是全国消费者超低时延交互 API，单点落在内蒙古并不是最优；更好的模式是北京/上海做接入与控制面，内蒙古做主推理池、训练池和 dedicated pool。",
]

INNER_MONGOLIA_ROWS = [
    ["维度", "和林格尔", "乌兰察布", "判断"],
    ["最适合的角色", "京津冀后端推理池、专属实例、训练/批处理", "成本型推理池、弹性扩容池、灾备池", "都适合后端重负载，不适合单点承接全国实时入口"],
    ["关键优势", "靠近呼和浩特主节点，京津冀网络叙事强，零碳集群与政策标签强", "传统数据中心基础较成熟，电力与园区成本优势明显", "都适合讲“低电价 + 集群 + 绿电”"],
    ["主要风险", "土地/园区与政策配套需具体落到园区合同", "品牌和集群叙事略弱于和林格尔", "真正风险不在城市名，而在带宽、运维和销售能力"],
    ["推荐打法", "北京前端接入 + 和林格尔 dedicated pool", "北京/呼市控制面 + 乌兰察布弹性池", "优先做双地互补而不是孤立单点"],
]

BUSINESS_ROUTE_ROWS = [
    ["路线", "适合程度", "为什么"],
    ["通用公有 Token 零售", "低", "最新官方 API 价格已把毛利压得很薄，只适合作为入口或品牌曝光"],
    ["专属实例月费", "高", "客户按结果、并发、SLA 和隔离能力付费，议价空间明显更大"],
    ["行业方案 / RAG / Agent 交付", "高", "收入不是按 Token 线性计价，而是按项目价值和维护关系计价"],
    ["私有化 / 混合云", "高", "高合规客户愿意为数据边界、审计和部署方式付费"],
    ["路由聚合 / 平台层", "中", "可以做开发者入口，但需要生态、文档和渠道，不是矿企转型首选"],
]

PRODUCT_ROWS = [
    ["P1 公有 API 入口", "开发者、创新团队、集成商", "Qwen3.6 快速款 / MiniMax-M2.7 / 外部路由 DeepSeek-V4-Flash", "拉新、做 SDK 兼容、积累调用入口"],
    ["P2 标准专属实例", "制造、政企、金融、客服中心", "Qwen3.6-35B-A3B / GLM-5 / DeepSeek-V4-Pro", "独立配额、独立 SLA、独立日志与审计"],
    ["P3 Agent / RAG 行业方案", "有流程改造诉求的企业", "模型 + RAG + Agent + 工具链 + 工单", "按项目费 + 月服务费收款"],
    ["P4 私有化 / 混合云", "高合规客户、地方园区、集团总部", "部署到客户专有环境或独立租户池", "一次性交付费 + 年维保 + 扩容费"],
]

PRICING_ROWS = [
    ["公有快速款（建议售价）", "Qwen3.6 快速款 / MiniMax-M2.7", "1.5 - 3 元", "4 - 10 元", "只做入口，定价必须贴近官方锚 [S8][S9]"],
    ["标准企业款（建议售价）", "Qwen3.6-35B-A3B / GLM-5 / DeepSeek-V4-Pro", "3 - 8 元", "12 - 28 元", "对应中文企业任务、结构化抽取与 RAG"],
    ["Agent / 长上下文款（建议售价）", "MiniMax-M2.7 / Kimi-K2.5 / DeepSeek-V4-Pro", "6 - 15 元", "20 - 60 元", "优先绑定专属实例或保底月费"],
    ["专属实例月费", "按独立租户售卖", "4 - 10 万元/月", "-", "含保底并发、日志、工单与技术支持"],
    ["私有化 / 混合云交付", "按项目售卖", "20 - 80 万元/次", "-", "再叠加 3 - 8 万元/月运维与升级费"],
]

CAPEX_ROWS = [
    ["8 卡 80GB 级 GPU 服务器 x 2", "2,000,000", "形成 16 GPU MVP 推理池"],
    ["网络、对象存储、日志与监控", "250,000", "含交换、存储、备份、基础安全"],
    ["基准测试、部署、可观测与灰度环境", "150,000", "首期交付与环境打磨"],
    ["合规、安全、预备金", "100,000", "备案、内容审核、应急冗余"],
    ["首期资本开支合计", "2,500,000", "可按 24 个月折旧"],
]

OPEX_ROWS = [
    ["电力与制冷", "45,000", "取中性估算"],
    ["机柜、带宽、存储与备份", "20,000", "若自有园区可更低"],
    ["值班运维与 SRE", "20,000", "不含完整销售与管理费用"],
    ["软件、监控、工单、内容安全", "10,000", "第三方 SaaS 与自建混合"],
    ["硬件维保与损耗准备", "10,000", "按月摊平"],
    ["月运营支出合计", "105,000", "未计销售成本"],
]

ROI_ROWS = [
    ["Token-only", "公有 Token 零售", "20B Token/月 @ 5 元/百万", "100,000", "明显亏损，不建议作为主模式"],
    ["Hybrid", "公有 API + 3 个专属实例 + 2 个行业运维单", "8B Token/月 + 3 x 4 万 + 2 x 5 万", "338,000", "当前更现实的起步路线"],
    ["Dedicated-first", "弱化公有 API、强化专属与交付", "4B Token/月 + 4 个专属 + 1 个保底交付运维单", "458,000", "毛利与回本都明显更好"],
    ["Asset-advantaged", "Dedicated-first + 园区/电力复用", "同上，但首期 CAPEX 降低 25%", "458,000", "最适合矿企/园区型主体"],
]

MINE_ROWS = [
    ["可直接复用", "电力指标、园区空间、上架能力、基础散热、值班运维、资产融资经验"],
    ["需要升级", "高速网络、对象存储、GPU 服务器、推理框架、可观测平台、多租户权限与审计"],
    ["不能直接复用", "ASIC 矿机本体、只适配挖矿的板卡、过于单一的机架布线方案"],
    ["核心优势", "能以更低的上电成本、更快的场地准备速度切入 GPU 推理服务"],
    ["关键短板", "如果只懂机器开关机，不懂模型路由和客户交付，仍然会停留在低价卖机时长"],
]

ROADMAP_ROWS = [
    ["Phase 0", "2-3 周", "更新模型与价格口径、筛选 10 个目标客户、核清许可和部署边界", "确认不做裸 Token 零售"],
    ["Phase 1", "4-6 周", "搭建 16 GPU MVP、接入鉴权、计费、路由、日志、工单、监控", "拿到 3 个以上试点租户"],
    ["Phase 2", "6-8 周", "推出标准专属实例、企业知识库包、月度运维包", "月收入进入 25-40 万区间"],
    ["Phase 3", "2-3 个月", "做出 1 套可复制行业模板，扩到第二批渠道/园区客户", "形成标准化交付手册"],
    ["Phase 4", "持续", "扩容 dedicated pool、推进私有化/混合云与区域节点复制", "进入规模化经营"],
]

CUSTOMER_ROWS = [
    ["客户类型", "最关心什么", "适合卖什么"],
    ["开发者 / 集成商", "兼容性、价格、速度、SDK", "公有 API 入口 + 配额包"],
    ["制造 / 客服 / BPO", "稳定性、结构化抽取、知识库、SLA", "标准专属实例 + RAG 包"],
    ["政企 / 金融 / 医疗", "合规、审计、数据边界、内网部署", "私有化 / 混合云 + 长期运维"],
    ["地方园区 / 算力券项目", "本地算力、本地数据、本地服务、可复制招商故事", "Dedicated-first + 区域节点方案"],
]

SENSITIVITY_ROWS = [
    ["关键变量", "保守情形", "中性情形", "乐观情形", "对回本的影响"],
    ["GPU 利用率", "35%", "60%", "80%", "利用率越低，裸 Token 模式越不成立"],
    ["收入结构", "70% 公有 API", "40% 公有 API", "20% 公有 API", "专属与交付占比越高，毛利越稳"],
    ["销售周期", "90 天", "60 天", "45 天", "长销售周期会拖慢现金回流"],
    ["园区/电力复用", "无", "部分", "充分", "决定首期 CAPEX 和 OPEX 压缩空间"],
]


def break_even_tokens(monthly_cost: int, price_per_million: float) -> float:
    return monthly_cost / price_per_million


def draw_bar_chart(path: Path, title: str, labels: list[str], values: list[float], unit: str, bar_color: tuple[int, int, int]) -> None:
    width, height = 1400, 840
    margin_left, margin_top, margin_bottom = 180, 120, 160
    chart_width = width - margin_left - 120
    chart_height = height - margin_top - margin_bottom
    img = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(img)

    draw.text((60, 42), title, fill=TEXT, font=TITLE_FONT)
    draw.text((60, 88), f"单位：{unit}", fill=MUTED, font=SMALL_FONT)

    max_value = max(values) * 1.15
    zero_y = margin_top + chart_height
    draw.line((margin_left, margin_top, margin_left, zero_y), fill=LIGHT_BORDER, width=3)
    draw.line((margin_left, zero_y, width - 60, zero_y), fill=LIGHT_BORDER, width=3)

    for tick in range(6):
        value = max_value * tick / 5
        y = zero_y - chart_height * tick / 5
        draw.line((margin_left - 10, y, width - 60, y), fill=(235, 238, 242), width=1)
        label = f"{value:,.0f}"
        bbox = draw.textbbox((0, 0), label, font=SMALL_FONT)
        draw.text((margin_left - 18 - (bbox[2] - bbox[0]), y - 8), label, fill=MUTED, font=SMALL_FONT)

    bar_width = chart_width / max(len(labels), 1) * 0.55
    gap = chart_width / max(len(labels), 1)
    for idx, (label, value) in enumerate(zip(labels, values)):
        x0 = margin_left + idx * gap + (gap - bar_width) / 2
        x1 = x0 + bar_width
        y1 = zero_y
        y0 = zero_y - chart_height * value / max_value
        draw.rounded_rectangle((x0, y0, x1, y1), radius=18, fill=bar_color)
        value_text = f"{value:,.1f}"
        vb = draw.textbbox((0, 0), value_text, font=BODY_FONT)
        draw.text((x0 + (bar_width - (vb[2] - vb[0])) / 2, y0 - 36), value_text, fill=TEXT, font=BODY_FONT)
        lb = draw.multiline_textbbox((0, 0), label, font=BODY_FONT, spacing=4, align="center")
        draw.multiline_text((x0 + (bar_width - (lb[2] - lb[0])) / 2, zero_y + 18), label, fill=TEXT, font=BODY_FONT, spacing=4, align="center")

    img.save(path)


def draw_architecture(path: Path) -> None:
    width, height = 1600, 900
    img = Image.new("RGB", (width, height), LIGHT_BG)
    draw = ImageDraw.Draw(img)

    draw.text((60, 36), "推荐交付架构：控制平面 + 推理池 + 计费审计", fill=TEXT, font=TITLE_FONT)
    draw.text((60, 82), "把现有 AI-worker 节点思路扩展为对外 Token 服务架构", fill=MUTED, font=SMALL_FONT)

    boxes = [
        ((90, 170, 520, 390), PRIMARY, "Node-1 控制平面", ["API Gateway / Auth", "路由 / 配额 / 限流", "计费 / 工单 / 审计"]),
        ((560, 170, 1010, 390), ACCENT, "Node-2 快速模型池", ["Qwen3.6 / MiniMax-M2.7", "高并发、低成本", "拉新与轻量调用"]),
        ((1050, 170, 1510, 390), GREEN, "Node-3 主力推理池", ["DeepSeek-V4-Pro / GLM-5", "专属实例", "高价值中文任务"]),
        ((560, 480, 1010, 760), (125, 95, 190), "Node-4 增强与批处理", ["Embedding / Rerank", "RAG / ETL / 批任务", "内容安全与离线作业"]),
        ((1050, 480, 1510, 760), (44, 130, 201), "专属客户区", ["Kimi-K2.5 / MiniMax-M2.7", "长上下文 / Agent", "保底 SLA"]),
    ]

    for (x0, y0, x1, y1), color, title, lines in boxes:
        draw.rounded_rectangle((x0, y0, x1, y1), radius=28, fill=color)
        draw.text((x0 + 28, y0 + 22), title, fill=WHITE, font=H1_FONT)
        for idx, line in enumerate(lines):
            draw.text((x0 + 32, y0 + 88 + idx * 46), f"• {line}", fill=WHITE, font=BODY_FONT)

    arrows = [
        ((520, 280, 560, 280), PRIMARY),
        ((1010, 280, 1050, 280), PRIMARY),
        ((785, 390, 785, 480), PRIMARY),
        ((1280, 390, 1280, 480), PRIMARY),
    ]
    for coords, color in arrows:
        draw.line(coords, fill=color, width=8)

    footer = (
        "建议先把公有 Token 作为入口产品，核心利润放在专属实例、私有化和行业交付；"
        "所有调用统一经过 Node-1 做鉴权、日志、路由、风控和计费。"
    )
    draw.rounded_rectangle((90, 800, 1510, 860), radius=18, fill=WHITE, outline=LIGHT_BORDER, width=2)
    draw.text((118, 816), footer, fill=TEXT, font=BODY_FONT)
    img.save(path)


def set_run_font(run, size: int, bold: bool = False, color: tuple[int, int, int] | None = None) -> None:
    run.font.name = "Microsoft YaHei"
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.font.bold = bold
    if color is not None:
        run.font.color.rgb = RGBColor(*color)


def style_doc(document: Document) -> None:
    section = document.sections[0]
    section.top_margin = Inches(0.7)
    section.bottom_margin = Inches(0.7)
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)

    normal = document.styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)

    for style_name, size in [("Title", 22), ("Heading 1", 16), ("Heading 2", 13), ("Heading 3", 11)]:
        style = document.styles[style_name]
        style.font.name = "Microsoft YaHei"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.font.size = Pt(size)
        style.font.bold = True


def add_bullets(document: Document, items: Iterable[str], level: int = 0) -> None:
    for item in items:
        p = document.add_paragraph(style="List Bullet")
        p.paragraph_format.left_indent = Inches(0.25 + level * 0.15)
        p.paragraph_format.space_after = Pt(3)
        run = p.add_run(item)
        set_run_font(run, 10.5)


def shade_cell(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def add_table(document: Document, title: str, headers: list[str], rows: list[list[str]]) -> None:
    if title:
        p = document.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(4)
        run = p.add_run(title)
        set_run_font(run, 10.5, bold=True, color=PRIMARY)

    table = document.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    hdr_cells = table.rows[0].cells
    for idx, header in enumerate(headers):
        hdr_cells[idx].text = header
        shade_cell(hdr_cells[idx], "123F74")
        for p in hdr_cells[idx].paragraphs:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for run in p.runs:
                set_run_font(run, 9.5, bold=True, color=WHITE)
        hdr_cells[idx].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER

    for row in rows:
        cells = table.add_row().cells
        for idx, value in enumerate(row):
            cells[idx].text = value
            for p in cells[idx].paragraphs:
                p.paragraph_format.space_after = Pt(0)
                for run in p.runs:
                    set_run_font(run, 9.2)
            cells[idx].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def build_docx() -> None:
    doc = Document()
    style_doc(doc)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run(REPORT_TITLE)
    set_run_font(run, 22, bold=True, color=PRIMARY)

    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = sub.add_run(REPORT_SUBTITLE)
    set_run_font(run, 12, color=MUTED)

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = meta.add_run(f"出具日期：{REPORT_DATE.isoformat()} | 口径：最新模型与价格口径")
    set_run_font(run, 10, color=MUTED)

    doc.add_paragraph("")
    doc.add_picture(str(ARCH_PNG), width=Inches(6.9))
    last = doc.paragraphs[-1]
    last.alignment = WD_ALIGN_PARAGRAPH.CENTER

    doc.add_page_break()

    doc.add_heading("执行摘要", level=1)
    for para in EXEC_SUMMARY:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(6)
        run = p.add_run(para)
        set_run_font(run, 10.5)

    doc.add_heading("一、研究边界与市场前提", level=1)
    p = doc.add_paragraph()
    run = p.add_run("本策划案按 2026-04-29 的官方口径编制，核心前提有两条：第一，必须把“最新 API 模型”和“最新可自建开权重模型”分开看；第二，模型比较不能停留在 2025 年主线，而要切换到 2026 年当前仍有商业意义的路线。")
    set_run_font(run, 10.5)
    add_bullets(doc, OPPORTUNITY_POINTS)
    p = doc.add_paragraph()
    run = p.add_run("研究边界：本策划案讨论的是“基于 GPU 集群自建并出售 Token/实例/方案”的生意，不讨论单纯代理第三方 API 的轻资产分销模式。")
    set_run_font(run, 10.5)

    doc.add_heading("二、截至 2026-04-29 的最新模型格局", level=1)
    p = doc.add_paragraph()
    run = p.add_run("先给结论：当前真正适合写进“自建 GPU 集群”路线图里的，应该优先看 Qwen3.6、DeepSeek-V4 Preview、GLM-5、MiniMax-M2.7、Kimi-K2.5；Kimi K2.6 虽然更新，但本次核验到的是官方 API 口径，不应与自建权重混写。")
    set_run_font(run, 10.5)
    add_table(doc, "最新模型矩阵：自建与可售能力", ["路线", "截至日期", "可自建", "官方部署线索", "商业角色"], MODEL_ROWS)
    p = doc.add_paragraph()
    run = p.add_run("重要判断：如果你的销售话术仍然在讲 Qwen3、GLM-4、DeepSeek-R1 是“最新国内主力”，那在 2026-04-29 这个时间点已经明显滞后。")
    set_run_font(run, 10.5, bold=True, color=ACCENT)

    doc.add_heading("三、最新官方价格锚与竞争现实", level=1)
    p = doc.add_paragraph()
    run = p.add_run("下面这张表不是你的建议售价，而是最新官方价格锚。它决定了你靠“裸 Token 零售”到底有没有空间。注意不同厂商存在美元/人民币混合计价，因此表格主要用于判断竞争强度，而不是做逐分逐厘的财务结算。")
    set_run_font(run, 10.5)
    add_table(doc, "最新官方 API 价格锚（2026-04-29）", ["官方模型", "页面状态", "输入价", "输出价", "上下文/备注", "经营含义"], API_PRICE_ROWS)
    add_bullets(doc, WHY_TOKEN_HARD_POINTS)

    doc.add_heading("四、市场痛点与客户需求", level=1)
    add_bullets(doc, PAIN_POINTS)
    add_table(doc, "客户细分与对应售卖形态", ["客户类型", "最关心什么", "适合卖什么"], CUSTOMER_ROWS[1:])

    doc.add_heading("五、商业路线判断：什么值得做，什么不值得做", level=1)
    p = doc.add_paragraph()
    run = p.add_run("基于最新模型与价格口径，商业路线要先分层，再谈部署。")
    set_run_font(run, 10.5)
    add_table(doc, "路线优先级", BUSINESS_ROUTE_ROWS[0], BUSINESS_ROUTE_ROWS[1:])
    p = doc.add_paragraph()
    run = p.add_run("建议把业务切成四层产品，而不是只卖统一 API：")
    set_run_font(run, 10.5)
    add_table(doc, "四层产品结构", ["产品层", "目标客群", "模型配置", "商业意义"], PRODUCT_ROWS)
    p = doc.add_paragraph()
    run = p.add_run("定价原则在 2026 年已经比 2025 年更苛刻：公有 API 只能做获客和兼容，真正的利润必须来自专属实例、私有化交付、工作流封装和长期运维。")
    set_run_font(run, 10.5, bold=True, color=PRIMARY)
    add_table(doc, "建议价格带（注意：这里是你对外报价带，不是官方底价）", ["SKU", "建议模型", "输入价格", "输出价格", "说明"], PRICING_ROWS)

    doc.add_heading("六、投产比与 ROI 测算", level=1)
    p = doc.add_paragraph()
    run = p.add_run("以下测算口径基于一个中性 MVP：2 台 8 卡 80GB 级 GPU 服务器，合计 16 GPU，用于起步阶段的共享推理池和少量专属实例。硬件价格与机房成本仍然属于商业推演假设，正式执行前必须以询价单、上电方案和实际带宽/机柜合同复核。")
    set_run_font(run, 10.5)
    add_table(doc, "首期 CAPEX 假设（人民币）", ["项目", "金额", "说明"], CAPEX_ROWS)
    add_table(doc, "月度 OPEX 假设（人民币）", ["项目", "金额", "说明"], OPEX_ROWS)

    p = doc.add_paragraph()
    run = p.add_run("若按 24 个月折旧，则月折旧约 104,167 元。叠加月度 OPEX 105,000 元后，项目在不计完整销售与管理费用时的月度完全成本约为 209,167 元，可近似视为 21 万元/月。")
    set_run_font(run, 10.5)

    doc.add_picture(str(BREAKEVEN_PNG), width=Inches(6.7))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    p = doc.add_paragraph()
    run = p.add_run("解释：如果你的真实变现价格只有 8 元/百万 Token，那么月度需要约 261.5 亿 Token 才能覆盖完全成本；而当前官方 API 已经给出更低的价格锚，所以“用自建集群卖通用 Token”这件事在小规模起步阶段几乎不成立。")
    set_run_font(run, 10.5, bold=True, color=ACCENT)

    doc.add_picture(str(REVENUE_PNG), width=Inches(6.7))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_table(doc, "四种经营模式对比", ["模式", "结构", "关键假设", "月收入", "判断"], ROI_ROWS)
    p = doc.add_paragraph()
    run = p.add_run("静态判断：如果按 Dedicated-first 路线估算，月收入约 45.8 万元，对应静态毛利约 24.9 万元/月；在不计销售与管理费用的理想情形下，首期 250 万 CAPEX 的静态回收期约 10 个月。若园区、电力和机房可以复用 25% 左右 CAPEX，则静态回收期可进一步压到约 7.5 个月。真实经营中应保守看待，把 12 到 18 个月回本视为更稳妥目标。")
    set_run_font(run, 10.5)
    add_table(doc, "敏感性分析", ["关键变量", "保守情形", "中性情形", "乐观情形", "对回本的影响"], SENSITIVITY_ROWS[1:])

    doc.add_heading("七、挖矿/算力企业转型卖 Token 的优势与边界", level=1)
    p = doc.add_paragraph()
    run = p.add_run("要强调一个关键判断：能转型的是“园区、电力、机房、运维能力”，不是 ASIC 矿机本体。矿机不能直接拿来跑大模型，但矿企积累的上电、散热、资产运营和 7x24 值守能力，正是 AI 推理集群初期最难补齐的部分。这个方向在 2026 年已经不只是概念，Bitdeer 公告里披露的 AI Cloud GPU 利用率与 ARR 就说明，基础设施型公司切入 AI 云是能跑通的，但前提是高利用率和长期合约 [S14]。")
    set_run_font(run, 10.5)
    add_table(doc, "转型资产拆解", ["分类", "内容"], MINE_ROWS)
    add_bullets(
        doc,
        [
            "优势 1：如果已有园区和电力，首期 CAPEX 往往可以比从零建园区低 20% 到 35%。",
            "优势 2：能够把“卖机时长”升级为“卖专属实例 + 卖交付 + 卖运维关系”，提升收入质量和合约黏性。",
            "优势 3：对于地方产业园、算力券、绿色电力和政企项目，更容易讲清楚“本地算力、本地数据、本地服务”的故事。",
            "边界：如果没有模型运维、推理调优、路由计费、Agent 工程和客户成功能力，最终仍会回到低价硬件租赁。",
        ],
    )
    p = doc.add_paragraph()
    run = p.add_run("内蒙古场景判断")
    set_run_font(run, 10.5, bold=True, color=PRIMARY)
    add_bullets(doc, INNER_MONGOLIA_POINTS)

    doc.add_heading("八、内蒙古落地版", level=1)
    p = doc.add_paragraph()
    run = p.add_run("如果你明确要把机房落到内蒙古，建议不要把它理解成“全国统一入口机房”，而应理解成“低成本、高负载、可扩容的后端算力底座”。最优结构通常是“东部入口 + 内蒙古主推理池/训练池”的双层架构。")
    set_run_font(run, 10.5)
    add_table(doc, "内蒙古选址与打法", ["维度", "和林格尔", "乌兰察布", "判断"], INNER_MONGOLIA_ROWS[1:])
    add_bullets(
        doc,
        [
            "最推荐的商业形态：专属实例、训练/微调、RAG 后端推理、批处理任务、政企 dedicated pool。",
            "次推荐的商业形态：做全国统一 API 入口，但前提是把接入层放在北京/上海/深圳，而不是全栈都放在内蒙古。",
            "不推荐的误区：只看到低电价，却忽略带宽、售后、人才、值班和销售半径。",
        ],
    )

    doc.add_heading("九、实施步骤与里程碑", level=1)
    p = doc.add_paragraph()
    run = p.add_run("建议按“先验证收入结构，再扩 GPU，再复制节点”的节奏推进。")
    set_run_font(run, 10.5)
    add_table(doc, "五阶段路线图", ["阶段", "周期", "关键动作", "目标"], ROADMAP_ROWS)
    add_bullets(
        doc,
        [
            "Phase 0 的关键不是买卡，而是先把模型口径和客户画像纠正过来，证明客户愿意为专属实例、RAG、工单和 SLA 付费。",
            "Phase 1 的关键是把 Node-1 控制平面做扎实，而不是先把所有资金砸在最贵模型池上。",
            "Phase 2 要开始区分公有入口池、标准专属池和高端 Agent 池，避免所有请求都打到最高成本模型。",
            "Phase 3 之后再谈区域复制、第二园区和更重的大模型 dedicated pool。",
        ],
    )

    doc.add_heading("十、推荐技术架构", level=1)
    p = doc.add_paragraph()
    run = p.add_run("建议延续本仓库既有的 Node-1 到 Node-4 结构，但把它从内部 AI-worker 架构升级为对外服务架构：")
    set_run_font(run, 10.5)
    add_bullets(
        doc,
        [
            "Node-1：API Gateway、统一鉴权、配额、路由、计费、工单、日志与审计。",
            "Node-2：快速模型池，承担高并发低成本调用和公有 API 入口。",
            "Node-3：主力推理池，承担标准企业任务、RAG 主调用与专属实例。",
            "Node-4：Embedding、Rerank、ETL、批任务、内容安全与离线作业。",
            "专属客户区：只给高阶客户开专属实例，部署更重的长上下文/Agent 模型，并隔离资源池。",
        ],
    )
    doc.add_picture(str(ARCH_PNG), width=Inches(6.9))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER

    doc.add_heading("十一、合规与主要风险", level=1)
    add_bullets(
        doc,
        [
            "提供生成式 AI 服务时，需按业务形态评估并落实生成式 AI 服务规则、内容安全、算法/服务备案、日志留存与数据安全要求 [S12]。",
            "如果对外提供经营性互联网信息服务，应同步核查 ICP、经营性许可和结算合规边界 [S13]。",
            "价格战风险：DeepSeek-V4-Flash、MiniMax-M2.7 等低价锚已经很强，因此不建议把低价公有 Token 零售视为主利润池。",
            "模型演进风险：公开模型迭代快，产品必须把“模型替换”做成后台能力，而不是产品承诺的一部分。",
            "利用率风险：GPU 空转会极快吞噬回本周期，所以必须先签客户，再扩集群。",
            "许可与边界风险：不是所有“最新模型”都等于“可合法自建并出售 Token”，所以你在对外方案里必须明确写清“自建模型池”和“外部 API 路由池”分别是什么。",
        ],
    )

    doc.add_heading("十二、最终判断", level=1)
    add_bullets(
        doc,
        [
            "是否可做：可以做，但不建议做成“通用聊天 Token 小商店”，更不建议再按 2025 年模型口径做方案。",
            "最优切入：以 Qwen3.6、DeepSeek-V4 Preview、GLM-5、MiniMax-M2.7、Kimi-K2.5 这些 2026 仍然有效的路线为底座，先做企业专属实例和行业工作流，再开放标准 API。",
            "最适合的转型主体：拥有园区、电力、机房与 7x24 运维能力，同时愿意补齐模型运维和客户成功能力的算力企业。",
            "核心 KPI：签约专属实例数、GPU 利用率、专属收入占比、单位 Token 毛利、SLA 达成率、客户续费率。",
        ],
    )

    doc.add_heading("附录：资料来源", level=1)
    for key, name, url in SOURCES:
        p = doc.add_paragraph(style="List Number")
        run = p.add_run(f"{key}  {name}：{url}")
        set_run_font(run, 9.5)

    doc.save(DOCX_PATH)


def md_table(headers: list[str], rows: list[list[str]]) -> str:
    head = "| " + " | ".join(headers) + " |"
    sep = "| " + " | ".join(["---"] * len(headers)) + " |"
    body = ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join([head, sep, *body])


def build_markdown() -> None:
    monthly_cost = 209167
    p8 = break_even_tokens(monthly_cost, 8) / 100
    p12 = break_even_tokens(monthly_cost, 12) / 100
    p20 = break_even_tokens(monthly_cost, 20) / 100

    lines = [
        f"# {REPORT_TITLE}",
        "",
        f"> {REPORT_SUBTITLE}",
        "",
        f"- 出具日期：{REPORT_DATE.isoformat()}",
        "- 口径说明：本文件按 2026-04-29 官方模型与价格口径编制，重点区分“可自建开权重模型”与“仅 API 公开模型”。",
        "",
        "## 执行摘要",
        "",
        *[f"- {item}" for item in EXEC_SUMMARY],
        "",
        "## 一、研究边界与市场前提",
        "",
        *[f"- {item}" for item in OPPORTUNITY_POINTS],
        "",
        "## 二、截至 2026-04-29 的最新模型格局",
        "",
        md_table(["路线", "截至日期", "可自建", "官方部署线索", "商业角色"], MODEL_ROWS),
        "",
        "## 三、最新官方价格锚与竞争现实",
        "",
        md_table(["官方模型", "页面状态", "输入价", "输出价", "上下文/备注", "经营含义"], API_PRICE_ROWS),
        "",
        *[f"- {item}" for item in WHY_TOKEN_HARD_POINTS],
        "",
        "## 四、市场痛点与客户需求",
        "",
        *[f"- {item}" for item in PAIN_POINTS],
        "",
        md_table(["客户类型", "最关心什么", "适合卖什么"], CUSTOMER_ROWS[1:]),
        "",
        "## 五、商业路线判断与产品定义",
        "",
        md_table(BUSINESS_ROUTE_ROWS[0], BUSINESS_ROUTE_ROWS[1:]),
        "",
        "",
        md_table(["产品层", "目标客群", "模型配置", "商业意义"], PRODUCT_ROWS),
        "",
        "### 建议价格带",
        "",
        md_table(["SKU", "建议模型", "输入价格", "输出价格", "说明"], PRICING_ROWS),
        "",
        "## 六、投产比与 ROI 测算",
        "",
        "### 1. 首期 CAPEX 假设",
        "",
        md_table(["项目", "金额", "说明"], CAPEX_ROWS),
        "",
        "### 2. 月度 OPEX 假设",
        "",
        md_table(["项目", "金额", "说明"], OPEX_ROWS),
        "",
        f"按照 24 个月折旧，月折旧约 104,167 元。加上月 OPEX 105,000 元，完全成本约 209,167 元/月。",
        "",
        "### 3. 纯 Token 模式的盈亏平衡",
        "",
        f"- 若真实变现价格为 8 元/百万 Token，则月度需要约 {p8:.2f} 亿 Token 才能打平。",
        f"- 若真实变现价格为 12 元/百万 Token，则月度需要约 {p12:.2f} 亿 Token 才能打平。",
        f"- 若真实变现价格为 20 元/百万 Token，则月度需要约 {p20:.2f} 亿 Token 才能打平。",
        "",
        "### 4. 四种经营模式对比",
        "",
        md_table(["模式", "结构", "关键假设", "月收入", "判断"], ROI_ROWS),
        "",
        "静态判断：Dedicated-first 比 Hybrid 更适合做第一阶段利润模型；公有 API 入口应弱化为获客与兼容能力，而不是利润中心。",
        "",
        md_table(["关键变量", "保守情形", "中性情形", "乐观情形", "对回本的影响"], SENSITIVITY_ROWS[1:]),
        "",
        "## 七、挖矿/算力企业转型卖 Token 的优势与边界",
        "",
        md_table(["分类", "内容"], MINE_ROWS),
        "",
        "- 能转型的是电力、机房、园区、值班与资产运营能力，而不是 ASIC 矿机本体。",
        "- 若已有园区和电力指标，常见收益是缩短建设周期、降低上电成本，并提升项目融资可讲性。",
        "- 2026 年这一条已不只是概念，Bitdeer 官方更新披露的 AI Cloud GPU 利用率和 ARR 说明基础设施公司切入 AI Cloud 是能跑通的，但靠的是长期合同和高利用率 [S14]。",
        "",
        "### 内蒙古场景判断",
        "",
        *[f"- {item}" for item in INNER_MONGOLIA_POINTS],
        "",
        "## 八、内蒙古落地版",
        "",
        "如果明确把机房放在内蒙古，建议把它定位为“低成本、高负载、可扩容的后端算力底座”，而不是全国统一入口机房。",
        "",
        md_table(["维度", "和林格尔", "乌兰察布", "判断"], INNER_MONGOLIA_ROWS[1:]),
        "",
        "- 最推荐的商业形态：专属实例、训练/微调、RAG 后端推理、批处理任务、政企 dedicated pool。",
        "- 次推荐的商业形态：做全国统一 API 入口，但接入层仍放在北京/上海/深圳，内蒙古承接主推理池。",
        "- 不推荐的误区：只看到低电价，却忽略带宽、售后、人才、值班和销售半径。",
        "",
        "## 九、实施步骤与里程碑",
        "",
        md_table(["阶段", "周期", "关键动作", "目标"], ROADMAP_ROWS),
        "",
        "## 十、推荐技术架构",
        "",
        "- Node-1：统一鉴权、路由、计费、日志与审计。",
        "- Node-2：快速模型池，承接公有 API 入口和高并发低成本请求。",
        "- Node-3：主力推理池，承接标准企业任务和专属实例。",
        "- Node-4：Embedding、Rerank、批处理、内容安全与离线任务。",
        "",
        "## 十一、合规与主要风险",
        "",
        "- 需按实际服务形态落实生成式 AI 服务规则、内容安全、日志留存与数据安全要求 [S12]。",
        "- 对外经营性互联网信息服务需由法务核查 ICP 与相关许可边界 [S13]。",
        "- 在 DeepSeek-V4-Flash、MiniMax-M2.7 等低价锚存在下，裸 Token 毛利会持续收窄，因此一定要保留专属实例和行业方案。",
        "- 不是所有“最新模型”都等于“可合法自建并出售 Token”，方案里必须写清自建模型池和外部 API 路由池边界。",
        "",
        "## 十二、最终判断",
        "",
        "- 是否可做：可以做，但不建议做成低价通用聊天 Token 小商店，更不建议继续按 2025 年模型口径做判断。",
        "- 推荐切入：以 Qwen3.6、DeepSeek-V4 Preview、GLM-5、MiniMax-M2.7、Kimi-K2.5 这些 2026 仍然有效的路线为底座，先签专属实例和行业工作流单，再逐步开放标准 API。",
        "- 推荐主体：已有电力、园区、机房和 7x24 运维能力，同时愿意补齐模型运维和客户成功能力的算力企业。",
        "",
        "## 资料来源",
        "",
        *[f"- {key} {name}：{url}" for key, name, url in SOURCES],
        "",
    ]
    MD_PATH.write_text("\n".join(lines), encoding="utf-8")


@dataclass
class SlideSpec:
    title: str
    bullets: list[str]
    note: str = ""
    image: Path | None = None


def add_textbox(slide, left, top, width, height, text, size=18, color=PPTColor(*TEXT), bold=False):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = text
    r.font.size = PPTPt(size)
    r.font.bold = bold
    r.font.name = "Microsoft YaHei"
    r.font.color.rgb = color
    return box


def add_bullet_box(slide, left, top, width, height, bullets: list[str], title: str | None = None) -> None:
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    if title:
        p0 = tf.paragraphs[0]
        r0 = p0.add_run()
        r0.text = title
        r0.font.size = PPTPt(20)
        r0.font.bold = True
        r0.font.name = "Microsoft YaHei"
        r0.font.color.rgb = PPTColor(*PRIMARY)
    else:
        tf.clear()
    for idx, bullet in enumerate(bullets):
        p = tf.add_paragraph() if idx or title else tf.paragraphs[0]
        p.level = 0
        p.bullet = True
        p.alignment = PP_ALIGN.LEFT
        run = p.add_run()
        run.text = bullet
        run.font.size = PPTPt(18)
        run.font.name = "Microsoft YaHei"
        run.font.color.rgb = PPTColor(*TEXT)


def add_slide_title(slide, title: str, subtitle: str | None = None) -> None:
    add_textbox(slide, PPTInches(0.55), PPTInches(0.35), PPTInches(8.2), PPTInches(0.55), title, size=24, color=PPTColor(*PRIMARY), bold=True)
    if subtitle:
        add_textbox(slide, PPTInches(0.57), PPTInches(0.82), PPTInches(11), PPTInches(0.38), subtitle, size=10.5, color=PPTColor(*MUTED))


def build_pptx() -> None:
    prs = Presentation()
    prs.slide_width = PPTInches(13.333)
    prs.slide_height = PPTInches(7.5)

    # Cover
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    bg = slide.background.fill
    bg.solid()
    bg.fore_color.rgb = PPTColor(*LIGHT_BG)
    shape = slide.shapes.add_shape(1, PPTInches(0.55), PPTInches(0.6), PPTInches(12.2), PPTInches(6.1))
    shape.fill.solid()
    shape.fill.fore_color.rgb = PPTColor(*WHITE)
    shape.line.color.rgb = PPTColor(*LIGHT_BORDER)
    add_textbox(slide, PPTInches(0.95), PPTInches(1.15), PPTInches(8.6), PPTInches(1.0), REPORT_TITLE, size=28, color=PPTColor(*PRIMARY), bold=True)
    add_textbox(slide, PPTInches(0.98), PPTInches(2.12), PPTInches(8.7), PPTInches(0.7), REPORT_SUBTITLE, size=16, color=PPTColor(*TEXT))
    add_textbox(slide, PPTInches(0.98), PPTInches(5.5), PPTInches(5.0), PPTInches(0.4), f"出具日期：{REPORT_DATE.isoformat()}", size=11, color=PPTColor(*MUTED))
    slide.shapes.add_picture(str(ARCH_PNG), PPTInches(8.55), PPTInches(1.2), width=PPTInches(3.2))

    slides = [
        SlideSpec(
            "1. 一页结论",
            [
                "按 2026-04-29 口径，国内自建主线已切到 Qwen3.6、DeepSeek-V4、GLM-5、MiniMax-M2.7、Kimi-K2.5。",
                "纯“卖通用 Token”可行性低，价格战会快速吞掉利润。",
                "推荐模式是“公有 API 入口 + 专属实例 + 行业方案 + 私有化运维”。",
                "最适合切入的主体仍然是有园区、电力、机房和 7x24 运维能力的算力企业。",
            ],
        ),
        SlideSpec(
            "2. 为什么是现在",
            OPPORTUNITY_POINTS,
        ),
        SlideSpec(
            "3. 最新自建模型阵营",
            [
                "Qwen3.6：最新中文基础款与中档主力池 [S1]。",
                "DeepSeek-V4 Preview：2026-04-24 官方发布，适合高端专属实例 [S2]。",
                "GLM-5：适合中文政企、Agent 与代码场景 [S3]。",
                "MiniMax-M2.7 / Kimi-K2.5：适合长上下文与 Agent 增强 [S4][S5]。",
            ],
        ),
        SlideSpec(
            "4. 关键边界：自建与 API 不能混写",
            [
                "Moonshot 平台截至 2026-04-29 的最新 API 模型是 K2.6，但本次核验到的可自建开权重主线仍是 K2.5。",
                "所以方案里必须明确区分“自建模型池”与“外部 API 路由池”。",
                "如果把这两类模型混成一张表，会直接误导 GPU 采购、部署和销售话术。",
            ],
        ),
        SlideSpec(
            "5. 最新官方价格锚",
            [
                "DeepSeek-V4-Flash：$0.14 / $0.28，每 1M Token，几乎把公有零售打成高周转低毛利 [S7]。",
                "Qwen3.6-Plus：￥2 / ￥12（<=256K），是中文市场的重要价格锚 [S8]。",
                "MiniMax-M2.7：$0.3 / $1.2，价格也明显下探 [S9]。",
                "Kimi K2.6：$0.95 / $4.0，更适合做高能力 API 对标 [S6]。",
            ],
        ),
        SlideSpec(
            "6. 客户真正买的不是 Token",
            [
                "客户买的是：数据留在国内、日志可审计、成本可预测、可签 SLA。",
                "客户怕的是模型漂移、限流、计费不透明和工作流链路不完整。",
                "因此产品必须从第一天就把鉴权、配额、日志、工单、账单做进去。",
            ],
        ),
        SlideSpec(
            "7. ROI 关键判断",
            [
                "以 16 GPU MVP 测算，月完全成本约 21 万元。",
                "若真实变现价格仅 8 元/百万 Token，月度需约 261.5 亿 Token 才能打平。",
                "Dedicated-first 模式月收入可到 45.8 万元，静态回本约 10 个月。",
                "若复用园区和电力，将首期 CAPEX 压低 25%，静态回本可压到约 7.5 个月。",
            ],
            image=BREAKEVEN_PNG,
        ),
        SlideSpec(
            "8. 建议收入结构",
            [
                "公有 API 只做入口，不做利润中心。",
                "标准专属实例是最稳的现金流。",
                "行业方案和私有化交付负责抬高客单价与续费率。",
                "高阶模型只卖给愿意签保底月费和长期运维的客户。",
            ],
            image=REVENUE_PNG,
        ),
        SlideSpec(
            "9. 挖矿/算力企业转型的真正优势",
            [
                "可复用的是电力、园区、机房、散热和 7x24 运维，而不是 ASIC 矿机。",
                "如果落到内蒙古，优先看和林格尔/乌兰察布这类现成算力节点，而不是随机找地。",
                "绿电直供、京津冀 5ms 级时延和 400G 全光网络，会让后端推理更有空间 [S16][S18][S19]。",
                "如果补齐模型路由、计费、审计和客户成功能力，能从卖机时长升级为卖服务。",
            ],
        ),
        SlideSpec(
            "10. 内蒙古落地版",
            [
                "最优定位：后端主推理池、训练/批处理池、政企 dedicated pool，不是全国统一入口机房。",
                "和林格尔更适合讲“京津冀后端 + 零碳算力集群”故事；乌兰察布更适合成本型扩容池。",
                "推荐结构：北京/上海/深圳做入口与控制面，内蒙古做主推理池和专属池。",
                "如果只靠低电价、不补带宽、运维和销售，优势也落不成利润。",
            ],
        ),
        SlideSpec(
            "11. 推荐技术架构",
            [
                "Node-1：统一鉴权、计费、限流、审计与 API Gateway。",
                "Node-2：快速模型池，承接公有 API 入口和高并发低成本请求。",
                "Node-3：主力推理池，承接企业常规业务和专属实例。",
                "Node-4：Embedding、Rerank、批处理、内容安全。",
            ],
            image=ARCH_PNG,
        ),
        SlideSpec(
            "12. 实施路线",
            [
                "Phase 0：先纠正模型口径和客户画像，再采购。",
                "Phase 1：16 GPU MVP 跑通 Node-1 控制平面、计费、日志和工单。",
                "Phase 2：推出标准专属实例与知识库/Agent 运维包。",
                "Phase 3：扩容、复制节点、做区域化交付。",
            ],
        ),
        SlideSpec(
            "13. 风险与合规",
            [
                "价格战会长期存在，不能用低价通用 Token 作为主要利润模型。",
                "需按国内业务形态落实生成式 AI 与互联网信息服务相关要求 [S12][S13]。",
                "GPU 利用率不够是最直接的亏损来源，因此必须先签约、后扩卡。",
            ],
        ),
        SlideSpec(
            "14. 最终建议",
            [
                "可做，但必须避开“低价通用聊天 Token 小商店”路线。",
                "先做企业专属实例和行业工作流，再开放标准 API。",
                "把“园区/电力/机房优势”转化为“更低成本的可审计 AI 服务”。",
            ],
        ),
    ]

    for spec in slides:
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = PPTColor(*WHITE)
        add_slide_title(slide, spec.title, "商业策划案摘要版")
        add_bullet_box(slide, PPTInches(0.7), PPTInches(1.35), PPTInches(5.6), PPTInches(5.5), spec.bullets)
        ribbon = slide.shapes.add_shape(1, PPTInches(0.68), PPTInches(6.85), PPTInches(12.0), PPTInches(0.18))
        ribbon.fill.solid()
        ribbon.fill.fore_color.rgb = PPTColor(*PRIMARY)
        ribbon.line.fill.background()
        if spec.image:
            slide.shapes.add_picture(str(spec.image), PPTInches(6.55), PPTInches(1.35), width=PPTInches(5.9))

    prs.save(PPTX_PATH)


def main() -> None:
    monthly_cost = 209167
    draw_bar_chart(
        BREAKEVEN_PNG,
        "完全成本打平所需月度 Token 量",
        ["8 元/百万 Token", "12 元/百万 Token", "20 元/百万 Token"],
        [break_even_tokens(monthly_cost, 8) / 100, break_even_tokens(monthly_cost, 12) / 100, break_even_tokens(monthly_cost, 20) / 100],
        "亿 Token / 月",
        ACCENT,
    )
    draw_bar_chart(
        REVENUE_PNG,
        "推荐收入结构（Hybrid 模式）",
        ["公有 API\n4.8 万", "标准专属\n12 万", "行业运维\n10 万", "私有化摊销\n7 万"],
        [4.8, 12.0, 10.0, 7.0],
        "万元 / 月",
        GREEN,
    )
    draw_architecture(ARCH_PNG)
    build_markdown()
    build_docx()
    build_pptx()
    print(f"Generated:\n- {MD_PATH}\n- {DOCX_PATH}\n- {PPTX_PATH}")


if __name__ == "__main__":
    main()

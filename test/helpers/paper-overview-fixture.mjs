import { emptyDraft } from "../../src/requirements/core.mjs";
import { PLATFORM_CONTRACT_VERSION } from "../../src/architecture/platform-contract.mjs";

export function paperOverviewDraft() {
  const draft = emptyDraft();
  for (const [key, value] of Object.entries({
    name: "论文速览助手", goal: "逐章通俗介绍论文的核心内容", scenario: "阅读论文前了解主要章节和结论",
    inputSource: "用户提供公开论文链接或上传 PDF，两种输入都必须保留",
    task: "读取实际可获得的论文内容，按主要章节顺序总结并注明来源和读取范围",
    deliverable: "中文章节概览与 paper_overview.md", successCriteria: "主要章节按原文顺序覆盖，来源和实际读取范围可追溯，不编造未读取内容",
  })) draft[key] = { value, source: "user" };
  draft.constraints = [{ text: "未成功读取的章节不能概括，读取失败和截断必须明确报告", source: "user" }];
  draft.capabilityDependencies = ["支持公开 HTTP(S) 论文链接", "支持文本 PDF 与扫描版 PDF"];
  draft.usage = { mode: "on_demand", detail: "用户提交论文后按需执行", source: "user" };
  draft.externalAction.source = "user";
  return draft;
}

export function paperOverviewDesign(requirements, { webStatus = "available", pdfOnly = false } = {}) {
  const components = [
    { id: "input_router", purpose: "确认输入并分流链接与 PDF", necessity: "否则无法选取合法读取路径",
      inputs: "论文链接或材料 ID", outputs: "读取路径与来源引用" },
    { id: "link_reader", purpose: "用公共正文工具读取论文链接", necessity: "删除会失去已确认的链接输入范围",
      inputs: "公开 HTTP(S) URL", outputs: "实际正文、来源、截断或失败说明" },
    { id: "pdf_reader", purpose: "按材料 ID 读取 PDF 文本及必要页面图像", necessity: "删除会失去上传 PDF 路径",
      inputs: "本 Agent 的 PDF 材料 ID", outputs: "实际文本和来源页码、图像理解限制" },
    { id: "chapter_summarizer", purpose: "汇总已读取章节并生成通俗概览", necessity: "否则没有逐章可追溯概览",
      inputs: "读取范围内的章节正文与来源", outputs: "按原文顺序的中文概览" },
    { id: "report_writer", purpose: "保存并读回概览文件", necessity: "否则无法核实实际文件交付",
      inputs: "概览与来源说明", outputs: "读回一致的 paper_overview.md" },
  ].filter((component) => !pdfOnly || component.id !== "link_reader");
  const steps = [
    { id: "S1", componentId: "input_router", dependsOn: [], input: "用户输入",
      output: "链接或材料 ID", completion: "无输入则明确索取链接或 PDF，不生成正文或报告文件" },
    ...(!pdfOnly ? [{ id: "S2a", componentId: "link_reader", dependsOn: ["S1"], input: "公开论文 URL",
      output: "正文与真实来源、读取范围", completion: "调用已实现且本轮允许的 web_fetch；每次返回结果判断网址可读性、付费墙、反爬和截断，不把工具可调用当作本站点已读取成功" }] : []),
    { id: "S2b", componentId: "pdf_reader", dependsOn: ["S1"], input: "PDF 材料 ID",
      output: "提取文本或页面图像、来源页码", completion: "读取实际材料；扫描页按模型图像能力理解，不证明独立 OCR 或未读取页面成功" },
    { id: "S3", componentId: "chapter_summarizer", dependsOn: pdfOnly ? ["S2b"] : ["S2a", "S2b"], input: "所选读取路径的结果",
      output: "逐章概览及来源表", completion: "S2a/S2b 是互斥输入分支，仅等待所选分支；两条路径统一核对实际主要章节与原文顺序，不虚构章节，注明实际读取范围和缺失" },
    { id: "S4", componentId: "report_writer", dependsOn: ["S3"], input: "概览与来源表",
      output: "paper_overview.md", completion: "保存并逐字读回；仅成功后报告文件落盘，不将读回当作业务质量验证" },
  ];
  return {
    schemaVersion: 2, profile: "light", rationale: "现有公共正文、材料读取、对话和文件工具足够，不需要独立研发或新连接。",
    instructions: `${pdfOnly ? "仅处理 PDF，不读取论文链接。" : "保留链接与 PDF 两种输入；D2 废弃仅 PDF 的收窄。"}按 S1-S4 读取实际内容，逐章用通俗中文概括，来源和范围可追溯。正文工具就绪不代表具体站点已实测，失败时如实说明并建议用户改传 PDF，不能宣称原链接已完成。`,
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "公开链接或 PDF 材料 ID",
      results: "中文概览与下载文件", persistentData: "仅概览文件，无后台状态" }, connections: [], components, steps,
    capabilities: [
      { id: "conversation", status: "available", reason: "对已读取正文生成通俗概览" },
      ...(!pdfOnly ? [{ id: "web_fetch", status: webStatus, reason: "公共正文工具已实现且本轮允许，不需要专属连接；具体站点由运行期每次调用结果验证" }] : []),
      { id: "read_material", status: "available", reason: "提取已上传 PDF 的实际文本" },
      { id: "read_material_image", status: "available", reason: "读取必要 PDF 页面图像，不宣称所有扫描页理解质量已验证" },
      { id: "write_workspace_file", status: "available", reason: "保存本 Agent 的概览文本" },
      { id: "read_workspace_file", status: "available", reason: "读回核实内容一致" },
    ], state: { mode: "task", reason: "仅单次材料读取与总结上下文" },
    failureHandling: [
      { scenario: "没有链接或 PDF", response: "明确索取输入，不生成章节概览或文件" },
      { scenario: "链接付费墙、登录、反爬或截断", response: "如实标注失败或读取范围，建议改传 PDF，不声称已读取全部论文" },
      { scenario: "扫描 PDF 图像理解不足", response: "列出缺失章节和页码，建议提供文字版，不编造正文" },
      { scenario: "保存或读回失败", response: "报告未交付，保留概览文本供重试" },
    ],
    decisions: [{ id: "D2", problem: "如何同时支持论文链接与 PDF", choice: pdfOnly ? "仅 PDF，但仍声称已满足链接需求" : "公共正文和材料工具分别读取，统一章节概览",
      alternatives: [{ option: "仅 PDF", reason: "会削减已确认链接范围，明确废弃；链接失败后的建议上传不等于已经完成链接输入" },
        { option: "独立爬虫或专属连接", reason: "公共正文读取已实现，不为单个站点未知新增研发依赖" }],
      reason: "平台快照证明工具实现和调用许可；具体站点成功、完整性和概览质量仍要运行期验证",
      evidenceIds: [`neuma-runtime-v${PLATFORM_CONTRACT_VERSION}`], uncertainties: ["具体论文站点的可读性、反爬和截断尚未实测"] }],
    coverage: requirements.map((item) => ({ requirementId: item.id, componentIds: components.map((component) => component.id),
      verification: item.id === "capability_1" ? "核对链接路径调用 web_fetch 的真实结果、来源与读取范围；工具就绪不代表具体网址读取成功"
        : `按实际来源和章节概览核对：${item.text}` })),
    acceptance: [
      { id: "ACC_1", kind: "success", requirementIds: requirements.map((item) => item.id), input: "可提取文本的 PDF",
        expected: "主要章节按原文顺序出现，概览通俗，来源页码与读取范围可追溯，文件读回一致" },
      { id: "ACC_2", kind: "success", requirementIds: ["inputSource", "capability_1", "successCriteria"], input: "公开论文链接",
        expected: "实际调用 web_fetch 读取正文；章节顺序规则与 ACC_1 相同，无虚构章节，记录网址及实际读取范围；未实测时不得声称该网址成功" },
      { id: "ACC_3", kind: "missing_input", requirementIds: ["inputSource"], input: "无论文输入",
        expected: "对话明确索取论文链接或 PDF，无章节要点，不生成或写入 paper_overview.md" },
      { id: "ACC_4", kind: "tool_failure", requirementIds: ["capability_1", "deliverable"], input: "网页失败或正文截断",
        expected: "说明真实失败和读取范围，建议上传 PDF；未读章节不概括，不把替代建议声称链接路径已完成" },
      { id: "ACC_5", kind: "boundary", requirementIds: ["capability_2", "constraint_1"], input: "扫描页无法可靠理解",
        expected: "标注缺失章节和页码，请求文字版，不编造内容" },
    ],
    unknowns: [
      { question: "具体论文站点可读性、反爬与截断未实测", blocking: false,
        resolution: "工具实现和许可已由平台事实确认；运行期每次调用验证站点结果，失败按 ACC_4 如实报告" },
      { question: "扫描 PDF 的图像理解质量未验证", blocking: false, resolution: "首次真实材料按 ACC_5 验证，不足如实列出缺失章节" },
      { question: "主要章节是否含附录是设计假设，待需求方确认", blocking: false, resolution: "先覆盖正文主要章节，确认后调整范围" },
    ],
  };
}

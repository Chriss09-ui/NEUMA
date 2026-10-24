import type { RequirementDraft } from "../../src/contracts/requirements.mjs";
import type { RequirementItem } from "../../src/contracts/architecture.mjs";
import { emptyDraft } from "../../src/requirements/core.mjs";
import { PLATFORM_CONTRACT_VERSION } from "../../src/architecture/platform-contract.mjs";

export function mathDemoDraft() {
  const draft = emptyDraft();
  for (const [key, value] of Object.entries({
    name: "数学演示助手", goal: "把公式或知识点变为可核对的几何讲解",
    scenario: "单用户按需学习导数与切线几何关系", inputSource: "用户在对话中输入公式或知识点",
    task: "解析输入，采用固定几何模板生成讲解、交互 HTML 和静态 SVG",
    deliverable: "下载 calculus_demo_<n>.html、calculus_demo_<n>.svg 与 calculus_demo_<n>_notes.md",
    successCriteria: "文件可读回；公式与输入一致；notes 可核对几何关系和关键点；运行验证据实标注",
  })) draft[key as keyof Pick<RequirementDraft, "name" | "goal" | "scenario" | "inputSource" | "task" | "deliverable" | "successCriteria">] = { value, source: "user" };
  draft.constraints = [
    { text: "不联网；HTML 的 SVG、JS、样式全部内联，不加载外部资源", source: "user" },
    { text: "固定几何模板，不要求真实动态几何引擎或 GeoGebra/Desmos 嵌入", source: "user" },
    { text: "文件名按序号递增，读回核对序号与公式，不谎报保存成功", source: "user" },
  ];
  draft.capabilityDependencies = ["交互预览明确指下载后在用户本地浏览器打开自包含 HTML；不要求 NEUMA 内预览"];
  draft.usage = { mode: "on_demand", detail: "单用户按需调用", source: "user" };
  draft.externalAction.source = "user";
  return draft;
}

export function mathDemoDesign(requirements: RequirementItem[], { includeExcludedCapabilities = false } = {}) {
  const components = [
    ["concept_classifier", "规范化公式并识别知识点", "否则无法选模板", "公式或知识点", "规范化公式与知识点"],
    ["formula_knowledge_base", "提取固定模板的几何关系", "否则讲解与图形没有共同依据", "规范化公式与知识点", "几何关系与关键点坐标"],
    ["explanation_generator", "生成几何讲解", "否则没有可核对的文字说明", "公式与几何关系", "讲解与公式原文"],
    ["demo_html_generator", "生成自包含交互 HTML", "否则缺少下载后的交互演示", "公式、模板与关键点", "内联 SVG、JS、样式的 HTML"],
    ["static_svg_generator", "生成静态 SVG 兜底", "否则本地脚本禁用时没有图形", "同一公式、模板与关键点", "静态 SVG"],
    ["deliverable_writer", "按序号保存并读回产物", "否则不能核实实际文件交付", "HTML、SVG、讲解与自查结论", "三个已读回核对的文件"],
  ].map(([id, purpose, necessity, inputs, outputs]) => ({ id, purpose, necessity, inputs, outputs }));
  const steps = [
    { id: "S1", componentId: "concept_classifier", dependsOn: [], input: "用户输入",
      output: "规范化公式", completion: "歧义先澄清，保留输入与规范化公式对应关系" },
    { id: "S2", componentId: "formula_knowledge_base", dependsOn: ["S1"], input: "规范化公式",
      output: "固定模板与几何要点", completion: "列出关系、参数及关键点坐标；不编造外部知识库连接" },
    { id: "S3", componentId: "explanation_generator", dependsOn: ["S2"], input: "公式与几何要点",
      output: "讲解和 notes 内容", completion: "notes 记录规范化公式原文与关键点，HTML/SVG 公式字符串与原文逐字核对" },
    { id: "S4", componentId: "demo_html_generator", dependsOn: ["S2"], input: "固定模板与公式",
      output: "自包含 HTML", completion: "所有资源内联；禁止运行时构造任何 URL 加载；核对公式字符串；D5 检查 script/link/img/iframe/@import/url()/fetch/XHR 及运行时字符串 URL 模式，notes 记录结论，不能声称浏览器运行通过" },
    { id: "S5", componentId: "static_svg_generator", dependsOn: ["S2"], input: "同一公式与模板",
      output: "静态 SVG", completion: "公式字符串与规范化公式逐字一致，关键点坐标与 S2 一致" },
    { id: "S6", componentId: "deliverable_writer", dependsOn: ["S3", "S4", "S5"], input: "三个产物内容",
      output: "calculus_demo_<n>.html/.svg/_notes.md", completion: "在同 Agent 串行执行下查询最大 n 后递增；notes 记录 n 与公式；逐个读回并核对名称、完整内容与归属，失败不报成功" },
  ];
  const capabilities = [
    { id: "conversation", status: "available", reason: "固定模板内文本生成，不宣称浏览器或动态引擎能力" },
    { id: "list_workspace_files", status: "available", reason: "查询本 Agent 文件序号" },
    { id: "write_workspace_file", status: "available", reason: "保存本 Agent 的 HTML、SVG 和 notes 文本" },
    { id: "read_workspace_file", status: "available", reason: "逐个读回校验保存内容和归属" },
  ];
  if (includeExcludedCapabilities) capabilities.push(
    { id: "dynamic_geometry_rendering", status: "needs_development", reason: "非当前交付阻断；固定模板文件替代，不声称接通动态引擎" },
    { id: "external_visualization_embed", status: "needs_connection", reason: "out_of_scope，刻意不采用，不作为阻断" },
  );
  return {
    schemaVersion: 2, profile: "light", rationale: "最终路径只生成并保存文件，现有文本与文件工具足够。",
    instructions: "按 S1-S6 使用固定模板生成文件。资源全部内联，不联网，不构造运行时 URL。记录规范化公式、几何关系、关键点坐标与自查结论；读回三个文件及归属后才报告保存。文件校验与浏览器运行验证分开表述，不能声称未执行的测试已通过。",
    interaction: { defaultEntry: "conversation", page: false, operations: false,
      inputs: "对话中的公式", results: "下载 HTML、SVG 和 notes", persistentData: "仅产物文件，不维护业务状态" },
    connections: [], components, steps, capabilities, state: { mode: "task", reason: "仅本次生成上下文" },
    failureHandling: [
      { scenario: "缺少输入或公式歧义", response: "请求澄清，暂不生成" },
      { scenario: "知识点没有固定模板", response: "说明范围，提供文本讲解并明确交互文件未生成" },
      { scenario: "HTML 自查或公式核对失败", response: "修正一次后降级静态 SVG 与讲解，说明实际缺少的产物" },
      { scenario: "保存或读回失败", response: "不谎报落盘，说明实际成功文件并保留内容供重试" },
      { scenario: "序号或内容归属冲突", response: "停止交付并重新分配序号，防止误报他人内容" },
      { scenario: "用户浏览器脚本受限", response: "报告本地运行未验证，使用静态 SVG 与 notes 兜底" },
    ],
    decisions: [
      { id: "runtime", problem: "怎样交付交互演示", choice: "light 生成自包含文件",
        alternatives: [{ option: "托管应用", reason: "用户明确只需下载后打开，不要求 NEUMA 内预览" },
          { option: "workflow/custom", reason: "当前不需要持久控制状态或独立操作程序" }],
        reason: "复用现有文本与文件工具；用户端运行仍需验证", evidenceIds: [`neuma-runtime-v${PLATFORM_CONTRACT_VERSION}`], uncertainties: [] },
      { id: "geometry_engine", problem: "是否使用动态几何引擎或外站嵌入", choice: "只使用内联固定模板",
        alternatives: [{ option: "dynamic_geometry_rendering", reason: "needs_development；本次未采用，需要独立研发验收" },
          { option: "external_visualization_embed", reason: "needs_connection；out_of_scope，违反零外链交付边界" }],
        reason: "二者不在最终执行路径，不加入 capabilities", evidenceIds: [], uncertainties: [] },
    ],
    coverage: requirements.map((item) => ({ requirementId: item.id,
      componentIds: components.map((component) => component.id), verification: `核对实际文件及 notes 满足：${item.text}` })),
    acceptance: [
      { id: "AC1", kind: "success", requirementIds: requirements.map((item) => item.id),
        input: "y=x^2，展示 x=1 处切线", expected: "三个文件读回一致；notes 记录 y=x^2、(1,1)、斜率 2 和 n；HTML/SVG 公式字符串逐字一致；保存与运行验证分开报告" },
      { id: "AC2", kind: "missing_input", requirementIds: ["inputSource"], input: "没有公式", expected: "询问公式，不生成文件" },
      { id: "AC3", kind: "boundary", requirementIds: ["externalAction", "constraint_1"],
        input: "嵌入外站 GeoGebra", expected: "拒绝外链，使用内联固定模板；不能将未来引擎说成已就绪" },
      { id: "AC4", kind: "tool_failure", requirementIds: ["deliverable"],
        input: "写入成功但读回不一致", expected: "不报告交付成功，指出归属或内容校验失败并保留重试内容" },
      { id: "AC5", kind: "boundary", requirementIds: ["successCriteria", "capability_1"],
        input: "浏览器禁用脚本", expected: "说明浏览器运行未验证，以 SVG 和 notes 兜底，不把读回校验当运行通过" },
    ],
    unknowns: [
      { question: "用户本地浏览器能否执行 file:// 内联脚本尚未验证", blocking: false,
        resolution: "交付物是文件；引导用户打开验证一次，失败使用 SVG 与讲解" },
      { question: "固定模板的 JS 运行正确性未执行验证", blocking: false,
        resolution: "notes 记录关键点、公式与 D5 结论供人工核对，保持运行未验证状态" },
      { question: "未来是否需要 NEUMA 内预览组件，是设计假设，待需求方确认", blocking: false,
        resolution: "本轮已明确本地文件预览；若新增内置预览要求，另行确认并走研发变更" },
    ],
  };
}

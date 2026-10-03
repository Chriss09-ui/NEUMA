import { ProviderError } from "./core.mjs";
import { setTimeout as delay } from "node:timers/promises";

const REQUIREMENT_SYSTEM_PROMPT = `你是 NEUMA 的 Agent 需求澄清助手。你负责主动引导用户，把模糊愿望逐步整理成可执行、可验证的需求。每次问题要容易回答，避免重复和不必要的盘问；不要以减少轮数为理由跳过关键澄清。不要创建 Agent，也不要设计技术架构。

产品的交付约定：用户在主 Agent 对话中确认需求后，新智能体会有左侧独立入口，并沿用 NEUMA 现有的标准对话框。提示词属于内部配置，需求层不生成运行提示词或设计执行架构。首期交付目标是完成用户已确认的基本任务，后续用户可以回到主 Agent 迭代需求。当前版本仅提供需求说明和交互预览，不能声称已创建可运行的智能体或已完成任务。除非用户明确提出额外形式，不追问是否要另做网页、独立聊天界面或导出提示词；deliverable 仍需澄清具体任务结果的内容、结构和粒度，不把“对话框”当成任务结果。

你会收到当前草稿、当前对话最近的用户原话 userMessages、上一问题和本轮原话。草稿含有系统建议，不是用户原话的替代品。每轮更新同一份草稿：先提取已明确的信息，不重复询问；用户纠正旧要求时，以本轮为准修改原字段，删除失效或矛盾的旧内容。用户通常只说一两句话，也可能不知道自己真正需要什么；不要要求用户一次填完所有字段。

维护的信息及其含义：
- goal：用户真正想解决的问题和最终目的，区别于具体操作。
- scenario：什么真实工作场景会用到这个 Agent，以及何时需要它。
- inputSource：每次工作会收到什么信息、文件、数据或上下文，以及来源。
- task：对输入执行的核心工作；用户已有固定方法、步骤或判断标准时一并记录。
- deliverable：最终结果的内容、结构、粒度及必要呈现形式。
- successCriteria：用户明确提出、或可直接推导的完成标准与信息不足时的处理要求。
- constraints：必须遵守的规则和禁止行为。
- routingCondition：未来主对话遇到哪类用户请求应调用此 Agent；优先从目标、场景和任务推导，不向用户索取技术描述。
- agentType：初步判断 Knowledge Agent、Analysis Agent、Generation Agent、Data Agent、Workflow Agent 中最贴切的一类；不要因类型而擅自添加常见能力。

来源必须区分：user 表示用户明确说过；inferred 表示由当前描述可靠、直接推导；default 只用于低风险的系统暂定值；unknown 表示仍不明确。“可能有用”的能力不能写成已确定需求，只能在确有必要时作为问题中的可选项。不要编造材料、收件人、授权、自动运行时间或成功标准。

关键选择的依据：inputSource、task、deliverable 只有用户原话明确支持、或用户针对上一条具体建议表示接受时，才能标记 source: user。保留用户原话的具体程度，不把“分析一下”“快速读懂”“从零到一”等愿望扩写为用户已经选择的一整套方法、支持的文件格式或报告结构。这些行为选择若由你建议，source 必须为 inferred，且至少一项必须继续澄清。用户说“按建议”“先给我推荐”时，先给一条简短、具体的处理建议让用户选择，不能把尚未展示的方案当成已接受。确认过的选择不重复问。

用户只表达宽泛愿望时，先了解他最困扰的地方或实际使用目的，再讨论处理重点、深度和结果形式。不要一次铺开完整方案要求全盘确认。比如“帮我快速读懂论文”还不足以确定详细分析步骤和八项报告结构；可以先问最难的是术语、方法、论证过程还是抓重点，但不要把这份例子套到其他任务上。输入获取方式不明时，只问谁提供材料或从哪里读取，不罗列未经确认的格式。完成标准没有明确依据时留空，不添加“无需再读原文”等保证。

纠正方式：用户说“不对”“都不对”或说不清时，帮助他定位偏差。给出 2～4 个贴合当前任务的简单选择，允许只回编号或一句短话。若上一问题是纠正方向的编号选项，按对应方向继续一个具体追问。不要只说“请详细描述”“请说哪里要改”，不要让用户重写整份需求。用户拒绝的方案不能继续当作有效要求。

追问规则：每轮找最可能改变 Agent 行为或设计的最大歧义，优先选信息增益高的问题，而非按字段顺序逐项盘问。原则上只问一个核心问题；两个高度相关、可轻松一起回答的点可合并。使用普通人的工作语言，不用 Prompt、RAG、Embedding、Tool Calling、Workflow、Context Window 等技术术语。优先问用户最近真实做过的任务，例如“你现在拿到这类材料后通常怎么处理？”。用户不知道如何选择时，给出 2～4 个易懂选项及简短区别。能可靠推断的内容直接记录；低风险细节不追问；会显著改变行为的歧义必须追问。对不同 agentType 关注相应的关键输入、处理方式和结果，不套同一份问题清单。

停止条件：影响行为的关键选择已有用户依据，输入来源、处理重点和输出可执行，且没有阻塞性的未解决事项时，proposedGap 才能设为 none。字段被填满或被你写得详细，不代表需求问清楚；不设固定追问轮数，信息充分的首次描述可以直接进入确认。低风险名称、场景概括、调用场景可直接推导，不为次要偏好继续追问。最终确认只用于收尾。只有当上一问题是最终确认、且本轮明确表示认可并且没有提出修改时，confirmed 才能为 true；确认本身不触发创建。

只返回一个完整 JSON 对象，字段和类型如下；下面的值是结构示例，不代表实际需求：
{
  "draft": {
    "name": {"value": "", "source": "unknown"},
    "agentType": {"value": "", "source": "unknown"},
    "goal": {"value": "", "source": "unknown"},
    "scenario": {"value": "", "source": "unknown"},
    "inputSource": {"value": "", "source": "unknown"},
    "task": {"value": "", "source": "unknown"},
    "deliverable": {"value": "", "source": "unknown"},
    "successCriteria": {"value": "", "source": "unknown"},
    "routingCondition": {"value": "", "source": "unknown"},
    "constraints": [],
    "usage": {"mode": "on_demand", "detail": "按需调用", "source": "default"},
    "externalAction": {"mode": "none", "operation": "", "target": "", "scope": "", "trigger": "", "source": "default"},
    "capabilityDependencies": [],
    "unresolved": [],
    "conflict": null
  },
  "proposedGap": "none",
  "question": "",
  "confirmed": false
}

格式与边界：
- 每个 source 只能取 user、inferred、default、unknown；不明确信息的 value 留空且 source 为 unknown。constraints 的元素格式为 {"text":"...","source":"user"}。
- agentType 的 value 只能取上述五个英文类型或空字符串；没有足够依据时留空。
- usage.mode 只能取 on_demand、scheduled、event、unclear。未提及自动运行时默认 on_demand，不因“每周周报”等工作频率擅自设定自动执行。
- externalAction.mode 只能取 none、possible、requested。“回复客户”等起草或发送不明时为 possible；明确要求实际发送、修改或删除时为 requested，只填用户明确给出的 operation、target、scope、trigger；未知部分留空。
- 能力尚未接通可记入 capabilityDependencies，不因此改写用户目的。真正互相冲突的有效要求才填 conflict: {"left":"...","right":"..."}，否则为 null。
- unresolved 只列仍影响行为、必须澄清的缺口，使用 goal、scenario、source、task、deliverable、boundary、conflict、external_boundary、trigger；已澄清的每轮删除。可选偏好或用户暂时不要求的额外标准不放入 unresolved。
- proposedGap 只能取 goal、scenario、source、task、deliverable、boundary、conflict、external_boundary、trigger、none。选择最值得追问的一项；question 只写对应的一句自然语言问题，可在一句中给出选项。若没有阻塞缺口，question 为空。
- 每轮返回完整 draft，保留未修改的有效内容。只输出 JSON，不输出 Markdown、解释或代码块。`;

function configValue(env, name) {
  return typeof env[name] === "string" ? env[name].trim() : "";
}

function isMimoEndpoint(url) {
  try {
    return /(^|\.)xiaomimimo\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function getProviderConfig(env = process.env) {
  const chatUrl = configValue(env, "NEUMA_LLM_CHAT_URL");
  const model = configValue(env, "NEUMA_LLM_MODEL");
  const apiKey = configValue(env, "NEUMA_LLM_API_KEY");
  const jevApiKey = configValue(env, "TYPESAFE_API_KEY");
  const jevModel = configValue(env, "TYPESAFE_MODEL") || "jev-1.13.0";
  const configuredTimeout = Number(configValue(env, "NEUMA_LLM_TIMEOUT_MS"));
  const llmTimeoutMs = Number.isInteger(configuredTimeout)
    && configuredTimeout >= 10_000 && configuredTimeout <= 300_000
    ? configuredTimeout : 90_000;
  return {
    chatUrl, model, apiKey, jevApiKey, jevModel, llmTimeoutMs,
    llmConfigured: Boolean(chatUrl && model && apiKey),
    jevConfigured: Boolean(jevApiKey),
  };
}

function retryNote(attempt) {
  return attempt > 1 ? `（已自动重试 ${attempt - 1} 次）` : "";
}

function providerError(message, label, reason, details = {}) {
  return new ProviderError(message, {
    stage: label === "Jev" ? "jev" : "llm", reason, ...details,
  });
}

function requestFailure(error, label, timeoutMs, signal, attempt = 1) {
  const note = retryNote(attempt);
  if (signal.aborted || error?.name === "TimeoutError") {
    return providerError(`${label}响应超过 ${Math.ceil(timeoutMs / 1000)} 秒${note}，本轮输入已保留，请重试`,
      label, "timeout", { attempts: attempt });
  }
  const code = error?.cause?.code ?? error?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return providerError(`${label}的域名暂时无法解析${note}，本轮输入已保留，请稍后重试`,
      label, "dns", { attempts: attempt, causeCode: code });
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return providerError(`${label}连接超时${note}，本轮输入已保留，请重试`,
      label, "connect_timeout", { attempts: attempt, causeCode: code });
  }
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code) || error?.name === "AbortError") {
    return providerError(`${label}连接中断${note}，本轮输入已保留，请重试`,
      label, "connection_reset", { attempts: attempt,
        causeCode: typeof code === "string" ? code : null });
  }
  return providerError(`${label}连接失败${note}，本轮输入已保留，请重试`,
    label, "connection_failed", { attempts: attempt });
}

function retryableTransport(error, signal) {
  if (signal.aborted || error?.name === "TimeoutError") return false;
  if (error?.name === "AbortError") return true;
  const code = error?.cause?.code ?? error?.code;
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EPIPE", "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"].includes(code)
    || (error?.name === "TypeError" && error.message === "fetch failed" && !code);
}

async function pauseBeforeRetry(attempt, signal, timeoutMs, label) {
  try {
    await delay(300 * 3 ** (attempt - 1), undefined, { signal });
  } catch (error) {
    throw requestFailure(error, label, timeoutMs, signal, attempt);
  }
}

async function postJson(url, body, apiKey, timeoutMs, fetchImpl, label, retryTransient = false) {
  const signal = AbortSignal.timeout(timeoutMs);
  const maxAttempts = retryTransient ? 3 : 1;
  const requestBody = JSON.stringify(body);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: requestBody,
        signal,
      });
    } catch (error) {
      if (attempt < maxAttempts && retryableTransport(error, signal)) {
        await pauseBeforeRetry(attempt, signal, timeoutMs, label);
        continue;
      }
      throw requestFailure(error, label, timeoutMs, signal, attempt);
    }
    if (!response.ok) {
      if (attempt < maxAttempts && [408, 429, 500, 502, 503, 504].includes(response.status)
        && !signal.aborted) {
        try { await response.body?.cancel(); } catch { /* Retry even if disposal fails. */ }
        await pauseBeforeRetry(attempt, signal, timeoutMs, label);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw providerError(`${label}鉴权失败（HTTP ${response.status}），请检查 API Key`,
          label, "authentication", { attempts: attempt, httpStatus: response.status });
      }
      if (response.status === 429) {
        throw providerError(`${label}请求过于频繁（HTTP 429）${retryNote(attempt)}，请稍后重试`,
          label, "rate_limit", { attempts: attempt, httpStatus: response.status });
      }
      throw providerError(`${label}返回 HTTP ${response.status}${retryNote(attempt)}，请重试本轮`,
        label, "http_error", { attempts: attempt, httpStatus: response.status });
    }
    let content;
    try {
      content = await response.text();
    } catch (error) {
      if (attempt < maxAttempts && retryableTransport(error, signal)) {
        await pauseBeforeRetry(attempt, signal, timeoutMs, label);
        continue;
      }
      throw requestFailure(error, label, timeoutMs, signal, attempt);
    }
    try {
      return JSON.parse(content);
    } catch {
      throw providerError(`${label}返回了无法读取的 JSON`, label, "invalid_json",
        { attempts: attempt });
    }
  }
}

function parseModelContent(payload) {
  let content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw providerError("兼容模型未返回文字内容", "兼容模型", "missing_content");
  }
  content = content.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw providerError("兼容模型未返回有效的需求 JSON，请重试本轮",
      "兼容模型", "invalid_model_json");
  }
}

function jevQuestions() {
  return {
    goal_clear: {
      type: "noul",
      instructions: "Is the user's underlying problem or desired outcome clear, beyond just naming an agent?",
      criteria: { true: "The purpose is identifiable", false: "Only a vague role name or ambition is given" },
    },
    scenario_clear: {
      type: "noul",
      instructions: "Is the real situation in which the user would call this agent identifiable?",
      criteria: { true: "A concrete use occasion can be identified or directly inferred", false: "The use situation is missing or speculative" },
    },
    source_clear: {
      type: "noul",
      instructions: "Using user_messages, latest_message and last_question as evidence, is it clear which material the agent should use and where it comes from? A detailed model-inferred draft is not user acceptance.",
      criteria: { true: "The necessary input and source are identifiable", false: "The input or its source is missing or ambiguous" },
    },
    task_clear: {
      type: "noul",
      instructions: "Using the user's words and accepted concrete suggestions, is the processing focus and necessary depth clear enough to execute? Broad wishes such as analyze or understand quickly do not validate an inferred multi-step method.",
      criteria: { true: "The main processing job is identifiable", false: "The work is only a vague role label" },
    },
    deliverable_clear: {
      type: "noul",
      instructions: "Does the user's evidence specify or accept the output's purpose, essential content and necessary depth? Do not treat a model-written report structure as an accepted requirement.",
      criteria: { true: "A concrete output is identifiable", false: "The requested output is missing or ambiguous" },
    },
    boundary_clear: {
      type: "noul",
      instructions: "Are all decision-changing quality rules, prohibitions, and information-shortage handling rules clear enough? Answer yes if no extra rules are needed for this task.",
      criteria: { true: "No blocking rule ambiguity remains", false: "An important boundary would change the agent's behavior" },
    },
    has_blocking_conflict: {
      type: "noul",
      instructions: "Do the user's current requirements contain a contradiction that changes what the agent should do?",
      criteria: { true: "Two active requirements cannot both be followed", false: "No blocking contradiction is present" },
    },
    has_external_action: {
      type: "noul",
      instructions: "Does the user want the agent to actually send, modify, delete, or otherwise act outside this chat, or is that boundary ambiguous?",
      criteria: { true: "Actual external action is requested or unclear", false: "The agent only prepares or returns content" },
    },
    external_boundary_clear: {
      type: "noul",
      instructions: "If external action is requested, are its operation, target, scope, and trigger clear? If no external action is requested, answer yes.",
      criteria: { true: "The action boundary is clear or no action is requested", false: "An external action boundary is missing" },
    },
    next_gap: {
      type: "choice",
      instructions: "Which single ambiguity would most change the agent's behavior if clarified? Choose none once purpose, use situation, input, task, output and important boundaries are clear.",
      criteria: {
        goal: "The user's underlying problem or intended outcome is unclear",
        scenario: "The real situation or occasion for using the agent is unclear",
        source: "The required input or its source is unclear",
        task: "The core work or required handling method is unclear",
        deliverable: "The expected output is unclear",
        boundary: "A key success standard or rule would change the agent's behavior",
        conflict: "Two requirements contradict each other",
        external_boundary: "Whether to execute an external action, or its target and scope, is unclear",
        trigger: "A requested automatic time or event trigger is unclear",
        none: "No blocking requirement gap remains",
      },
    },
  };
}

export function makeProviders(config = getProviderConfig(), fetchImpl = fetch) {
  const generateDraft = async ({ message, previousDraft, lastQuestion, userMessages = [] }) => {
    if (!config.llmConfigured) {
      throw providerError("请先配置兼容模型的接口地址、模型名和 API Key",
        "兼容模型", "not_configured");
    }
    const body = {
      model: config.model,
      messages: [
        { role: "system", content: REQUIREMENT_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ currentDraft: previousDraft,
          userMessages, lastQuestion, latestUserMessage: message }) },
      ],
    };
    if (isMimoEndpoint(config.chatUrl)) {
      body.response_format = { type: "json_object" };
      body.thinking = { type: "disabled" };
    }
    const payload = await postJson(config.chatUrl, body,
      config.apiKey, config.llmTimeoutMs ?? 90_000, fetchImpl, "兼容模型",
      isMimoEndpoint(config.chatUrl));
    return parseModelContent(payload);
  };

  const judgeJev = config.jevConfigured ? async ({ message, draft, lastQuestion = "", userMessages = [] }) => {
    const payload = await postJson("https://api.typesafe.ai/v1/systemone", {
      model: config.jevModel,
      state: { latest_message: message, current_draft: draft,
        last_question: lastQuestion, user_messages: userMessages },
      questions: jevQuestions(),
    }, config.jevApiKey, 3_000, fetchImpl, "Jev");
    return payload;
  } : null;

  return { generateDraft, judgeJev };
}

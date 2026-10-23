const ref = (id) => ({ ref: id });
const value = (number) => ({ value: String(number) });
const op = (name, ...args) => ({ op: name, args });
const premise = (id, number, unit, kind, detail) => ({ id, value: String(number), unit,
  source: { kind, reference: kind === "platform" ? "platform.runtime" : "deliverable", detail } });
const expression = (id, unit, formula) => ({ id, unit, formula });

// These are teaching contracts, not NEUMA wire formats or current platform facts.
export const CAPACITY_PROOF_EXAMPLE = {
  output: { json: '{"totalVotes":整数,"labels":[{"label":字符串,"votes":整数},...]}', csvHeader: "label,votes\r\n",
    policy: "最多7个选项，每个名称最多11个UTF-16单元，每项票数0至999；按原顺序保留所有选项，不分组、不增加字段。JSON紧凑且非ASCII按\\uXXXX编码；CSV始终用双引号包名称、内部双引号加倍、每行CRLF。" },
  frames: {
    gateway: { action: "tally", input: null }, task: { scope: "example", action: "tally", input: null },
    worker: { type: "request", id: "demo", input: null },
    jsonWrite: { type: "host_call", operation: "files.write", args: { path: "votes.json", content: null } },
    csvWrite: { type: "host_call", operation: "files.write", args: { path: "votes.csv", content: null } },
    workerReply: { type: "result", id: "demo", result: null },
  },
  result: { json: "votes.json", csv: "votes.csv" },
  hostReply: { type: "host_result", id: "demo", result: { path: "votes.json" } },
  request: {
    issueId: "example_capacity", requirementIds: ["task", "deliverable"],
    premises: [
      premise("rows", 7, "count", "requirement", "教学需求：选项数量上界"),
      premise("label_units", 11, "utf16_units", "requirement", "教学需求：名称UTF-16长度上界"),
      premise("max_votes", 999, "count", "requirement", "教学需求：每项票数上界"),
      premise("input_bytes", 1024, "bytes", "requirement", "教学需求另限同一紧凑ASCII JSON编码的完整输入字节数，不能从输出反推"),
      premise("frame_bound", 128, "bytes", "platform", "教学框架去掉null最多86字节，统一保守取128；这是封装开销上界，不是容量限额"),
      premise("reference_bytes", 39, "bytes", "platform", "教学动作只返回固定文件引用，结果JSON为39字节"),
    ],
    expressions: [
      expression("total_votes_bound", "count", op("multiply", ref("rows"), ref("max_votes"))),
      expression("json_file_bound", "utf16_units", op("add", value(27), value(4), op("multiply", ref("rows"),
        op("add", value(19), value(2), op("multiply", value(6), ref("label_units")), value(3), value(1))))),
      expression("csv_file_chars", "utf16_units", op("add", value(13), op("multiply", ref("rows"), op("add", value(2), op("multiply", value(2), ref("label_units")), value(6))))),
      expression("csv_file_bytes", "bytes", op("add", value(13), op("multiply", ref("rows"), op("add", value(2), op("multiply", value(3), ref("label_units")), value(6))))),
      expression("framed_input_bytes", "bytes", op("add", ref("input_bytes"), ref("frame_bound"))),
      expression("json_write_ipc_bytes", "bytes", op("add", ref("frame_bound"), value(2), op("multiply", value(6), ref("json_file_bound")))),
      expression("csv_write_ipc_bytes", "bytes", op("add", ref("frame_bound"), value(2), op("multiply", value(6), ref("csv_file_chars")))),
      expression("reply_ipc_bytes", "bytes", op("add", ref("reference_bytes"), ref("frame_bound"))),
    ],
  },
  limits: { integer_limit: { value: "9999999", unit: "count" }, gateway_limit: { value: "65536", unit: "bytes" },
    task_limit: { value: "16384", unit: "bytes" }, ipc_limit: { value: "131072", unit: "bytes" },
    result_limit: { value: "32768", unit: "bytes" }, write_limit: { value: "4096", unit: "utf16_units" },
    download_limit: { value: "8192", unit: "bytes" } },
  comparisons: [
    { demand: "total_votes_bound", limit: "integer_limit", unit: "count" },
    { demand: "framed_input_bytes", limit: "gateway_limit", unit: "bytes" },
    { demand: "framed_input_bytes", limit: "task_limit", unit: "bytes" },
    ...["framed_input_bytes", "json_write_ipc_bytes", "csv_write_ipc_bytes", "reply_ipc_bytes"].map((demand) => ({ demand, limit: "ipc_limit", unit: "bytes" })),
    { demand: "reference_bytes", limit: "result_limit", unit: "bytes" },
    ...["json_file_bound", "csv_file_chars"].map((demand) => ({ demand, limit: "write_limit", unit: "utf16_units" })),
    { demand: "json_file_bound", limit: "download_limit", unit: "bytes", reason: "JSON强制ASCII转义，UTF-16长度等于UTF-8字节数" },
    { demand: "csv_file_bytes", limit: "download_limit", unit: "bytes" },
  ],
};

export const REQUIREMENT_STAGE_GUIDANCE = `阶段正反例：可信证据说明所需运行通道已实现、目标受支持，权限和容量有合法路径，仅缺尚未编写的业务代码/边界测试，应保留system/development/open；本交付的环境准备、隔离启动探测、显式开启入口/客户端授权和真实接口检查，保留system/activation/open。都尚未通过，但“本交付未验收”不能反推“平台没有实现通道”。后移仍须独立复核对应可信checks，义务继续进入后续验收。
反之，冻结平台没有所需通道、目标不支持、已观测隔离探测失败且无合法替代，或真实外部依赖/权限未知，应保留system/requirements阻断。目标受支持≠隔离探测通过，通道已实现≠依赖已安装、本交付已运行、业务已正确。
生成进程不监听≠宿主无本机入口；allowNetwork=false约束业务出站，不自动禁止宿主受控且显式开启的本机入站网关，也不允许外部访问。不能把未知能力标verified或后续验收标resolved。
交互可视化：用户要在工作台里看公式或概念的动态图形、滑块、自包含 SVG/HTML，并配文字讲解时，这是现有托管页面或可下载图形文件能完成的交付，不是能力缺口。页面、图形和参数动作进入研发，画面留到真实页面验收；没有动态几何引擎、没有浏览器自动操作，只说明不能调用现成引擎或自动点浏览器，不能拒绝自写图形。此类事项用 system/development 或 activation、open，blocking=false；没有其他真实缺口时 verdict=sufficient。不要新建 requirements 阻断，也不要因此要求用户改成非可视化。只有用户明确要求浏览器自动操作、现成动态几何引擎，或冻结平台 unsupported 列表中的能力时，才保留 system/requirements 阻断。`;

export const CAPACITY_PROOF_GUIDANCE = `容量证明按实际输出投影→字段/行→全文件→每层封装→相同单位限额逐项推导。需求量公式不得掺入限额；min(需求量,限额)或min(两个限额)不证明可容纳。保守上界超限只表示该上界不能证明可行，不证明需求不可行；应收紧有依据的界、找现有合法通道，或说明尚缺证据，不能据此要求用户缩水。
以下是无关业务的完整教学例子，需求/限额/框架/编号全属虚构，不是本工作台的真实接口或当前证据，不能照抄编号/数值。实际calculate只用已有system问题、当前需求编号、核实值和实际封装。例子input嵌入完整对象而非二次编码；各框架JSON去掉null的4字节，固定开销最大86，保守取128。真实可变框架另算。
JSON固定行片段{\"label\":、,\"votes\":、}共19；外围{\"totalVotes\":、,\"labels\":[、]}共27。名称引号2、每UTF-16单元转义最多6个ASCII字符/字节；行内数字最多3位，总数7×999=6993最多4位，每行多算1个逗号。CSV名称引号2、内部双引号加倍最多2倍UTF-16长度；每UTF-16单元UTF-8最多3字节，双引号加倍也仅2字节，故字节界取3倍；非BMP占2单元。header13、逗号1+数字3+CRLF2=6均为ASCII，可按同值字节换算。
输入经网关/任务/worker；文件内容走写入IPC，外层JSON字符串另加引号和最多6倍转义；动作/worker只返回文件引用，写入响应至多65字节元数据。不要把文件错计入引用结果/网关输入，也不能漏掉实际传输的内容。实际若返回内容则重算。
教学数据如下，只有request可作为calculate请求形状，其他字段仅解释：${JSON.stringify(CAPACITY_PROOF_EXAMPLE)}
应算出总数6993；JSON≤668个ASCII字符/字节；CSV≤223个UTF-16单元、300字节；各输入封装≤1152字节，JSON写入IPC≤4138、CSV写入IPC≤1468、回复IPC≤167、动作引用39字节。每项comparisons为独立需求上界<=限额。此例仅教推导，不证明当前可行或已验收；实际仍须平台checks、独立复核及研发/激活测试，原两次只读/六模型回合预算不变。`;

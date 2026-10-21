const freeze = (value) => {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
};

export const VALUE_SCHEMA_RULES = freeze({
  types: ["object", "array", "string", "number", "integer", "boolean", "null"],
  keywords: ["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"],
  commonKeywords: ["type", "description", "enum"],
  applicable: { object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"],
    string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] },
  jsonValue: { schema: "empty_object", nestedOnly: true, depth: 32, nodes: 100000 },
  stringLengthUnit: "unicode_code_points",
  lengthKeywords: ["minLength", "maxLength", "minItems", "maxItems"], numericKeywords: ["minimum", "maximum"],
  intervals: [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"]],
  propertyNamePattern: "^[A-Za-z][A-Za-z0-9_-]{0,79}$", forbiddenPropertyNames: ["__proto__", "prototype", "constructor"],
  limits: { depth: 12, descriptionLength: 2000, properties: 100, enumItems: 100, lengthOrCount: 1000000 },
});

export const VALUE_SCHEMA_DESCRIPTION = `动作输入输出使用现有受限JSON结构规则，不是任意JSON Schema。根结构type必填，仅允许${VALUE_SCHEMA_RULES.types.join("、")}；全部允许关键词只有${VALUE_SCHEMA_RULES.keywords.join("、")}。
各类型除通用${VALUE_SCHEMA_RULES.commonKeywords.join("、")}外，只可使用：${Object.entries(VALUE_SCHEMA_RULES.applicable).map(([type, keys]) => `${type}=${keys.length ? keys.join(",") : "无额外规则"}`).join("；")}。
object必须同时声明properties、required数组、additionalProperties:false；required只列properties内真实字段且不重复；最多${VALUE_SCHEMA_RULES.limits.properties}个属性，名称匹配${VALUE_SCHEMA_RULES.propertyNamePattern}且禁用${VALUE_SCHEMA_RULES.forbiddenPropertyNames.join("、")}。array必须提供合法items子结构。根深度为0，子结构深度最多${VALUE_SCHEMA_RULES.limits.depth}；description最多${VALUE_SCHEMA_RULES.limits.descriptionLength}个UTF-16单位。
长度/条数边界必须为0至${VALUE_SCHEMA_RULES.limits.lengthOrCount}的安全整数；数值边界须为有限数，所有下界不得大于上界。enum为1至${VALUE_SCHEMA_RULES.limits.enumItems}个null/字符串/数值/布尔值且须与type匹配，integer枚举必须为安全整数。不支持未列出的关键词，包括$ref、anyOf、oneOf、allOf、pattern、default、nullable、format、const、uniqueItems。业务唯一性、格式及跨字段校验由程序实现；不放宽已确认业务要求。这些是结构定义规则，不代表调用、文件或任务容量已通过验收。嵌套字段或items另支持严格空对象{}作为有界原生JSON数据；根结构不能空。minLength/maxLength按Unicode码点计数。`;

export const JSON_VALUE_SCHEMA_DESCRIPTION = `嵌套字段或array.items可用严格空对象{}表示保留原形的JSON数据，不能用于动作根结构；其他已有类型仍执行原字段约束。该数据只允许有限数、字符串、布尔、null、普通对象和密集数组，最多32层/100000节点，拒绝访问器、隐藏字段、循环和非JSON值，完整动作仍受1MiB值/128KiB任务/256KiB网关限制。业务需要程序逐条报告坏记录的位置时，可用{type:"object",properties:{records:{}},required:["records"],additionalProperties:false}，或array.items:{}；业务类型/字段/格式由真实程序校验，不将整份JSON先stringify为字符串再嵌套以免扩大转义。容量以映射后真实输入、整个信封和实际序列化字节分别核算，不能把原材料字节当嵌套字符串大小。minLength/maxLength按Unicode码点计数，与标准JSON Schema/MCP一致；文件write的120000和read分页仍按UTF-16单位，不能混用。`;

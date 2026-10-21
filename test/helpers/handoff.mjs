export function handoffChecker(classification = "user_choice") {
  return async (options) => ({ modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {},
    async prompt(text) {
      await options.onModelCall(); const payload = JSON.parse(text);
      await options.customTools[0].execute("necessity", { contextHash: payload.contextHash, decisions: payload.proposal.map((item) => ({
        issueId: item.id, classification, reason: "固定测试的独立必要性决定", references: item.references,
      })) });
    },
  });
}

export function requirementReference(payload, id) {
  const index = payload.requirements.findIndex((item) => item.id === id);
  return { source: "requirements", path: `/${index}/text`, quote: payload.requirements[index].text };
}

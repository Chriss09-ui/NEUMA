import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, reviewSubmissionSchema } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { validDesign } from "./helpers/architecture.mjs";

test("分项保存和组装的真实错误先保存位置与原因，再结束当前模型请求", async (t) => {
  for (const name of ["save_architecture_review_parts", "submit_architecture_review_parts"]) await t.test(name, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "neuma-part-error-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const requirements = [{ id: "R1", text: "完整处理输入" }], design = validDesign(requirements, { schemaVersion: 3 });
    const candidateHash = designHash(design), progress = [], statuses = []; let diagnostic, requests = 0;
    const context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
    const expected = name === "save_architecture_review_parts"
      ? { path: "reviewParts.progressHash", reason: "invalid_reference" }
      : { path: "reviewParts", reason: "missing_coverage" };
    const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "offline-diagnostics" }, cwd, dataDir: join(cwd, "data"),
      sessionFactory: async (options) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
        async prompt(text) {
          requests++; await options.onModelCall(); const payload = JSON.parse(text);
          const tool = options.customTools.find((item) => item.name === name);
          const args = { candidateHash, progressHash: name === "save_architecture_review_parts" ? "b".repeat(64) : payload.reviewParts.progressHash,
            ...(name === "save_architecture_review_parts" ? { checks: [{ id: "verification", passed: true, evidence: "本地测试" }] }
              : { verdict: "pass", summary: "缺项不得通过" }) };
          await assert.rejects(tool.execute("actual-rejection", args), (error) => {
            assert.deepEqual(error.validationIssue, expected); return true;
          });
          throw new Error("offline stop after the actual rejected call");
        } }) });
    await assert.rejects(designer.role({ role: "reviewer", systemPrompt: "本地诊断夹具", submitName: "submit_architecture_review",
      parameters: reviewSubmissionSchema({ evidenceRequired: true }), payload: { candidateHash, design, requirements, requireAcceptanceVerification: true },
      reviewEvidenceContext: context, validate: () => { throw new Error("must not reach formal review"); },
      onProgress: (event) => statuses.push(event), onReviewProgress: (value) => progress.push(structuredClone(value)),
      onDiagnostics: (value) => { diagnostic = value; } }));
    assert.equal(requests, 1); assert.equal(diagnostic.modelCalls, 1);
    assert.deepEqual(diagnostic.lastSubmissionIssue, expected);
    assert.deepEqual(progress.findLast((value) => value.diagnostic)?.diagnostic.lastSubmissionIssue, expected);
    assert.ok(statuses.some((event) => event.validationIssue?.reason === expected.reason));
    assert.equal(progress.some((value) => value.parts || value.review), false);
  });
});

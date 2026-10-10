import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderError } from "../../src/requirements/core.mjs";

export function registerConnectionProbeTests({ label, testConnection, config, apiKey, assertSafe }) {
  const probe = (options) => testConnection(config, {}, options);

  test(`${label} HTTP 错误分类清楚，不读取失败正文并释放响应`, async () => {
    for (const [status, reason] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"],
      [404, "not_found"], [500, "service_unavailable"], [503, "service_unavailable"],
      [400, "http_error"], [302, "redirect_rejected"]]) {
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(apiKey)); },
        cancel() { cancelled = true; },
      });
      const response = new Response(stream, { status, headers: { "x-private-info": apiKey } });
      response.text = async () => { assert.fail("不能读取失败响应正文"); };
      stream.getReader = () => { assert.fail("不能读取失败响应正文流"); };
      await assert.rejects(probe({ fetchImpl: async () => response }), (error) => {
        assertSafe(error, reason);
        assert.equal(error.diagnostic.httpStatus, status);
        return true;
      });
      assert.equal(cancelled, true);
    }
  });

  test(`${label} 无效 JSON、损坏 UTF-8 和空正文给出安全固定提示`, async () => {
    for (const content of [apiKey, `<html>${apiKey}</html>`, "{", new Uint8Array([0xff, 0xfe]), null]) {
      await assert.rejects(probe({ fetchImpl: async () => new Response(content) }),
        (error) => assertSafe(error, "invalid_json"));
    }
  });

  test(`${label} 单块响应超过 64 KiB 时安全拒绝`, async () => {
    await assert.rejects(probe({ fetchImpl: async () => new Response("x".repeat(65_537)) }),
      (error) => assertSafe(error, "response_too_large"));
  });

  test(`${label} 累计响应上限按字节计算，超限立即取消`, async () => {
    let cancelled = false, pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("字".repeat(12_000)));
      },
      cancel() { cancelled = true; },
    });
    await assert.rejects(probe({ fetchImpl: async () => new Response(stream) }),
      (error) => assertSafe(error, "response_too_large"));
    assert.equal(cancelled, true);
    assert.ok(pulls <= 3);
  });

  test(`${label} 网络故障分类清楚，上游异常文字和未知代码不泄漏`, async () => {
    for (const [code, reason] of [["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"],
      ["ETIMEDOUT", "connect_timeout"], ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
      ["UND_ERR_BODY_TIMEOUT", "timeout"], ["UND_ERR_HEADERS_TIMEOUT", "timeout"],
      ["ECONNRESET", "connection_reset"], ["UND_ERR_SOCKET", "connection_reset"],
      [apiKey, "connection_failed"]]) {
      await assert.rejects(probe({ fetchImpl: async () => {
        throw Object.assign(new Error(`${config.chatUrl} ${apiKey}`), { cause: { code } });
      } }), (error) => assertSafe(error, reason));
    }
    await assert.rejects(probe({ fetchImpl: async () => {
      throw new ProviderError(apiKey, { stage: config.chatUrl, reason: config.jevApiKey });
    } }), (error) => assertSafe(error, "connection_failed"));
  });

  test(`${label} 总时限覆盖不响应的 fetch，向底层发出取消`, async () => {
    let requestSignal;
    await assert.rejects(probe({ timeoutMs: 15, fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    } }), (error) => assertSafe(error, "timeout"));
    assert.equal(requestSignal.aborted, true);
  });

  test(`${label} 总时限覆盖停滞的响应正文并取消 reader`, async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(probe({ timeoutMs: 15, fetchImpl: async () => new Response(stream) }),
      (error) => assertSafe(error, "timeout"));
    assert.equal(cancelled, true);
  });

  test(`${label} 提前取消不发请求，外部取消不伪装为超时`, async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(apiKey);
    await assert.rejects(probe({ signal: alreadyCancelled.signal,
      fetchImpl: async () => { assert.fail("取消之后不能请求"); } }), (error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.message.includes(apiKey), false);
      return true;
    });
    const controller = new AbortController();
    let requestSignal;
    const pending = probe({ signal: controller.signal, fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    } });
    controller.abort(new Error(apiKey));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requestSignal.aborted, true);
  });

  test(`${label} 读取正文期间可以外部取消，reader 不继续等待`, async () => {
    const controller = new AbortController();
    let cancelled = false;
    const pending = probe({ signal: controller.signal,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await delay(0);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(cancelled, true);
  });

  test(`${label} 正文读取的连接错误不泄漏上游异常文字`, async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error(apiKey), { code: "ECONNRESET" }));
    } });
    await assert.rejects(probe({ fetchImpl: async () => new Response(stream) }),
      (error) => assertSafe(error, "connection_reset"));
  });
}

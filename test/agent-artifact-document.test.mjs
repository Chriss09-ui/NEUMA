import test from "node:test";
import assert from "node:assert/strict";
import { staticArtifactDocument } from "../public/agent-details-view.js";
import { browserResult, testBrowser } from "./helpers/browser.mjs";

test("真实浏览器清洗产物网页，移除活动内容并保留允许的静态内容", { timeout: 20_000 }, async (t) => {
  const browser = await testBrowser(t);
  if (!browser) return;
  const image = "data:image/png;base64,AQID";
  const content = `<script>throw new Error('must stay inert')</script>
    <meta http-equiv="refresh" content="0;url=https://example.invalid">
    <base href="https://example.invalid"><link rel="stylesheet" href="https://example.invalid/style.css">
    <iframe srcdoc="unsafe"></iframe><object data="unsafe"></object><embed src="unsafe">
    <template><script>unsafe()</script></template><noscript>unsafe</noscript>
    <svg><animate attributeName="href"></animate><set attributeName="href"></set></svg>
    <a id="link" href="https://example.invalid" target="_blank" ping="https://example.invalid" onclick="unsafe()">链接</a>
    <form id="form" action="https://example.invalid"><button id="button" formaction="https://example.invalid" onfocus="unsafe()">提交</button></form>
    <img id="external" src="https://example.invalid/image.png" srcset="https://example.invalid/image.png 2x" onerror="unsafe()">
    <img id="svg" src="data:image/svg+xml;base64,AQID"><img id="data" src="${image}">
    <svg><a id="svg-link" xlink:href="https://example.invalid"><text>SVG</text></a></svg>
    <p id="kept" style="color: purple">中文 &amp; 静态内容</p><style>p { font-weight: bold; }</style>`;
  const facts = await browserResult(t, browser, `
    const sanitize = (${staticArtifactDocument.toString()});
    const output = sanitize(${JSON.stringify(content).replaceAll("<", "\\u003c")});
    const parsed = new DOMParser().parseFromString(output, "text/html");
    return {
      doctype: parsed.doctype.name,
      blockedNodes: [...parsed.body.querySelectorAll("script,meta,base,link,iframe,object,embed,template,noscript,animate,set")].map(node => node.tagName),
      blockedAttributes: [...parsed.body.querySelectorAll("*")].flatMap(node => [...node.attributes].filter(attribute =>
        attribute.name.startsWith("on") || ["href", "xlink:href", "srcset", "action", "formaction", "ping", "target", "srcdoc", "http-equiv"].includes(attribute.name)).map(attribute => attribute.name)),
      externalSource: parsed.getElementById("external").getAttribute("src"),
      svgSource: parsed.getElementById("svg").getAttribute("src"),
      image: parsed.getElementById("data").getAttribute("src"),
      text: parsed.getElementById("kept").textContent,
      style: parsed.getElementById("kept").getAttribute("style"),
      stylesheet: parsed.body.querySelector("style").textContent,
      policy: parsed.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    };
  `);
  assert.equal(facts.doctype, "html");
  assert.deepEqual(facts.blockedNodes, []);
  assert.deepEqual(facts.blockedAttributes, []);
  assert.equal(facts.externalSource, null);
  assert.equal(facts.svgSource, null);
  assert.equal(facts.image, image);
  assert.equal(facts.text, "中文 & 静态内容");
  assert.equal(facts.style, "color: purple");
  assert.equal(facts.stylesheet, "p { font-weight: bold; }");
  assert.equal(facts.policy, "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
});

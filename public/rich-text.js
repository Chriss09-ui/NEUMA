import { Marked } from "marked";
import katex from "katex";

const sources = new WeakMap();
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", hellip: "…", ndash: "–", mdash: "—" };
const decode = (value = "") => value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (raw, entity) => {
  if (!entity.startsWith("#")) return entities[entity] ?? raw;
  const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
});

function closing(source, delimiter, from) {
  for (let at = source.indexOf(delimiter, from); at >= 0; at = source.indexOf(delimiter, at + delimiter.length)) {
    let slashes = 0;
    for (let index = at - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
    if (slashes % 2 === 0) return at;
  }
  return -1;
}

function mathToken(source, block = false) {
  const prefix = block ? source.match(/^ {0,3}(\$\$|\\\[)/)?.[0] : source.match(/^(\$\$|\$|\\\(|\\\[)/)?.[0];
  if (!prefix) return;
  const opener = prefix.trim(), end = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : opener;
  const at = closing(source, end, prefix.length);
  if (at < 0 || at - prefix.length > 8192) {
    if (!block && opener.startsWith("\\")) return { type: "text", raw: source, text: source };
    return;
  }
  const formula = source.slice(prefix.length, at), display = opener === "$$" || opener === "\\[";
  if (!formula.trim() || (!display && (/\n/.test(formula) || opener === "$" && formula.trim() !== formula))) {
    if (!block && opener.startsWith("\\")) return { type: "text", raw: source, text: source };
    return;
  }
  const suffix = source.slice(at + end.length);
  if (block && !/^(?:[ \t]*(?:\n|$))/.test(suffix)) return;
  const extra = block ? suffix.match(/^[ \t]*(?:\n|$)/)[0].length : 0;
  return { type: block ? "displayMath" : "inlineMath", raw: source.slice(0, at + end.length + extra), formula, display };
}

const markdown = new Marked({ gfm: true, breaks: true });
markdown.use({ extensions: [
  { name: "displayMath", level: "block", start: (source) => source.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/),
    tokenizer(source) { return mathToken(source, true); } },
  { name: "inlineMath", level: "inline", start: (source) => source.search(/\$|\\[([]/),
    tokenizer(source) { return mathToken(source); } },
] });

export function safeRichTextLink(value) {
  const href = decode(value).trim();
  if (/[\u0000-\u0020\u007f\\]/.test(href)) return null;
  if (/^#(?:chat(?:\/(?:requirements|projects))?|create|groups|group\/[^/?#]+|agents|agent\/[^/?#]+|projects(?:\/(?:list|assistant|add))?|skills|settings|add|manage(?:\/agents)?)$/.test(href)) return href;
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) && url.hostname || url.protocol === "mailto:" && url.pathname ? href : null;
  } catch { return null; }
}

function simpleFormula(value, mathContext) {
  if (value.length > 160 || !/^[A-Za-z\d+\-*/=^().,\[\] \t]+$/.test(value)) return false;
  const compact = value.replace(/[ \t]/g, ""), equation = compact.match(/^[A-Za-z]\([A-Za-z]\)=([A-Za-z\d+\-*/^().]+)$/);
  if (equation && !/[A-Za-z]{2,}|[A-Za-z]\(/.test(equation[1])) return true;
  return mathContext && (/^[A-Za-z]=[+-]?\d+(?:\.\d+)?$/.test(compact)
    || /^[[(](?:[A-Za-z]|[+-]?\d+(?:\.\d+)?),(?:[A-Za-z]|[+-]?\d+(?:\.\d+)?)[\])]$/.test(compact)
    || /^[A-Za-z\d]+\^[+-]?\d+$/.test(compact));
}

/** Markdown tokens become a small DOM allowlist; model HTML is always literal text. */
export function renderRichText(container, content) {
  const source = typeof content === "string" ? content : String(content ?? "");
  if (sources.get(container) === source) return;
  const document = container.ownerDocument || globalThis.document, fragment = document.createDocumentFragment();
  const mathContext = (text) => /公式|数学|导数|积分|极限|几何|方程|函数|微积分|\b(?:math|formula|derivative|integral|equation)\b/i.test(text || "");
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const literal = (parent, value) => parent.append(document.createTextNode(value ?? ""));
  const math = (parent, formula, original, display = false, block = false) => {
    const node = element(block ? "div" : "span"); node.className = "rich-text-math";
    try {
      katex.render(formula, node, { displayMode: display, output: "htmlAndMathml", trust: false, throwOnError: true,
        strict: "error", maxExpand: 1000, maxSize: 20, macros: {} });
      parent.append(node);
    } catch { literal(parent, original); }
  };
  const inline = (parent, tokens = [], context = false) => {
    for (const token of tokens) {
      switch (token.type) {
        case "inlineMath": math(parent, token.formula, token.raw, token.display); break;
        case "strong": case "em": case "del": {
          const node = element(token.type); inline(node, token.tokens, context); parent.append(node); break;
        }
        case "br": parent.append(element("br")); break;
        case "codespan": {
          const value = decode(token.text);
          if (simpleFormula(value, context)) math(parent, value, value);
          else parent.append(element("code", value));
          break;
        }
        case "link": {
          const href = safeRichTextLink(token.href);
          if (!href) { inline(parent, token.tokens, context); break; }
          const node = element("a"); node.setAttribute("href", href);
          if (/^https?:/i.test(href)) { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
          if (token.title) node.setAttribute("title", decode(token.title));
          inline(node, token.tokens, context); parent.append(node); break;
        }
        case "image": literal(parent, decode(token.text || "图片")); break;
        case "html": literal(parent, token.raw); break;
        case "text": if (token.tokens) inline(parent, token.tokens, context); else literal(parent, decode(token.text)); break;
        default: literal(parent, decode(token.text ?? token.raw));
      }
    }
  };
  const blocks = (parent, tokens = [], tight = false) => {
    for (const token of tokens) {
      switch (token.type) {
        case "space": case "checkbox": break;
        case "displayMath": math(parent, token.formula, token.raw, true, true); break;
        case "heading": {
          const node = element(`h${Math.min(6, token.depth + 1)}`); inline(node, token.tokens, mathContext(token.text)); parent.append(node); break;
        }
        case "paragraph": case "text": {
          const node = tight ? parent : element("p");
          if (token.tokens) inline(node, token.tokens, mathContext(token.text)); else literal(node, decode(token.text));
          if (!tight) parent.append(node);
          break;
        }
        case "code": {
          const node = element("pre"), code = element("code", token.text);
          if (/^[\w+-]+$/.test(token.lang || "")) code.className = `language-${token.lang}`;
          node.append(code); parent.append(node); break;
        }
        case "blockquote": {
          const node = element("blockquote"); blocks(node, token.tokens); parent.append(node); break;
        }
        case "list": {
          const node = element(token.ordered ? "ol" : "ul");
          if (token.ordered && Number.isSafeInteger(token.start) && token.start !== 1) node.setAttribute("start", String(token.start));
          for (const item of token.items) {
            const li = element("li");
            if (item.task) {
              const check = element("span", item.checked ? "☑ " : "☐ "); check.setAttribute("aria-label", item.checked ? "已完成" : "未完成"); li.append(check);
            }
            blocks(li, item.tokens, !token.loose); node.append(li);
          }
          parent.append(node); break;
        }
        case "table": {
          const wrapper = element("div"), table = element("table"), head = element("thead"), body = element("tbody");
          wrapper.className = "rich-text-table";
          const row = (cells, heading) => {
            const tr = element("tr");
            for (const [index, cell] of cells.entries()) {
              const node = element(heading ? "th" : "td");
              if (heading) node.setAttribute("scope", "col");
              const align = cell.align || token.align[index];
              if (["left", "center", "right"].includes(align)) node.style.textAlign = align;
              inline(node, cell.tokens, mathContext(token.header.map((cell) => cell.text).join(" ")) || mathContext(cell.text)); tr.append(node);
            }
            return tr;
          };
          head.append(row(token.header, true)); body.append(...token.rows.map((cells) => row(cells, false)));
          table.append(head, body); wrapper.append(table); parent.append(wrapper); break;
        }
        case "hr": parent.append(element("hr")); break;
        case "html": literal(parent, token.raw); break;
        default: inline(parent, [token]);
      }
    }
  };
  try { blocks(fragment, markdown.lexer(source)); }
  catch { fragment.replaceChildren(document.createTextNode(source)); }
  container.classList.add("rich-text");
  container.replaceChildren(fragment);
  sources.set(container, source);
}

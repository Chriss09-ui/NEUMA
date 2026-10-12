/** Small DOM with real fragment/text semantics; no HTML parsing is permitted. */
export function richTextDocument(t) {
  const document = { compatMode: "CSS1Compat" };
  class Node {
    constructor(tagName, text) { this.tagName = tagName; this.ownerDocument = document; this.nodeValue = text; }
    children = []; attributes = new Map(); className = ""; style = {}; replacements = 0;
    classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
    get textContent() { return this.nodeValue ?? this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.nodeValue = undefined; this.children = value ? [document.createTextNode(String(value))] : []; }
    set innerHTML(_value) { throw new Error("Rich text must not parse HTML strings"); }
    append(...nodes) { for (const node of nodes) this.appendChild(typeof node === "string" ? document.createTextNode(node) : node); }
    appendChild(node) {
      if (node.isFragment) { this.append(...node.children); node.children = []; }
      else { this.children.push(node); node.parentNode = this; }
      return node;
    }
    replaceChildren(...nodes) { this.replacements++; this.nodeValue = undefined; this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
  }
  document.createElement = (tag) => new Node(tag.toUpperCase());
  document.createElementNS = (namespace, tag) => Object.assign(document.createElement(tag), { namespaceURI: namespace });
  document.createTextNode = (text) => new Node(undefined, String(text));
  document.createDocumentFragment = () => Object.assign(new Node(), { isFragment: true });
  const previous = globalThis.document; globalThis.document = document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return document;
}

export const descendants = (node) => [node, ...node.children.flatMap(descendants)];
export const tagged = (node, tag) => descendants(node).filter((child) => child.tagName === tag.toUpperCase());
export const formulas = (node) => tagged(node, "annotation").filter((child) => child.getAttribute("encoding") === "application/x-tex").map((child) => child.textContent);

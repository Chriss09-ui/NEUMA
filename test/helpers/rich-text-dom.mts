import type { TestContext } from "node:test";

/** Small DOM with real fragment/text semantics; no HTML parsing is permitted. */
export function richTextDocument(t: TestContext) {
  const document = {
    compatMode: "CSS1Compat",
    createElement: (tag: string): Node => new Node(tag.toUpperCase()),
    createElementNS: (namespace: string, tag: string): Node => Object.assign(document.createElement(tag), { namespaceURI: namespace }),
    createTextNode: (text: unknown): Node => new Node(undefined, String(text)),
    createDocumentFragment: (): Node => Object.assign(new Node(), { isFragment: true }),
  };
  class Node {
    tagName: string | undefined; nodeValue: string | undefined; ownerDocument: typeof document; parentNode?: Node; isFragment?: boolean; namespaceURI?: string;
    constructor(tagName?: string, text?: string) { this.tagName = tagName; this.ownerDocument = document; this.nodeValue = text; }
    children: Node[] = []; attributes = new Map<string, string>(); className = ""; style: Record<string, string> = {}; dataset: Record<string, string> = {}; replacements = 0;
    scrollHeight = 0; scrollTop = 0; clientHeight = 0;
    classList = {
      add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !this.classList.contains(name);
        if (enabled) this.classList.add(name);
        else this.className = this.className.split(/\s+/).filter((value) => value && value !== name).join(" ");
        return enabled;
      },
    };
    get firstElementChild() { return this.children.find((child) => child.tagName); }
    get textContent(): string { return this.nodeValue ?? this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.nodeValue = undefined; this.children = value ? [document.createTextNode(String(value))] : []; }
    set innerHTML(_value: string) { throw new Error("Rich text must not parse HTML strings"); }
    append(...nodes: (Node | string)[]) { for (const node of nodes) this.appendChild(typeof node === "string" ? document.createTextNode(node) : node); }
    prepend(...nodes: (Node | string)[]) { const previous = this.children; this.children = []; this.append(...nodes); this.children.push(...previous); }
    appendChild(node: Node) {
      if (node.isFragment) { this.append(...node.children); node.children = []; }
      else { this.children.push(node); node.parentNode = this; }
      return node;
    }
    replaceChildren(...nodes: (Node | string)[]) { this.replacements++; this.nodeValue = undefined; this.children = []; this.append(...nodes); }
    setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
  }
  const previous = globalThis.document; Reflect.set(globalThis, "document", document);
  t.after(() => { if (previous === undefined) Reflect.deleteProperty(globalThis, "document"); else globalThis.document = previous; });
  return document;
}

type RichNode = ReturnType<ReturnType<typeof richTextDocument>["createElement"]>;
export const descendants = (node: RichNode): RichNode[] => [node, ...node.children.flatMap(descendants)];
export const tagged = (node: RichNode, tag: string) => descendants(node).filter((child) => child.tagName === tag.toUpperCase());
export const formulas = (node: RichNode) => tagged(node, "annotation").filter((child) => child.getAttribute("encoding") === "application/x-tex").map((child) => child.textContent);

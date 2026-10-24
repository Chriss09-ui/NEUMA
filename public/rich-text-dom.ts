export interface RichTextParent<N> { append(...children: N[]): unknown }
export interface RichTextElement<N> extends RichTextParent<N> {
  ownerDocument?: RichTextDocument<N> | undefined;
  className: string;
  textContent: string | null;
  classList: { add(...names: string[]): unknown };
  style: { textAlign?: string | undefined };
  replaceChildren(...children: N[]): unknown;
  setAttribute(name: string, value: string): unknown;
}
export interface RichTextDocument<N> {
  createElement(tag: string): N & RichTextElement<N>;
  createTextNode(text: string): N;
  createDocumentFragment(): N & RichTextParent<N> & { replaceChildren(...children: N[]): unknown };
}

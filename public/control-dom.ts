/** DOM operations shared by the select and mention controls, including injected documents. */
export interface ControlEvent { type: string; target?: unknown; key?: string | undefined; ctrlKey?: boolean | undefined; metaKey?: boolean | undefined; altKey?: boolean | undefined; shiftKey?: boolean | undefined; inputType?: string | undefined; isComposing?: boolean | undefined; keyCode?: number | undefined; preventDefault(): void; stopPropagation(): void }
type ControlListener = { invoke(event: ControlEvent): unknown }["invoke"];
export interface ControlEvents { addEventListener(type: string, listener: ControlListener, capture?: boolean): unknown }
export interface ControlChild { tagName: string; value?: string | undefined; label?: string | undefined; textContent: string | null; disabled?: boolean | undefined }
export interface ControlElement<E> extends ControlEvents {
  id: string; className: string; textContent: string | null; children: ArrayLike<ControlChild> & Iterable<ControlChild>;
  hidden?: boolean | string | undefined; disabled?: boolean | undefined; type?: string | undefined; tabIndex?: number | undefined;
  value?: string | undefined; label?: string | undefined; title?: string | undefined; inert?: boolean | undefined;
  dataset: Record<string, string | undefined>;
  classList: { toggle(name: string, force?: boolean): unknown; add(...names: string[]): unknown; remove(...names: string[]): unknown; contains(name: string): boolean };
  scrollTop: number; clientHeight: number; offsetTop?: number | undefined; offsetHeight?: number | undefined;
  tagName: string; setAttribute(name: string, value: string): unknown; removeAttribute(name: string): unknown;
  append(...children: E[]): unknown; replaceChildren(...children: E[]): unknown; focus(options?: {preventScroll?:boolean}): unknown;
  contains(target: unknown): boolean; dispatchEvent(event: {type:string}): unknown;
  getBoundingClientRect?(): {top:number;bottom:number;height:number};
}
export interface ControlDocument<E> extends ControlEvents { createElement(tag: string): E; activeElement?: unknown; defaultView?: { Event?: (new(type:string,options?:{bubbles?:boolean})=>{type:string}) | undefined } | null | undefined; documentElement?: {clientHeight:number} | undefined }
export interface ControlWindow extends ControlEvents { innerHeight?: number | undefined; Event?: (new(type:string,options?:{bubbles?:boolean})=>{type:string}) | undefined }

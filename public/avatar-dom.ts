/** The avatar renderer only needs these construction and decoration operations. */
export interface AvatarElement<E> {
  dataset: { [key: string]: string | undefined };
  children: ArrayLike<unknown>;
  className: string;
  textContent: string | null;
  classList: { add(...names: string[]): unknown; toggle(name: string, force?: boolean): unknown };
  ownerDocument?: AvatarDocument<E> | undefined;
  replaceChildren(): unknown;
  append(...children: E[]): unknown;
  setAttribute(name: string, value: string): unknown;
  src?: string | undefined;
  alt?: string | undefined;
  draggable?: boolean | undefined;
}
export interface AvatarDocument<E> { createElement(tag: string): E }
export interface AvatarActivityTarget { dataset: { [key: string]: string | undefined }; children: ArrayLike<unknown> }

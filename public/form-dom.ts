/** Construction port for settings views; controls are created by their tag inside each view. */
export interface FormElement<E> {
  className: string; textContent: string | null; hidden: boolean | string;
  value?: string | undefined; checked?: boolean | undefined; disabled?: boolean | undefined; type?: string | undefined;
  step?: string | undefined; placeholder?: string | undefined; readOnly?: boolean | undefined; autocomplete?: string | undefined; href?:string;target?:string;rel?:string;open?:boolean;rows?:number;name?:string;
  parentElement?: {remove():unknown} | null | undefined;
  append(...children:E[]):unknown; replaceChildren(...children:E[]):unknown; remove():unknown;
  setAttribute(name:string,value:string):unknown;
  addEventListener(type:string,callback: {invoke(event:{type:string;preventDefault():void}):unknown}["invoke"]):unknown;
}
export interface FormDocument<E> { createElement(tag:string):E; hidden?:boolean }

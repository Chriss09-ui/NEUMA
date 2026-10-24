import type { AvatarElement } from "./avatar-dom.js";
import type { FormElement } from "./form-dom.js";
export interface ApplicationDomEvent { type:string; target?:unknown; currentTarget?:unknown; detail?:{agentId?:string|null;active?:boolean}; pointerId?:number;button?:number;clientX?:number;clientY?:number;key?:string;shiftKey?:boolean;preventDefault():void }
type Listener = {invoke(event:ApplicationDomEvent):unknown}["invoke"];
export interface ApplicationEvents {addEventListener(type:string,listener:Listener):unknown}
export interface ApplicationElement<E> extends Omit<FormElement<E>,"addEventListener"|"parentElement">, ApplicationEvents {
  title?:string;src?:string;inert?:boolean;open?:boolean;href?:string;download?:string;
  children:ArrayLike<unknown>;classList:{toggle(name:string,force?:boolean):unknown;add(...names:string[]):unknown};
  dataset:Record<string,string|undefined>;
  style?:{setProperty(name:string,value:string):unknown};
  parentElement: E|null;
  close?():unknown;showModal?():unknown;click():unknown;focus(options?:{preventScroll?:boolean}):unknown;
  getBoundingClientRect?():{x?:number;y?:number;width:number;height:number};
  setPointerCapture?(id:number):unknown;releasePointerCapture?(id:number):unknown;
  contentWindow?:{postMessage(message:unknown,origin:string):unknown}|null;
}
export interface ApplicationDocument<E> extends ApplicationEvents {
  createElement(tag:string):E;getElementById(id:string):E|null;activeElement?:unknown;
  dispatchEvent(event:{type:string}):unknown;
}
export interface ApplicationWindow<E> extends ApplicationEvents {
  location:{origin:string};matchMedia?(query:string):{matches:boolean};
  setTimeout?(callback:()=>void,delay:number):unknown;clearTimeout?(timer:unknown):unknown;
  ResizeObserver?:new(callback:()=>void)=>{observe(element:E):unknown;disconnect():unknown};
  MutationObserver?:new(callback:(records:{type:string;attributeName?:string|null}[])=>void)=>{observe(element:E,options:MutationObserverInit):unknown;disconnect():unknown};
}
export interface DownloadElement<E> {href?:string;download?:string;hidden:boolean|string;append(...children:E[]):unknown;click():unknown;remove():unknown}
export interface DownloadDocument<E> {createElement(tag:string):E;querySelector?(selector:string):{append(...children:E[]):unknown}|null;defaultView?:{URL:Pick<typeof URL,"createObjectURL"|"revokeObjectURL">;setTimeout(callback:()=>void,delay:number):unknown}|null}

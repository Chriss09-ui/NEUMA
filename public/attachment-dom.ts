import type {AttachmentElement as CardElement} from "./chat-ui.js";
export interface AttachmentFile {name:string;size:number;type:string}
export interface AttachmentEvent<F> {type:string;target?:unknown;key?:string;defaultPrevented?:boolean;dataTransfer?:{files:ArrayLike<F>};preventDefault():void}
export interface AttachmentElement<E,F> extends CardElement<E> {
 hidden:boolean|string;disabled?:boolean;open?:boolean;value?:string;files?:ArrayLike<F>|null;tabIndex?:number;alt?:string;src?:string;href?:string;download?:string;
 classList:{add(...names:string[]):unknown;remove(...names:string[]):unknown};
 append(...children:E[]):unknown;replaceChildren(...children:E[]):unknown;remove():unknown;
 contains(target:unknown):boolean;focus(options?:{preventScroll?:boolean}):unknown;click():unknown;
 close?():unknown;showModal?():unknown;
 addEventListener(type:string,listener:{invoke(event:AttachmentEvent<F>):unknown}["invoke"]):unknown;
}
export interface AttachmentDocument<E,F> {getElementById(id:string):E|null;createElement(tag:string):E;activeElement:unknown;addEventListener(type:string,listener:{invoke(event:AttachmentEvent<F>):unknown}["invoke"]):unknown}

// This source is passed by the trusted launcher through --eval, never loaded
// from the generated application's mutable workspace.
export const NODE_ACTION_BOOTSTRAP = `
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const target=process.argv[1], pending=new Map(); let started=false, finished=false, sequence=0;
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const call=(capability,args={})=>new Promise((resolve,reject)=>{
 if(finished){reject(new Error('action_finished'));return}
 const id='call_'+(++sequence);pending.set(id,{resolve,reject});send({type:'call',id,capability,args});
});
const group=(name,methods)=>Object.freeze(Object.fromEntries(methods.map(method=>[method,(args={})=>call(name+'.'+method,args)])));
const ctx=Object.freeze({web:group('web',['search','fetch']),model:group('model',['call']),connection:group('connection',['call','readResult']),
 material:group('material',['list','read','image']),files:group('files',['list','read','write']),state:group('state',['get','set']),
 progress:(value)=>{if(!finished)send({type:'progress',value})}});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',async line=>{
 try{
  const message=JSON.parse(line);
  if(message.type==='reply'){
   const waiter=pending.get(message.id);if(!waiter)throw new Error('invalid_reply');pending.delete(message.id);
   if(message.ok)waiter.resolve(message.value);else waiter.reject(Object.assign(new Error(message.error||'capability_failed'),{reason:message.reason||'capability_failed'}));return;
  }
  if(message.type!=='start'||started||message.protocolVersion!==2)throw new Error('invalid_start');started=true;
  const module=await import(pathToFileURL(target).href);
  if(!module.actions||!Object.hasOwn(module.actions,message.actionId)||typeof module.actions[message.actionId]!=='function')throw new Error('unknown_action');
  const value=await module.actions[message.actionId](message.input,ctx);
  if(pending.size)throw new Error('unfinished_capability_calls');
  finished=true;send({type:'result',ok:true,value:value===undefined?null:value});lines.close();process.stdin.destroy();
 }catch{
  if(!finished){finished=true;send({type:'result',ok:false,error:'action_failed'});lines.close();process.stdin.destroy();process.exitCode=1}
 }
});
`;

export const ACTION_CAPABILITIES = Object.freeze(["web.search", "web.fetch", "model.call", "connection.call", "connection.readResult", "material.list", "material.read", "material.image", "files.list", "files.read", "files.write", "state.get", "state.set"]);

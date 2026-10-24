import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { copyField } from "../src/ide/copy-controls.js";
const source=fs.readFileSync(new URL("../src/web/copyable.js",import.meta.url),"utf8");
function fixture(write?: (value:string)=>Promise<void>,fallback=false,waiting=false){
  let selected=false,focused=false,now=1000,reloads=0;
  const value={value:"/ide auth 123456",focus(){focused=true;},select(){selected=true;},setSelectionRange(start:number,end:number){assert.equal(start,0);assert.equal(end,this.value.length);}};
  const button={disabled:false},status={textContent:""};
  const container={querySelector(selector:string){return ({"[data-copy-value]":value,"[data-copy-button]":button,"[data-copy-status]":status} as Record<string,unknown>)[selector];}};
  const events=new Map<string,Function>();let tick!:()=>void;
  const document={hidden:false,querySelector:()=>waiting?{}:null,addEventListener(name:string,fn:Function){events.set(name,fn);},execCommand(command:string){assert.equal(command,"copy");return fallback;}};
  const context=vm.createContext({window:{setInterval(fn:()=>void,ms:number){assert.equal(ms,3000);tick=fn;},location:{reload(){reloads++;}}},document,navigator:{clipboard:write?{writeText:write}:undefined},Date:{now:()=>now}});
  vm.runInContext(source,context);
  return{api:context.window.gatewayCopy,container,value,button,status,events,document,selection:()=>({selected,focused}),poll:()=>tick(),advance:(ms:number)=>now+=ms,reloads:()=>reloads};
}
test("copy fields are inert, independently labelled and identical across the SSR and management surfaces",()=>{
  const f=fixture(),label='命令 <"test">',value='</textarea><script>alert(1)</script> & `';
  const html=copyField(label,value);assert.equal(f.api.field(label,value),html);
  assert.doesNotMatch(html,/<script>|onclick=|onfocus=/);assert.match(html,/&lt;\/textarea&gt;/);
  assert.match(html,/readonly/);assert.match(html,/type="button"/);assert.match(html,/aria-live="polite"/);
});
test("copy writes the exact standalone value once and reports success only after clipboard completion",async()=>{
  let release!:()=>void,calls=0;
  const f=fixture(async value=>{assert.equal(value,"/ide auth 123456");calls++;await new Promise<void>(r=>release=r);});
  const pending=f.api.copy(f.container);await f.api.copy(f.container);assert.equal(calls,1);assert.equal(f.button.disabled,true);
  assert.notEqual(f.status.textContent,"已复制");release();await pending;assert.equal(f.status.textContent,"已复制");assert.equal(f.button.disabled,false);
});
test("clipboard rejection selects the visible field and uses a verified legacy copy fallback",async()=>{
  const f=fixture(async()=>{throw Error("permission denied");},true);await f.api.copy(f.container);
  assert.deepEqual(f.selection(),{selected:true,focused:true});assert.equal(f.status.textContent,"已复制");
});
test("unavailable clipboard keeps a manual selection and never falsely claims success",async()=>{
  const f=fixture();await f.api.copy(f.container);assert.equal(f.selection().selected,true);
  assert.match(f.status.textContent,/长按复制/);assert.notEqual(f.status.textContent,"已复制");assert.equal(f.button.disabled,false);
});
test("waiting browser pauses polling during copying and in background, then resumes without issuing authorization",()=>{
  const f=fixture(undefined,false,true);f.poll();assert.equal(f.reloads(),1);
  f.events.get("pointerdown")!();f.advance(3000);f.poll();assert.equal(f.reloads(),1);
  f.advance(5001);f.document.hidden=true;f.poll();assert.equal(f.reloads(),1);
  f.document.hidden=false;f.poll();assert.equal(f.reloads(),2);
  const idle=fixture();assert.equal(idle.events.has("pointerdown"),false);
});

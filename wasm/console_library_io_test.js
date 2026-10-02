'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const timers = new Map(); let timerId=0, requests=0, writes=0, readers=[];
const c={console:{log(){},warn(){},error(){}},Promise,Blob,navigator:{},isInGame:false,
  setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},
  FileReader:function(){readers.push(this);this.result='data:image/png;base64,Zml4dHVyZQ==';this.readAsDataURL=function(){};},
  tizen:{filesystem:{openFile(name,mode){if(mode==='w')return {writeData(){writes++;},close(){}};throw Error('cache miss');}}},
  sendMessage(){requests++;return Promise.resolve(new Uint8Array([1,2,3]));}};
let invalidImage=false;
c.Image=function(){Object.defineProperty(this,'src',{set(value){if(!value)return;const bad=invalidImage;invalidImage=false;Promise.resolve().then(()=>{if(bad){if(this.onerror)this.onerror();}else if(this.onload)this.onload();});}});};
c.window=c;vm.createContext(c);
vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js','utf8'),c);
vm.runInContext(fs.readFileSync('wasm/static/js/utils.js','utf8'),c);
const host=new c.NvHTTP('fixture.invalid','fixture');host._baseUrlHttps='https://fixture.invalid';
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
(async()=>{
  let scope=c.createMenuRequestScope();
  await assert.rejects(host.getBoxArt(1,scope,true),/cache miss/);
  assert.strictEqual(requests,0,'offline cache miss must never use network');
  scope.cancel();await assert.rejects(host.getBoxArt(1,scope),/cancelled/);
  assert.strictEqual(requests,0);
  scope=c.createMenuRequestScope();c.isInGame=true;
  await assert.rejects(host.getBoxArt(1,scope),/cancelled/);c.isInGame=false;
  assert.strictEqual(requests,0,'no menu IO during gameplay');
  scope=c.createMenuRequestScope();let resolve;
  c.sendMessage=()=>{requests++;return new Promise(r=>resolve=r);};
  const cancelled=host.getBoxArt(1,scope).catch(e=>e.message);
  await flush();
  scope.cancel();resolve(new Uint8Array([1]));await flush();
  assert.match(await cancelled,/cancelled/);assert.strictEqual(readers.length,0);
  assert.strictEqual(timers.size,0);
  c.sendMessage=()=>{requests++;return Promise.resolve(new Uint8Array([1]));};
  scope=c.createMenuRequestScope();const lateRead=host.getBoxArt(1,scope).catch(e=>e.message);
  await flush();assert.strictEqual(readers.length,1);const lateCallback=readers[0].onloadend;scope.cancel();lateCallback();
  assert.match(await lateRead,/cancelled/);assert.strictEqual(writes,0);
  scope=c.createMenuRequestScope();const success=host.getBoxArt(1,scope);await flush();
  readers[1].onloadend();assert.match(await success,/^data:image/);assert.strictEqual(writes,1);
  c.tizen.filesystem.openFile=()=>({readBlob(){return new Blob(['fixture']);},close(){}});
  scope=c.createMenuRequestScope();const cached=host.getBoxArt(1,scope,true);readers[2].onloadend();
  assert.match(await cached,/^data:image/);assert.strictEqual(requests,3);
  // A valid download is displayed even when the cache cannot be written.
  c.tizen.filesystem.openFile=()=>{throw Error('Storage full');};
  scope=c.createMenuRequestScope();const noStorage=host.getBoxArt(1,scope);await flush();readers[3].onloadend();
  assert.match(await noStorage,/^data:image/);assert.strictEqual(writes,1);
  // Empty and corrupt cached covers are retried, but never downloaded offline.
  c.tizen.filesystem.openFile=(name,mode)=>mode==='w'?{writeData(){writes++;},close(){}}:{readBlob(){return new Blob([]);},close(){}};
  scope=c.createMenuRequestScope();await assert.rejects(host.getBoxArt(1,scope,true),/Empty/);
  const empty=host.getBoxArt(1,scope);await flush();readers[4].onloadend();assert.match(await empty,/^data:image/);
  c.tizen.filesystem.openFile=(name,mode)=>mode==='w'?{writeData(){writes++;},close(){}}:{readBlob(){return new Blob(['corrupt']);},close(){}};
  const corrupt=host.getBoxArt(1,scope);invalidImage=true;readers[5].onloadend();await flush();
  readers[6].onloadend();assert.match(await corrupt,/^data:image/);
  // Forced refresh bypasses a cache, with cached fallback if the network fails.
  let readCount=readers.length;const renewed=host.getBoxArt(1,scope,false,true);await flush();
  readers[readCount].onloadend();assert.match(await renewed,/^data:image/);
  c.sendMessage=()=>{requests++;return Promise.reject(Error('offline'));};
  readCount=readers.length;const fallback=host.getBoxArt(1,scope,false,true);await flush();
  readers[readCount].onloadend();assert.match(await fallback,/^data:image/);
  assert.strictEqual(timers.size,0);
  console.log('console_library_io_test: offline cache, cancellation, no gameplay IO, corrupt/empty cache, write failure, renewal and cached fallback OK');
})().catch(e=>{console.error(e);process.exitCode=1;});

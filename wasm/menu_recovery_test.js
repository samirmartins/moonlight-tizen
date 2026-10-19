'use strict';
// Exercise production menu ordering and bounded cover retention after a stream.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const fixture=require('./library_cover_cache_test.js').fixture;
const flush=async()=>{for(let i=0;i<350;i++)await Promise.resolve();};
(async()=>{
  const ordered=fixture(4);let ready;
  ordered.host.connect=()=>new Promise(resolve=>{ready=resolve;});
  const opening=ordered.c.ConsoleLibrary.open(ordered.host);await flush();
  assert.strictEqual(ordered.calls.length,4,'cold open reads disk without waiting for the PC');
  assert(ordered.calls.every(call=>call.offline===true),'no speculative network cover work');
  ready('fixture.invalid');await opening;await flush();
  assert.strictEqual(ordered.calls.length,4);ordered.suspend();

  // Sixteen 128 KiB covers fit the original 4 MiB bound as binary, but not
  // as UTF-16 base64 strings. Preserve exact bytes and avoid filesystem work.
  const url=id=>'data:image/png;base64,'+Buffer.alloc(128*1024,id).toString('base64');
  const cached=fixture(16,url);await cached.open();const before=cached.calls.length;
  cached.suspend();assert.strictEqual(cached.timers.size,0);
  await cached.open();assert.strictEqual(cached.calls.length,before,'warm return must retain compressed bytes within the same budget');
  for(let id=1;id<=16;id++)assert.strictEqual(cached.card(id).querySelector('img').src,url(id),'cover bytes unchanged');
  const retained=cached.calls.length;cached.revision();cached.node('libraryRefresh').click();await flush();
  assert.strictEqual(cached.calls.length,retained+16,'explicit Refresh still renews every cover');
  cached.suspend();

  const large=fixture(6,id=>'data:image/png;base64,'+Buffer.alloc(1024*1024,id).toString('base64'));
  await large.open();const previous=large.calls.length;large.suspend();await large.open();
  assert(large.calls.length>previous,'binary retention remains bounded by 4 MiB');large.suspend();
  const oversized=fixture(1,()=> 'data:image/png;base64,'+Buffer.alloc(4*1024*1024+1,3).toString('base64'));
  await oversized.open();const old=oversized.calls.length;oversized.suspend();await oversized.open();
  assert(oversized.calls.length>old,'oversized binary is displayed, never retained');oversized.suspend();

  // A menu query failure does not change pairing or native session ownership;
  // recovery succeeds without restarting the PC or inventing a new pairing.
  const recovery=fixture(4);recovery.host.ppkstr='fixture-pin';recovery.host.paired=true;
  recovery.host._authenticatedOnline=true;await recovery.open();recovery.suspend();
  recovery.host.connect=()=>Promise.reject(Error('Transient fixture failure'));
  await recovery.open();assert.strictEqual(recovery.host.paired,true);
  assert.strictEqual(recovery.host.ppkstr,'fixture-pin');
  recovery.host.connect=function(){this.online=true;this._authenticatedOnline=true;return Promise.resolve('fixture.invalid');};
  recovery.node('libraryRefresh').click();await flush();
  assert.match(recovery.node('libraryStatus').textContent,/PC online/);
  assert.strictEqual(recovery.node('libraryPlay').textContent,'Play');recovery.suspend();
  const cp=require('child_process'),file='wasm/platform/console-library.js';
  const source=fs.readFileSync(file,'utf8'),oldSource=cp.execFileSync('git',['show','v3.4.4:'+file],{encoding:'utf8'});
  const normalize=require('./menu-recovery-scope.cjs').normalize;
  assert.strictEqual(normalize(file,source),oldSource,'only tested cache and PC-first changes against released library');
  for(const [old,next] of [['4 * 1024 * 1024','8 * 1024 * 1024'],['cacheOnly === true || !hostReady()','false'],
    ['return host.loadLibrary(current','return host.loadLibrary(null'],['if (!host.paired)','if (host.paired)']]) {
    assert(source.includes(old));assert.notStrictEqual(normalize(file,source.replace(old,next)),oldSource,'unknown neighboring changes are rejected');
  }
  console.log('menu_recovery_test: disk-before-PC/network-after-PC ordering, exact binary retention, count/byte bounds, forced renewal and transient recovery OK');
})().catch(error=>{console.error(error);process.exitCode=1;});

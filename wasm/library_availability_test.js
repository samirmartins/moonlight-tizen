'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const {fixture}=require('./library_cover_cache_test.js');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
(async()=>{
  // Disk cache must be visible before the first server response, including a
  // process restart. No speculative network artwork may precede discovery.
  let f=fixture(), gate=deferred(), connections=0, scopes=[];
  f.host.connect=scope=>{connections++;scopes.push(scope);return gate.promise;};
  let opening=f.c.ConsoleLibrary.open(f.host);await f.flush();
  assert.strictEqual(connections,1);assert.strictEqual(scopes[0].useAppListProbe,undefined);
  assert.strictEqual(f.calls.length,4);assert(f.calls.every(call=>call.offline===true));
  for(const app of f.apps)assert(f.card(app.id).querySelector('img').src.startsWith('data:image/'));
  assert.match(f.node('libraryStatus').textContent,/Checking/);
  assert(!f.node('libraryPlay').disabled,'checking does not block manual Play/Wake');
  assert(!f.node('libraryRefresh').disabled,'document reload is available even during discovery');
  gate.resolve('fixture.invalid');await opening;await f.flush();
  assert.strictEqual(f.calls.filter(call=>call.force).length,0);
  assert.match(f.node('libraryStatus').textContent,/PC online/);assert(!f.node('libraryRefresh').disabled);
  f.suspend();assert.strictEqual(f.timers.size,0);
  // A missing discovery callback is bounded independently of artwork.
  f=fixture();f.host.connect=()=>new Promise(()=>{});
  opening=f.c.ConsoleLibrary.open(f.host);await f.flush();
  const timeout=[...f.timers].find(([,t])=>t.ms===26000);assert(timeout);
  f.timers.delete(timeout[0]);timeout[1].fn();await opening;
  assert.strictEqual(f.node('libraryStatus').textContent,'PC unavailable. Turn it on or use Wake PC, then reload VibeLight.');
  assert(!f.node('libraryRefresh').disabled);f.suspend();assert.strictEqual(f.timers.size,0);
  // Slow disk decoding never schedules another check in the old document.
  f=fixture();f.host.delay=[];f.host.connect=()=>Promise.reject(Error('timeout'));
  opening=f.c.ConsoleLibrary.open(f.host);await f.flush();
  assert(![...f.timers.values()].some(t=>t.ms===2000));
  for(let i=0;i<2;i++){f.host.delay.splice(0).forEach(resolve=>resolve('data:image/png;base64,fixture'));await f.flush();}
  await opening;assert.strictEqual(f.timers.size,0);f.suspend();
  // No response is not proof of power-off. Recovery is an explicit visit/reload.
  f=fixture();scopes=[];connections=0;f.host.online=false;
  f.host.connect=scope=>{scopes.push(scope);connections++;return connections===1?Promise.reject(Error('quick timeout')):Promise.resolve('fixture.invalid');};
  await f.open();assert.match(f.node('libraryStatus').textContent,/PC unavailable/);
  assert(!/offline|powered off/i.test(f.node('libraryStatus').textContent));
  assert.strictEqual(f.timers.size,0);
  f.host.online=true;await f.open();
  assert.strictEqual(scopes[1].useAppListProbe,undefined);assert.match(f.node('libraryStatus').textContent,/PC online/);
  f.suspend();assert.strictEqual(f.timers.size,0);
  // App-list failure after authenticated contact never becomes PC offline.
  f=fixture();f.host.getAppListWithCacheFlush=()=>Promise.reject(Error('slow app list'));
  await f.open();assert.strictEqual(f.host.online,true);assert.strictEqual(f.node('libraryStatus').textContent,'Games unavailable · Try Reload VibeLight.');
  f.suspend();
  f=fixture();f.host.paired=false;await f.open();
  assert.strictEqual(f.node('libraryStatus').textContent,'Pairing required · Open PCs.');
  f.suspend();assert.strictEqual(f.timers.size,0);
  // Delayed discovery cannot restart I/O or repaint after entering gameplay.
  f=fixture();gate=deferred();let lateScope;
  f.host.connect=scope=>{lateScope=scope;return gate.promise;};
  opening=f.c.ConsoleLibrary.open(f.host);await f.flush();const count=f.calls.length;
  f.suspend();assert(!lateScope.active);gate.resolve('fixture.invalid');await opening;await f.flush();
  assert.strictEqual(f.calls.length,count);assert.strictEqual(f.node('game-grid').children.length,0);assert.strictEqual(f.timers.size,0);
  // Real NvHTTP requests retain the pin and identity parser. Try LAN hostname
  // before WAN; only the quick menu pass uses the shorter deadline.
  const timers=new Map();let serial=0,requests=[];
  const c={Promise,isInGame:false,console:{log(){},error(){},warn(){}},navigator:{},
    setTimeout(fn,ms){timers.set(++serial,{fn,ms});return serial;},clearTimeout(id){timers.delete(id);}};
  c.window=c;vm.createContext(c);
  vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js','utf8'),c);
  vm.runInContext(fs.readFileSync('wasm/static/js/utils.js','utf8'),c);
  const host=new c.NvHTTP('old.fixture.invalid','fixture');host.ppkstr='synthetic pin';host.hostname='new-fixture';
  host.serverUid='fixture';host.localAddress='lan.fixture.invalid';host.externalIP='wan.fixture.invalid';host.httpsPort=47984;host.httpPort=47989;
  c.NvHTTP.prototype._parseServerInfo=function(xml,secure){assert.strictEqual(secure,true);if(xml!=='verified fixture')return false;this._authenticatedOnline=true;return true;};
  c.sendMessage=(name,args)=>{requests.push({name,args});return args[0].includes('new-fixture.local')?Promise.resolve('verified fixture'):Promise.reject(Error('unavailable'));};
  let scope=c.createMenuRequestScope();scope.serverInfoTimeoutMs=1500;
  assert.strictEqual(await host.connect(scope),'new-fixture.local');
  assert.strictEqual(requests.length,3);assert(requests.every(r=>r.name==='openUrlScoped'&&r.args[0].startsWith('https://')&&r.args[1]===host.ppkstr&&r.args[3]===4500));
  assert(!requests.some(r=>r.args[0].includes('wan.fixture.invalid')));assert.strictEqual(timers.size,0);
  requests=[];scope=c.createMenuRequestScope();await host.connect(scope);
  assert(requests.every(r=>r.args[3]===4500));assert.strictEqual(timers.size,0);
  c.sendMessage=()=>Promise.resolve('wrong server');
  await assert.rejects(host.connect(c.createMenuRequestScope()));assert.strictEqual(host._authenticatedOnline,false);
  assert.strictEqual(timers.size,0);
  for(const file of ['wasm/platform/console-library.js','wasm/static/js/utils.js']) {
    const normalize=require('./library-availability-scope.cjs').normalize;
    assert.strictEqual(normalize(file,fs.readFileSync(file,'utf8')),cp.execFileSync('git',['show','v3.4.5:'+file],{encoding:'utf8'}),'availability-only changes: '+file);
  }
  console.log('library_availability_test: cache before one-shot check, bounded probes, no false power claim, slow list, explicit recovery, pinned fallback and cancellation OK');
})().catch(error=>{console.error(error);process.exitCode=1;});

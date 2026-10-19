'use strict';
// Real menu, NvHTTP, XML parsers and cancellation; synthetic transport/clock.
const assert=require('assert'),fs=require('fs'),cp=require('child_process');
const {fixture}=require('./library_cover_cache_test.js');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function tick(f,ms){const entry=[...f.timers].find(([,t])=>t.ms===ms);assert(entry,'missing timer '+ms);f.timers.delete(entry[0]);entry[1].fn();await f.flush();}
function query(xml,tag='root'){
 const apps=[...xml.matchAll(/<App>([\s\S]*?)<\/App>/g)];
 const root={getElementsByTagName(n){return n==='App'?apps.map(m=>({getElementsByTagName(t){const v=m[1].match(new RegExp('<'+t+'>([^<]*)</'+t+'>'));return v?[{textContent:v[1]}]:[];}})):[];}};
 return {length:/^<root\b[^>]*>[\s\S]*<\/root>$/.test(xml)?1:0,0:root,find(t){return query(xml,t);},each(){},
  attr(){const m=xml.match(/status_code="(\d+)"/);return m&&m[1];},text(){const m=xml.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>'));return m?m[1]:'';}};
}
const info=uid=>'<root status_code="200"><uniqueid>'+uid+'</uniqueid><hostname>fixture</hostname><PairStatus>1</PairStatus><appversion>7.1</appversion><state>SUNSHINE_SERVER_FREE</state></root>';
const list=title=>'<root status_code="200"><App><ID>1</ID><AppTitle>'+title+'</AppTitle></App></root>';
function setup(){
 const f=fixture(1),c=f.c,h=f.host;
 delete h.connect;delete h.getAppListWithCacheFlush;Object.setPrototypeOf(h,c.NvHTTP.prototype);
 Object.assign(h,{address:'192.0.2.20',localAddress:'192.0.2.20',userEnteredAddress:'',externalIP:'',hostname:'fixture',
  httpPort:47989,httpsPort:47984,ppkstr:'synthetic pin',clientUid:'fixture',paired:true,online:false,_authenticatedOnline:false,macAddress:'12:34:56:78:9A:BC'});
 const dom=c.$;c.$=xml=>typeof xml==='string'&&xml.startsWith('<')?query(xml):dom(xml);c.$.parseXML=xml=>xml;
 c.Module={discoverHosts(){}};c.webapis={network:{getIp:()=> '192.0.2.12',getSubnetMask:()=> '255.255.255.0'}};
 f.phase='off';f.requests=[];f.wakes=0;f.launches=[];f.cancels=0;f.now=0;f.closed=0;f.audio=0;
 c.performance={now:()=>f.now};c.prepareStreamAudio=()=>f.audio++;c.stopAudioScheduler=()=>f.closed++;
 h.sendWOL=()=>{f.wakes++;return Promise.resolve('sent');};
 c.startGame=(...args)=>{f.launches.push(args);c.isInGame=true;c.ConsoleLibrary.suspend();};
 c.sendMessage=(method,args)=>{
  f.requests.push({method,args});
  if(method==='discoverHosts')return Promise.resolve(JSON.stringify({cursor:32,addresses:f.phase==='off'?[]:['192.0.2.30']}));
  assert.strictEqual(method,'openUrlScoped');assert.strictEqual(args[1],h.ppkstr);assert(args[0].startsWith('https:'));
  const url=new URL(args[0]);if(f.phase==='off'||url.hostname!=='192.0.2.30')return Promise.reject(Error('old address unavailable'));
  if(url.pathname==='/serverinfo')return Promise.resolve(info(f.phase==='foreign'?'other-pc':'fixture-pc'));
  assert.strictEqual(url.pathname,'/applist');
  if(f.gate){const p=f.gate.promise;p.cancel=()=>f.cancels++;return p;}
  return Promise.resolve(f.phase==='bad-list'?'<root status_code="401"></root>':f.phase==='empty'?'<root status_code="200"></root>':list('Fresh game'));
 };
 return f;
}
(async()=>{
 // Negative control: the previous implementation really held retries behind
 // pending cover decoding. Do not merely test that a new method was added.
 const before=cp.execFileSync('git',['show','04f56c5:wasm/platform/console-library.js'],{encoding:'utf8'});
 const old=fixture(2,null,{source:before});old.host.delay=[];old.host.connect=()=>Promise.reject(Error('offline'));
 old.c.ConsoleLibrary.open(old.host);await old.flush();assert(![...old.timers.values()].some(t=>t.ms===2000));old.suspend();
 let f=fixture(2);f.host.delay=[];f.host.connect=()=>Promise.reject(Error('offline'));
 await f.open();assert([...f.timers.values()].some(t=>t.ms===2000));assert(!f.node('libraryRefresh').disabled);
 f.host.connect=function(){this.online=true;return Promise.resolve('fixture.invalid');};
 await tick(f,2000);assert.match(f.node('libraryStatus').textContent,/PC online/);
 assert(!f.node('libraryRefresh').disabled,'successful network readiness also completes before covers');
 f.host.getAppListWithCacheFlush=()=>Promise.resolve([{id:2,title:'Renamed while reading covers'}]);
 f.node('libraryRefresh').click();await f.flush();
 assert.strictEqual(f.node('game-grid').children.length,1);assert.strictEqual(f.card(2).querySelector('.console-card-title').textContent,'Renamed while reading covers');
 f.host.delay.splice(0).forEach(r=>r('stale artwork'));await f.flush();
 assert.notStrictEqual(f.card(2).querySelector('img').src,'stale artwork','pending old-title cover cannot attach to renamed app');
 const traffic=f.calls.length;f.suspend();f.host.delay.splice(0).forEach(r=>r('late cover'));await f.flush();
 assert.strictEqual(f.calls.length,traffic);assert.strictEqual(f.timers.size,0);
 // A superseding connection retires an old list, not merely old serverinfo.
 for(const replacement of ['library','connection']){
  f=setup();f.phase='ready';f.gate=deferred();
  const pending=f.host.loadLibrary(f.c.createMenuRequestScope()).then(()=>false,()=>true);await f.flush();
  assert(!Object.keys(f.host).includes('_libraryAttempt'));assert(!JSON.stringify(f.host).includes('_libraryAttempt'));
  const gate=f.gate;delete f.gate;
  if(replacement==='library')await f.host.loadLibrary(f.c.createMenuRequestScope());
  else await f.host.connect(f.c.createMenuRequestScope());
  assert(await pending);assert(f.cancels>0);const cache=JSON.stringify(f.host._memCachedApplist);
  gate.resolve(list('Stale game'));await f.flush();assert.strictEqual(JSON.stringify(f.host._memCachedApplist),cache);
  assert.strictEqual(f.timers.size,0);assert.strictEqual(f.host._libraryAttempt,null);
  assert(!JSON.stringify(f.host).includes('_libraryAttempt'));
 }
 // A cancelled old readiness request must not mark a new authenticated
 // connection offline, even if its rejection reaches the UI after success.
 f=setup();f.phase='ready';f.host.address='192.0.2.30';
 const send=f.c.sendMessage,infoGate=deferred();
 f.c.sendMessage=()=>infoGate.promise;
 const opening=f.c.ConsoleLibrary.open(f.host);await f.flush();
 f.c.sendMessage=send;await f.host.connect(f.c.createMenuRequestScope());await opening;await f.flush();
 assert(f.host.online&&f.host._authenticatedOnline,'cancelled old request overwrote verified online status');
 assert(!f.node('libraryStatus').textContent.includes('not responding'),'cancelled request displayed a false failed probe');
 infoGate.resolve(info('fixture-pc'));f.suspend();await f.flush();assert.strictEqual(f.timers.size,0);
 // Full off -> changed address -> wrong UUID -> valid server/bad list -> ready
 // path uses production discovery and parsers; only one WoL and Play survive.
 f=setup();await f.open();f.host.delay=[];f.c.ConsoleLibrary.invalidateCovers(f.host);
 f.node('libraryPlay').click();f.node('libraryPlay').click();await f.flush();assert.strictEqual(f.wakes,1);
 f.phase='foreign';await tick(f,2000);assert(!f.launches.length);assert(!f.host._authenticatedOnline);
 f.phase='bad-list';await tick(f,2000);assert(!f.launches.length);assert(f.host.online&&f.host._authenticatedOnline);
 assert.strictEqual(f.host._memCachedApplist[0].title,'Game 001');
 f.phase='ready';await tick(f,2000);assert.strictEqual(f.launches.length,1);assert.strictEqual(f.host.address,'192.0.2.30');
 assert.strictEqual(f.launches[0][1],1);assert.strictEqual(f.launches[0][2],true);assert.strictEqual(f.launches[0].length,3);
 assert.strictEqual(f.wakes,1);assert.strictEqual(f.audio,1);assert.strictEqual(f.closed,0);assert.strictEqual(f.timers.size,0);
 const requests=f.requests.length;f.host.delay.splice(0).forEach(r=>r('late cover'));await f.flush();assert.strictEqual(f.requests.length,requests);
 // Wake's absolute monotonic deadline holds even if its timeout task has not
 // run yet. No late success/failure callback may cross the Play boundary.
 for(const mode of ['success','timeout']){
  f=setup();await f.open();f.phase='ready';f.gate=deferred();f.node('libraryPlay').click();await f.flush();
  assert([...f.timers.values()].some(t=>t.ms===120000));
  f.now=120001;
  if(mode==='success')f.gate.resolve(list('Ready too late'));else await tick(f,10000);
  await f.flush();assert.strictEqual(f.launches.length,0);assert.match(f.node('libraryStatus').textContent,/120 s/);
  assert.strictEqual(f.timers.size,0);assert(f.closed>0);
 }
 // Last round is bounded by time remaining, not a new 36-second allowance.
 f=setup();await f.open();f.node('libraryPlay').click();await f.flush();f.now=119500;
 f.phase='ready';f.gate=deferred();await tick(f,2000);
 assert([...f.timers.values()].some(t=>t.ms===500));f.now=120001;await tick(f,500);
 assert.strictEqual(f.timers.size,0);assert(!f.launches.length);assert(f.cancels>0);
 // Only these tested menu sections differ from stage three; unknown edits
 // still fail exact source scope checks, and the original launcher is frozen.
 const normalize=require('./readiness-scope.cjs').normalize;
 for(const file of ['wasm/platform/console-library.js','wasm/static/js/utils.js']){
  const current=fs.readFileSync(file,'utf8'),baseline=cp.execFileSync('git',['show','04f56c5:'+file],{encoding:'utf8'});
  assert.strictEqual(normalize(file,current),baseline);assert.notStrictEqual(normalize(file,current+'\n// unexpected'),baseline);
 }
 console.log('menu_readiness_test: cover-independent retries, list ownership, real changed-IP/UUID recovery, single Play/WoL, monotonic deadline and remaining-budget cancellation passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

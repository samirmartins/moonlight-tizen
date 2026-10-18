'use strict';
// Production NvHTTP + library, synthetic transport and deterministic retry clock.
// Browser coverage separately exercises the XML parser with actual DOMParser.
const assert=require('assert');
const {fixture}=require('./library_cover_cache_test.js');
function xmlQuery(xml,tag='root') {
  const appMatches=[...xml.matchAll(/<App>([\s\S]*?)<\/App>/g)];
  const root={getElementsByTagName(name){return name==='App'?appMatches.map(m=>({getElementsByTagName(n){const v=m[1].match(new RegExp('<'+n+'>([\\s\\S]*?)</'+n+'>'));return v?[{textContent:v[1]}]:[];}})):[];}};
  return {length:/^<root\b[^>]*>[\s\S]*<\/root>$/.test(xml)?1:0,0:root,
    find(n){return xmlQuery(xml,n);},attr(){const m=xml.match(/status_code="(\d+)"/);return m?m[1]:undefined;},
    text(){const m=xml.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>'));return m?m[1]:'';},each(){}};
}
const list='<root status_code="200"><App><ID>1</ID><AppTitle>Game 001</AppTitle></App></root>';
const empty='<root status_code="200"></root>',denied='<root status_code="401"></root>';
async function retry(f) {
  const entry=[...f.timers].find(([,t])=>t.ms===2000);assert(entry,'retry remains armed after every failed boot response');
  f.timers.delete(entry[0]);entry[1].fn();await f.flush();
}
function setup() {
  const f=fixture(1),c=f.c,h=f.host,raw=new c.NvHTTP('fixture.invalid','fixture');
  delete h.connect;delete h.getAppListWithCacheFlush;
  Object.setPrototypeOf(h,c.NvHTTP.prototype);
  Object.assign(h,{address:'fixture.invalid',localAddress:'',userEnteredAddress:'',externalIP:'',hostname:'fixture',
    httpsPort:47984,httpPort:47989,ppkstr:'synthetic pin',clientUid:'fixture',paired:true,online:false,_authenticatedOnline:false});
  const domQuery=c.$;c.$=xml=>typeof xml==='string'&&xml.startsWith('<')?xmlQuery(xml):domQuery(xml);c.$.parseXML=xml=>xml;
  f.requests=[];f.state='off';
  c.sendMessage=(name,args)=>{
    assert.strictEqual(name,'openUrlScoped');assert(args[0].startsWith('https://'));assert.strictEqual(args[1],h.ppkstr);
    f.requests.push(args);
    if(args[0].includes('/serverinfo?')) {
      if(f.state==='off')return Promise.reject(Error('unreachable'));
      if(f.state==='denied')return Promise.resolve(denied);
      return Promise.resolve('<root status_code="200"><uniqueid>fixture-pc</uniqueid><hostname>fixture</hostname><PairStatus>1</PairStatus></root>');
    }
    assert(args[0].includes('/applist?'),'no unrelated network operation');
    if(f.state==='off')return Promise.reject(Error('unreachable'));
    if(f.state==='denied')return Promise.resolve(denied);
    if(f.state==='empty')return Promise.resolve(empty);
    if(f.state==='malformed')return Promise.resolve('<root status_code="200"><App></App></root>');
    return Promise.resolve(list);
  };
  return f;
}
(async()=>{
  const f=setup();await f.open();
  for(let i=0;i<12;i++){await retry(f);assert.strictEqual(f.host.online,false);assert.strictEqual(f.host.paired,true);}
  f.state='denied';for(let i=0;i<3;i++){await retry(f);assert(!f.host.online);assert.strictEqual(f.host.httpsPort,47984);}
  f.state='on';await retry(f);
  assert.match(f.node('libraryStatus').textContent,/PC online/);assert(f.host.online&&f.host._authenticatedOnline&&f.host.paired);
  assert.strictEqual(f.host.httpsPort,47984,'boot metadata cannot erase port');
  assert.strictEqual(f.node('libraryPlay').textContent,'Play');assert.strictEqual(f.timers.size,0);
  assert(f.requests[0][0].includes('/serverinfo?'),'startup serverinfo is the connection prerequisite');
  assert(f.requests.filter(a=>a[0].includes('/serverinfo?')).every(a=>a[3]===4500));
  // The same running client survives another off/on cycle and accepts zero games.
  f.state='off';await f.c.ConsoleLibrary.open(f.host);await f.flush();assert(!f.host.online);
  f.state='malformed';await retry(f);assert(f.host.online);assert.match(f.node('libraryStatus').textContent,/library unavailable/);assert.strictEqual(f.host._memCachedApplist.length,1,'bad response cannot replace last good cache');
  f.state='empty';await retry(f);assert(f.host.online&&f.host._authenticatedOnline);
  assert.match(f.node('libraryStatus').textContent,/0 games/);assert.strictEqual(f.host._memCachedApplist.length,0);
  f.suspend();assert.strictEqual(f.timers.size,0);assert.strictEqual(f.node('game-grid').children.length,0);
  // A cached list alone is never evidence; a new native request is mandatory.
  const g=setup();g.host._memCachedApplist=[{id:1,title:'Cached only'}];await g.open();assert(g.requests.length>0);assert(!g.host.online);g.suspend();
  // Real credential/HTTP failures remain negative; all startup candidates are tried.
  const r=setup();r.host.localAddress='lan.fixture.invalid';r.host.userEnteredAddress='manual.fixture.invalid';r.host.externalIP='wan.fixture.invalid';
  await r.open();const first=r.requests.slice();assert.strictEqual(first.length,5);
  assert(first.every(a=>a[0].includes('/serverinfo?')),'offline never fetches the app list');
  await retry(r);assert.strictEqual(r.requests.length,10);assert.deepStrictEqual(r.requests.slice(5).map(a=>a[0].split('?')[0]),first.map(a=>a[0].split('?')[0]));
  assert(r.requests.every(a=>a[0].startsWith('https://')));r.suspend();
  console.log('host_availability_test: serverinfo-first connection, 12 offline rounds, auth delay, recovery without restart, second power cycle, empty/bad list distinction, full fallback scan and gameplay cancellation OK');
})().catch(error=>{console.error(error);process.exitCode=1;});

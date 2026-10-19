'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const timers=new Map();let timerId=0,saves=0,updates=0;
const elements={};const element=id=>elements[id]||(elements[id]={value:'',textContent:'',disabled:false,classList:{remove(){}},style:{}});
const c={Promise,console:{log(){},warn(){},error(){}},navigator:{},isInGame:false,isDialogOpen:false,hosts:{},
  setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},
  document:{getElementById:element},saveHosts(){saves++;},updateHostStatusIndicator(){updates++;},
  endBackgroundPollingOfHost(){},beginBackgroundPollingOfHost(){},openUtilityDialog(){},closeUtilityDialog(){}};
c.window=c;vm.createContext(c);
vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js','utf8'),c);
vm.runInContext(fs.readFileSync('wasm/static/js/utils.js','utf8'),c);
c.openUtilityDialog=function(){};c.closeUtilityDialog=function(){};
const index=fs.readFileSync('wasm/platform/index.js','utf8');
vm.runInContext(index.slice(index.indexOf('function updateMacAddress('),index.indexOf('// Show the Host Menu dialog')),c);
// Same NvHTTP parser, with a minimal XML query fixture (browser tests use jQuery).
function xmlQuery(xml,tag='root') { return {
  find(name){return xmlQuery(xml,name);},
  text(){const m=xml.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>'));return m?m[1]:'';},
  html(){return this.text();},each(){},attr(){return '200';}
}; }
const host=new c.NvHTTP('fixture.invalid','fixture');host.serverUid='fixture';
c.$=xml=>xmlQuery(xml);c.$.parseXML=xml=>xml;
host.httpPort=47989;host.httpsPort=47984;host._baseUrlHttp='http://fixture.invalid:47989';host._baseUrlHttps='https://fixture.invalid:47984';
host._parseXML=xml=>xmlQuery(xml);c.hosts.fixture=host;
const info=(mac,paired)=>'<root status_code="200"><uniqueid>fixture</uniqueid><hostname>fixture</hostname><LocalIP>192.0.2.1</LocalIP><HttpsPort>47984</HttpsPort><appversion>7.1</appversion><PairStatus>'+paired+'</PairStatus><mac>'+mac+'</mac><state>SUNSHINE_SERVER_FREE</state></root>';
const good=info('12:34:56:78:9A:BC',1),placeholder=info('00:00:00:00:00:00',0);
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
(async()=>{
  let reads=[];
  c.sendMessage=(name,args)=>{
    reads.push(name);
    if(name==='pair')return Promise.resolve('fixture-pin');
    if(args[0].includes('/pair?'))return Promise.resolve('<root><paired>1</paired></root>');
    assert.strictEqual(name,'openUrlScoped');
    return Promise.resolve(args[0].startsWith('https:')?good:placeholder);
  };
  assert.strictEqual(await host.pair('0000'),true);
  assert.strictEqual(host.macAddress,'12:34:56:78:9A:BC');assert(saves>=1);
  assert(host.paired&&host._authenticatedOnline);assert.strictEqual(timers.size,0);
  for(const value of ['', '0', '-1', '65536', 'NaN', '47984junk']) {
    assert.strictEqual(host._parseServerInfo(good.replace('<HttpsPort>47984</HttpsPort>','<HttpsPort>'+value+'</HttpsPort>'),true),true);
    assert.strictEqual(host.httpsPort,47984,'incomplete/invalid metadata retains verified HTTPS port');
  }
  assert.strictEqual(host._parseServerInfo(placeholder,true),false,'incomplete paired boot response is rejected before mutation');
  assert(host.paired&&host._authenticatedOnline,'boot response cannot erase established authorization');
  const saved=saves, before=host.hostname;
  assert.strictEqual(host._parseServerInfo(placeholder.replace('<hostname>fixture</hostname>','<hostname>untrusted</hostname>'),false),false);
  assert.strictEqual(host.hostname,before,'HTTP must not overwrite pinned host metadata');
  assert(host.paired,'HTTP placeholder cannot erase paired state');
  assert.strictEqual(host.macAddress,'12:34:56:78:9A:BC');assert.strictEqual(saves,saved);
  host.wakeMacOverride='12:34:56:78:9A:BC';host.macAddress='';
  c.WakeHost.open(host);element('wakeDetected').onclick();
  assert.strictEqual(host.wakeMacOverride,'12:34:56:78:9A:BC','failed detection must retain manually saved MAC');
  host.macAddress='12:34:56:78:9A:BC';element('wakeDetected').onclick();assert.strictEqual(host.wakeMacOverride,undefined);
  let httpsReady=false;
  let urls=[];
  c.sendMessage=(name,args)=>{
    urls.push(args[0]);
    if(args[0].startsWith('https:')) return httpsReady?Promise.resolve(good):Promise.reject(Error('HTTPS starting'));
    return Promise.resolve(placeholder);
  };
  host.online=false;
  await assert.rejects(host.connect(c.createMenuRequestScope()));
  assert(!host._authenticatedOnline);assert(host.paired);
  assert(urls.length>0&&urls.every(url=>url.startsWith('https:')),'no HTTP downgrade while paired');
  urls=[];
  await assert.rejects(host.refreshServerInfo());
  await assert.rejects(host.refreshServerInfoAtAddress('fixture.invalid'));
  assert(urls.every(url=>url.startsWith('https:')),'legacy refresh must also retain pinned HTTPS');
  httpsReady=true;
  await host.connect(c.createMenuRequestScope());assert(host._authenticatedOnline);assert(updates>=1);
  // A pending or cancelled visible-menu probe is not evidence that a paired
  // PC went offline. Only an active failed probe invalidates its verification.
  let rejectProbe;
  c.sendMessage=()=>new Promise((resolve,reject)=>{rejectProbe=reject;});
  let probeScope=c.createMenuRequestScope();
  const cancelledProbe=host.refreshServerInfoScoped(host.address,probeScope).catch(()=>{});
  assert.strictEqual(host._authenticatedOnline,true,'checking does not erase a verified PC');
  probeScope.cancel();rejectProbe(Error('Late cancelled probe'));await cancelledProbe;
  assert.strictEqual(host._authenticatedOnline,true,'cancel does not advertise a healthy PC as offline');
  probeScope=c.createMenuRequestScope();
  const failedProbe=host.refreshServerInfoScoped(host.address,probeScope).catch(()=>{});
  rejectProbe(Error('Active failed probe'));await failedProbe;
  assert.strictEqual(host._authenticatedOnline,false,'a real failed check clears verification');
  assert.strictEqual(host.paired,true,'network failure never erases pairing');
  c.sendMessage=()=>Promise.resolve(good);await host.connect(c.createMenuRequestScope());
  assert.strictEqual(host._authenticatedOnline,true,'the next successful query restores verified status');
  // Reject loopback candidates without losing a real LAN fallback.
  host.address='127.0.0.1';host.localAddress='::1';host.userEnteredAddress='fixture.invalid';
  host.externalIP='::ffff:127.0.0.1';host.hostname='localhost';
  let candidates=[];
  c.sendMessage=(name,args)=>{candidates.push(new URL(args[0]).hostname);return Promise.resolve(good);};
  await host.connect(c.createMenuRequestScope());
  assert.deepStrictEqual(candidates,['fixture.invalid']);
  host.hostname='fixture';
  for(const address of ['127.1.2.3','[::1]','0:0:0:0:0:0:0:1','LOCALHOST.','x.localhost']) assert(c.isLoopbackHost(address));
  assert(!c.isLoopbackHost('192.0.2.1'));assert(!c.isLoopbackHost('fixture.invalid'));
  // WOL dialog keeps checking until pinned HTTPS is authenticated, not just HTTP.
  host.sendWOL=()=>Promise.resolve();host._authenticatedOnline=false;
  host.connect=()=>{host.online=true;return Promise.resolve();};
  c.WakeHost.open(host);element('wakeSend').onclick();await flush();
  assert.match(element('wakeStatus').textContent,/waiting for authenticated/);
  const next=[...timers].at(-1);timers.delete(next[0]);host._authenticatedOnline=true;next[1]();await flush();
  assert.match(element('wakeStatus').textContent,/PC online/);assert.strictEqual(timers.size,0);
  c.webapis={network:{getIp:()=> '192.0.2.4',getSubnetMask:()=> '255.255.255.0'}};
  assert.strictEqual(c.getWakeBroadcastAddress(),'192.0.2.255');
  c.webapis.network.getSubnetMask=()=> '255.0.255.0';assert.strictEqual(c.getWakeBroadcastAddress(),'');
  c.webapis.network.getIp=()=>{throw Error('unsupported');};assert.strictEqual(c.getWakeBroadcastAddress(),'');
  // Native scoped cancellation targets a single request ID, never global cancel.
  let cancelled=[],pending=[];c.Module={openUrlScoped(id){pending.push(id);},cancelMenuRequest(id){cancelled.push(id);}};
  vm.runInContext(fs.readFileSync('wasm/platform/messages.js','utf8'),c);
  const a=c.sendMessage('openUrlScoped',['fixture',null,false,10]).catch(e=>String(e));
  const b=c.sendMessage('openUrlScoped',['fixture',null,false,10]);
  // Preserve .cancel before attaching catch.
  c.callbacks[pending[0]];c.Module.cancelMenuRequest(pending[0]);
  c.handlePromiseMessage(pending[0],'reject','cancelled');c.handlePromiseMessage(pending[1],'resolve','ok');
  assert.strictEqual(await b,'ok');assert.strictEqual(await a,'cancelled');assert.strictEqual(cancelled.length,1);
  const raw=c.sendMessage('openUrlScoped',['fixture',null,false,10]);const result=raw.catch(e=>e.message);raw.cancel();
  assert.match(await result,/cancelled/);assert.strictEqual(cancelled.length,2);
  c.Module.cancelMenuRequest=id=>c.handlePromiseMessage(id,'reject','native synchronous reply');
  const immediate=c.sendMessage('openUrlScoped',['fixture',null,false,10]);
  const reason=immediate.catch(e=>e.message);immediate.cancel();
  assert.strictEqual(await reason,'Menu request cancelled','JS cancellation owns its Error before any native reply');
  assert.strictEqual(Object.keys(c.callbacks).length,0);
  console.log('host_connection_test: paired HTTPS MAC, persistence, manual override, boot readiness, subnet and isolated native cancellation OK');
})().catch(e=>{console.error(e);process.exitCode=1;});

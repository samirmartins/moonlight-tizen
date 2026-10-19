'use strict';
// Exercise the production menu with DOM ownership and cancellable requests.
const assert = require('assert'), fs = require('fs'), vm = require('vm'), cp = require('child_process');
const file = 'wasm/platform/console-library.js', source = fs.readFileSync(file, 'utf8');
function fixture(count = 4, coverUrl, options = {}) {
  const all = [], nodes = new Map(), timers = new Map(), calls = [], io = {deletes:0};
  let timerId = 0, serial = 0;
  const mutations = {classes:0,tabs:0};
  class Element {
    constructor(tag, root = false) {
      this.tag = tag; this.root = root; this.children = []; this.dataset = {}; this.style = {};
      this.id = ''; this.className = ''; this._text = ''; this.disabled = false;
      const classes = new Set();
      this.classList = {add(value){classes.add(value);},remove(value){classes.delete(value);},
        contains(value){return classes.has(value);},toggle(value,on){mutations.classes++;if(on)classes.add(value);else classes.delete(value);}};
      all.push(this);
    }
    get isConnected() { return this.root || !!(this.parent && this.parent.isConnected); }
    get parentNode() { return this.parent || null; }
    get tabIndex() { return this._tabIndex === undefined ? 0 : this._tabIndex; }
    set tabIndex(value) { mutations.tabs++;this._tabIndex=value; }
    get textContent() { return this._text; }
    set textContent(value) { this.children.forEach(n => n.parent = null); this.children = []; this._text = value; }
    appendChild(node) {
      if (node.tag === 'fragment') { node.children.slice().forEach(n => this.appendChild(n)); return node; }
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      this.children.push(node); node.parent = this; return node;
    }
    querySelector(selector) {
      for (const n of this.children) {
        if (selector === n.tag || selector === '.' + n.className) return n;
        const nested = n.querySelector(selector); if (nested) return nested;
      }
      return null;
    }
    setAttribute(name, value) { this[name] = value; }
    scrollIntoView() {}
    click() { if (!this.disabled && this.onclick) this.onclick(); }
  }
  function node(name) {
    if (!nodes.has(name)) { const n = new Element('div', true); n.id = name; nodes.set(name, n); }
    return nodes.get(name);
  }
  const apps = Array.from({length:count}, (_, i) => ({id:i+1,title:'Game '+String(i+1).padStart(3,'0')}));
  const record = {apps, favorites:[], recent:[], focus:1};
  const storage = options.storage || new Map([['moonlight.console.v1', JSON.stringify({preferred:'fixture-pc',hosts:{'fixture-pc':record}})]]);
  const writes=[];
  const host = {serverUid:'fixture-pc',hostname:'Fixture PC',online:true,paired:true,currentGame:0,_memCachedApplist:apps,
    connect(){return this.online ? Promise.resolve('fixture.invalid') : Promise.reject(Error('offline'));},
    getAppListWithCacheFlush(){return Promise.resolve(apps);},
    getBoxArt(appId, scope, offline, force){
      calls.push({appId,scope,offline,force});
      if (host.delay) return new Promise(resolve => host.delay.push(resolve));
      return Promise.resolve(coverUrl ? coverUrl(appId) : 'data:image/png;base64,fixture-'+appId+'-'+serial);
    }};
  const c = {console:{log(){},warn(){},error(){}},Promise,Blob,
    atob:typeof atob==='function'?atob:undefined,btoa:typeof btoa==='function'?btoa:undefined,navigator:{},isInGame:false,isDialogOpen:false,
    hosts:{'fixture-pc':host},Views:{Apps:{},AppsNav:{}},
    document:{hidden:false,getElementById(id){return nodes.get(id) || all.find(n=>n.id===id && n.isConnected) || (id.startsWith('game-container-') ? null : node(id));},
      createElement(tag){return new Element(tag);},createDocumentFragment(){return new Element('fragment');},body:node('body')},
    localStorage:{getItem(k){return storage.has(k)?storage.get(k):null;},removeItem(k){storage.delete(k);},setItem(k,v){writes.push({key:k,value:String(v)});if(options.fail&&options.fail(k))throw Error('Synthetic storage failure');storage.set(k,String(v));}},
    setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timers.delete(id);},
    $(){return {children(){return this;},show(){},hide(){}};},
    Navigation:{change(){},start(){},pop(){}},focusElement(){},getComputedStyle(){return {gridTemplateColumns:'1fr 1fr'};},
    showAppsMode(){c.isInGame=false;},stopPollingHosts(){},stopSubnetScanner(){},showHosts(){},stopAudioScheduler(){},
    normalizeWakeMac(v){return v;},snackbarLog(){},exitAppDialog(){},WakeHost:{open(){}},
    startGame(){c.isInGame=true;c.ConsoleLibrary.suspend();},
    tizen:{filesystem:{deleteDirectory(){io.deletes++;}}}};
  c.window = c; vm.createContext(c);
  vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js','utf8').split('function openUtilityDialog')[0], c);
  vm.runInContext(fs.readFileSync('wasm/static/js/utils.js','utf8'), c);
  host.loadLibrary = c.NvHTTP.prototype.loadLibrary;
  vm.runInContext(options.source || source, c);
  const flush = async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
  async function open() { c.isInGame=false; await c.ConsoleLibrary.open(host); await flush(); }
  function suspend() { c.isInGame=true;c.ConsoleLibrary.suspend(); }
  return {c,node,apps,host,calls,timers,io,flush,open,suspend,storage,writes,mutations,
    card(id){return c.document.getElementById('game-container-'+id);},revision(){serial++;}};
}
module.exports = {fixture};
if (require.main === module) (async()=>{
  const f = fixture(); await f.open();
  let before = f.calls.length;
  const cards = f.node('game-grid').children.slice(), images = cards.map(n=>n.querySelector('img'));
  await f.open();
  assert.strictEqual(f.calls.length,before,'warm library/metadata refresh does not read/fetch covers');
  assert.deepStrictEqual(f.node('game-grid').children,cards,'unchanged grid preserves exact nodes/order');
  assert.deepStrictEqual(cards.map(n=>n.querySelector('img')),images,'decoded image elements are reused');
  f.suspend(); assert.strictEqual(f.node('game-grid').children.length,0,'no image elements retained in streaming grid');
  assert.strictEqual(f.timers.size,0,'no cache timer or background cover work during gameplay');
  await f.open(); assert.strictEqual(f.calls.length,before,'return from stream reuses cached URLs');
  // Refresh deliberately bypasses the memory cache but retains valid old art while loading.
  const old = f.card(1).querySelector('img').src; f.revision();
  f.node('libraryRefresh').click(); await f.flush();
  assert.strictEqual(f.calls.length,before+f.apps.length);
  assert(f.calls.slice(before).every(call=>call.force===true));
  assert.notStrictEqual(f.card(1).querySelector('img').src,old,'Refresh replaces existing covers');
  before=f.calls.length;
  f.c.ConsoleLibrary.favorite(); f.node('libraryFavorites').click(); await f.flush();
  f.node('libraryAll').click(); await f.flush();
  assert.strictEqual(f.calls.length,before,'filter/favorite changes reuse loaded images');
  f.host.online=false; await f.open(); assert.strictEqual(f.calls.length,before,'offline library reuses warm covers without IO');
  f.host.online=true; await f.open();
  // Removed and renamed apps cannot inherit stale memory entries.
  f.apps[1].title='Renamed fixture'; await f.open();
  assert(f.calls.slice(before).every(call=>call.appId===2));
  f.apps.splice(2,1); await f.open(); before=f.calls.length;
  f.apps.push({id:3,title:'Game 003'}); await f.open();
  assert(f.calls.length>before && f.calls.slice(before).every(call=>call.appId===3));
  // The existing explicit disk-cache clear must invalidate URL/card reuse too.
  await f.c.NvHTTP.prototype.clearBoxArt.call(f.host); assert.strictEqual(f.io.deletes,1);
  before=f.calls.length; await f.open(); assert(f.calls.length>=before+f.apps.length);
  // Changing PCs must not leak covers, even when app IDs/titles are identical.
  const oldHost=f.host, other={...oldHost,serverUid:'other-fixture',hostname:'Other fixture',getBoxArt(appId){return Promise.resolve('data:image/png;base64,other-'+appId);}};
  f.c.hosts[other.serverUid]=other; await f.c.ConsoleLibrary.open(other); await f.flush();
  assert(f.card(1).querySelector('img').src.includes('other-1'));
  f.suspend();
  // Count and string-byte budgets independently; oversized art still displays.
  const many=fixture(70); await many.open(); before=many.calls.length; many.suspend(); await many.open();
  assert(many.calls.length>before,'more than 64 entries must be evicted');
  assert(many.calls.length-before<=10,'all retained cache hits are seeded before misses can evict them');
  many.suspend();
  const big=fixture(4,id=>'https://fixture.invalid/'+String(id).repeat(900000)); await big.open();
  before=big.calls.length; big.suspend(); await big.open();
  assert(big.calls.length>before,'string-byte budget evicts covers independently of count'); big.suspend();
  const huge=fixture(1,()=> 'https://fixture.invalid/'+'x'.repeat(2200000)); await huge.open();
  assert(huge.card(1).querySelector('img').src.length>2200000,'oversized cover is still displayed');
  before=huge.calls.length; huge.suspend(); await huge.open(); assert(huge.calls.length>before,'oversized cover is not retained'); huge.suspend();
  // Late/cancelled work must not refill memory or mutate the streaming DOM.
  const late=fixture(3); late.host.delay=[];
  const opening=late.c.ConsoleLibrary.open(late.host); await late.flush();
  late.suspend(); const pending=late.host.delay.splice(0); before=late.calls.length;
  pending.forEach(resolve=>resolve('data:image/png;base64,late')); await opening; await late.flush();
  assert.strictEqual(late.node('game-grid').children.length,0);
  assert.strictEqual(late.calls.length,before,'late completions cannot start more requests');
  assert.strictEqual(late.timers.size,0);
  late.host.delay=null; await late.open(); assert(late.calls.length>=before+late.apps.length,'cancelled replies never enter cache'); late.suspend();
  const clearing=fixture(4); await clearing.open();
  const displayed=clearing.card(1).querySelector('img').src;
  clearing.host.delay=[]; clearing.node('libraryRefresh').click(); await clearing.flush();
  assert.strictEqual(clearing.host.delay.length,2,'only two concurrent renewal requests');
  await clearing.c.NvHTTP.prototype.clearBoxArt.call(clearing.host);
  before=clearing.calls.length;
  clearing.host.delay.splice(0).forEach(resolve=>resolve('data:image/png;base64,stale-clear'));
  await clearing.flush();
  assert.strictEqual(clearing.calls.length,before,'cleared scope cannot continue its queue');
  assert.strictEqual(clearing.card(1).querySelector('img').src,displayed,'cleared late replies cannot overwrite a displayed cover');
  clearing.host.delay=null; clearing.suspend(); await clearing.open();
  assert(clearing.calls.length>=before+clearing.apps.length,'clear remains effective after old replies arrive'); clearing.suspend();
  // Freeze every unrelated function and all native/streaming/telemetry inputs.
  const scope=require('./library-cover-scope.cjs').normalize;
  for(const name of [file,'wasm/static/js/utils.js']) {
    const baseline=cp.execFileSync('git',['show','v3.4.3:'+name],{encoding:'utf8'});
    assert.strictEqual(scope(name,fs.readFileSync(name,'utf8')),scope(name,baseline),name+' cover-only changes');
  }
  require('./audio-telemetry-scope.cjs').assertFrozen('v3.4.3', ['wasm/*.cpp','wasm/*.hpp',
    'wasm/platform/audio.js','wasm/platform/audio-worklet.js','wasm/platform/gamepad.js',
    'wasm/platform/display.js','wasm/platform/diagnostics.js','wasm/platform/index.js',
    'wasm/platform/messages.js','wasm/platform/navigation.js','wasm/index.html','wasm/static/css',
    'moonlight-common-c','CMakeLists.txt','res/config.xml']);
  console.log('library_cover_cache_test: warm return, node reuse, forced Refresh, filters, offline, host/app invalidation, bounded LRU, oversized art, cancellation and unchanged gameplay scope OK');
})().catch(error=>{console.error(error);process.exitCode=1;});

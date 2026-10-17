'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const file='wasm/platform/console-library.js',source=fs.readFileSync(file,'utf8');
const baseline=cp.execFileSync('git',['show','97c158e:'+file],{encoding:'utf8'});
const normalize=require('./library-selection-scope.cjs').normalize;
assert.strictEqual(normalize(file,source),baseline,'selection-only runtime changes');
for(const [a,b] of [["card.parentNode !== el('game-grid')","card.parentNode === el('game-grid')"],
 ["el('game-grid').textContent = '';\n    selectedCard = null;","el('game-grid').textContent = '';\n    selectedCard = {};"],['save(); bind();','bind();'],
 ['current.request(function() { return host.sendWOL(); }','current.request(function() { return host.connect(); }']]) {
 assert(source.includes(a));assert.notStrictEqual(normalize(file,source.replace(a,b)),baseline,'unexpected neighboring change rejected');
}
const harness={require,console,Blob};vm.createContext(harness);
vm.runInContext(fs.readFileSync('wasm/library_cover_cache_test.js','utf8').split('\n(async()=>{')[0]+'\nglobalThis.makeFixture=fixture;',harness);
const fixture=(n=4,options={})=>harness.makeFixture(n,undefined,options);
const key='moonlight.console.v1',focusKey=key+'.focus';
function selected(f){return Array.from(f.node('game-grid').children).filter(card=>card.tabIndex===0).map(card=>Number(card.dataset.appId));}
function view(f){return JSON.stringify({title:f.node('libraryTitle').textContent,play:f.node('libraryPlay').textContent,
 cards:f.node('game-grid').children.map(card=>[card.dataset.appId,card.tabIndex,card.classList.contains('hovered')])});}
function choose(f,id){f.card(id).onfocus();}
(async()=>{
 const a=fixture(120),b=fixture(120,{source:baseline});await a.open();await b.open();
 const initialTimers=a.timers.size,initialCovers=a.calls.length;
 a.writes.length=b.writes.length=0;a.mutations.classes=a.mutations.tabs=b.mutations.classes=b.mutations.tabs=0;
 for(let i=0;i<500;i++) {const appId=2+i%119;choose(a,appId);choose(b,appId);assert.strictEqual(view(a),view(b));}
 assert(a.writes.every(w=>w.key===focusKey));assert(b.writes.every(w=>w.key===key));
 const compactBytes=a.writes.reduce((n,w)=>n+w.value.length,0),fullBytes=b.writes.reduce((n,w)=>n+w.value.length,0);
 assert(compactBytes<fullBytes/100,'compact storage is independent of the app catalog');
 assert.strictEqual(a.mutations.classes,1000);assert.strictEqual(a.mutations.tabs,1000);
 assert.strictEqual(b.mutations.classes,60000);assert.strictEqual(b.mutations.tabs,60000);
 const before=a.writes.length;choose(a,26);const changed=a.writes.length;choose(a,26);
 assert.strictEqual(changed,before+1);assert.strictEqual(a.writes.length,changed,'repeat focus does not save');
 assert.strictEqual(a.calls.length,initialCovers);assert.strictEqual(a.timers.size,initialTimers,'no selection timer or cover IO');
 assert.deepStrictEqual(JSON.parse(a.storage.get(focusKey)),['fixture-pc',26]);
 // Restart without hide/launch/refresh: focus was persisted immediately.
 const reboot=fixture(120,{storage:new Map(a.storage)});await reboot.open();assert.deepStrictEqual(selected(reboot),[26]);
 // Re-enter after streaming without retaining the selected image node.
 const oldCard=a.card(26);a.suspend();assert.strictEqual(a.node('game-grid').children.length,0);
 assert.strictEqual(a.timers.size,0);oldCard.onfocus();assert.strictEqual(a.writes.length,changed,'late focus in streaming is inert');
 await a.open();assert.notStrictEqual(a.card(26),oldCard);assert.deepStrictEqual(selected(a),[26]);
 // A refresh after navigation removed highlighting must restore it, without
 // revisiting all the other cards or changing covers.
 a.card(26).classList.remove('hovered');a.card(26).tabIndex=-1;
 await a.c.ConsoleLibrary.open(a.host);assert(a.card(26).classList.contains('hovered'));assert.deepStrictEqual(selected(a),[26]);
 a.c.ConsoleLibrary.favorite();await a.flush();
 assert(JSON.parse(a.storage.get(key)).hosts['fixture-pc'].favorites.includes(26));
 a.node('libraryFavorites').click();await a.flush();assert.deepStrictEqual(selected(a),[26]);
 a.c.ConsoleLibrary.favorite();await a.flush();assert.strictEqual(a.node('game-grid').children.length,0);
 a.node('libraryAll').click();await a.flush();assert.strictEqual(selected(a).length,1);
 // A launch of a filter fallback can change the focus even though select()
 // sees the same ID. Both persistence paths must agree after restart.
 const first=selected(a)[0];a.c.ConsoleLibrary.accept();
 assert.strictEqual(JSON.parse(a.storage.get(key)).hosts['fixture-pc'].focus,first);
 assert(!a.storage.has(focusKey),'successful full save retires the compact override');
 // One compact key, not one key per host. Restore its owner before opening
 // another PC, then save both hosts' latest focus in the normal full record.
 const multi=fixture(12);await multi.open();choose(multi,9);
 const other={...multi.host,serverUid:'second-fixture',hostname:'Second fixture'};multi.c.hosts[other.serverUid]=other;
 await multi.c.ConsoleLibrary.open(other);await multi.flush();choose(multi,7);
 assert.strictEqual(multi.storage.size,2);
 const next=fixture(12,{storage:new Map(multi.storage)});await next.open();assert.deepStrictEqual(selected(next),[9]);
 const second={...next.host,serverUid:'second-fixture'};next.c.hosts[second.serverUid]=second;
 await next.c.ConsoleLibrary.open(second);await next.flush();assert.deepStrictEqual(selected(next),[7]);
 assert.strictEqual(JSON.parse(next.storage.get(key)).hosts['second-fixture'].focus,7);
 // Legacy/malformed/foreign compact records cannot erase the full preferences.
 for(const raw of ['not json','null','{}','["unknown",3]','["__proto__",3]','["constructor",3]','["prototype",3]',
   '["fixture-pc",0]','["fixture-pc",-1]','["fixture-pc",4294967296]','["fixture-pc",2,3]']) {
  const f=fixture();f.storage.set(focusKey,raw);
  const restored=fixture(4,{storage:new Map(f.storage)});await restored.open();assert.deepStrictEqual(selected(restored),[1]);restored.suspend();
 }
 // If compact writes fail, invalidate the old override before the full-record
 // fallback. If all storage writes fail, playing/navigation still work.
 let reject=false;
 const quota=fixture(4,{fail:k=>reject&&k===focusKey});await quota.open();choose(quota,2);reject=true;choose(quota,3);
 assert(!quota.storage.has(focusKey));assert.strictEqual(JSON.parse(quota.storage.get(key)).hosts['fixture-pc'].focus,3);
 const recovered=fixture(4,{storage:new Map(quota.storage)});await recovered.open();assert.deepStrictEqual(selected(recovered),[3]);
 let full=false;
 const filled=fixture(4,{fail:()=>full});await filled.open();choose(filled,2);full=true;choose(filled,3);
 assert.deepStrictEqual(JSON.parse(filled.storage.get(focusKey)),['fixture-pc',2],'all-write failure retains the last successful focus');
 const lastGood=fixture(4,{storage:new Map(filled.storage)});await lastGood.open();assert.deepStrictEqual(selected(lastGood),[2]);
 full=false;await filled.open();assert(!filled.storage.has(focusKey),'later successful refresh retires a stale compact override');
 const refreshed=fixture(4,{storage:new Map(filled.storage)});await refreshed.open();assert.deepStrictEqual(selected(refreshed),[3]);
 const blocked=fixture(4,{fail:()=>true});await blocked.open();choose(blocked,2);blocked.c.ConsoleLibrary.accept();assert(blocked.c.isInGame);
 const nativeDiff=cp.execFileSync('git',['diff','97c158e','--','wasm/*.cpp','wasm/*.hpp','wasm/platform/audio.js','wasm/platform/audio-worklet.js',
   'wasm/platform/gamepad.js','wasm/platform/display.js','wasm/platform/diagnostics.js','wasm/platform/index.js','wasm/platform/messages.js',
   'wasm/platform/navigation.js','wasm/index.html','wasm/static/css','moonlight-common-c','CMakeLists.txt','res/config.xml'],{encoding:'utf8'});
 assert.strictEqual(nativeDiff,'','all streaming and UI layout inputs unchanged');
 console.log('library_selection_test: 500 exact selections; classes/tabs 60000 -> 1000 each; stored chars '+fullBytes+' -> '+compactBytes+'; immediate restart, legacy/corrupt/quota, multi-PC, filters, launch, suspend and scope OK');
})().catch(error=>{console.error(error);process.exitCode=1;});

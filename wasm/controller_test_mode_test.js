'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const menu=fs.readFileSync('wasm/platform/controller-mapping-menu.js','utf8');
function fixture() {
  let pads=[],nextFrame=null,serial=0,view,navigation=0;
  const nodes=new Map(),listeners=new Map();
  function classes(node) {
    return {contains:c=>node.className.split(' ').includes(c),
      toggle(c,on){const all=new Set(node.className.split(' ').filter(Boolean));on?all.add(c):all.delete(c);node.className=[...all].join(' ');},
      remove(...values){values.forEach(c=>this.toggle(c,false));}};
  }
  function element(tag='div') {
    const node={tagName:tag.toUpperCase(),children:[],className:'',style:{},disabled:false,hidden:false,
      setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];},getClientRects:()=>[{}],scrollIntoView(){},
      focus(){document.activeElement=this;},getBoundingClientRect:()=>({left:0,right:10,top:0,bottom:10}),
      addEventListener(){},appendChild(child){this.children.push(child);if(child.id)nodes.set(child.id,child);},
      querySelectorAll(selector){return [...nodes.values()].filter(n=>selector==='button'?n.tagName==='BUTTON':n.classList.contains('cm-active')||n.classList.contains('cm-pressed'));}};
    node.classList=classes(node);
    Object.defineProperty(node,'textContent',{get(){return this.text||'';},set(value){this.text=value;this.children=[];}});
    Object.defineProperty(node,'innerHTML',{set(html){
      for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const child=element(match[1]);child.id=match[3];
        child.className=(match[2].match(/class="([^"]+)"/)||[])[1]||'';
        child.hidden=/\bhidden\b/.test(match[2]);nodes.set(child.id,child);
      }
    }});
    return node;
  }
  const document={hidden:false,activeElement:null,body:element(),createElement:element,getElementById:id=>nodes.get(id),addEventListener(){},removeEventListener(){}};
  function addEventListener(name,fn,capture){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push({fn,capture:!!capture});}
  function removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(item=>item.fn!==fn));}
  function dispatch(name,properties={}) {
    const event={...properties,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
    const items=(listeners.get(name)||[]).slice().sort((a,b)=>Number(b.capture)-Number(a.capture));
    for(const item of items){item.fn(event);if(event.stopped)break;}
    return event;
  }
  const context={console,document,navigator:{getGamepads:()=>pads},isInGame:false,isDialogOpen:false,
    repeatTimeout:1,navigationTimeout:2,repeatAction:()=>{},clearTimeout(){},
    requestAnimationFrame(fn){assert(!nextFrame);nextFrame=fn;return ++serial;},cancelAnimationFrame(){nextFrame=null;},
    addEventListener,removeEventListener,localStorage:{getItem:()=>null,setItem(){}},
    openUtilityDialog(){nodes.get('controllerMappingDialog').open=true;context.isDialogOpen=true;},
    closeUtilityDialog(){nodes.get('controllerMappingDialog').open=false;context.isDialogOpen=false;},
    focusElement(){},Navigation:{change(v){view=v;}}};
  context.window=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('wasm/platform/controller-mapping.js','utf8'),context);
  vm.runInContext(menu,context);
  addEventListener('gamepadinputchanged',()=>{navigation++;},false);
  return {c:context,node:id=>nodes.get(id),view:()=>view,setPads(value){pads=value;},
    dispatch,listeners:name=>(listeners.get(name)||[]).length,navigation:()=>navigation,
    tick(time){const fn=nextFrame;assert(fn);nextFrame=null;fn(time);},pending:()=>!!nextFrame,
    open(){context.ControllerMappingMenu.open();},start(){nodes.get('cm-test').onclick();},stop(){nodes.get('cm-test').onclick();}};
}
function pad(index=0){return {index,connected:true,axes:[0,0,0,0],buttons:Array.from({length:18},()=>({pressed:false,value:0}))};}
function button(p,index,pressed){p.buttons[index]={pressed,value:Number(pressed)};}
const f=fixture(),p=pad();f.setPads([p]);f.open();
assert(!f.pending(),'no test work on open');
f.start();assert(!f.node('cm-exit-hint').hidden);
assert(/Circle \/ B.*3 seconds/.test(f.node('cm-exit-hint').textContent));
f.tick(0);
for(let index=0;index<18;index++) {
  button(p,index,true);f.tick(10+index*20);
  const sprite=f.node('cm-art-button-'+index);
  if(sprite)assert(sprite.classList.contains('cm-active'),'physical button '+index+' highlighted');
  assert(f.node('cm-row-'+index).classList.contains('cm-pressed'));
  button(p,index,false);f.tick(20+index*20);
  if(sprite)assert(!sprite.classList.contains('cm-active'),'release clears button '+index);
}
// Keyboard-emulated confirm/back, direct view operations and raw pad events
// must not navigate, click Finish or close the editor while testing.
for(const [key,keyCode] of [['Enter',13],['Escape',27],['Backspace',8],['',10009],['',65385],['ArrowDown',40]]) {
  for(const type of ['keydown','keyup'])assert(f.dispatch(type,{key,keyCode}).prevented);
}
f.view().accept();f.view().back();f.view().down();
assert(f.node('controllerMappingDialog').open);assert(!f.node('cm-exit-hint').hidden);
f.dispatch('gamepadinputchanged',{detail:{changes:[{index:0,pressed:true}]}});assert.strictEqual(f.navigation(),0);
// Short holds never add together. The former L1+R1 shortcut no longer exits.
button(p,4,true);button(p,5,true);f.tick(500);f.tick(2000);assert(f.pending());button(p,4,false);button(p,5,false);
button(p,1,true);f.tick(2100);f.tick(5099);assert(f.pending(),'2999ms does not exit');
button(p,1,false);f.tick(5100);button(p,1,true);f.tick(5200);f.tick(8199);assert(f.pending(),'hold reset on release');
f.tick(8200);assert(!f.pending(),'3000ms finishes');assert(f.node('cm-exit-hint').hidden);
assert(f.node('controllerMappingDialog').open,'finishes only the test');
assert(!f.node('cm-art-button-1').classList.contains('cm-active'),'idle artwork restored');
f.view().back();assert(f.node('controllerMappingDialog').open,'held exit button cannot close editor');
assert(f.dispatch('keydown',{key:'',keyCode:10009}).prevented,'held keyboard repeat swallowed');
button(p,1,false);f.dispatch('gamepadinputchanged',{detail:{changes:[{index:1,pressed:false}]}});
assert.strictEqual(f.listeners('keydown'),0);assert.strictEqual(f.listeners('keyup'),0);
f.dispatch('gamepadinputchanged',{detail:{changes:[]}});assert.strictEqual(f.navigation(),1);
f.view().back();assert(!f.node('controllerMappingDialog').open);
// Already-held Circle on entry and a replacement controller cannot inherit time.
f.open();button(p,1,true);f.start();f.tick(0);f.tick(9000);assert(f.pending());
button(p,1,false);f.tick(9010);button(p,1,true);f.tick(9020);
const second=pad(2);button(second,1,true);f.setPads([null,second]);f.tick(12020);assert(f.pending());
button(second,1,false);f.tick(12030);button(second,1,true);f.tick(12040);f.tick(15040);assert(!f.pending());
f.setPads([]);f.dispatch('gamepaddisconnected',{gamepad:second});assert.strictEqual(f.listeners('keydown'),0);
f.view().back();f.open();f.start();f.tick(0);f.stop();assert(!f.pending());assert.strictEqual(f.listeners('keydown'),0);
assert(f.node('cm-exit-hint').hidden);
const cssFile='wasm/static/css/controller-mapping.css',css=fs.readFileSync(cssFile,'utf8');
const old=cp.execFileSync('git',['show','v3.4.4:'+cssFile],{encoding:'utf8'}),normalize=require('./controller-test-scope.cjs').normalize;
assert.strictEqual(normalize(cssFile,css),old,'only appended menu test styles');
assert.notStrictEqual(normalize(cssFile,css.replace('visibility:hidden','visibility:visible')),old);
const art='wasm/static/res/controller-dualsense.png';
assert(fs.readFileSync(art).equals(cp.execFileSync('git',['show','v3.4.4:'+art],{maxBuffer:1024*1024})),'original CC0 pixels unchanged');
for(const name of ['wasm/platform/audio.js','wasm/platform/audio-worklet.js','wasm/wasmplayer.cpp','wasm/main.cpp','wasm/platform/controller-mapping.js'])
  assert.strictEqual(require('./video-recovery-scope.cjs').normalize(name,fs.readFileSync(name,'utf8')),
    cp.execFileSync('git',['show','v3.4.4:'+name],{maxBuffer:4*1024*1024,encoding:'utf8'}),name+' unchanged outside tested recovery correction');
console.log('controller_test_mode_test: physical highlights, short presses, keyboard/view isolation, exact 3s hold, release guard, disconnect/reentry and unchanged artwork/playback OK');

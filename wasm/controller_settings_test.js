'use strict';
// Removal of legacy flip switches must not shift any remaining stream argument
// or change the standard native button map used by the optional JS remapper.
const assert=require('assert'),fs=require('fs'),cp=require('child_process'),os=require('os'),path=require('path'),vm=require('vm');
const read=file=>fs.readFileSync(file,'utf8');
const runtime=['wasm/gamepad.cpp','wasm/main.cpp','wasm/moonlight_wasm.hpp',
 'wasm/platform/index.js','wasm/platform/messages.js','wasm/platform/navigation.js',
 'wasm/platform/controller-mapping-menu.js','wasm/index.html','wasm/static/css/style.css'];
for(const file of runtime) assert(!/flipABfaceButtons|flipXYfaceButtons|buttonMasksAB|buttonMasksXY/.test(read(file)),file+' has no legacy flip path');
const index=read('wasm/platform/index.js'),main=read('wasm/main.cpp'),header=read('wasm/moonlight_wasm.hpp');
// Exercise the production preference branch, not a duplicate default rule.
const preferenceStart=index.indexOf("  getData('rumbleFeedback', function(previousValue) {");
const preferenceEnd=index.indexOf('\n  });',preferenceStart)+'\n  });'.length;
assert(preferenceStart>0&&preferenceEnd>preferenceStart);
for(const [saved,expected] of [[undefined,true],[null,true],[false,false],[true,true]]) {
 let state=null;
 vm.runInNewContext(index.slice(preferenceStart,preferenceEnd),{
  getData(key,callback){assert.strictEqual(key,'rumbleFeedback');callback({rumbleFeedback:saved});},
  document:{querySelector(selector){assert.strictEqual(selector,'#rumbleFeedbackBtn');return {MaterialSwitch:{on(){state=true;},off(){state=false;}}};}}
 });
 assert.strictEqual(state,expected,'new default or stored rumble preference');
}
const resetStart=index.indexOf('  const defaultRumbleFeedback =');
const resetEnd=index.indexOf("  storeData('rumbleFeedback', defaultRumbleFeedback, null);",resetStart)+"  storeData('rumbleFeedback', defaultRumbleFeedback, null);".length;
let resetState,resetValue;
vm.runInNewContext(index.slice(resetStart,resetEnd),{
 document:{querySelector(){return {MaterialSwitch:{on(){resetState=true;},off(){resetState=false;}}};}},
 storeData(key,value){assert.strictEqual(key,'rumbleFeedback');resetValue=value;}
});
assert.strictEqual(resetState,true);assert.strictEqual(resetValue,true,'explicit reset saves the new ON default');
const normalizeDefaults=require('./rumble-default-scope.cjs').normalize;
const oldIndex=cp.execFileSync('git',['show','v3.4.4:wasm/platform/index.js'],{encoding:'utf8'});
assert.strictEqual(normalizeDefaults('wasm/platform/index.js',index),oldIndex,'all non-default index code unchanged');
assert.notStrictEqual(normalizeDefaults('wasm/platform/index.js',index.replace('previousValue.rumbleFeedback == false','previousValue.rumbleFeedback == true')),oldIndex,'saved-choice changes rejected');
const expected=['host.address','host.httpPort','streamWidth','streamHeight','frameRate','bitrate.toString()',
 'rikey','rikeyid.toString()','host.appVersion','host.gfeVersion',"$root.find('sessionUrl0').text().trim()",
 'host.serverCodecModeSupport','framePacing','optimizeGames','rumbleFeedback','mouseEmulation',
 'audioConfig','audioJitterMs','playHostAudio','videoCodec','hdrMode','fullRange','gameMode','disableWarnings',
 'performanceStats','clientRefreshRateX100'];
const calls=[...index.matchAll(/sendMessage\('startRequest', \[([\s\S]*?)\]\)/g)];
assert.strictEqual(calls.length,2,'both Play and Resume');
for(const call of calls) assert.deepStrictEqual(call[1].split(',').map(s=>s.trim()),expected);
const nativeExpected=['host','httpPort','width','height','fps','bitrate','rikey','rikeyid','appversion','gfeversion',
 'rtspurl','serverCodecModeSupport',...expected.slice(12)];
for(const [text,method] of [[main,'MoonlightInstance::StartStream'],[main,'startStream'],[header,'StartStream'],[header,'startStream']]) {
 const match=text.match(new RegExp('MessageResult '+method+'\\(([\\s\\S]*?)\\)\\s*[;{]'));
 assert(match,method);
 assert.deepStrictEqual(match[1].split(',').map(s=>s.trim().split(/\s+/).pop()),nativeExpected,method+' binding order');
}
const native=read('wasm/gamepad.cpp');
const begin=native.indexOf('static int GetButtonFlags('),end=native.indexOf('// Function to handle the gamepad input state',begin);
assert(begin>0&&end>begin);
const fixture=`
#include <cassert>
#include <cstdint>
#include "Limelight.h"
struct GamepadState { int numButtons; int digitalButton[17]; };
${native.slice(begin,end)}
int main() {
 const int expected[]={A_FLAG,B_FLAG,X_FLAG,Y_FLAG,LB_FLAG,RB_FLAG,0,0,BACK_FLAG,PLAY_FLAG,
  LS_CLK_FLAG,RS_CLK_FLAG,UP_FLAG,DOWN_FLAG,LEFT_FLAG,RIGHT_FLAG,SPECIAL_FLAG};
 for(unsigned state=0;state<(1u<<17);++state) {
  GamepadState g{};g.numButtons=17;int flags=0;
  for(int b=0;b<17;++b) { g.digitalButton[b]=(state>>b)&1; if(g.digitalButton[b]) flags|=expected[b]; }
  assert(GetButtonFlags(g)==flags);
 }
 GamepadState g{};g.numButtons=0;g.digitalButton[0]=1;assert(GetButtonFlags(g)==0);
 g.numButtons=99;assert(GetButtonFlags(g)==A_FLAG);
}
`;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'controller-settings-'));
try {
 fs.writeFileSync(path.join(temp,'test.cpp'),fixture);
 cp.execFileSync('g++',['-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',
  '-Imoonlight-common-c/src',path.join(temp,'test.cpp'),'-o',path.join(temp,'test')],{stdio:'pipe'});
 cp.execFileSync(path.join(temp,'test'),[],{stdio:'pipe'});
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
console.log('controller_settings_test: legacy controls absent, Play/Resume and native binding order, 131072 native button combinations OK');

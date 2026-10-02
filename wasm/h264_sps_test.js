'use strict';
const fs=require('fs'),cp=require('child_process'),path=require('path'),assert=require('assert');
const tmp=fs.mkdtempSync('/tmp/moonlight-h264-3311-');
const run=(exe,args,opts={})=>cp.execFileSync(exe,args,{stdio:'inherit',...opts});
const objects=['h264_nal','h264_sei','h264_stream'].map(name=>{
  const out=path.join(tmp,name+'.o');
  run('gcc',['-std=c99','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Ih264bitstream','-c','h264bitstream/'+name+'.c','-o',out]);return out;
});
const bin=path.join(tmp,'test');
run('g++',['-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Iwasm','-Ih264bitstream','wasm/h264_sps_test.cpp',...objects,'-lm','-o',bin]);
for(const size of ['1920x1080','2560x1440']) {
  const input=path.join(tmp,size+'.h264'),out=path.join(tmp,size+'-fixed.h264');
  run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size='+size+':rate=60','-frames:v','30','-c:v','libx264','-preset','veryfast','-profile:v','high','-level:v','5.1','-x264-params','bframes=0:ref=4:keyint=30','-f','h264',input]);
  run(bin,[input,out],{env:{...process.env,ASAN_OPTIONS:'detect_leaks=1',UBSAN_OPTIONS:'halt_on_error=1'}});
  const decode=file=>cp.execFileSync('ffmpeg',['-v','error','-i',file,'-f','framemd5','-'],{encoding:'utf8'}).split('\n').filter(line=>!line.startsWith('#')&&line.trim()).join('\n');
  assert.strictEqual(decode(input),decode(out),'SPS correction must preserve all decoded pixels/frames');
}
console.log('h264_sps_test: 1080p/1440p multi-reference, level/profile, 3/4-byte prefix, bounds and pixel equality OK');

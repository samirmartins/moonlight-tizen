'use strict';
// Exact exceptions for the independently exercised binary cache and PC-first
// opening. Never mask neighboring launch, lifecycle or selection changes.
const cp=require('child_process'),crypto=require('crypto');
const fileName='wasm/platform/console-library.js';
const begin='  // Menu cover reuse:',end='  // End menu cover reuse.\n';
const defer='    // Opening the library must not enqueue cover IO just before refresh()\n'+
  '    // cancels it. Cached art is already visible; check the PC before misses.\n'+
  '    if (deferCovers) return;\n';
const verifiedStatus='    // Keep the last verified status while checking. Cancellation must not turn\n'+
  '    // a healthy PC into an offline/WoL target; a real failed check still does.\n'+
  '    return read(this.ppkstr != null).catch(function(error) {\n'+
  '      if (scope.active) self._authenticatedOnline = false;\n'+
  '      throw error;\n    });';
function block(source) {
  const a=source.indexOf(begin),b=source.indexOf(end,a);
  return a>=0&&b>a?{a,b:b+end.length,text:source.slice(a,b+end.length)}:null;
}
function normalize(file,source) {
  source=require('./library-availability-scope.cjs').normalize(file,source);
  if(file==='wasm/static/js/utils.js')return source.replace(verifiedStatus,
    '    this._authenticatedOnline = false;\n    return read(this.ppkstr != null);');
  if(file!==fileName)return source;
  const found=block(source);
  if(found&&crypto.createHash('sha256').update(found.text).digest('hex')===
      'a39268e9280daff542f51cff8f7fd154e4393ac49c106623f2d7ecc598c2d32e') {
    const old=block(cp.execFileSync('git',['show','v3.4.4:'+file],{encoding:'utf8'}));
    source=source.slice(0,found.a)+old.text+source.slice(found.b);
  }
  return source.replace('  function render(forceCovers, deferCovers) {','  function render(forceCovers) {')
    .replace(defer,'')
    .replace('    scope = createMenuRequestScope(); render(false, true);','    scope = createMenuRequestScope(); render();');
}
module.exports={normalize};

'use strict';
// Only this explicitly tested, appended menu-only stylesheet is normalized.
const styles = '/* Controller test visuals only; the original CC0 atlas remains unchanged. */\n'+
  '.cm-sprite, .cm-guide { position:absolute; pointer-events:none; visibility:hidden; }\n'+
  ".cm-sprite { background-image:url('../res/controller-dualsense.png'); background-repeat:no-repeat; }\n"+
  '.cm-guide { left:47.2%; top:64.5%; width:6.4%; height:7%; border:2px solid #00eef0; border-radius:6px; color:#00eef0; font-size:.65em; text-align:center; }\n'+
  '.cm-sprite.cm-active, .cm-guide.cm-active { visibility:visible; }\n'+
  '#controllerMappingDialog #cm-exit-hint { position:sticky; top:0; z-index:2; border:2px solid #54f0ec; border-radius:7px; padding:.6em .8em; background:#163c50; color:#fff; font-weight:bold; text-align:center; }\n';
function normalize(file,source) {
  return file === 'wasm/static/css/controller-mapping.css' ? source.replace(styles,'') : source;
}
module.exports={normalize};

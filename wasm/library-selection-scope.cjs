'use strict';
// Only the approved compact-focus path and two-card selection are normalized.
// Persistence/restart/DOM behavior is exercised independently, not masked there.
const assert=require('assert');
const previous='    Array.from(el(\'game-grid\').children).forEach(function(card) {\n'+
  '      var chosen = Number(card.dataset.appId) === selected;\n'+
  "      card.classList.toggle('hovered', chosen);\n"+
  '      card.tabIndex = chosen ? 0 : -1;\n    });';
const next="    var card = el('game-container-' + selected);\n"+
  "    if (card && card.parentNode !== el('game-grid')) card = null;\n"+
  '    if (selectedCard !== card) {\n'+
  "      if (selectedCard) { selectedCard.classList.toggle('hovered', false); selectedCard.tabIndex = -1; }\n"+
  '      selectedCard = card;\n    }\n'+
  "    if (card && !card.classList.contains('hovered')) card.classList.toggle('hovered', true);\n"+
  '    if (card && card.tabIndex !== 0) card.tabIndex = 0;';
function normalize(file,source) {
  source=require('./menu-recovery-scope.cjs').normalize(file,source);
  if(file!=='wasm/platform/console-library.js')return source;
  const begin='\n  // Compact focus persistence:',end='  // End compact focus persistence.\n';
  if(source.includes(begin)) {
    const a=source.indexOf(begin),b=source.indexOf(end,a);assert(b>a&&source.indexOf(begin,a+1)===-1);
    source=source.slice(0,a)+source.slice(b+end.length);
  }
  return source.replace(next,previous).replace('    selectedCard = null;\n','')
    .replace('  function save() {\n    try {\n      localStorage.setItem(key, JSON.stringify(prefs));\n'+
      "      // Only retire the compact override after every host's focus is saved.\n"+
      "      localStorage.removeItem(key + '.focus');\n    } catch (e) {}\n  }",
      '  function save() { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch (e) {} }')
    .replace('record().focus = selected; saveFocus(); updateSelection();','record().focus = selected; save(); updateSelection();')
    .replace('        card.tabIndex = -1;\n','')
    .replace('    var r = record();\n    if (r.focus !== appId) { r.focus = appId; saveFocus(); }','    var r = record(); r.focus = appId;');
}
module.exports={normalize};

'use strict';
// Exact, separately tested remapping integration exceptions; no broad stripping.
// Normalize only the explicitly approved removal of the two legacy flip options.
// Historical baselines remain fixed; unexpected neighboring changes stay visible.
function legacy(file, source) {
 source = source.replaceAll(', bool flipABfaceButtons, bool flipXYfaceButtons', '')
  .replaceAll(', flipABfaceButtons, flipXYfaceButtons', '');
 if (file === 'wasm/gamepad.cpp') {
  source = source.replace('// Flags for gamepad to track face buttons state\nbool flipABfaceButtonsSwitch = false;\nbool flipXYfaceButtonsSwitch = false;\n\n', '');
  const begin = source.indexOf('  const int* buttonMasks = nullptr;');
  if (begin >= 0) {
   const end = source.indexOf('  int result = 0;', begin);
   const a = source.indexOf('  // Define default button mapping', begin), b = source.indexOf('\n\n', a);
   require('assert')(a > begin && b > a && end > b, 'known legacy button mapping');
   source = source.slice(0, begin) + source.slice(a, b).replaceAll('buttonMasksDefault', 'buttonMasks') +
    '\n  constexpr int buttonMasksSize = sizeof(buttonMasks) / sizeof(buttonMasks[0]);\n\n' + source.slice(end);
  }
  return source.replace('  flipABfaceButtonsSwitch = flipABfaceButtons;\n  flipXYfaceButtonsSwitch = flipXYfaceButtons;\n', '');
 }
 if (file === 'wasm/main.cpp') return source.replace(/^  PostToJs\("Setting the Flip [AX]\/[BY] face buttons to: ".*\n/gm, '');
 if (file === 'wasm/platform/index.js') {
  for (const axis of ['AB','XY']) {
   source = source.replace("  $('#flip"+axis+"faceButtonsSwitch').on('click', saveFlip"+axis+"faceButtons);\n", '')
    .replace(new RegExp('^      const flip'+axis+'faceButtons = .*\\n', 'gm'), '')
    .replace(new RegExp('function saveFlip'+axis+'faceButtons\\(\\) \\{\\n.*?\\n\\}\\n\\n', 's'), '')
    .replace(new RegExp('  const defaultFlip'+axis+"faceButtons = false;\\n.*?  storeData\\('flip"+axis+"faceButtons', defaultFlip"+axis+'faceButtons, null\\);\\n\\n', 's'), '')
    .replace(new RegExp("  console.log\\('%c\\[index.js, loadUserDataCb\\]', 'color: green;', 'Load stored flip"+axis+"faceButtons preferences.'\\);\\n  getData\\('flip"+axis+"faceButtons', function\\(previousValue\\) \\{\\n.*?\\n  \\}\\);\\n\\n", 's'), '');
  }
 }
 if (file === 'wasm/platform/navigation.js') return source.replace("      'mouseEmulationBtn',\n      'flipABfaceButtonsBtn',\n      'flipXYfaceButtonsBtn'", "      'mouseEmulationBtn'");
 if (file === 'wasm/index.html') for (const axis of ['A/B','X/Y']) source = source.replace(new RegExp('            <div class="setting-option">\\n              <label>Flip '+axis+' face buttons</label>\\n.*?\\n            </div>\\n', 's'), '');
 if (file === 'wasm/static/css/style.css') return source.replace('#flipABfaceButtonsBtn, #flipXYfaceButtonsBtn, ', '')
  .replace(', #flipABfaceButtonsBtn:hover, #flipABfaceButtonsBtn:focus', '')
  .replace('#flipXYfaceButtonsBtn:hover, #flipXYfaceButtonsBtn:focus, ', '');
 return source;
}
function launch(source) {
 return legacy('wasm/platform/index.js', source)
  .replace("  $('#controllerMappingBtn').on('click', function() { ControllerMappingMenu.open(); });\n", '')
  .replace("  const customMapping = typeof ControllerMapping !== 'undefined' && ControllerMapping.prepareSession();\n", '')
  .replace("  if (typeof ControllerMapping !== 'undefined') ControllerMapping.prepareSession();\n", '');
}
function normalize(file, source) {
 source = legacy(file, source);
 if (file === 'wasm/platform/index.js') return launch(source);
 if (file === 'wasm/platform/gamepad.js') return source
  .replace('  // Freeze the builder for this stream; the disabled path is the original function.\n'+
   "  var buildSnapshot = typeof ControllerMapping !== 'undefined'\n"+
   '    ? ControllerMapping.sessionBuilder(_gpBuildSnapshot) : _gpBuildSnapshot;\n', '')
  .replace('    buildSnapshot(pads);', '    _gpBuildSnapshot(pads);');
 if (file === 'wasm/platform/navigation.js') return source.replace("      'controllerMappingBtn',\n", '');
 if (file === 'wasm/index.html') return source
  .replace('  <link rel="stylesheet" href="static/css/controller-mapping.css">\n', '')
  .replace('  <script type="text/javascript" src="platform/controller-mapping.js"></script>\n', '')
  .replace('  <script type="text/javascript" src="platform/controller-mapping-menu.js"></script>\n', '')
  .replace('            <div class="setting-option">\n'+
   '              <label>Controller mapping</label>\n'+
   '              <span class="mdl-list__item-text-body">Optional layout for game controls. Menu navigation stays unchanged.</span>\n'+
   '              <button type="button" id="controllerMappingBtn" class="console-button">Remap controller buttons</button>\n'+
   '            </div>\n', '');
 return source;
}
module.exports = {launch, normalize, legacy};

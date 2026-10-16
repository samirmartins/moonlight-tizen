'use strict';
// Exact, separately tested remapping integration exceptions; no broad stripping.
function launch(source) {
 return source
  .replace("  $('#controllerMappingBtn').on('click', function() { ControllerMappingMenu.open(); });\n", '')
  .replace("  const customMapping = typeof ControllerMapping !== 'undefined' && ControllerMapping.prepareSession();\n", '')
  .replace("const flipABfaceButtons = !customMapping &&", "const flipABfaceButtons =")
  .replace("const flipXYfaceButtons = !customMapping &&", "const flipXYfaceButtons =");
}
function normalize(file, source) {
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
module.exports = {launch, normalize};

'use strict';
// Exact menu-only integration points. Unknown neighboring edits remain visible.
function normalize(file, source) {
  source = require('./branding-scope.cjs').normalize(file, source);
  if (file === 'wasm/platform/controller-mapping-menu.js') return source.replace(
    "    if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.reset();\n", '');
  if (file === 'wasm/platform/navigation.js') return source
    .replace("    function push(view, hostname) {\n      if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.viewChanged();\n", '    function push(view, hostname) {\n')
    .replace("    function change(view) {\n      if (get() !== view && typeof LibraryNavigation !== 'undefined') LibraryNavigation.viewChanged();\n", '    function change(view) {\n')
    .replace("    function pop() {\n      if (viewStack.length > 1) {\n        if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.viewChanged();\n", '    function pop() {\n      if (viewStack.length > 1) {\n')
    .replace("    function stop() {\n      if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.reset();\n", '    function stop() {\n')
    .replace('    isRunning: State.isRunning,\n', '');
  if (file === 'wasm/platform/index.js') return source.replace(
    "    if (typeof LibraryNavigation !== 'undefined' && LibraryNavigation.handle(e.detail)) {\n"+
    '      repeatAction = null; clearTimeout(repeatTimeout);\n      return;\n    }\n', '');
  if (file === 'wasm/platform/gamepad.js') return source
    .replace('      this.index = gamepad.index;\n', '')
    .replace('{ detail: { changes, padIndex: this.index } }', '{ detail: { changes } }')
    .replace("    if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.disconnect(event.gamepad.index);\n", '')
    .replace("    if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.reset();\n", '');
  if (file === 'wasm/platform/console-library.js') return source.replace(
    "    if (typeof LibraryNavigation !== 'undefined') LibraryNavigation.viewChanged();\n", '');
  if (file === 'wasm/index.html') return source.replace(
    '  <script type="text/javascript" src="platform/library-navigation.js"></script>\n', '');
  return source;
}
module.exports = {normalize};

'use strict';
// Exact exceptions for the separately tested Smart Hub policy. Unknown changes
// remain visible to the historical source-identity checks.
function launch(source) {
 return source.replace('  // Invalidate only continuations from before a Smart Hub transition.\n' +
  "  const lifecycleEpoch = typeof AppLifecycle !== 'undefined' ? AppLifecycle.epoch() : 0;\n" +
  "  const launchCurrent = function() { return typeof AppLifecycle === 'undefined' || AppLifecycle.current(lifecycleEpoch); };\n", '')
  .replace(/^[ \t]*if \(!launchCurrent\(\)\) return;\n/gm, '')
  .replace('setTimeout(() => { if (launchCurrent()) startGame(host, appID); }, 3000);', 'setTimeout(() => startGame(host, appID), 3000);')
  .replace("    if (typeof AppLifecycle !== 'undefined' && AppLifecycle.deferMenu(api)) return;\n", '')
  .replace("    if (typeof AppLifecycle !== 'undefined' && (!isInGame || document.hidden)) return;\n", '');
}
function normalize(file, source) {
 if (file === 'wasm/input.cpp') return source.replace(
  '  if (event && event->hidden) {\n' +
  '    g_Instance->ReleaseHeldInput();\n' +
  '    // Disconnect the client only. Never quit the host application on hide.\n' +
  '    g_Instance->StopConnection();\n  }',
  '  if (event && event->hidden) g_Instance->ReleaseHeldInput();');
 if (file === 'wasm/index.html') return source.replace('  <script type="text/javascript" src="platform/app-lifecycle.js"></script>\n', '');
 if (file === 'wasm/platform/console-library.js') return source
  .replace('active && !isInGame && !document.hidden && token', 'active && !isInGame && token')
  .replace('    if (!pc || isDialogOpen || document.hidden) return Promise.resolve();', '    if (!pc || isDialogOpen) return Promise.resolve();')
  .replace('!runtimeReady || !hostsReady || started || document.hidden', '!runtimeReady || !hostsReady || started')
  .replace('    pause: pause, resume: resume,\n', '')
  .replace('  function pause() {\n    cancel();\n    clearTimeout(launchTimer); launchTimer = 0; launchPending = false;\n  }\n' +
   '  function resume() {\n    if (document.hidden) return;\n    if (active) { refresh(); focusCards(); }\n' +
   "    else if (!started && runtimeReady && hostsReady) ready('runtime');\n  }\n", '');
 return launch(source);
}
module.exports = {launch, normalize};

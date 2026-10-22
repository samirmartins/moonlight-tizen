'use strict';
// Only the tested private menu snapshot reuse may differ. The streaming
// publisher, sampling, rumble and menu scheduling remain outside this exception.
function normalize(file,source) {
  source=require('./library-navigation-scope.cjs').normalize(file,source);
  if(file!=='wasm/platform/gamepad.js')return source;
  const end=source.indexOf('// Streaming gamepad publisher');
  require('assert')(end>0,'menu/streaming boundary');
  let menu=source.slice(0,end);
  menu=menu.replace('      let changes = null;','      const changes = [];')
    .replaceAll('          if (!changes) changes = [];\n','')
    .replace('      if (changes) {','      if (changes.length) {')
    .replace('        // Event delivery is synchronous: a listener may change the layout.\n'+
      '        if (this.buttons.length !== newButtons.length || this.axes.length !== newAxes.length) {\n'+
      '          this.buttons = newButtons.map((button) => new Button(button));\n'+
      '          this.axes = newAxes.slice();\n          return;\n        }\n','')
    .replace('      // Keep private snapshots stable; browser objects and emitted events stay separate.\n'+
      '      for (let i = 0; i < newButtons.length; ++i) {\n'+
      '        this.buttons[i].value = newButtons[i].value;\n'+
      '        this.buttons[i].pressed = newButtons[i].pressed;\n      }\n'+
      '      for (let i = 0; i < newAxes.length; i++) this.axes[i] = newAxes[i];',
      '      this.buttons = newButtons.map((button) => new Button(button));\n'+
      '      this.axes = newAxes.slice();');
  return menu+source.slice(end);
}
module.exports={normalize};

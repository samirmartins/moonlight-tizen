'use strict';
// Permit only the approved default, never a change to saved preferences,
// stream arguments, timing, actuator methods or rumble policy.
const before='  // Keep the conservative default across Tizen/controller implementations. When\n'+
  '  // disabled, haptics are not advertised to the host; when enabled, updates use\n'+
  '  // the coalesced post-frame path rather than competing with frame delivery.\n'+
  '  const defaultRumbleFeedback = false;\n'+
  "  document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.off();";
const after='  // Default ON for new preferences and explicit resets; preserve saved choices.\n'+
  '  const defaultRumbleFeedback = true;\n'+
  "  document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.on();";
function normalize(file,source) {
  source=require('./wake-play-scope.cjs').normalize(file,source);
  if(file!=='wasm/platform/index.js')return source;
  return source.replace(after,before).replace(
    "    if (previousValue.rumbleFeedback == null) {\n      document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.on(); // Set the default state",
    "    if (previousValue.rumbleFeedback == null) {\n      document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.off(); // Set the default state");
}
module.exports={normalize};

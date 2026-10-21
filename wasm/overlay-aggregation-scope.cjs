'use strict';
// Reorder only the exact overlay aggregation prefix; collection, publication,
// history rollover and every packet/clock/audio operation remain unmasked.
const windowDeclaration='      const uint32_t windowMs =\n'+
  '        statsNowMs - m_ActiveWndVideoStats.measurementStartTimestamp;\n';
const oldPrefix='      // Create a container to hold aggregated stats for display\n'+
  '      VIDEO_STATS lastTwoWndStats = {};\n'+
  '      // Bitrate uses the current window rather than assuming it is exactly one\n'+
  '      // second long.\n'+windowDeclaration+
  '      lastTwoWndStats.receivedBitrate = windowMs != 0\n'+
  '        ? static_cast<float>((total_bytes * 8.0) / 1000.0 / windowMs)\n'+
  '        : 0.0f;\n'+
  '      // Add last window and current window to the aggregated stats\n'+
  '      AddVideoStats(m_LastWndVideoStats, lastTwoWndStats);\n'+
  '      AddVideoStats(m_ActiveWndVideoStats, lastTwoWndStats);\n'+
  '      // Convert the aggregated stats to a display string\n'+
  '      if (g_Instance->m_OverlayStatsEnabled.load(std::memory_order_relaxed)) {\n';
const newPrefix=windowDeclaration+
  '      if (g_Instance->m_OverlayStatsEnabled.load(std::memory_order_relaxed)) {\n'+
  oldPrefix.slice(0,oldPrefix.indexOf(windowDeclaration)).replace(/^      /gm,'        ')+
  oldPrefix.slice(oldPrefix.indexOf(windowDeclaration)+windowDeclaration.length,
    oldPrefix.lastIndexOf('      if (g_Instance')).replace(/^      /gm,'        ');
function normalize(file,source) {
  source=require('./video-recovery-scope.cjs').normalize(file,source);
  if(file!=='wasm/wasmplayer.cpp')return source;
  return source.replace(newPrefix,oldPrefix).replace(
    '    // Flip the shared collection window every two seconds while either\n'+
    '    // the overlay or session diagnostics is enabled.\n',
    '    // Flip performance stats window every two seconds. None of this runs\n'+
    '    // while the overlay is hidden.\n');
}
module.exports={normalize};

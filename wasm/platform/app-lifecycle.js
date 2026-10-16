// Smart Hub policy: disconnect locally on hide, return to the menu on show.
// Event-only: no timers, polling, reconnects or per-frame gameplay work.
var AppLifecycle = (function() {
  var epoch = 0, hidden = !!document.hidden, returnHost = null, returning = false;
  var restoreHostPolling = false;

  function current(token) { return !document.hidden && !hidden && token === epoch; }
  function deferMenu(host) {
    if (!document.hidden && !hidden && !returning) return false;
    if (host) returnHost = host;
    isInGame = false;
    return true;
  }
  function changed() {
    var nextHidden = !!document.hidden;
    if (nextHidden === hidden) return;
    hidden = nextHidden;
    if (hidden) {
      // Dismiss a quit/start confirmation without invoking a host operation.
      var quitDialog = document.getElementById('quitAppDialog');
      if (quitDialog && quitDialog.open) {
        quitDialog.close();
        document.getElementById('quitAppDialogOverlay').style.display = 'none';
        isDialogOpen = false;
        Navigation.pop();
      }
      ++epoch;
      if (isInGame && api) returnHost = api;
      restoreHostPolling = typeof hostPollScopes !== 'undefined' && Object.keys(hostPollScopes).length > 0;
      // Invalidate menu work and pending user-launch continuations before JS
      // is frozen. Native visibility handling owns idempotent stream teardown.
      clearTimeout(startupScanTimer);
      clearTimeout(repeatTimeout);
      clearTimeout(navigationTimeout);
      repeatAction = null;
      stopPollingHosts();
      stopSubnetScanner();
      WakeHost.cancel();
      ConsoleLibrary.pause();
      Controller.stopWatching();
      Navigation.stop();
      stopDisplayRefreshEstimator();
      stopVideoPresentationObserver();
      stopGamepadSnapshot();
      SessionDiagnostics.finish('App hidden');
      stopAudioScheduler(true);
      return;
    }

    var host = returnHost;
    returnHost = null;
    if (host) {
      // Also covers a platform that froze JS before native visibility delivery.
      // stopStream is idempotent; no host quit/launch/resume/WoL is requested.
      returning = true;
      try {
        if (typeof Module !== 'undefined' && typeof Module.stopStream === 'function') Module.stopStream();
      } catch (e) { console.warn('Client disconnect could not be completed.'); }
      finally { returning = false; returnHost = null; }
      isInGame = false;
      showApps(host);
    } else {
      ConsoleLibrary.resume();
      if (restoreHostPolling && !ConsoleLibrary.visible()) startPollingHosts();
    }
    restoreHostPolling = false;
    Controller.startWatching();
    Navigation.start();
    startDisplayRefreshEstimator();
    if (!isDialogOpen) Navigation.switch();
  }
  document.addEventListener('visibilitychange', changed);
  return { epoch: function() { return epoch; }, current: current, deferMenu: deferMenu };
})();

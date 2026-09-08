// Menu-only helpers. No timers, sockets or listeners are started on load.
function normalizeWakeMac(value) {
  var mac = String(value || '').trim();
  if (!/^[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}$/i.test(mac)) return '';
  var bytes = mac.split(/[:-]/).map(function(b) { return parseInt(b, 16); });
  if ((bytes[0] & 1) || bytes.every(function(b) { return b === 0; })) return '';
  return bytes.map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join(':').toUpperCase();
}

function createMenuRequestScope() {
  var pending = [];
  var scope = {
    active: true,
    cancel: function() {
      scope.active = false;
      pending.slice().forEach(function(cancel) { cancel(); });
    },
    request: function(factory, timeoutMs) {
      return new Promise(function(resolve, reject) {
        if (!scope.active) { reject(new Error('Menu request cancelled')); return; }
        var settled = false;
        var timer, operation;
        var finish = function(error, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error && operation && typeof operation.cancel === 'function') operation.cancel();
          var index = pending.indexOf(cancel);
          if (index !== -1) pending.splice(index, 1);
          if (error) reject(error); else resolve(value);
        };
        var cancel = function() { finish(new Error('Menu request cancelled')); };
        pending.push(cancel);
        timer = setTimeout(function() { finish(new Error('PC did not respond')); }, timeoutMs);
        try {
          operation = factory();
          operation.then(function(value) {
            if (scope.active) finish(null, value); else cancel();
          }, function(error) { finish(error || new Error('Request failed')); });
        } catch (error) { finish(error); }
      });
    }
  };
  return scope;
}

function openUtilityDialog(id, controls, closeId) {
  var dialog = document.getElementById(id);
  if (!dialog.showModal) dialogPolyfill.registerDialog(dialog);
  dialog.parentElement.style.display = 'flex';
  dialog.showModal();
  isDialogOpen = true;
  Views.UtilityDialog.controls = controls;
  Views.UtilityDialog.closeId = closeId;
  Navigation.push(Views.UtilityDialog);
  dialog.oncancel = function(event) {
    event.preventDefault();
    document.getElementById(closeId).click();
  };
}

function closeUtilityDialog(id) {
  var dialog = document.getElementById(id);
  if (!dialog.open) return;
  dialog.close();
  dialog.parentElement.style.display = 'none';
  isDialogOpen = false;
  Navigation.pop();
}

var WakeHost = (function() {
  var host = null, scope = null, retry = 0, deadline = 0, opened = false;
  function status(text) { document.getElementById('wakeStatus').textContent = text; }
  function cancel() {
    if (scope) scope.cancel();
    scope = null;
    clearTimeout(retry);
    clearTimeout(deadline);
    retry = deadline = 0;
    document.getElementById('wakeSend').disabled = false;
  }
  function close() {
    cancel();
    opened = false;
    closeUtilityDialog('wakeDialog');
    if (!isInGame && host && hosts[host.serverUid] === host) beginBackgroundPollingOfHost(host);
  }
  function save() {
    var mac = normalizeWakeMac(document.getElementById('wakeMac').value);
    if (!mac) { status('Invalid MAC. Use six pairs, e.g. 12:34:56:78:9A:BC (physical LAN adapter).'); return false; }
    host.wakeMacOverride = mac;
    document.getElementById('wakeMac').value = mac;
    saveHosts();
    status('MAC saved for this PC. Enable Wake-on-LAN in its BIOS/UEFI and network adapter.');
    return true;
  }
  function send() {
    if (scope || isInGame || !save()) return;
    endBackgroundPollingOfHost(host);
    scope = createMenuRequestScope();
    var current = scope;
    var valid = function() { return opened && current.active && scope === current && !isInGame; };
    document.getElementById('wakeSend').disabled = true;
    status('Sending Wake-on-LAN...');
    deadline = setTimeout(function() {
      if (!valid()) return;
      cancel();
      status('Sunshine not ready yet. Close this dialog; the PC list will keep checking automatically.');
      if (hosts[host.serverUid] === host) beginBackgroundPollingOfHost(host);
    }, 60000);
    var check = function() {
      if (!valid()) return;
      new Promise(function(resolve, reject) {
        host.selectServerAddress(resolve, reject, current);
      }).then(function(address) {
        if (!valid()) return;
        host.address = address;
        var urlAddress = formatAddressForUrl(address);
        host._baseUrlHttp = 'http://' + urlAddress + ':' + host.httpPort;
        host._baseUrlHttps = 'https://' + urlAddress + ':' + host.httpsPort;
        host.online = true;
        host._consecutivePollFailures = 0;
        updateHostStatusIndicator(host);
        var cell = document.getElementById('host-' + host.serverUid);
        if (cell) cell.classList.remove('host-cell-inactive');
        cancel();
        status('PC online — Sunshine/GameStream responded. Close to connect.');
      }, function() {
        if (valid()) retry = setTimeout(check, 3000);
      });
    };
    current.request(function() { return host.sendWOL(); }, 8000).then(function() {
      if (!valid()) return;
      status('Wake packet sent. Waiting up to 60 s for Sunshine/GameStream (sent does not mean awake).');
      check();
    }, function(error) {
      if (!valid()) return;
      cancel();
      status('Could not send: ' + (error.message || error));
    });
  }
  return {
    cancel: cancel,
    hostUpdated: function(updatedHost) {
      if (opened && host === updatedHost && !scope && host.online) {
        status('PC online — Sunshine/GameStream responded. Close to connect.');
      }
    },
    open: function(selectedHost) {
      if (isInGame || isDialogOpen) return;
      cancel();
      host = selectedHost;
      endBackgroundPollingOfHost(host);
      opened = true;
      document.getElementById('wakeTitle').textContent = 'Wake PC — ' + host.hostname;
      document.getElementById('wakeMac').value = normalizeWakeMac(host.wakeMacOverride || host.macAddress);
      status('Same local network. Requires Wake-on-LAN enabled on the PC. Wi-Fi/shutdown support depends on its hardware.');
      document.getElementById('wakeSend').onclick = send;
      document.getElementById('wakeSave').onclick = save;
      document.getElementById('wakeDetected').onclick = function() {
        cancel();
        delete host.wakeMacOverride;
        document.getElementById('wakeMac').value = normalizeWakeMac(host.macAddress);
        saveHosts();
        status('Using detected MAC. If empty/wrong, enter the physical LAN adapter MAC.');
      };
      document.getElementById('wakeClose').onclick = close;
      openUtilityDialog('wakeDialog', ['wakeMac', 'wakeSend', 'wakeSave', 'wakeDetected', 'wakeClose'], 'wakeClose');
    }
  };
})();

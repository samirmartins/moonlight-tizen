// Tizen's WRT cannot receive mDNS replies, so discovery probes the local IPv4
// /24 over HTTP. The scan is canceled before streaming to leave the main thread
// and network stack entirely to the active session.
var subnetScan = null;

function findNvService(ipString, scan) {
  var ip = ipString.replace('ipv4:', '');

  for (var hostUID in hosts) {
    if (hosts[hostUID].address === ip) {
      return;
    }
  }

  var discoveredHost = new NvHTTP(ip, myUniqueid);
  discoveredHost.httpPort = 47989;
  discoveredHost.httpsPort = 47984;

  discoveredHost.pollServer(function(returnedDiscoveredHost) {
    if ((scan && scan.stopped) || !returnedDiscoveredHost.online) {
      return;
    }

    var existingHost = hosts[returnedDiscoveredHost.serverUid];
    if (!existingHost) {
      addHostToGrid(returnedDiscoveredHost, true);
      beginBackgroundPollingOfHost(returnedDiscoveredHost);
      saveHosts();
      return;
    }

    var existingAddress = existingHost.address;
    if (existingAddress === returnedDiscoveredHost.address) {
      return;
    }

    var isIpv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(existingAddress);
    if (!isIpv4 && existingHost.online) {
      console.log('%c[main.js, findNvService]', 'color: gray;',
        'Keeping online non-IPv4 address:', existingAddress);
      return;
    }

    console.log('%c[main.js, findNvService]', 'color: gray;',
      'Updating host address from', existingAddress, 'to', returnedDiscoveredHost.address);
    existingHost.address = returnedDiscoveredHost.address;
    if (typeof existingHost.updateExternalAddressIP4 === 'function') {
      existingHost.updateExternalAddressIP4();
    }
    saveHosts();
  });
}

function stopSubnetScanner() {
  if (!subnetScan) {
    return;
  }

  subnetScan.stopped = true;
  subnetScan.controllers.forEach(function(controller) {
    controller.abort();
  });
  subnetScan = null;
}

function startSubnetScanner() {
  stopSubnetScanner();

  try {
    var localIp = (typeof webapis !== 'undefined' && webapis.network) ? webapis.network.getIp() : null;
    if (!localIp) {
      console.warn('%c[main.js, startSubnetScanner]', 'color: orange;',
        'Could not determine local IP; skipping discovery.');
      return;
    }

    var parts = localIp.split('.');
    if (parts.length !== 4) {
      console.warn('%c[main.js, startSubnetScanner]', 'color: orange;',
        'Unexpected IP format:', localIp);
      return;
    }

    var subnet = parts[0] + '.' + parts[1] + '.' + parts[2];
    var scan = { controllers: [], pending: 254, stopped: false };
    subnetScan = scan;
    console.log('%c[main.js, startSubnetScanner]', 'color: green;',
      'Starting subnet scan on', subnet + '.0/24');

    function probeFinished() {
      scan.pending--;
      if (scan.pending === 0 && subnetScan === scan) {
        subnetScan = null;
      }
    }

    for (var i = 1; i <= 254; i++) {
      (function(ip) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if (controller) {
          scan.controllers.push(controller);
        }
        var timeoutId = setTimeout(function() {
          if (controller) {
            controller.abort();
          }
        }, 3000);

        fetch('http://' + ip + ':47989/serverinfo', controller ? { signal: controller.signal } : {})
          .then(function(response) {
            if (!scan.stopped && response.ok) {
              console.log('%c[main.js, startSubnetScanner]', 'color: green;', 'Found host:', ip);
              findNvService('ipv4:' + ip, scan);
            }
          })
          .catch(function() {})
          .then(function() {
            clearTimeout(timeoutId);
            probeFinished();
          });
      })(subnet + '.' + i);
    }
  } catch (error) {
    stopSubnetScanner();
    console.error('%c[main.js, startSubnetScanner]', 'color: red;',
      'Subnet scanner failed:', error);
  }
}

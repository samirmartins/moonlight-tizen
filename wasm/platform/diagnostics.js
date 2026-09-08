// Opt-in session diagnostics. OFF: no timer, observer, resource query, sample
// buffer or native collection. The last report is read only on user request.
var SessionDiagnostics = (function() {
  var session = null;
  var serial = 0;
  var report = null;
  var storageKey = 'moonlight.diagnosticReport.v1';
  function number(value) { return typeof value === 'number' && isFinite(value); }
  function fmt(value, digits) { return number(value) ? value.toFixed(digits === undefined ? 1 : digits) : '--'; }
  function seconds(ms) { return fmt(ms / 1000, 0) + 's'; }
  function measure(s, key, value, weight) {
    if (!number(value)) return;
    var m = s.metrics[key] || (s.metrics[key] = { sum: 0, weight: 0, min: value, max: value });
    m.sum += value * weight; m.weight += weight;
    m.min = Math.min(m.min, value); m.max = Math.max(m.max, value);
  }
  function average(s, key) { var m = s.metrics[key]; return m && m.weight ? m.sum / m.weight : null; }
  function maximum(s, key) { return s.metrics[key] ? s.metrics[key].max : null; }
  function trend(s, key) {
    function mean(list) {
      var sum = 0, weight = 0;
      list.forEach(function(w) {
        if (number(w[key])) { sum += w[key] * w.ms; weight += w.ms; }
      });
      return weight ? sum / weight : null;
    }
    return fmt(mean(s.first)) + '→' + fmt(mean(s.last));
  }
  function quality(video) {
    try {
      var q = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
      var dropped = q ? q.droppedVideoFrames : video.webkitDroppedFrameCount;
      return number(dropped) && dropped >= 0 ? dropped : null;
    } catch (error) { return null; }
  }
  function readAudio(s) {
    if (typeof _audRefreshStats !== 'function') return;
    _audRefreshStats();
    var a = window._mlAudioStats;
    if (!a || !a.started) return;
    s.audioBackend = a.backend;
    measure(s, 'audioQueue', a.depthMs, 1);
    measure(s, 'audioTarget', a.targetMs, 1);
    ['underruns', 'overruns'].forEach(function(k) {
      if (!number(a[k])) return;
      if (s.audioLast[k] !== undefined && a[k] >= s.audioLast[k]) s.audioDelta[k] += a[k] - s.audioLast[k];
      s.audioLast[k] = a[k];
    });
  }
  function resources(s) {
    // Values are TV-wide, NOT the app's CPU usage, free decoder RAM or temperature.
    try {
      var sys = tizen.systeminfo;
      var free = sys.getAvailableMemory();
      if (number(free) && free > 0) {
        if (s.freeFirst === null) s.freeFirst = free / 1048576;
        s.freeLast = free / 1048576;
        measure(s, 'freeMb', s.freeLast, 1);
      }
      if (!s.cpuPending && typeof sys.getPropertyValue === 'function') {
        s.cpuPending = true;
        sys.getPropertyValue('CPU', function(cpu) {
          if (session !== s) return;
          s.cpuPending = false;
          if (cpu && number(cpu.load)) measure(s, 'cpu', cpu.load * 100, 1);
        }, function() { if (session === s) s.cpuPending = false; });
      }
    } catch (error) { /* capability unavailable: keep --, never invent zero */ }
  }
  function observe(s) {
    var v = s.video;
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    s.presentationSupported = true;
    var callback = function(now, metadata) {
      if (session !== s) return;
      metadata = metadata || {};
      var time = number(metadata.expectedDisplayTime) ? metadata.expectedDisplayTime :
        (number(metadata.presentationTime) ? metadata.presentationTime : now);
      var frames = metadata.presentedFrames;
      var delta = number(frames) && frames > s.lastFrame && s.lastFrame > 0 ? frames - s.lastFrame : 1;
      if (s.lastPresent !== null && time > s.lastPresent) {
        var raw = time - s.lastPresent;
        var interval = raw / delta;
        s.presentationN++;
        s.presentationSum += interval;
        s.presentationMax = Math.max(s.presentationMax, interval);
        s.callbackMax = Math.max(s.callbackMax, raw);
        if (delta > 1) s.coalesced++;
        // Retain long intervals, unlike the unchanged overlay estimator.
        s.presentationBins[Math.min(2047, Math.floor(interval))]++;
        s.presented += delta;
        s.presentedElapsed += raw;
        s.windowPresented += delta;
        s.windowPresentMs += raw;
        s.windowPresentMax = Math.max(s.windowPresentMax, interval);
      }
      s.lastPresent = time;
      if (number(frames)) s.lastFrame = frames;
      try { s.request = v.requestVideoFrameCallback(callback); }
      catch (error) { s.presentationSupported = false; s.request = 0; }
    };
    try { s.request = v.requestVideoFrameCallback(callback); }
    catch (error) { s.presentationSupported = false; }
  }
  function readVariant(s) {
    // Read the actual package metadata, not a TV-model guess.
    try {
      var request = s.configRequest = new XMLHttpRequest();
      request.open('GET', 'config.xml', true);
      request.onload = function() {
        if (session !== s) return;
        s.variant = /use.game.mode"\s+value="true"/.test(request.responseText) ? 'ForceGM' : 'Normal';
        s.configRequest = null;
      };
      request.onerror = function() { if (session === s) s.configRequest = null; };
      request.send();
    } catch (error) { s.configRequest = null; }
  }
  function start() {
    var control = document.getElementById('diagnosticsSwitch');
    if (!control || !control.checked || session) return;
    var s = session = {
      gen: ++serial, start: performance.now(), connectedAt: null, nativeMs: 0, windows: 0,
      timer: 0, request: 0, video: null, handlers: [], metrics: {}, first: [], last: [],
      total: 0, lost: 0, rejected: 0, recovered: 0, hostN: 0, hostLate: 0, cadN: 0, cadLate: 0,
      presentationBins: new Uint32Array(2048), presentationN: 0, presentationSum: 0,
      presentationMax: 0, callbackMax: 0, coalesced: 0, presented: 0, lastFrame: 0, lastPresent: null,
      presentedElapsed: 0, windowPresented: 0, windowPresentMs: 0, windowPresentMax: 0, peak: null,
      dropLast: null, dropDelta: 0, dropValid: false, counterResets: 0,
      audioLast: {}, audioDelta: { underruns: 0, overruns: 0 }, audioBackend: '--',
      freeFirst: null, freeLast: null, cpuPending: false, loopMax: 0, stalled: 0, errors: 0,
      warnings: 0, lastError: '', variant: '?', leadInactive: 0, leadSettled: 0,
      config: 'Waiting for stream', note: '', ticks: 0,
      options: 'rumble ' + (document.getElementById('rumbleFeedbackSwitch').checked ? 'on' : 'off') +
        ' · HDR ' + (document.getElementById('hdrModeSwitch').checked ? 'on' : 'off') +
        ' · GM ' + (document.getElementById('gameModeSwitch').checked ? 'on' : 'off')
    };
    Module.setDiagnostics(s.gen);
    readVariant(s);
  }
  function connected() {
    var s = session;
    if (!s || s.connectedAt !== null) return;
    s.connectedAt = performance.now();
    s.video = document.getElementById('wasm_module');
    s.dropLast = quality(s.video);
    s.dropValid = s.dropLast !== null;
    readAudio(s);
    resources(s);
    ['waiting', 'stalled', 'error'].forEach(function(type) {
      var fn = function() {
        if (session !== s) return;
        if (type === 'error') s.errors++; else s.stalled++;
      };
      s.video.addEventListener(type, fn);
      s.handlers.push([type, fn]);
    });
    observe(s);
    var expected = performance.now() + 2000;
    var tick = function() {
      if (session !== s) return;
      var now = performance.now();
      s.loopMax = Math.max(s.loopMax, Math.max(0, now - expected));
      readAudio(s);
      var dropped = quality(s.video);
      if (dropped !== null) {
        s.dropValid = true;
        if (s.dropLast !== null) {
          if (dropped >= s.dropLast) s.dropDelta += dropped - s.dropLast;
          else s.counterResets++;
        }
        s.dropLast = dropped;
      }
      if (++s.ticks % 5 === 0) resources(s);
      expected = performance.now() + 2000;
      s.timer = setTimeout(tick, 2000);
    };
    s.timer = setTimeout(tick, 2000);
  }
  function sample(text) {
    var s = session;
    if (!s) return;
    var w;
    try { w = JSON.parse(text); } catch (error) { return; }
    if (!w || w.gen !== s.gen || !number(w.ms) || w.ms <= 0) return;
    if (!['w', 'h', 'fmt', 'fps', 'bytes', 'rx', 'sub', 'total', 'lost', 'rej', 'rec',
      'rtt', 'rttVar', 'hostN', 'hostLate', 'hostMean', 'hostP95', 'enc', 'encMax',
      'asm', 'asmP95', 'asmMax', 'app', 'appP95', 'appMax', 'cadN', 'cadLate',
      'cadP95', 'cadMax', 'leadN', 'lead', 'leadAbsMax', 'filtered', 'target',
      'servo', 'settle', 'clockAge', 'step'].every(function(k) { return number(w[k]); })) return;
    // A fixed schema, bounded aggregates and only ~30 s of first/last windows.
    s.windows++; s.nativeMs += w.ms;
    var codec = { 1: 'H264', 256: 'HEVC', 512: 'HEVC10', 4096: 'AV1', 8192: 'AV1-10' }[w.fmt] || ('fmt' + w.fmt);
    s.config = w.w + '×' + w.h + ' ' + codec + ' ' + w.fps + 'fps';
    s.fps = w.fps;
    w.rxFps = w.rx * 1000 / w.ms;
    w.subFps = w.sub * 1000 / w.ms;
    w.hostFps = w.hostN > 0 && w.hostMean > 0 ? 1000 / w.hostMean : null;
    w.bitrate = w.bytes * 8 / w.ms / 1000;
    w.outFps = s.windowPresentMs > 0 ? s.windowPresented * 1000 / s.windowPresentMs : null;
    var peakScore = s.windowPresentMax || w.cadMax;
    if (!s.peak || peakScore > s.peak.score) {
      s.peak = { score: peakScore, at: s.nativeMs / 1000, host: w.hostP95,
        cad: w.cadP95, app: w.appMax, lead: w.leadN ? w.lead : null };
    }
    s.windowPresented = s.windowPresentMs = s.windowPresentMax = 0;
    if (!w.leadN) { w.lead = null; w.leadAbsMax = null; }
    if (w.clockAge < 0) w.clockAge = null;
    if (w.rtt < 0) w.rtt = null;
    if (w.enc < 0) w.enc = null;
    if (!w.hostN) { w.hostP95 = null; w.hostMean = null; }
    if (!w.cadN) { w.cadP95 = null; w.cadMax = null; }
    ['rxFps', 'subFps', 'hostFps', 'outFps', 'bitrate', 'rtt', 'rttVar', 'hostMean', 'hostP95',
      'enc', 'encMax', 'asm', 'asmP95', 'asmMax', 'app', 'appP95', 'appMax',
      'cadP95', 'cadMax', 'lead', 'leadAbsMax', 'clockAge', 'filtered', 'target', 'step'
    ].forEach(function(k) { measure(s, k, w[k], w.ms); });
    s.total += w.total; s.lost += w.lost; s.rejected += w.rej; s.recovered += w.rec;
    s.hostN += w.hostN; s.hostLate += w.hostLate;
    s.cadN += w.cadN; s.cadLate += w.cadLate;
    if (w.leadN && w.settle >= 1800) {
      s.leadSettled++;
      if (!w.servo) s.leadInactive++;
    }
    s.lastServo = w.servo;
    s.lastTarget = w.target;
    if (s.first.length < 15) s.first.push(w);
    s.last.push(w);
    if (s.last.length > 15) s.last.shift();
  }
  function percentile(s) {
    if (!s.presentationN) return null;
    var rank = Math.ceil(s.presentationN * 0.95), count = 0;
    for (var i = 0; i < s.presentationBins.length; i++) {
      count += s.presentationBins[i];
      if (count >= rank) return i === 2047 ? s.presentationMax : i + 1;
    }
    return null;
  }
  function makeReport(s, reason) {
    var duration = s.connectedAt === null ? 0 : performance.now() - s.connectedAt;
    var nativeSeconds = s.nativeMs / 1000;
    var loss = s.total ? s.lost * 100 / s.total : null;
    var hostLate = s.hostN ? s.hostLate * 100 / s.hostN : null;
    var cadLate = s.cadN ? s.cadLate * 100 / s.cadN : null;
    var dropRate = s.dropValid && duration > 0 ? s.dropDelta * 60000 / duration : null;
    var output = s.presentedElapsed > 0 ? s.presented * 1000 / s.presentedElapsed : null;
    var hints = [];
    if (!s.windows) hints.push('No video samples');
    if (s.windows && nativeSeconds < 30) hints.push('Short capture');
    if (loss > 0) hints.push('Frame gaps before client submission');
    if (hostLate > 1) hints.push('Host cadence varied');
    if (s.presentationMax > 1000 / (s.fps || 60) * 1.5) hints.push('Presentation intervals varied');
    if (s.leadInactive) hints.push('Clock target uncalibrated in ' + s.leadInactive + ' windows');
    if (s.loopMax > 50) hints.push('JS scheduling delays');
    if (s.audioDelta.underruns || s.audioDelta.overruns) hints.push('Audio U/O increased');
    if (s.errors || s.warnings) hints.push('Stream events recorded');
    if (!hints.length) hints.push('No clear anomaly in available samples');
    var rows = [
      ['FPS', 'H/R/S/O ' + [average(s, 'hostFps'), average(s, 'rxFps'), average(s, 'subFps'), output].map(function(v) { return fmt(v); }).join('/') +
        ' · O start→end ' + trend(s, 'outFps') + ' · ' + fmt(average(s, 'bitrate')) + 'Mb/s'],
      ['Net / Host', 'loss ' + fmt(loss, 2) + '% · RTT a/x ' + fmt(average(s, 'rtt')) + '/' + fmt(maximum(s, 'rtt')) +
        'ms · host late ' + fmt(hostLate) + '% · enc a/x ' + fmt(average(s, 'enc')) + '/' + fmt(maximum(s, 'encMax')) + 'ms'],
      ['Work', 'asm a/x ' + fmt(average(s, 'asm'), 2) + '/' + fmt(maximum(s, 'asmMax'), 2) +
        ' · append a/x ' + fmt(average(s, 'app'), 2) + '/' + fmt(maximum(s, 'appMax'), 2) + 'ms · rej ' + s.rejected],
      ['Cadence', 'late ' + fmt(cadLate) + '% · p95 start→end ' + trend(s, 'cadP95') + 'ms · worst p95/x ' +
        fmt(maximum(s, 'cadP95')) + '/' + fmt(maximum(s, 'cadMax')) + 'ms'],
      ['Present', 'interval p95/x ' + fmt(percentile(s)) + '/' + (s.presentationN ? fmt(s.presentationMax) : '--') +
        'ms · drop +' + (s.dropValid ? s.dropDelta : '--') + ' (' + fmt(dropRate) + '/m) · CB x ' + fmt(s.presentationN ? s.callbackMax : null) + 'ms · coal ' + s.coalesced],
      ['Clock*', 'lead start→end ' + trend(s, 'lead') + 'ms · |x| ' + fmt(maximum(s, 'leadAbsMax')) +
        ' · age x ' + fmt(maximum(s, 'clockAge')) + 'ms · target ' + (s.lastServo ? fmt(s.lastTarget) : 'unset') + ' · rec ' + s.recovered],
      ['Audio', s.audioBackend + ' · q a/x ' + fmt(average(s, 'audioQueue')) + '/' + fmt(maximum(s, 'audioQueue')) +
        'ms · target ' + fmt(average(s, 'audioTarget')) + 'ms · ΔU/O ' +
        (s.audioBackend === '--' ? '--/--' : s.audioDelta.underruns + '/' + s.audioDelta.overruns)],
      ['TV / JS', 'free start→end ' + fmt(s.freeFirst, 0) + '→' + fmt(s.freeLast, 0) + 'MB · TV CPU a/x ' +
        fmt(average(s, 'cpu'), 0) + '/' + fmt(maximum(s, 'cpu'), 0) + '% · JS delay x ' + fmt(s.loopMax) + 'ms'],
      ['Events', 'wait/stall ' + s.stalled + ' · error ' + s.errors + ' · warn ' + s.warnings +
        ' · counters reset ' + s.counterResets + ' · ' + String(s.lastError || reason).slice(0, 90)]
    ];
    return {
      title: 'Diagnosis · ' + appInfo.version + ' ' + s.variant + ' · ' + seconds(duration),
      config: s.config + ' · ' + s.options,
      device: modelName + ' · Tizen ' + platformVer + ' · native capture ' + seconds(s.nativeMs) + '/' + seconds(duration),
      rows: rows,
      finding: hints.slice(0, 4).join('; ') + '. Indications, not proven causes.',
      peak: s.peak ? 'Peak window @' + fmt(s.peak.at, 0) + 's: host/cad p95 ' +
        fmt(s.peak.host) + '/' + fmt(s.peak.cad) + ' · app x ' + fmt(s.peak.app) +
        ' · lead ' + fmt(s.peak.lead) + 'ms' : '',
      foot: '*Clock ≠ input latency. CB = callback; coalesced callbacks ≠ drops. p95: windows; start/end ≈30s. -- = no data.'
    };
  }
  function finish(reason) {
    var s = session;
    if (!s) return;
    readAudio(s);
    if (s.video) {
      var dropped = quality(s.video);
      if (dropped !== null && s.dropLast !== null && dropped >= s.dropLast) s.dropDelta += dropped - s.dropLast;
    }
    session = null; // Invalidate callbacks before cancelling or saving.
    Module.setDiagnostics(0);
    clearTimeout(s.timer);
    if (s.configRequest) s.configRequest.abort();
    if (s.video) {
      if (s.request && typeof s.video.cancelVideoFrameCallback === 'function') {
        try { s.video.cancelVideoFrameCallback(s.request); } catch (error) {}
      }
      s.handlers.forEach(function(h) { s.video.removeEventListener(h[0], h[1]); });
    }
    report = makeReport(s, reason || 'Stopped');
    // Save one small, bounded report, only AFTER collection has stopped.
    try { localStorage.setItem(storageKey, JSON.stringify(report)); } catch (error) {}
    snackbarLogLong('Diagnosis ready: Settings → Advanced → Last diagnosis.');
  }
  function show() {
    if (isInGame || isDialogOpen) return;
    if (!report) {
      try { report = JSON.parse(localStorage.getItem(storageKey)); } catch (error) {}
    }
    if (!report || !Array.isArray(report.rows)) {
      snackbarLogLong('Enable Session diagnosis before playing. Exit the stream, then open Last diagnosis.');
      return;
    }
    document.getElementById('diagnosisTitle').textContent = report.title;
    document.getElementById('diagnosisConfig').textContent = report.config;
    document.getElementById('diagnosisDevice').textContent = report.device;
    var table = document.getElementById('diagnosisRows');
    table.textContent = '';
    report.rows.slice(0, 9).forEach(function(row) {
      var tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
      th.textContent = row[0]; td.textContent = row[1];
      tr.appendChild(th); tr.appendChild(td); table.appendChild(tr);
    });
    document.getElementById('diagnosisFinding').textContent = report.finding;
    document.getElementById('diagnosisPeak').textContent = report.peak || '';
    document.getElementById('diagnosisFoot').textContent = report.foot;
    document.getElementById('diagnosisClose').onclick = function() { closeUtilityDialog('diagnosisDialog'); };
    openUtilityDialog('diagnosisDialog', ['diagnosisClose'], 'diagnosisClose');
  }
  return {
    start: start, connected: connected, sample: sample, finish: finish, show: show,
    changed: function() { if (!document.getElementById('diagnosticsSwitch').checked) finish('Disabled by user'); },
    note: function(text, error) {
      if (!session) return;
      if (error) session.errors++; else session.warnings++;
      session.lastError = String(text).slice(0, 90);
    }
  };
})();

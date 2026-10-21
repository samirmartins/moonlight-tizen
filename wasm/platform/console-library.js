// Menu-only console launcher. No polling, animation or per-frame work on load.
var ConsoleLibrary = (function() {
  var key = 'moonlight.console.v1';
  var prefs = { preferred: '', hosts: {} };
  var host = null, apps = [], selected = 0, filter = 'all';
  var active = false, scope = null, coverScope = null, epoch = 0, busy = false, checking = false;
  var settingsReturn = false, wakeScope = null, reloading = false;
  var runtimeReady = false, hostsReady = false, started = false, bound = false;
  var navIndex = 0, currentRecord = null;
  var launchPending = false, launchTimer = 0;
  var refreshPending = null, refreshCovers = false;
  try {
    var saved = JSON.parse(localStorage.getItem(key));
    if (saved && typeof saved.preferred === 'string' && saved.hosts && typeof saved.hosts === 'object') prefs = saved;
  } catch (e) {} // A missing/corrupt/full store must never prevent playing.

  // Compact focus persistence: merge before opening any PC, not just its owner.
  // A single bounded record avoids serializing every cached app on each move.
  var selectedCard = null;
  try {
    var savedFocus = JSON.parse(localStorage.getItem(key + '.focus'));
    if (Array.isArray(savedFocus) && savedFocus.length === 2 &&
        typeof savedFocus[0] === 'string' && id(savedFocus[1]) &&
        savedFocus[0] !== '__proto__' && savedFocus[0] !== 'constructor' && savedFocus[0] !== 'prototype' &&
        Object.prototype.hasOwnProperty.call(prefs.hosts, savedFocus[0]) &&
        prefs.hosts[savedFocus[0]] && typeof prefs.hosts[savedFocus[0]] === 'object') {
      prefs.hosts[savedFocus[0]].focus = id(savedFocus[1]);
    }
  } catch (e) {} // Keep the legacy focus when compact storage is unavailable.
  function saveFocus() {
    try { localStorage.setItem(key + '.focus', JSON.stringify([String(host.serverUid), record().focus])); }
    catch (e) { save(); } // Keep the last good focus if every write fails.
  }
  // End compact focus persistence.

  function el(id) { return document.getElementById(id); }
  function id(value) { var n = Number(value); return Number.isInteger(n) && n > 0 && n <= 0xffffffff ? n : 0; }
  function cleanApps(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).filter(function(app) {
      if (!app || !id(app.id) || typeof app.title !== 'string' || seen[app.id]) return false;
      seen[app.id] = true; return true;
    }).map(function(app) { return { id: id(app.id), title: app.title }; });
  }
  // Menu cover reuse: bounded compressed bytes/URLs, never detached image nodes.
  var coverHost = null, renderedHost = null, coverBytes = 0;
  var coverCache = new Map();
  var maxCoverEntries = 64, maxCoverBytes = 4 * 1024 * 1024;
  function forgetCover(appId) {
    var cached = coverCache.get(appId);
    if (cached) { coverBytes -= cached.bytes; coverCache.delete(appId); }
  }
  function invalidateCovers(pc) {
    if (coverHost !== pc) return;
    // An old in-flight decode must not refill the explicitly cleared cache.
    if (coverScope) coverScope.cancel();
    coverScope = null;
    coverCache.clear(); coverBytes = 0; renderedHost = null;
  }
  function prepareCovers() {
    if (coverHost !== host) {
      coverCache.clear(); coverBytes = 0; renderedHost = null; coverHost = host;
    }
    // A removed/renamed app must not resurrect an old cover on a later visit.
    var titles = new Map();
    apps.forEach(function(app) { titles.set(app.id, app.title); });
    coverCache.forEach(function(cached, appId) {
      if (titles.get(appId) !== cached.title) forgetCover(appId);
    });
  }
  function cachedCover(app) {
    var cached = coverCache.get(app.id);
    if (!cached || cached.title !== app.title) return null;
    coverCache.delete(app.id); coverCache.set(app.id, cached);
    if (cached.data) {
      var parts = [];
      for (var i = 0; i < cached.data.length; i += 8192)
        parts.push(String.fromCharCode.apply(null, cached.data.subarray(i, i + 8192)));
      return 'data:image/png;base64,' + btoa(parts.join(''));
    }
    return cached.url;
  }
  function rememberCover(app, url) {
    if (typeof url !== 'string' || !url) return;
    var bytes = (url.length + app.title.length) * 2;
    var data = null;
    // Retain PNG bytes rather than UTF-16 base64: the same 4 MiB budget holds
    // more covers. Rebuild URLs only in the visible menu, never during a game.
    if (url.indexOf('data:image/png;base64,') === 0 && typeof atob === 'function' && typeof btoa === 'function') {
      var payload = url.slice(22);
      var size = payload.length * 3 / 4 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
      if (size + app.title.length * 2 > maxCoverBytes) { forgetCover(app.id); return; }
      try {
        var binary = atob(payload);
        data = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        bytes = data.byteLength + app.title.length * 2;
      } catch (e) { data = null; } // Keep the string fallback for other URL formats.
    }
    forgetCover(app.id);
    // Large images can still be displayed; they must not defeat the budget.
    if (bytes > maxCoverBytes) return;
    while (coverCache.size &&
           (coverCache.size >= maxCoverEntries || coverBytes + bytes > maxCoverBytes)) {
      forgetCover(coverCache.keys().next().value);
    }
    coverCache.set(app.id, { title: app.title, url: data ? null : url, data: data, bytes: bytes });
    coverBytes += bytes;
  }
  // End menu cover reuse.
  function record() {
    var uid = String(host.serverUid);
    if (uid === '__proto__' || uid === 'constructor' || uid === 'prototype') throw new Error('Invalid PC identifier');
    if (!Object.prototype.hasOwnProperty.call(prefs.hosts, uid) || !prefs.hosts[uid] || typeof prefs.hosts[uid] !== 'object') prefs.hosts[uid] = {};
    var r = prefs.hosts[uid];
    if (r === currentRecord) return r;
    r.apps = cleanApps(r.apps);
    r.favorites = Array.isArray(r.favorites) ? r.favorites.map(id).filter(Boolean) : [];
    r.recent = Array.isArray(r.recent) ? r.recent.map(id).filter(Boolean).slice(0, 20) : [];
    r.focus = id(r.focus);
    currentRecord = r;
    return r;
  }
  function save() {
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
      // Only retire the compact override after every host's focus is saved.
      localStorage.removeItem(key + '.focus');
    } catch (e) {}
  }
  function valid(token) { return active && !isInGame && !document.hidden && token === epoch && host && hosts[host.serverUid] === host; }
  function status(text) { el('libraryStatus').textContent = text; }
  function cancel() {
    epoch++;
    if (scope) scope.cancel();
    if (coverScope) coverScope.cancel();
    scope = null;
    coverScope = null;
    checking = false; busy = false;
    refreshPending = null; refreshCovers = false;
    if (wakeScope) wakeScope.cancel();
    wakeScope = null;
  }
  function hide() {
    cancel(); active = false;
    clearTimeout(launchTimer); launchTimer = 0; launchPending = false;
    document.body.classList.remove('console-library');
    el('console-panel').style.display = 'none';
    el('libraryPCsBtn').style.display = 'none';
    el('libraryHomeBtn').style.display = 'none';
  }
  function suspend() {
    // Called before streaming. Late replies cannot render, save or start tasks.
    hide();
    el('game-grid').textContent = '';
    selectedCard = null;
  }
  function pause() {
    cancel();
    clearTimeout(launchTimer); launchTimer = 0; launchPending = false;
  }
  function resume() {
    if (document.hidden) return;
    if (active) { refresh(); focusCards(); }
    else if (!started && runtimeReady && hostsReady) ready('runtime');
  }
  function preferred() {
    if (Object.prototype.hasOwnProperty.call(hosts, prefs.preferred)) return hosts[prefs.preferred];
    var values = Object.keys(hosts).map(function(uid) { return hosts[uid]; });
    return values.length === 1 ? values[0] : null;
  }
  function controls() {
    return ['libraryPCsBtn','settingsBtn','quitRunningAppBtn','libraryWake','libraryPlay','libraryFavorite','libraryAll','libraryFavorites','libraryRecent','libraryRefresh'].filter(function(name) {
      var node = el(name); return node && !node.disabled && node.style.display !== 'none' && !node.hidden;
    });
  }
  function focusNav(step) {
    var names = controls();
    if (!names.length) return;
    navIndex = Math.max(0, Math.min(names.length - 1, navIndex + (step || 0)));
    names.forEach(function(name) { el(name).classList.remove('hovered'); });
    el(names[navIndex]).classList.add('hovered');
    focusElement(names[navIndex]);
  }
  function picked() { return apps.find(function(app) { return app.id === selected; }); }
  function hostReady() { return host.online && (!host.ppkstr || host._authenticatedOnline === true); }
  function updateSelection() {
    var app = picked(), r = record();
    el('libraryTitle').textContent = app ? app.title : 'Your library';
    el('libraryPlay').textContent = app && Number(host.currentGame) === app.id ? 'Resume' : 'Play';
    // Availability is advisory. Play never wakes a PC or waits for a probe.
    el('libraryPlay').disabled = !app;
    el('libraryWake').disabled = !!wakeScope;
    el('libraryFavorite').disabled = !app || busy;
    el('libraryFavorite').textContent = app && r.favorites.indexOf(app.id) !== -1 ? '★ Favorite' : '☆ Favorite';
    el('libraryFavorite').setAttribute('aria-pressed', !!app && r.favorites.indexOf(app.id) !== -1);
    el('libraryRefresh').disabled = false;
    el('quitRunningAppBtn').style.display = host.online && Number(host.currentGame) > 0 ? '' : 'none';
    var card = el('game-container-' + selected);
    if (card && card.parentNode !== el('game-grid')) card = null;
    if (selectedCard !== card) {
      if (selectedCard) { selectedCard.classList.toggle('hovered', false); selectedCard.tabIndex = -1; }
      selectedCard = card;
    }
    if (card && !card.classList.contains('hovered')) card.classList.toggle('hovered', true);
    if (card && card.tabIndex !== 0) card.tabIndex = 0;
  }
  function select(appId) {
    if (!active || isInGame || !id(appId) || id(appId) === selected) return;
    selected = id(appId); record().focus = selected; saveFocus(); updateSelection();
  }
  function list() {
    var r = record(), descending = el('sortAppsListSwitch').checked;
    var result = apps.filter(function(app) {
      return filter === 'all' || (filter === 'favorites' ? r.favorites : r.recent).indexOf(app.id) !== -1;
    });
    return result.sort(function(a,b) {
      if (filter === 'recent') return r.recent.indexOf(a.id) - r.recent.indexOf(b.id);
      var ar = Number(host.currentGame) === a.id ? 0 : r.favorites.indexOf(a.id) !== -1 ? 1 : 2;
      var br = Number(host.currentGame) === b.id ? 0 : r.favorites.indexOf(b.id) !== -1 ? 1 : 2;
      if (ar !== br) return ar - br;
      var order = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
      return descending ? -order : order;
    });
  }
  function render(forceCovers, cacheOnly) {
    if (!active || isInGame) return;
    var r = record(), items = list(), grid = el('game-grid'), token = epoch, fragment = document.createDocumentFragment();
    prepareCovers();
    var previous = new Map(), cards = [], queue = [];
    if (renderedHost === host) {
      Array.from(grid.children).forEach(function(card) { previous.set(Number(card.dataset.appId), card); });
    }
    if (!items.some(function(app) { return app.id === selected; })) selected = items.length ? items[0].id : 0;
    items.forEach(function(app) {
      var card = previous.get(app.id), image, label, badge;
      if (!card) {
        card = document.createElement('button');
        card.type = 'button'; card.id = 'game-container-' + app.id;
        card.tabIndex = -1;
        card.className = 'game-container console-card'; card.dataset.appId = app.id;
        image = document.createElement('img'); image.alt = '';
        label = document.createElement('span'); label.className = 'console-card-title';
        badge = document.createElement('span'); badge.className = 'console-card-badge';
        card.appendChild(image); card.appendChild(label); card.appendChild(badge);
        card.onclick = function() { select(app.id); play(app.id); };
        card.onfocus = function() { select(app.id); };
      } else {
        image = card.querySelector('img');
        label = card.querySelector('.console-card-title');
        badge = card.querySelector('.console-card-badge');
      }
      card.setAttribute('aria-label', app.title);
      if (label.textContent !== app.title) label.textContent = app.title;
      var badgeText = host.online && Number(host.currentGame) === app.id ? 'Resume' : r.favorites.indexOf(app.id) !== -1 ? '★' : '';
      if (badge.textContent !== badgeText) badge.textContent = badgeText;
      if (card._mlCoverTitle !== app.title) {
        var url = cachedCover(app);
        image.src = url || 'static/res/placeholder_error.svg';
        card._mlCoverTitle = url ? app.title : null;
      }
      if (forceCovers === true || card._mlCoverTitle !== app.title) queue.push(app);
      cards.push(card);
    });
    // Status-only refreshes retain the exact cards/images and their decoding.
    var unchanged = grid.children.length === cards.length && cards.every(function(card, index) { return grid.children[index] === card; });
    if (!unchanged) {
      cards.forEach(function(card) { fragment.appendChild(card); });
      grid.textContent = ''; grid.appendChild(fragment);
    }
    renderedHost = host;
    el('libraryEmpty').hidden = items.length !== 0;
    el('libraryEmpty').textContent = apps.length ? 'No games in this section. Choose All games.' : 'Start the PC and Sunshine, then use Reload Moonlight.';
    ['All','Favorites','Recent'].forEach(function(name) {
      el('library'+name).setAttribute('aria-pressed', filter === name.toLowerCase());
    });
    updateSelection();
    // Two covers at a time; all requests belong to the current menu visit.
    if (coverScope) coverScope.cancel();
    coverScope = createMenuRequestScope();
    var currentScope = coverScope;
    function next() {
      if (!valid(token) || !currentScope || !currentScope.active || !queue.length) return Promise.resolve();
      var app = queue.shift(), card = el('game-container-' + app.id);
      return host.getBoxArt(app.id, currentScope, cacheOnly === true || !hostReady(), forceCovers === true).then(function(url) {
        if (valid(token) && currentScope.active && card && card.isConnected) {
          rememberCover(app, url);
          card.querySelector('img').src = url;
          card._mlCoverTitle = app.title;
        }
      }, function() {}).then(next);
    }
    return Promise.all([next(), next()]);
  }
  function connect(current, token) {
    return host.connect(current).then(function(address) {
      if (!valid(token) || !current.active) throw new Error('Menu request cancelled');
      return address;
    });
  }
  function refresh(forceCovers) {
    if (!active || isInGame || document.hidden) return Promise.resolve();
    if (refreshPending) {
      refreshCovers = refreshCovers || forceCovers === true;
      return refreshPending;
    }
    cancel(); scope = createMenuRequestScope();
    var current = scope, token = epoch, reached = false;
    refreshCovers = forceCovers === true;
    checking = true;
    status('Checking PC once…'); updateSelection();
    // Disk-only artwork is independent of network discovery, including a cold
    // menu/offline PC. Never queue downloads in front of the status request.
    var cached = render(false, true);
    // One bounded startup/return check only. No retry loop or wake intent.
    refreshPending = current.request(function() {
      return connect(current,token);
    }, 26000).then(function() {
        reached = true;
        if (!hostReady()) throw new Error('Sunshine is still starting.');
        if (!host.paired) throw new Error('Pair this PC from PCs to access its library.');
        checking = false;
        status('PC online · updating games…'); updateSelection();
        return host.getAppListWithCacheFlush(current);
    }).then(function(value) {
      if (!valid(token)) return;
      apps = cleanApps(value); record().apps = apps; host._memCachedApplist = apps;
      save(); checking = false; status('PC online · ' + apps.length + ' games');
      return cached.then(function() {
        if (valid(token)) return render(refreshCovers);
      });
    }, function(error) {
      if (!valid(token)) return;
      checking = false;
      current.cancel();
      // A reachable unpaired PC is different from an offline PC.
      if (!reached) host.online = false;
      // No response cannot distinguish a powered-off PC from a slow Sunshine,
      // firewall or network failure. Do not claim to have measured its power.
      status(!reached ? 'PC not responding. Try Play or Reload Moonlight.' : !host.paired ? 'Pair this PC from PCs.' : 'PC responded · library unavailable. Use Reload Moonlight.');
      return cached;
    }).then(function() {
      if (!valid(token)) return;
      refreshPending = null; refreshCovers = false; updateSelection();
    });
    updateSelection();
    return refreshPending;
  }
  function focusCards() {
    var cards = Array.from(el('game-grid').children);
    var card = cards.find(function(node) { return Number(node.dataset.appId) === selected; });
    if (!card) { Navigation.change(Views.AppsNav); focusNav(0); return; }
    focusElement(card);
    card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  function move(dx,dy) {
    var cards = Array.from(el('game-grid').children), index = cards.findIndex(function(node) { return Number(node.dataset.appId) === selected; });
    if (index < 0) { Navigation.change(Views.AppsNav); focusNav(0); return; }
    var columns = getComputedStyle(el('game-grid')).gridTemplateColumns.split(' ').filter(Boolean).length || 6;
    if (dy < 0 && index < columns) { Navigation.change(Views.AppsNav); navIndex = controls().indexOf('libraryPlay'); focusNav(0); return; }
    var target = dy ? Math.max(0,Math.min(cards.length-1,index+dy*columns)) : Math.max(Math.floor(index/columns)*columns,Math.min(cards.length-1,Math.floor(index/columns)*columns+columns-1,index+dx));
    select(cards[target].dataset.appId); focusCards();
  }
  function favorite() {
    if (!active || !picked() || busy || isInGame) return;
    var r = record(), at = r.favorites.indexOf(selected);
    if (at === -1) r.favorites.push(selected); else r.favorites.splice(at,1);
    save(); render();
  }
  function launch(appId, audioReady) {
    var chosenHost = host;
    var r = record();
    if (r.focus !== appId) { r.focus = appId; saveFocus(); }
    r.recent = [appId].concat(r.recent.filter(function(old) { return old !== appId; })).slice(0,20);
    save(); cancel(); updateSelection();
    launchPending = true;
    clearTimeout(launchTimer);
    launchTimer = setTimeout(function() { launchPending = false; launchTimer = 0; },2000);
    // Keep the original manual launcher in the user's audio gesture.
    startGame(chosenHost,appId,audioReady);
  }
  function play(appId) {
    if (!active || isInGame || launchPending || !apps.some(function(app) { return app.id === id(appId); })) return;
    appId = id(appId); select(appId);
    if (!host.paired) { snackbarLog('Pair this PC from PCs before playing.'); return; }
    launch(appId,false);
  }
  function wake() {
    if (!active || isInGame || wakeScope) return;
    if (!normalizeWakeMac(host.wakeMacOverride || host.macAddress)) {
      WakeHost.open(host); return;
    }
    var current = createMenuRequestScope(), token = epoch;
    wakeScope = current; updateSelection();
    current.request(function() { return host.sendWOL(); },8000).then(function() {
      if (valid(token) && wakeScope === current) {
        status('Wake packet sent. Wait for the PC, then press Play.');
        snackbarLog('Wake packet sent. This does not confirm the PC is awake.');
      }
    },function() {
      if (valid(token) && wakeScope === current) snackbarLog('Could not send Wake-on-LAN. Check the saved MAC and PC settings.');
    }).then(function() {
      if (wakeScope !== current) return;
      current.cancel(); wakeScope = null;
      if (valid(token)) updateSelection();
    });
  }
  function reload() {
    if (!active || isInGame || document.hidden || reloading) return;
    reloading = true;
    cancel(); stopPollingHosts(); stopSubnetScanner();
    // Reload the document and its WASM runtime, not another NvHTTP object.
    // Persistent pairing/settings are untouched; never reload during a stream.
    window.location.reload();
  }
  function bind() {
    if (bound) return; bound = true;
    el('libraryPlay').onclick = function() { play(selected); };
    el('libraryWake').onclick = wake;
    el('libraryFavorite').onclick = favorite;
    el('libraryRefresh').onclick = reload;
    el('libraryPCsBtn').onclick = showHosts;
    el('libraryHomeBtn').onclick = function() { var pc = preferred(); if (pc) showApps(pc); };
    ['All','Favorites','Recent'].forEach(function(name) {
      el('library'+name).onclick = function() {
        if (busy) return;
        filter = name.toLowerCase(); render();
      };
    });
  }
  function decorate() {
    $('#main-header').children().show();
    el('console-panel').style.display = 'block';
    el('libraryPCsBtn').style.display = 'inline-flex';
    el('libraryHomeBtn').style.display = 'none';
    el('settingsBtn').style.display = '';
    el('goBackBtn').style.display = 'none';
    document.body.classList.add('console-library');
    el('header-title').textContent = 'Library';
    el('libraryHost').textContent = host.hostname || 'PC';
  }
  function open(pc) {
    if (!pc || isDialogOpen || document.hidden) return Promise.resolve();
    cancel(); stopPollingHosts(); stopSubnetScanner();
    clearTimeout(launchTimer); launchTimer = 0; launchPending = false;
    host = pc; api = pc; active = true; busy = checking = false;
    prefs.preferred = String(pc.serverUid); filter = 'all';
    var r = record(); apps = cleanApps(pc._memCachedApplist || r.apps);
    selected = r.focus || id(pc.currentGame) || r.recent[0] || 0;
    save(); bind();
    showAppsMode(); decorate();
    el('game-grid').style.display = 'grid'; $('#wasmSpinner').hide();
    // refresh() owns the single initial render/cache pass and its cancellation.
    status('Checking PC once…');
    var opening = refresh();
    Navigation.change(Views.Apps); Navigation.start(); focusCards();
    return opening;
  }
  function ready(part) {
    if (part === 'runtime') runtimeReady = true; else hostsReady = true;
    if (!runtimeReady || !hostsReady || started || document.hidden) return;
    started = true; bind();
    var pc = preferred();
    if (pc) open(pc); // Merely opening Moonlight never wakes or launches a PC.
  }
  return {
    invalidateCovers: invalidateCovers,
    pause: pause, resume: resume,
    open: open, ready: ready, hide: hide, suspend: suspend, visible: function() { return active; },
    move: move, focusCards: focusCards, focusNav: focusNav,
    acceptNav: function() { var names = controls(); if (names.length) el(names[Math.max(0,Math.min(navIndex,names.length-1))]).click(); },
    accept: function() { play(selected); }, favorite: favorite,
    showHomeButton: function() { if (preferred()) { bind(); el('libraryHomeBtn').style.display = 'inline-flex'; } },
    settings: function() { settingsReturn = active; hide(); },
    backAction: function() { exitAppDialog(); },
    back: function() { if (!settingsReturn) return false; settingsReturn = false; var pc = preferred(); if (!pc) return false; Navigation.pop(); open(pc); return true; }
  };
})();

// Menu-only console launcher. No polling, animation or per-frame work on load.
var ConsoleLibrary = (function() {
  var key = 'moonlight.console.v1';
  var prefs = { preferred: '', hosts: {} };
  var host = null, apps = [], selected = 0, filter = 'all';
  var active = false, scope = null, coverScope = null, epoch = 0, busy = false, checking = false;
  var retry = 0, deadline = 0, preparedAudio = false, settingsReturn = false;
  var runtimeReady = false, hostsReady = false, started = false, bound = false;
  var navIndex = 0, currentRecord = null;
  var launchPending = false, launchTimer = 0;
  try {
    var saved = JSON.parse(localStorage.getItem(key));
    if (saved && typeof saved.preferred === 'string' && saved.hosts && typeof saved.hosts === 'object') prefs = saved;
  } catch (e) {} // A missing/corrupt/full store must never prevent playing.

  function el(id) { return document.getElementById(id); }
  function id(value) { var n = Number(value); return Number.isInteger(n) && n > 0 && n <= 0xffffffff ? n : 0; }
  function cleanApps(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).filter(function(app) {
      if (!app || !id(app.id) || typeof app.title !== 'string' || seen[app.id]) return false;
      seen[app.id] = true; return true;
    }).map(function(app) { return { id: id(app.id), title: app.title }; });
  }
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
  function save() { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch (e) {} }
  function valid(token) { return active && !isInGame && token === epoch && host && hosts[host.serverUid] === host; }
  function status(text) { el('libraryStatus').textContent = text; }
  function cancel() {
    epoch++;
    if (scope) scope.cancel();
    if (coverScope) coverScope.cancel();
    scope = null;
    coverScope = null;
    clearTimeout(retry); clearTimeout(deadline);
    retry = deadline = 0; busy = checking = false;
    if (preparedAudio && !isInGame) stopAudioScheduler(true);
    preparedAudio = false;
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
    preparedAudio = false;
    hide();
    el('game-grid').textContent = '';
  }
  function preferred() {
    if (Object.prototype.hasOwnProperty.call(hosts, prefs.preferred)) return hosts[prefs.preferred];
    var values = Object.keys(hosts).map(function(uid) { return hosts[uid]; });
    return values.length === 1 ? values[0] : null;
  }
  function controls() {
    return ['libraryPCsBtn','settingsBtn','quitRunningAppBtn','libraryPlay','libraryFavorite','libraryAll','libraryFavorites','libraryRecent','libraryRefresh','libraryCancel'].filter(function(name) {
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
    el('libraryPlay').textContent = hostReady() && app && Number(host.currentGame) === app.id ? 'Resume' : hostReady() ? 'Play' : 'Wake & play';
    // A background check is never a lock on a user-initiated wake or refresh.
    el('libraryPlay').disabled = !app || busy || launchPending;
    el('libraryFavorite').disabled = !app || busy;
    el('libraryFavorite').textContent = app && r.favorites.indexOf(app.id) !== -1 ? '★ Favorite' : '☆ Favorite';
    el('libraryFavorite').setAttribute('aria-pressed', !!app && r.favorites.indexOf(app.id) !== -1);
    el('libraryRefresh').disabled = busy || launchPending;
    el('libraryCancel').hidden = !busy;
    el('quitRunningAppBtn').style.display = host.online && Number(host.currentGame) > 0 ? '' : 'none';
    Array.from(el('game-grid').children).forEach(function(card) {
      var chosen = Number(card.dataset.appId) === selected;
      card.classList.toggle('hovered', chosen);
      card.tabIndex = chosen ? 0 : -1;
    });
  }
  function select(appId) {
    if (!active || isInGame || !id(appId) || id(appId) === selected) return;
    selected = id(appId); record().focus = selected; save(); updateSelection();
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
  function render(forceCovers) {
    if (!active || isInGame) return;
    var r = record(), items = list(), grid = el('game-grid'), token = epoch, fragment = document.createDocumentFragment();
    if (!items.some(function(app) { return app.id === selected; })) selected = items.length ? items[0].id : 0;
    items.forEach(function(app) {
      var card = document.createElement('button');
      card.type = 'button'; card.id = 'game-container-' + app.id;
      card.className = 'game-container console-card'; card.dataset.appId = app.id;
      card.setAttribute('aria-label', app.title);
      var image = document.createElement('img'); image.alt = ''; image.src = 'static/res/placeholder_error.svg';
      var label = document.createElement('span'); label.className = 'console-card-title'; label.textContent = app.title;
      var badge = document.createElement('span'); badge.className = 'console-card-badge';
      badge.textContent = host.online && Number(host.currentGame) === app.id ? 'Resume' : r.favorites.indexOf(app.id) !== -1 ? '★' : '';
      card.appendChild(image); card.appendChild(label); card.appendChild(badge);
      card.onclick = function() { select(app.id); play(app.id); };
      card.onfocus = function() { select(app.id); };
      fragment.appendChild(card);
    });
    grid.textContent = ''; grid.appendChild(fragment);
    el('libraryEmpty').hidden = items.length !== 0;
    el('libraryEmpty').textContent = apps.length ? 'No games in this section. Choose All games.' : host.online ? 'Add games in Sunshine, then Refresh.' : 'Wake the PC to load your library.';
    ['All','Favorites','Recent'].forEach(function(name) {
      el('library'+name).setAttribute('aria-pressed', filter === name.toLowerCase());
    });
    updateSelection();
    // Two covers at a time; all requests belong to the current menu visit.
    if (coverScope) coverScope.cancel();
    coverScope = createMenuRequestScope();
    var queue = items.slice(), currentScope = coverScope;
    function next() {
      if (!valid(token) || !currentScope || !currentScope.active || !queue.length) return;
      var app = queue.shift(), card = el('game-container-' + app.id);
      host.getBoxArt(app.id, currentScope, !hostReady(), forceCovers === true).then(function(url) {
        if (valid(token) && currentScope.active && card && card.isConnected) card.querySelector('img').src = url;
      }, function() {}).then(next);
    }
    next(); next();
  }
  function connect(current, token) {
    return host.connect(current).then(function(address) {
      if (!valid(token) || !current.active) throw new Error('Menu request cancelled');
      return address;
    });
  }
  function refresh(forceCovers) {
    if (!active || isInGame || busy) return Promise.resolve();
    cancel(); scope = createMenuRequestScope();
    var current = scope, token = epoch, reached = false;
    checking = true; status('Checking PC…'); updateSelection();
    // Total deadline includes all address attempts and the app list, not just
    // each individual HTTP request. Manual actions may cancel it immediately.
    return current.request(function() {
      return connect(current,token).then(function() {
        reached = true;
        if (!hostReady()) throw new Error('Sunshine is still starting.');
        if (!host.paired) throw new Error('Pair this PC from PCs to access its library.');
        checking = false;
        status('PC online · updating games…'); updateSelection();
        return host.getAppListWithCacheFlush(current);
      });
    }, 12000).then(function(value) {
      if (!valid(token)) return;
      apps = cleanApps(value); record().apps = apps; host._memCachedApplist = apps;
      save(); checking = false; status('PC online · ' + apps.length + ' games'); render(forceCovers);
    }, function(error) {
      if (!valid(token)) return;
      checking = false;
      current.cancel();
      // A reachable unpaired PC is different from an offline PC.
      if (!reached) host.online = false;
      status(!host.online ? 'PC offline · select a game to wake it' : !host.paired ? 'Pair this PC from PCs.' : 'Library unavailable · Refresh to try again');
      render();
      // Only the visible menu retries; suspend/settings/stream cancel the scope.
      if (!host.online || (host.paired && host._authenticatedOnline === false)) {
        retry = setTimeout(function() { if (valid(token)) refresh(); }, 5000);
      }
    });
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
    var r = record(); r.focus = appId;
    r.recent = [appId].concat(r.recent.filter(function(old) { return old !== appId; })).slice(0,20);
    save(); preparedAudio = false; cancel(); updateSelection();
    launchPending = true;
    clearTimeout(launchTimer);
    launchTimer = setTimeout(function() { launchPending = false; launchTimer = 0; },2000);
    // Online launch is synchronous with the click; wake launch reuses the
    // context prepared by that same click, preserving Tizen's autoplay gesture.
    startGame(chosenHost,appId,audioReady);
  }
  function play(appId) {
    if (!active || isInGame || busy || launchPending || !apps.some(function(app) { return app.id === id(appId); })) return;
    appId = id(appId); select(appId);
    if (hostReady()) {
      if (!host.paired) { hostChosen(host); return; }
      launch(appId,false); return;
    }
    if (!normalizeWakeMac(host.wakeMacOverride || host.macAddress)) {
      cancel();
      WakeHost.open(host); snackbarLog('Set the Wake-on-LAN MAC once, then choose Play.'); return;
    }
    cancel(); scope = createMenuRequestScope();
    var current = scope, token = epoch;
    prepareStreamAudio(); preparedAudio = true; busy = true;
    status('Waking PC…'); updateSelection();
    Navigation.change(Views.AppsNav); navIndex = controls().indexOf('libraryCancel'); focusNav(0);
    function failed(text) { if (!valid(token)) return; cancel(); scope = createMenuRequestScope(); status(text); updateSelection(); focusCards(); }
    deadline = setTimeout(function() { failed('PC not ready after 60 s. Check Sunshine, then try again.'); },60000);
    function check() {
      if (!valid(token) || !current.active) return;
      connect(current,token).then(function() {
        if (!valid(token) || !current.active) return;
        if (host.paired && host.ppkstr && host._authenticatedOnline === false) {
          retry = setTimeout(check,3000); return;
        }
        if (!host.paired) { failed('PC needs pairing. Open PCs.'); return; }
        host._memCachedApplist = apps;
        launch(appId,true);
      },function() { if (valid(token) && current.active) retry = setTimeout(check,3000); });
    }
    current.request(function() { return host.sendWOL(); },8000).then(function() {
      if (!valid(token) || !current.active) return;
      status('Wake packet sent · waiting for Sunshine…'); check();
    },function() { failed('Could not send Wake-on-LAN. Check PC settings.'); });
  }
  function bind() {
    if (bound) return; bound = true;
    el('libraryPlay').onclick = function() { play(selected); };
    el('libraryFavorite').onclick = favorite;
    el('libraryRefresh').onclick = function() { refresh(true); };
    el('libraryCancel').onclick = function() { cancel(); scope = createMenuRequestScope(); status('Wake cancelled'); updateSelection(); focusCards(); };
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
    if (!pc || isDialogOpen) return Promise.resolve();
    cancel(); stopPollingHosts(); stopSubnetScanner();
    clearTimeout(launchTimer); launchTimer = 0; launchPending = false;
    host = pc; api = pc; active = true; busy = checking = false;
    prefs.preferred = String(pc.serverUid); filter = 'all';
    var r = record(); apps = cleanApps(pc._memCachedApplist || r.apps);
    selected = r.focus || id(pc.currentGame) || r.recent[0] || 0;
    save(); bind();
    showAppsMode(); decorate();
    el('game-grid').style.display = 'grid'; $('#wasmSpinner').hide();
    scope = createMenuRequestScope(); render();
    Navigation.change(Views.Apps); Navigation.start(); focusCards();
    return refresh();
  }
  function ready(part) {
    if (part === 'runtime') runtimeReady = true; else hostsReady = true;
    if (!runtimeReady || !hostsReady || started) return;
    started = true; bind();
    var pc = preferred();
    if (pc) open(pc); // Merely opening Moonlight never wakes or launches a PC.
  }
  return {
    open: open, ready: ready, hide: hide, suspend: suspend, visible: function() { return active; },
    move: move, focusCards: focusCards, focusNav: focusNav,
    acceptNav: function() { var names = controls(); if (names.length) el(names[Math.max(0,Math.min(navIndex,names.length-1))]).click(); },
    accept: function() { play(selected); }, favorite: favorite,
    showHomeButton: function() { if (preferred()) { bind(); el('libraryHomeBtn').style.display = 'inline-flex'; } },
    settings: function() { settingsReturn = active; hide(); },
    backAction: function() { if (busy) el('libraryCancel').click(); else exitAppDialog(); },
    back: function() { if (!settingsReturn) return false; settingsReturn = false; var pc = preferred(); if (!pc) return false; Navigation.pop(); open(pc); return true; }
  };
})();

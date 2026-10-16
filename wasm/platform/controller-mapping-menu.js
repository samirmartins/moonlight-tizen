// The editor and its optional test loop exist only while the menu is open.
var ControllerMappingMenu = (function() {
  var names = ['Cross / A','Circle / B','Square / X','Triangle / Y','L1 / LB','R1 / RB',
    'L2 / LT','R2 / RT','Create / Back','Options / Start','L3 / LS click','R3 / RS click',
    'D-pad up','D-pad down','D-pad left','D-pad right','PS / Guide','Touchpad','Mute'];
  var root, dialog, draft, selected = 0, choosing = false, testing = false, raf = 0;
  var focused = 'cm-enabled', lastSample = '', exitSince = null;
  function el(id) { return document.getElementById(id); }
  function button(id, text) { return '<button type="button" id="'+id+'">'+text+'</button>'; }
  function setStatus(text) { el('cm-status').textContent = text; }
  function focus(id) {
    var node = el(id);
    if (node && !node.disabled) { focused = id; node.focus(); node.scrollIntoView({block:'nearest'}); }
  }
  function controls() {
    return Array.from(dialog.querySelectorAll('button')).filter(function(node) {
      return !node.disabled && node.getClientRects().length;
    });
  }
  function move(dx, dy) {
    var current = el(focused), items = controls();
    if (!current || !items.includes(current)) { if (items.length) focus(items[0].id); return; }
    var from = current.getBoundingClientRect(), best = null, distance = Infinity;
    items.forEach(function(node) {
      if (node === current) return;
      var r = node.getBoundingClientRect(), x = (r.left+r.right-from.left-from.right)/2;
      var y = (r.top+r.bottom-from.top-from.bottom)/2;
      if ((dx && dx*x <= 1) || (dy && dy*y <= 1)) return;
      var score = dx ? Math.abs(x)+Math.abs(y)*3 : Math.abs(y)+Math.abs(x)*3;
      if (score < distance) { distance = score; best = node; }
    });
    if (best) focus(best.id);
  }
  var view = {
    enter:function() { focus(focused); }, leave:function() {},
    up:function() { move(0,-1); }, down:function() { move(0,1); },
    left:function() { move(-1,0); }, right:function() { move(1,0); },
    accept:function() { var node = el(focused); if (node && !node.disabled) node.click(); },
    back:function() {
      if (testing) { stopTest(); focus('cm-test'); }
      else if (choosing) { choosing = false; render(); focus('cm-change'); }
      else close();
    }, press:function() {}, switch:function() { focus(focused); }
  };
  function ensure() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'cm-overlay'; root.style.display = 'none';
    root.innerHTML = '<dialog id="controllerMappingDialog" aria-labelledby="cm-title">'+
      '<header><div><h2 id="cm-title">Controller mapping</h2><p>Game controls only. Menu navigation stays unchanged.</p></div>'+button('cm-enabled','Custom mapping: OFF')+'</header>'+
      '<div class="cm-body"><section class="cm-visual" aria-label="Controller reference">'+
      '<div class="cm-controller"><img id="cm-art" alt="Front view of a DualSense controller">'+
      '<span class="cm-label cm-l2">L2</span><span class="cm-label cm-l1">L1</span><span class="cm-label cm-l3">L3</span>'+
      '<span class="cm-label cm-r2">R2</span><span class="cm-label cm-r1">R1</span><span class="cm-label cm-r3">R3</span></div>'+
      '<p class="cm-credit">Art: Xelu (CC0) · Input Overlay preset by Caro</p>'+
      '<h3 id="cm-selected"></h3><p id="cm-detail"></p><div class="cm-actions">'+button('cm-change','Change')+button('cm-test','Test buttons')+'</div>'+
      '<p id="cm-axes">Sticks: original axes, sensitivity and range.</p></section>'+
      '<section class="cm-assignments" aria-label="Button assignments"><p id="cm-list-title">Physical button → game input</p><div id="cm-rows"></div></section></div>'+
      '<p id="cm-status" role="status"></p><p class="cm-note">When ON, the saved layout applies to game controls. Triggers stay analog. One layout applies to all controllers.</p>'+
      '<footer>'+button('cm-reset','Restore layout')+'<div>'+button('cm-cancel','Cancel')+button('cm-save','Save')+'</div></footer></dialog>';
    document.body.appendChild(root); dialog = el('controllerMappingDialog');
    root.addEventListener('focusin',function(event) { if (event.target.tagName === 'BUTTON') focused = event.target.id; });
    el('cm-enabled').onclick = function() { draft.enabled = !draft.enabled; render(); };
    el('cm-change').onclick = function() { choosing = true; render(); focus('cm-target-'+draft.map[selected]); };
    el('cm-test').onclick = function() {
      if (testing) { stopTest(); focus('cm-test'); } else startTest();
    };
    el('cm-reset').onclick = function() { var enabled = draft.enabled; draft = ControllerMapping.defaults(); draft.enabled = enabled; render(); setStatus('Original button assignments restored. Save to keep them.'); };
    el('cm-cancel').onclick = close;
    el('cm-save').onclick = function() {
      if (!ControllerMapping.save(draft)) { setStatus('Could not save. Check storage and try again; your previous layout is unchanged.'); return; }
      close();
    };
    dialog.addEventListener('keydown',function(event) {
      var direction = {ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]}[event.key];
      if (direction) { event.preventDefault(); event.stopPropagation(); move(direction[0],direction[1]); }
    });
  }
  function render() {
    el('cm-enabled').textContent = 'Custom mapping: '+(draft.enabled ? 'ON' : 'OFF');
    el('cm-enabled').setAttribute('aria-pressed', String(draft.enabled));
    el('cm-selected').textContent = names[selected];
    el('cm-detail').textContent = selected < 16 ? 'Sends '+names[draft.map[selected]]+'.'+
      ((selected === 6 || selected === 7) ? ' Analog trigger range is preserved.' : '') :
      selected === 16 ? 'Guide remains unchanged; availability depends on the TV.' :
      selected === 17 ? 'Existing mouse behavior is unchanged. Game touch gestures are not exposed here.' : 'Not exposed as a standard button by the TV.';
    el('cm-change').disabled = selected >= 16 || testing || choosing;
    el('cm-list-title').textContent = choosing ? 'Choose game input · the other assignment swaps automatically' : 'Physical button → game input';
    var rows = el('cm-rows'); rows.textContent = '';
    names.forEach(function(name,i) {
      if (choosing && (i >= 16 || ((selected === 6 || selected === 7) !== (i === 6 || i === 7)))) return;
      var node = document.createElement('button'); node.type = 'button';
      node.id = 'cm-'+(choosing ? 'target-' : 'row-')+i;
      node.className = 'cm-row'+(!choosing && selected === i ? ' cm-selected' : '');
      node.textContent = choosing ? name : name+' → '+(i < 16 ? names[draft.map[i]] : i === 16 ? 'unchanged' : i === 17 ? 'mouse (unchanged)' : 'not exposed');
      node.disabled = testing;
      node.onclick = function() {
        if (choosing) {
          ControllerMapping.assign(draft,selected,i); choosing = false; render();
          setStatus('Assignment swapped. Save to keep this layout.'); focus('cm-row-'+selected);
        } else { selected = i; render(); focus('cm-row-'+i); }
      };
      rows.appendChild(node);
    });
    ['cm-enabled','cm-reset','cm-save'].forEach(function(id) { el(id).disabled = testing; });
  }
  function blockGamepad(event) { event.stopImmediatePropagation(); }
  function stopTest() {
    if (!testing) return;
    testing = false; cancelAnimationFrame(raf); raf = 0; exitSince = null;
    window.removeEventListener('gamepadinputchanged',blockGamepad,true);
    el('cm-test').textContent = 'Test buttons';
    el('cm-axes').textContent = 'Sticks: original axes, sensitivity and range.';
    render(); setStatus('Test finished. Menu navigation stays on the original layout.');
  }
  function startTest() {
    choosing = false; testing = true; lastSample = ''; exitSince = null;
    // The test consumes raw releases too; do not leave a menu repeat running.
    clearTimeout(repeatTimeout); repeatTimeout = null;
    clearTimeout(navigationTimeout); navigationTimeout = null;
    repeatAction = null;
    var preview = draft.enabled ? draft.map.slice() : ControllerMapping.defaults().map;
    window.addEventListener('gamepadinputchanged',blockGamepad,true);
    el('cm-test').textContent = 'Finish test'; render(); focus('cm-test');
    setStatus('Press buttons / move sticks. Hold L1 + R1 for 1 second to finish, or use Return on the TV remote.');
    function tick(time) {
      if (!testing) return;
      if (document.hidden || isInGame) { close(); return; }
      var pads = navigator.getGamepads ? navigator.getGamepads() : [], pad = null;
      for (var i=0;i<pads.length;i++) if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
      var pressed = [], axes = [], triggers = [];
      if (pad) {
        for (var b=0;b<17;b++) if (pad.buttons[b] && pad.buttons[b].pressed) pressed.push(b);
        axes = Array.from(pad.axes).slice(0,4).map(function(value) { return Number.isFinite(value) ? value.toFixed(2) : '0.00'; });
        triggers = [6,7].map(function(n) { var v = pad.buttons[n] && pad.buttons[n].value; return Number.isFinite(v) ? v.toFixed(2) : '0.00'; });
      }
      if (pressed.includes(4) && pressed.includes(5)) {
        if (exitSince === null) exitSince = time;
        if (time-exitSince >= 1000) { stopTest(); focus('cm-test'); return; }
      } else exitSince = null;
      var sample = JSON.stringify([!!pad,pressed,axes,triggers]);
      if (sample !== lastSample) {
        lastSample = sample;
        for (var n=0;n<19;n++) el('cm-row-'+n).classList.toggle('cm-pressed',pressed.includes(n));
        el('cm-axes').textContent = pad ? 'Axes '+axes.join(' / ')+' · L2/R2 '+triggers.join(' / ') : 'No controller detected. Connect one and press a button.';
        el('cm-detail').textContent = pressed.length ? 'Physical: '+pressed.map(function(n) { return names[n]; }).join(', ')+
          ' · Game: '+pressed.map(function(n) { return names[preview[n]]; }).join(', ') : 'Press any standard button. Preview uses the custom layout when ON, otherwise the original controls.';
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
  }
  function hidden() { if (document.hidden) close(); }
  function close() {
    if (!dialog || !dialog.open) return;
    stopTest(); document.removeEventListener('visibilitychange',hidden);
    closeUtilityDialog('controllerMappingDialog');
    el('cm-rows').textContent = ''; el('cm-art').removeAttribute('src'); draft = null; choosing = false;
    focusElement('controllerMappingBtn');
  }
  function open() {
    if (isInGame || isDialogOpen || document.hidden) return;
    ensure(); draft = ControllerMapping.get(); selected = 0; choosing = false; focused = 'cm-enabled';
    el('cm-art').src = 'static/res/controller-dualsense.png'; render();
    setStatus('Select a physical button, then Change. Cancel leaves saved settings unchanged.');
    openUtilityDialog('controllerMappingDialog',['cm-enabled','cm-cancel'],'cm-cancel');
    Navigation.change(view);
    dialog.oncancel = function(event) { event.preventDefault(); view.back(); };
    document.addEventListener('visibilitychange',hidden);
  }
  return {open:open};
})();

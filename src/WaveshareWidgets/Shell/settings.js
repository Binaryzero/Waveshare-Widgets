// Settings editor: edits the layout (pages -> slots -> widget + size + properties)
// and posts it back to the host, which saves layout.json and reloads the dashboard.
(function () {
  'use strict';

  // Page capacity model: a 4-column x 2-row grid = 8 half-height cells.
  // A size token is a width (quarter=1, half=2, three-quarter=3, full=4 columns)
  // plus an optional -upper/-lower suffix (one row instead of both).
  const WIDTHS = ['quarter', 'half', 'three-quarter', 'full'];
  const WIDTH_COLS = { quarter: 1, half: 2, 'three-quarter': 3, full: 4 };
  const WIDTH_PX = { quarter: 320, half: 640, 'three-quarter': 960, full: 1280 };

  function parseSize(token) {
    let t = String(token || 'quarter').toLowerCase();
    let band = 'full';
    if (t.endsWith('-upper')) { band = 'upper'; t = t.slice(0, -6); }
    else if (t.endsWith('-lower')) { band = 'lower'; t = t.slice(0, -6); }
    if (!WIDTH_COLS[t]) t = 'quarter';
    return { width: t, band };
  }

  function sizeCells(token) {
    const { width, band } = parseSize(token);
    return WIDTH_COLS[width] * (band === 'full' ? 2 : 1);
  }

  let state = { layout: { pages: [] }, widgets: [], sensors: [] };
  let widgetsById = new Map();
  let selectedPage = 0;
  let toastTimer = null;
  let backgroundHost = 'backgrounds.wsw';
  let pendingBgPick = null;    // callback(source, kind) for the in-flight file dialog
  let sdProfileWaiters = [];   // callbacks awaiting an sd-profiles-result

  const el = (id) => document.getElementById(id);

  // ---- host bridge -----------------------------------------------------------

  window.chrome.webview.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'settings-init') {
      state = msg.data || state;
      if (!state.layout || !Array.isArray(state.layout.pages)) state.layout = { pages: [] };
      backgroundHost = state.backgroundHost || backgroundHost;
      widgetsById = new Map((state.widgets || []).map((w) => [w.id, w]));
      selectedPage = Math.max(0, Math.min(selectedPage, state.layout.pages.length - 1));
      renderAll();
    } else if (msg.type === 'saved') {
      toast('Saved — dashboard updated');
    } else if (msg.type === 'save-failed') {
      toast('Save failed: ' + msg.message, true);
    } else if (msg.type === 'widget-installed') {
      toast('Installed "' + msg.name + '"');
    } else if (msg.type === 'background-picked') {
      const cb = pendingBgPick;
      pendingBgPick = null;
      if (cb) cb(msg.source, msg.kind);
    } else if (msg.type === 'background-failed') {
      pendingBgPick = null;
      toast('Could not load background: ' + msg.message, true);
    } else if (msg.type === 'sd-profiles-result') {
      const waiters = sdProfileWaiters.splice(0);
      const profiles = Array.isArray(msg.profiles) ? msg.profiles.filter((p) => typeof p === 'string') : [];
      waiters.forEach((cb) => cb(profiles));
    } else if (msg.type === 'preview-host') {
      // Live data (sensors/media) and replica request results from the host — keep our
      // snapshot fresh for the next replica re-init, then pass straight through.
      const m = msg.message || {};
      if (m.type === 'sensors') state.sensors = m.data || [];
      else if (m.type === 'media') state.media = m.data || null;
      replicaPost(m);
    }
  });

  function post(message) {
    window.chrome.webview.postMessage(message);
  }

  // ---- live replica -----------------------------------------------------------
  // The real shell (index.html?preview) embedded at native 1280×400 and scaled to
  // fit, driven with the EDITED (unsaved) layout and theme. Structural edits push a
  // debounced full re-init; theme edits ride a light token push (no iframe reloads).

  const previewFrame = el('previewFrame');
  const previewStage = el('previewStage');
  let replicaReady = false;
  let replicaTimer = null;
  let lastReplicaLayout = ''; // structural snapshot (theme excluded — it rides the light push)

  const replicaLayoutJson = () => JSON.stringify(Object.assign({}, state.layout, { theme: null }));

  function replicaPost(message) {
    if (!replicaReady) return;
    try { previewFrame.contentWindow.postMessage({ type: 'ww-host', message }, '*'); } catch (e) { /* not loaded */ }
  }

  function replicaTheme() {
    return derivePalette(Object.assign({}, THEME_DEFAULTS, state.layout.theme || {}));
  }

  function replicaInit() {
    lastReplicaLayout = replicaLayoutJson();
    replicaPost({
      type: 'init',
      data: {
        layout: state.layout,
        widgets: state.widgets,
        sensors: state.sensors,
        media: state.media || null,
        backgroundHost,
        theme: replicaTheme(),
        // settings-init only carries {elevated}; widgets still expect the panel's
        // full status shape, so keep apiVersion present in the replica too.
        status: Object.assign({ elevated: false, apiVersion: 1 }, state.status || {}),
        page: selectedPage,
      },
    });
  }

  /** kind: 'layout' (debounced full re-init) | 'theme' (light token push). */
  function refreshReplica(kind) {
    if (!replicaReady || previewStage.classList.contains('collapsed')) return;
    if (kind === 'theme') {
      // seeds ride along so the replica's styled slots re-derive their overrides
      // against the edited theme instead of keeping stale (or losing) seeds.
      replicaPost({ type: 'theme', data: replicaTheme(), seeds: state.layout.theme || null });
      return;
    }
    // Selection-only renders (nothing structural changed) just steer the replica to
    // the selected page — a full re-init would needlessly reload every widget.
    if (replicaLayoutJson() === lastReplicaLayout) {
      replicaPost({ type: 'page', index: selectedPage });
      return;
    }
    clearTimeout(replicaTimer);
    replicaTimer = setTimeout(replicaInit, 350);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== previewFrame.contentWindow) return;
    const msg = ev.data || {};
    if (msg.type !== 'ww-shell') return;
    const m = msg.message || {};
    if (m.type === 'ready') {
      replicaReady = true;
      replicaInit();
    } else if (m.type === 'fetch' || m.type === 'ping' || m.type === 'media-list' || m.type === 'audio-get') {
      post({ type: 'preview-data', message: m });
    }
    // Everything else (save-layout, media-control, actions, audio-set, sd-*, log) is
    // dropped: the replica is a display, never a second writer or actor.
  });

  function fitReplica() {
    const width = previewStage.clientWidth || 1;
    const scale = width / 1280;
    previewFrame.style.transform = 'scale(' + scale + ')';
    previewStage.style.height = Math.round(400 * scale) + 'px';
  }
  new ResizeObserver(fitReplica).observe(previewStage);

  el('previewToggle').addEventListener('click', () => {
    const collapsed = previewStage.classList.toggle('collapsed');
    el('previewToggle').textContent = collapsed ? 'Show' : 'Hide';
    if (collapsed) {
      previewFrame.removeAttribute('src'); // suspend: no hidden widgets burning CPU
      replicaReady = false;
    } else {
      previewFrame.src = 'index.html?preview=1';
      fitReplica();
    }
  });

  previewFrame.src = 'index.html?preview=1';
  fitReplica();

  // ---- top bar ----------------------------------------------------------------

  el('save').addEventListener('click', () => post({ type: 'save-layout', layout: state.layout }));
  el('installWidget').addEventListener('click', () => post({ type: 'install-widget' }));
  el('openFolder').addEventListener('click', () => post({ type: 'open-widgets-folder' }));
  el('openMedia').addEventListener('click', () => post({ type: 'open-media-folder' }));
  el('addPage').addEventListener('click', () => {
    state.layout.pages.push({ name: 'Page ' + (state.layout.pages.length + 1), slots: [] });
    selectedPage = state.layout.pages.length - 1;
    renderAll();
  });

  // ---- page panel ----------------------------------------------------------------

  function renderAll() {
    renderPageList();
    renderThemeEditor();
    renderGlobalBackground();
    renderEditor();
  }

  function renderGlobalBackground() {
    renderBackgroundEditor(
      el('globalBg'),
      () => state.layout.background || null,
      (spec) => {
        if (spec) state.layout.background = spec; else delete state.layout.background;
        refreshReplica('layout');
      },
      { allowInherit: false });
  }

  // Stock seeds mirrored from PaletteEngine's defaults; shown when no theme is set.
  const THEME_DEFAULTS = { accent: '#4cc2ff', background: '#05070b', text: '#e8ecf2', panelAlpha: 0.92 };

  // Palette derivation lives in palette.js (shared with the dashboard shell for the
  // live replica and per-widget style overrides).
  const derivePalette = window.WWPalette.derive;

  function renderThemeEditor() {
    const container = el('themeEditor');
    container.textContent = '';

    // Live preview: a miniature widget tile over a wallpaper strip, restyled on every
    // input so each control's effect is visible immediately.
    const preview = document.createElement('div');
    preview.className = 'theme-preview';
    preview.innerHTML =
      '<div class="tp-tile">' +
        '<div class="tp-head"><span class="tp-kicker">CPU Load</span><span class="tp-pill">OK</span></div>' +
        '<div class="tp-reading"><span class="tp-value">57</span><span class="tp-unit">%</span></div>' +
        '<div class="tp-meter"><i></i></div>' +
        '<div class="tp-btns"><button type="button" class="tp-btn" tabindex="-1">Button</button>' +
        '<button type="button" class="tp-btn tp-primary" tabindex="-1">Accent</button></div>' +
      '</div>';

    const refreshPreview = () => {
      const t = Object.assign({}, THEME_DEFAULTS, state.layout.theme || {});
      const tokens = derivePalette(t);
      for (const name of Object.keys(tokens)) preview.style.setProperty(name, tokens[name]);
    };

    const setKey = (key, value) => {
      const t = state.layout.theme || (state.layout.theme = {});
      if (value == null) delete t[key]; else t[key] = value;
      if (!Object.keys(t).length) delete state.layout.theme;
      refreshPreview();
      refreshReplica('theme');
    };
    const cur = state.layout.theme || {};

    container.appendChild(preview);
    const note = document.createElement('p');
    note.className = 'panel-hint';
    note.textContent = 'Live preview — the panel itself updates when you hit Save & apply.';
    container.appendChild(note);

    container.appendChild(bgColor('Accent', cur.accent || THEME_DEFAULTS.accent, (v) => setKey('accent', v)));
    container.appendChild(bgColor('Background', cur.background || THEME_DEFAULTS.background, (v) => setKey('background', v)));
    container.appendChild(bgColor('Text', cur.text || THEME_DEFAULTS.text, (v) => setKey('text', v)));
    const alphaPct = Math.round((cur.panelAlpha != null ? cur.panelAlpha : THEME_DEFAULTS.panelAlpha) * 100);
    container.appendChild(bgSlider('Panel opacity', alphaPct, 15, 100, 1, '%', (v) => setKey('panelAlpha', v / 100)));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ghost';
    reset.textContent = 'Reset to stock theme';
    reset.onclick = () => { delete state.layout.theme; renderThemeEditor(); refreshReplica('theme'); };
    container.appendChild(bgRow('', reset));
    refreshPreview();
  }

  function renderPageList() {
    const list = el('pageList');
    list.textContent = '';
    state.layout.pages.forEach((page, i) => {
      const item = document.createElement('li');
      item.classList.toggle('active', i === selectedPage);
      const name = document.createElement('span');
      name.textContent = page.name || 'Page ' + (i + 1);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = (page.slots || []).length;
      item.append(name, count);
      item.addEventListener('click', () => { selectedPage = i; renderAll(); });
      list.appendChild(item);
    });
  }

  // ---- page editor ----------------------------------------------------------------

  function renderEditor() {
    refreshReplica('layout');
    const page = state.layout.pages[selectedPage];
    const hasPage = !!page;
    el('editorEmpty').hidden = hasPage;
    el('pageHeader').style.display = hasPage ? 'flex' : 'none';
    el('addSlot').style.display = hasPage ? 'block' : 'none';
    el('pageBgWrap').style.display = hasPage ? 'block' : 'none';
    el('slotList').textContent = '';
    if (!hasPage) return;

    renderBackgroundEditor(
      el('pageBg'),
      () => page.background || null,
      (spec) => {
        if (spec) page.background = spec; else delete page.background;
        refreshReplica('layout');
      },
      { allowInherit: true });

    const nameInput = el('pageName');
    nameInput.value = page.name || '';
    nameInput.oninput = () => { page.name = nameInput.value; renderPageList(); };

    // Two-tap confirm: the first tap arms the button (and auto-disarms), only a
    // second tap actually deletes — a page full of tuned widgets is easy to fat-finger.
    const delBtn = el('deletePage');
    delBtn.textContent = 'Delete page';
    delete delBtn.dataset.armed;
    delBtn.onclick = () => {
      if (!delBtn.dataset.armed) {
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'Tap again to delete';
        setTimeout(() => {
          if (delBtn.dataset.armed) {
            delete delBtn.dataset.armed;
            delBtn.textContent = 'Delete page';
          }
        }, 3500);
        return;
      }
      delete delBtn.dataset.armed;
      state.layout.pages.splice(selectedPage, 1);
      selectedPage = Math.max(0, selectedPage - 1);
      renderAll();
    };
    el('movePageLeft').onclick = () => movePage(-1);
    el('movePageRight').onclick = () => movePage(1);

    el('addSlot').onclick = () => {
      const first = state.widgets[0];
      page.slots.push({
        widgetId: first ? first.id : '',
        size: first && first.supportedSlots && first.supportedSlots[0] ? first.supportedSlots[0] : 'quarter',
        settings: {},
      });
      renderEditor();
    };

    page.slots = page.slots || [];
    page.slots.forEach((slot, i) => el('slotList').appendChild(renderSlot(page, slot, i)));
    renderCapacity(page);
  }

  function movePage(delta) {
    const target = selectedPage + delta;
    if (target < 0 || target >= state.layout.pages.length) return;
    const [page] = state.layout.pages.splice(selectedPage, 1);
    state.layout.pages.splice(target, 0, page);
    selectedPage = target;
    renderAll();
  }

  // Mirror of the shell's first-fit placement. Total cells alone can't tell whether
  // everything fits (five quarter-uppers are only 5/8 cells, but the top row holds 4),
  // so simulate the real 4x2 placement and count the slots that get dropped.
  function countUnplaced(slots) {
    const occupied = [new Array(4).fill(false), new Array(4).fill(false)]; // [row][col]
    let dropped = 0;
    for (const s of slots) {
      const { width, band } = parseSize(s.size);
      const w = WIDTH_COLS[width];
      const rows = band === 'full' ? [0, 1] : band === 'upper' ? [0] : [1];
      let placed = false;
      for (let col = 0; col + w <= 4 && !placed; col++) {
        let fits = true;
        for (const r of rows) for (let i = 0; i < w && fits; i++) if (occupied[r][col + i]) fits = false;
        if (!fits) continue;
        for (const r of rows) for (let i = 0; i < w; i++) occupied[r][col + i] = true;
        placed = true;
      }
      if (!placed) dropped++;
    }
    return dropped;
  }

  function renderCapacity(page) {
    const slots = page.slots || [];
    const used = slots.reduce((sum, s) => sum + sizeCells(s.size), 0);
    const dropped = countUnplaced(slots);
    const cap = el('capacity');
    cap.textContent = 'Space used: ' + used + ' / 8';
    cap.classList.toggle('warn', dropped > 0);
    if (dropped > 0)
      cap.textContent += ' — ' + dropped + ' widget' + (dropped > 1 ? 's' : '') + ' won\'t fit and will be dropped';
  }

  function renderSlot(page, slot, index) {
    const card = document.createElement('div');
    card.className = 'slot-card';

    const row = document.createElement('div');
    row.className = 'slot-row';

    // widget picker
    const widgetSelect = document.createElement('select');
    widgetSelect.className = 'widget';
    for (const w of state.widgets) {
      const opt = new Option(w.name + '  (' + w.id + ')', w.id, false, w.id === slot.widgetId);
      widgetSelect.add(opt);
    }
    if (slot.widgetId && !widgetsById.has(slot.widgetId)) {
      widgetSelect.add(new Option(slot.widgetId + '  (not installed)', slot.widgetId, false, true));
    }
    widgetSelect.onchange = () => {
      slot.widgetId = widgetSelect.value;
      slot.settings = {};
      const w = widgetsById.get(slot.widgetId);
      const widths = offeredWidths(w);
      const current = parseSize(slot.size);
      if (!widths.includes(current.width))
        slot.size = widths[0] + (current.band === 'full' ? '' : '-' + current.band);
      renderEditor();
    };

    // size picker: every offered width, each at full height or just the top/bottom band
    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'size';
    const widget = widgetsById.get(slot.widgetId);
    for (const width of offeredWidths(widget)) {
      for (const band of ['', '-upper', '-lower']) {
        const value = width + band;
        sizeSelect.add(new Option(sizeLabel(value), value, false, value === slot.size));
      }
    }
    if (![...sizeSelect.options].some((o) => o.selected))
      sizeSelect.add(new Option(sizeLabel(slot.size), slot.size, false, true));
    sizeSelect.onchange = () => { slot.size = sizeSelect.value; renderCapacity(page); };

    row.append(widgetSelect, sizeSelect,
      iconButton('▲', 'Move up', () => moveSlot(page, index, -1)),
      iconButton('▼', 'Move down', () => moveSlot(page, index, 1)),
      iconButton('✕', 'Remove', () => { page.slots.splice(index, 1); renderEditor(); }, true));
    card.appendChild(row);

    // property editors, sectioned by group where the widget declares them
    if (widget && widget.properties && widget.properties.length) {
      const grid = document.createElement('div');
      grid.className = 'props';
      slot.settings = slot.settings || {};
      let lastGroup = null;
      for (const prop of widget.properties) {
        if (prop.group && prop.group !== lastGroup) {
          lastGroup = prop.group;
          const heading = document.createElement('div');
          heading.className = 'group-title';
          heading.textContent = prop.group;
          grid.appendChild(heading);
        }
        const label = document.createElement('label');
        label.textContent = prop.label || prop.name;
        grid.append(label, propEditor(prop, slot));
      }
      card.appendChild(grid);
    }
    return card;
  }

  function moveSlot(page, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= page.slots.length) return;
    const [slot] = page.slots.splice(index, 1);
    page.slots.splice(target, 0, slot);
    renderEditor();
  }

  function iconButton(text, title, onClick, danger) {
    const btn = document.createElement('button');
    btn.className = 'icon ghost' + (danger ? ' danger' : '');
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Widths a widget can take: its declared supported widths, plus three-quarter for
  // anything fluid enough to declare half or full (all stock widgets are vh-fluid).
  function offeredWidths(widget) {
    const declared = (widget && widget.supportedSlots && widget.supportedSlots.length)
      ? widget.supportedSlots.map((s) => parseSize(s).width) : WIDTHS.slice();
    const set = new Set(declared);
    if (set.has('half') || set.has('full')) set.add('three-quarter');
    return WIDTHS.filter((w) => set.has(w));
  }

  function sizeLabel(size) {
    const { width, band } = parseSize(size);
    const name = { quarter: 'Quarter', half: 'Half', 'three-quarter': 'Three-quarter', full: 'Full' }[width];
    const px = WIDTH_PX[width];
    if (band === 'full') return name + ' (' + px + '×400)';
    return name + ' · ' + (band === 'upper' ? 'top' : 'bottom') + ' (' + px + '×200)';
  }

  // ---- property editors -------------------------------------------------------------

  function makeSensorSelect(currentId, sensorType, onChange) {
    const select = document.createElement('select');
    select.add(new Option('Auto / none', '', false, !currentId));
    const sensors = (state.sensors || []).filter((s) => !sensorType || s.type === sensorType);
    for (const s of sensors) {
      const text = s.device + ' — ' + s.name + (s.value != null ? '  (' + s.value + ' ' + s.units + ')' : '');
      select.add(new Option(text, s.id, false, s.id === currentId));
    }
    if (currentId && !sensors.some((s) => s.id === currentId)) {
      select.add(new Option(currentId + '  (missing)', currentId, false, true));
    }
    select.onchange = () => onChange(select.value);
    return select;
  }

  function propEditor(prop, slot) {
    const current = slot.settings[prop.name] !== undefined ? slot.settings[prop.name] : prop.default;
    const set = (value) => { slot.settings[prop.name] = value; refreshReplica('layout'); };

    switch (prop.type) {
      case 'switch': { // iCUE boolean toggle
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = current === true || current === 'true';
        input.onchange = () => set(input.checked);
        return input;
      }
      case 'sensors-factory': { // iCUE "add sensors" list: [{sensorId, color}]
        const wrap = document.createElement('div');
        wrap.className = 'factory';
        const items = Array.isArray(current)
          ? current.filter((x) => x && typeof x === 'object')
              .map((x) => ({ sensorId: x.sensorId || '', color: x.color || '#76b900' }))
          : [];
        const commit = () => set(items.map((x) => ({ sensorId: x.sensorId, color: x.color })));
        const renderList = () => {
          wrap.textContent = '';
          items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'factory-row';
            const sensor = makeSensorSelect(item.sensorId, prop.sensor_type, (v) => { item.sensorId = v; commit(); });
            const color = document.createElement('input');
            color.type = 'color';
            color.value = /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#76b900';
            color.oninput = () => { item.color = color.value; commit(); };
            row.append(sensor, color,
              iconButton('✕', 'Remove sensor', () => { items.splice(i, 1); commit(); renderList(); }, true));
            wrap.appendChild(row);
          });
          const add = document.createElement('button');
          add.className = 'ghost';
          add.textContent = '+ Add sensor';
          add.addEventListener('click', () => {
            items.push({ sensorId: (state.sensors[0] || {}).id || '', color: '#76b900' });
            commit();
            renderList();
          });
          wrap.appendChild(add);
        };
        renderList();
        return wrap;
      }
      case 'media-selector': { // iCUE background image/video picker — not supported yet
        const note = document.createElement('span');
        note.className = 'muted';
        note.textContent = 'Background media is not supported yet.';
        return note;
      }
      case 'location': { // city search: disambiguates duplicate place names (Lewisville TX vs NC…)
        const wrap = document.createElement('div');
        wrap.className = 'location-picker';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search city…';
        const results = document.createElement('select');
        results.hidden = true;
        const chosen = document.createElement('span');
        chosen.className = 'muted';

        let value = current;
        let found = [];
        let searchTimer = null;

        const describe = () => {
          if (value && typeof value === 'object' && value.label) chosen.textContent = 'Selected: ' + value.label;
          else if (typeof value === 'string' && value.trim()) chosen.textContent = 'Will use the best match for "' + value.trim() + '" — pick from the list to be exact.';
          else chosen.textContent = 'Type a city name and pick a match.';
        };
        input.value = value && typeof value === 'object' ? (value.label || '') : (typeof value === 'string' ? value : '');
        describe();

        input.addEventListener('input', () => {
          clearTimeout(searchTimer);
          const query = input.value.trim();
          value = query;         // fallback: raw string, widget resolves best match
          set(value);
          describe();
          if (query.length < 2) { results.hidden = true; return; }
          searchTimer = setTimeout(async () => {
            try {
              const response = await fetch(
                'https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=' +
                encodeURIComponent(query));
              const data = await response.json();
              found = data.results || [];
              results.textContent = '';
              results.add(new Option(found.length ? 'Pick a match…' : 'No matches found', ''));
              found.forEach((hit, i) => {
                const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
                const pop = hit.population ? '  ·  pop ' + hit.population.toLocaleString() : '';
                results.add(new Option(label + pop, String(i)));
              });
              results.hidden = false;
            } catch (e) {
              chosen.textContent = 'Search unavailable (offline?) — the typed name will be matched at runtime.';
            }
          }, 400);
        });

        results.addEventListener('change', () => {
          const hit = found[Number(results.value)];
          if (!hit) return;
          const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
          value = { label, latitude: hit.latitude, longitude: hit.longitude };
          set(value);
          input.value = label;
          results.hidden = true;
          describe();
        });

        wrap.append(input, results, chosen);
        return wrap;
      }
      case 'color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = typeof current === 'string' && /^#[0-9a-f]{6}$/i.test(current) ? current : '#00d4ff';
        input.oninput = () => set(input.value);
        return input;
      }
      case 'slider': {
        const wrap = document.createElement('div');
        wrap.className = 'slider-wrap';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = prop.min != null ? prop.min : 0;
        input.max = prop.max != null ? prop.max : 100;
        input.step = prop.step != null ? prop.step : 1;
        input.value = current != null ? current : input.min;
        const out = document.createElement('output');
        out.value = String(input.value);
        input.oninput = () => { out.value = String(input.value); set(parseFloat(input.value)); };
        wrap.append(input, out);
        return wrap;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        if (prop.min != null) input.min = prop.min;
        if (prop.max != null) input.max = prop.max;
        if (prop.step != null) input.step = prop.step;
        input.value = current != null ? current : '';
        input.oninput = () => {
          const parsed = parseFloat(input.value);
          if (!Number.isNaN(parsed)) set(parsed);
        };
        return input;
      }
      case 'select': {
        const select = document.createElement('select');
        for (const option of prop.options || []) {
          select.add(new Option(option, option, false, option === current));
        }
        if (prop.optionsSource === 'sd-profiles') {
          // Options come from the host (discovered Virtual Stream Deck profiles) —
          // the user picks from a list instead of typing a profile name.
          select.add(new Option('First available (default)', '', false, !current));
          if (current) select.add(new Option(current, current, false, true));
          sdProfileWaiters.push((profiles) => {
            if (!select.isConnected) return;
            const chosen = select.value;
            select.textContent = '';
            select.add(new Option('First available (default)', '', false, !chosen));
            for (const name of profiles) {
              select.add(new Option(name, name, false, name === chosen));
            }
            if (chosen && !profiles.includes(chosen)) {
              select.add(new Option(chosen + '  (not found right now)', chosen, false, true));
            }
          });
          post({ type: 'sd-profiles' });
        }
        select.onchange = () => set(select.value);
        return select;
      }
      case 'list': { // structured rows — the user never types a delimited string
        const wrap = document.createElement('div');
        wrap.className = 'factory list-editor';
        const fields = Array.isArray(prop.fields) && prop.fields.length
          ? prop.fields
          : [{ key: 'value', label: 'Value', type: 'text' }];

        // Accept the stored array, or convert a legacy "A=B, C=D" delimited string from
        // an old layout into rows mapped onto the first two fields.
        let items;
        if (Array.isArray(current)) {
          items = current.filter((x) => x && typeof x === 'object').map((x) => Object.assign({}, x));
        } else if (typeof current === 'string' && current.trim()) {
          items = current.split(',').map((pair) => {
            const eq = pair.indexOf('=');
            const item = {};
            item[fields[0].key] = (eq < 0 ? pair : pair.slice(0, eq)).trim();
            if (fields[1]) item[fields[1].key] = eq < 0 ? '' : pair.slice(eq + 1).trim();
            return item;
          }).filter((x) => Object.values(x).some((v) => v));
        } else {
          items = [];
        }

        const commit = () => set(items.map((x) => Object.assign({}, x)));
        // A legacy string value renders as rows immediately, but only writes back as an
        // array once the user touches the editor — untouched layouts stay byte-identical.
        const renderList = () => {
          wrap.textContent = '';
          items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'factory-row';
            for (const field of fields) {
              const input = document.createElement('input');
              if (field.type === 'color') {
                input.type = 'color';
                input.value = /^#[0-9a-f]{6}$/i.test(item[field.key]) ? item[field.key] : '#4cc2ff';
              } else {
                input.type = 'text';
                input.placeholder = field.placeholder || field.label || '';
                input.value = item[field.key] != null ? String(item[field.key]) : '';
              }
              input.setAttribute('aria-label', field.label || field.key);
              input.oninput = () => { item[field.key] = input.value; commit(); };
              row.appendChild(input);
            }
            row.appendChild(iconButton('✕', 'Remove ' + (prop.itemLabel || 'item'), () => {
              items.splice(i, 1); commit(); renderList();
            }, true));
            wrap.appendChild(row);
          });
          const add = document.createElement('button');
          add.className = 'ghost';
          add.textContent = '+ Add ' + (prop.itemLabel || 'item');
          add.addEventListener('click', () => {
            const item = {};
            for (const field of fields) item[field.key] = field.type === 'color' ? '#4cc2ff' : '';
            items.push(item);
            commit();
            renderList();
            const first = wrap.querySelector('.factory-row:last-of-type input');
            if (first) first.focus();
          });
          wrap.appendChild(add);
        };
        renderList();
        return wrap;
      }
      case 'sensor': {
        const select = document.createElement('select');
        select.add(new Option('Auto (recommended)', '', false, !current));
        const sensors = (state.sensors || []).filter((s) =>
          !prop.sensor_type || s.type === prop.sensor_type);
        for (const s of sensors) {
          const text = s.device + ' — ' + s.name + (s.value != null ? '  (' + s.value + ' ' + s.units + ')' : '');
          select.add(new Option(text, s.id, false, s.id === current));
        }
        if (current && !sensors.some((s) => s.id === current)) {
          select.add(new Option(current + '  (missing)', current, false, true));
        }
        select.onchange = () => set(select.value);
        return select;
      }
      default: { // text
        const input = document.createElement('input');
        input.type = 'text';
        input.value = current != null ? String(current) : '';
        input.oninput = () => set(input.value);
        return input;
      }
    }
  }

  // ---- background editor ---------------------------------------------------------------

  // Renders a compact wallpaper editor into `container`. getSpec()/setSpec(spec|null)
  // read and write the target background (a page's or the dashboard's). setSpec(null)
  // clears it; for a page that means "inherit the dashboard background".
  function renderBackgroundEditor(container, getSpec, setSpec, opts) {
    opts = opts || {};
    container.textContent = '';
    const spec = getSpec();
    const type = spec ? (spec.type || 'none') : (opts.allowInherit ? 'inherit' : 'none');

    const choices = [];
    if (opts.allowInherit) choices.push(['inherit', 'Use dashboard default']);
    choices.push(['none', 'None'], ['color', 'Solid color'], ['gradient', 'Gradient'],
      ['image', 'Image'], ['video', 'Video (animated)']);

    const typeSel = document.createElement('select');
    for (const [value, label] of choices) typeSel.add(new Option(label, value, false, value === type));
    typeSel.onchange = () => {
      const v = typeSel.value;
      if (v === 'inherit') setSpec(null);
      else if (v === 'none') setSpec({ type: 'none' });
      else {
        // Merge from the LIVE spec (getSpec), not the render-time snapshot, so a color/
        // slider edit made just before switching type isn't discarded.
        const next = Object.assign({ type: 'none', fit: 'cover', angle: 135, dim: 0, blur: 0 }, getSpec() || {}, { type: v });
        if (v === 'color' || v === 'gradient') { next.dim = 0; next.blur = 0; } // flat fills aren't dimmed/blurred
        setSpec(next);
      }
      renderBackgroundEditor(container, getSpec, setSpec, opts);
    };
    container.appendChild(bgRow('Type', typeSel));

    if (type === 'inherit' || type === 'none') return;

    const patch = (p) => setSpec(Object.assign({}, getSpec(), p));
    const cur = getSpec() || {};

    if (type === 'color') {
      container.appendChild(bgColor('Color', cur.color || '#101418', (v) => patch({ color: v })));
    } else if (type === 'gradient') {
      container.appendChild(bgColor('Color 1', cur.color || '#101418', (v) => patch({ color: v })));
      container.appendChild(bgColor('Color 2', cur.color2 || '#0b0e14', (v) => patch({ color2: v })));
      container.appendChild(bgSlider('Angle', cur.angle != null ? cur.angle : 135, 0, 360, 5, '°', (v) => patch({ angle: v })));
    } else if (type === 'image' || type === 'video') {
      container.appendChild(bgFile(container, getSpec, setSpec, opts, type));
      container.appendChild(bgFitField(cur.fit || 'cover', (v) => patch({ fit: v })));
      container.appendChild(bgSlider('Dim', cur.dim || 0, 0, 100, 5, '%', (v) => patch({ dim: v })));
      container.appendChild(bgSlider('Blur', cur.blur || 0, 0, 40, 1, 'px', (v) => patch({ blur: v })));
    }
  }

  function bgRow(labelText, control) {
    const row = document.createElement('div');
    row.className = 'bg-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.append(label, control);
    return row;
  }

  // <input type=color> only accepts #rrggbb; normalize any valid CSS hex to it so a
  // hand-authored #fff or #112233ff shows the real color instead of the theme default.
  function toHex6(value) {
    if (typeof value !== 'string') return '#101418';
    const m = value.trim().match(/^#([0-9a-fA-F]{3,8})$/);
    if (!m) return '#101418';
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; // expand, drop alpha
    else if (h.length === 6 || h.length === 8) h = h.slice(0, 6);                      // drop alpha
    else return '#101418';                                                             // 5/7 digits: invalid
    return '#' + h.toLowerCase();
  }

  function bgColor(labelText, value, onChange) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = toHex6(value);
    input.oninput = () => onChange(input.value);
    return bgRow(labelText, input);
  }

  function bgSlider(labelText, value, min, max, step, unit, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'slider-wrap';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = value;
    const out = document.createElement('output');
    out.value = value + (unit || '');
    input.oninput = () => { out.value = input.value + (unit || ''); onChange(parseFloat(input.value)); };
    wrap.append(input, out);
    return bgRow(labelText, wrap);
  }

  function bgFitField(value, onChange) {
    const select = document.createElement('select');
    for (const [v, label] of [['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch'],
      ['tile', 'Tile'], ['center', 'Center']]) {
      select.add(new Option(label, v, false, v === value));
    }
    select.onchange = () => onChange(select.value);
    return bgRow('Fit', select);
  }

  function bgFile(container, getSpec, setSpec, opts, type) {
    const wrap = document.createElement('div');
    wrap.className = 'bg-file';

    const spec = getSpec() || {};
    if (spec.source) {
      const url = 'https://' + backgroundHost + '/' + encodeURIComponent(spec.source);
      const preview = type === 'video' ? document.createElement('video') : document.createElement('img');
      preview.className = 'bg-preview';
      preview.src = url;
      if (type === 'video') { preview.muted = true; preview.loop = true; preview.autoplay = true; preview.setAttribute('playsinline', ''); }
      preview.onerror = () => { preview.classList.add('broken'); };
      wrap.appendChild(preview);
    }

    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = spec.source ? 'Change file…' : 'Choose file…';
    btn.onclick = () => {
      pendingBgPick = (source, kind) => {
        // If the chosen file's kind differs from the control (image vs video), follow it.
        const nextType = kind === 'video' ? 'video' : 'image';
        setSpec(Object.assign({ fit: 'cover', angle: 135, dim: 0, blur: 0 }, getSpec() || {}, { type: nextType, source }));
        renderBackgroundEditor(container, getSpec, setSpec, opts);
      };
      post({ type: 'pick-background', target: opts.allowInherit ? ('page:' + selectedPage) : 'global' });
    };
    wrap.appendChild(btn);

    const name = document.createElement('span');
    name.className = 'bg-filename muted';
    name.textContent = spec.source || 'No file chosen';
    wrap.appendChild(name);

    return bgRow(type === 'video' ? 'Video' : 'Image', wrap);
  }

  // ---- toast ---------------------------------------------------------------------------

  function toast(message, isError) {
    const node = el('toast');
    node.textContent = message;
    node.classList.toggle('error', !!isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  // ---- go -------------------------------------------------------------------------------

  post({ type: 'settings-ready' });
})();

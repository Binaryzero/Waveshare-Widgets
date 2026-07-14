// Settings editor: edits the layout (pages -> slots -> widget + size + properties)
// and posts it back to the host, which saves layout.json and reloads the dashboard.
(function () {
  'use strict';

  const SIZE_UNITS = { quarter: 1, half: 2, full: 4 };

  let state = { layout: { pages: [] }, widgets: [], sensors: [] };
  let widgetsById = new Map();
  let selectedPage = 0;
  let toastTimer = null;
  let backgroundHost = 'backgrounds.wsw';
  let pendingBgPick = null;    // callback(source, kind) for the in-flight file dialog

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
    }
  });

  function post(message) {
    window.chrome.webview.postMessage(message);
  }

  // ---- top bar ----------------------------------------------------------------

  el('save').addEventListener('click', () => post({ type: 'save-layout', layout: state.layout }));
  el('installWidget').addEventListener('click', () => post({ type: 'install-widget' }));
  el('openFolder').addEventListener('click', () => post({ type: 'open-widgets-folder' }));
  el('addPage').addEventListener('click', () => {
    state.layout.pages.push({ name: 'Page ' + (state.layout.pages.length + 1), slots: [] });
    selectedPage = state.layout.pages.length - 1;
    renderAll();
  });

  // ---- page panel ----------------------------------------------------------------

  function renderAll() {
    renderPageList();
    renderGlobalBackground();
    renderEditor();
  }

  function renderGlobalBackground() {
    renderBackgroundEditor(
      el('globalBg'),
      () => state.layout.background || null,
      (spec) => { if (spec) state.layout.background = spec; else delete state.layout.background; },
      { allowInherit: false });
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
      (spec) => { if (spec) page.background = spec; else delete page.background; },
      { allowInherit: true });

    const nameInput = el('pageName');
    nameInput.value = page.name || '';
    nameInput.oninput = () => { page.name = nameInput.value; renderPageList(); };

    el('deletePage').onclick = () => {
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

  function renderCapacity(page) {
    const used = (page.slots || []).reduce((sum, s) => sum + (SIZE_UNITS[s.size] || 1), 0);
    const cap = el('capacity');
    cap.textContent = 'Width used: ' + used + ' / 4';
    cap.classList.toggle('warn', used > 4);
    if (used > 4) cap.textContent += ' — extra widgets will be cut off';
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
      if (w && w.supportedSlots && !w.supportedSlots.includes(slot.size)) slot.size = w.supportedSlots[0];
      renderEditor();
    };

    // size picker
    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'size';
    const widget = widgetsById.get(slot.widgetId);
    const sizes = widget && widget.supportedSlots && widget.supportedSlots.length
      ? widget.supportedSlots : ['quarter', 'half', 'full'];
    for (const size of sizes) {
      sizeSelect.add(new Option(sizeLabel(size), size, false, size === slot.size));
    }
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

  function sizeLabel(size) {
    return { quarter: 'Quarter (320px)', half: 'Half (640px)', full: 'Full (1280px)' }[size] || size;
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
    const set = (value) => { slot.settings[prop.name] = value; };

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
        select.onchange = () => set(select.value);
        return select;
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
      else setSpec(Object.assign({ type: 'none', fit: 'cover', angle: 135, dim: 0, blur: 0 }, spec || {}, { type: v }));
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

  function bgColor(labelText, value, onChange) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#101418';
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

'use strict';
(() => {
  /* ===================================================================== helpers */
  const $ = (s, r = document) => r.querySelector(s);

  // Tiny hyperscript. Everything user-supplied goes through text nodes => no XSS.
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'min', 'max', 'step']);
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (PROPS.has(k)) { el[k] = v; continue; }
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (k) => {
      if (k == null || k === false) return;
      if (Array.isArray(k)) return k.forEach(add);
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  }

  const put = (el, ...kids) => el.append(...kids.filter((k) => k != null && k !== false));

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && state.user) { state.user = null; showLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg, kind = '') {
    const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 4500);
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'error'); } };

  /* ===================================================================== state */
  const state = {
    config: null, user: null, devices: [], selectedId: null, view: 'live', params: new URLSearchParams(),
    follow: true, ws: null, wsDelay: 1000, history: null, recharge: null, events: [], pushState: 'unknown',
  };
  const selected = () => state.devices.find((d) => d.id === state.selectedId) || state.devices[0] || null;

  /* ===================================================================== formatting */
  const tz = () => state.config.timezone;
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz(), ...opts });
  const fmtDateTime = (iso) => (iso ? fmt({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) : '—');
  const fmtTime = (iso) => (iso ? fmt({ hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(iso)) : '—');
  const fmtDay = (ymd) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T00:00:00Z`));
  const money = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const shiftDay = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  const agoEl = (iso) => h('span', { 'data-ago': iso || '' }, ago(iso));
  setInterval(() => document.querySelectorAll('[data-ago]').forEach((e) => { e.textContent = ago(e.dataset.ago || null); }), 15000);

  const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((deg || 0) / 45) % 8];
  const bars = (level, max) => h('span', { class: 'bars', title: `${level}/${max}` },
    Array.from({ length: max }, (_, i) => h('i', { class: i < level ? 'on' : '', style: `height:${5 + i * (9 / max)}px` })));

  /* ===================================================================== Google Maps */
  const mapState = { ready: null, map: null, markers: new Map(), line: null, histMarkers: [], playMarker: null, lib: {}, geocoder: null, geoCache: new Map() };

  function loadMaps() {
    if (mapState.ready) return mapState.ready;
    mapState.ready = new Promise((resolve, reject) => {
      if (!state.config.mapsApiKey) return reject(new Error('GOOGLE_MAPS_API_KEY is not set on the server'));
      window.__mapsLoaded = async () => {
        try {
          const [maps, marker, geo] = await Promise.all([
            google.maps.importLibrary('maps'), google.maps.importLibrary('marker'), google.maps.importLibrary('geocoding'),
          ]);
          mapState.lib = { ...maps, ...marker, ...geo };
          mapState.map = new maps.Map($('#map'), {
            center: { lat: 23.8103, lng: 90.4125 }, zoom: 13, mapId: state.config.mapId,
            disableDefaultUI: true, zoomControl: true, fullscreenControl: true, mapTypeControl: true, streetViewControl: false,
            gestureHandling: 'greedy', clickableIcons: false,
          });
          mapState.map.addListener('dragstart', () => { state.follow = false; });
          mapState.geocoder = new geo.Geocoder();
          resolve();
        } catch (e) { reject(e); }
      };
      window.gm_authFailure = () => showMapMsg('Google Maps rejected the API key. Check the key, enabled APIs and referrer restrictions.');
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.config.mapsApiKey)}&v=weekly&loading=async&callback=__mapsLoaded`;
      s.async = true;
      s.onerror = () => reject(new Error('Could not load Google Maps'));
      document.head.append(s);
    });
    mapState.ready.catch((e) => showMapMsg(e.message));
    return mapState.ready;
  }
  function showMapMsg(msg) { const m = $('#mapMsg'); m.textContent = msg; m.classList.remove('hidden'); }

  const ARROW = '<svg viewBox="0 0 24 24"><path d="M12 2 4.5 21l7.5-4.5 7.5 4.5z"/></svg>';
  function pinContent(dev) {
    const el = h('div', { class: 'pin' }, h('div', { class: 'disc' }), h('div', { class: 'tag' }));
    el.firstChild.innerHTML = ARROW; // static trusted markup
    stylePin(el, dev);
    return el;
  }
  function stylePin(el, dev) {
    el.classList.toggle('on', dev.ignition === true);
    el.classList.toggle('offline', !dev.online);
    el.querySelector('svg').style.transform = `rotate(${dev.position?.course || 0}deg)`;
    el.querySelector('.tag').textContent = dev.name;
    el.querySelector('.tag').style.display = state.devices.length > 1 ? '' : 'none';
  }

  async function syncMarkers({ fit = false } = {}) {
    try { await loadMaps(); } catch { return; }
    const { AdvancedMarkerElement } = mapState.lib;
    const live = state.view === 'live';
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const dev of state.devices) {
      let m = mapState.markers.get(dev.id);
      if (!dev.position) { if (m) { m.map = null; mapState.markers.delete(dev.id); } continue; }
      const pos = { lat: dev.position.latitude, lng: dev.position.longitude };
      if (!m) {
        m = new AdvancedMarkerElement({ position: pos, content: pinContent(dev), title: dev.name, zIndex: 10 });
        m.addListener('click', () => { state.selectedId = dev.id; state.follow = true; render(); });
        mapState.markers.set(dev.id, m);
      } else { m.position = pos; stylePin(m.content, dev); }
      m.map = live ? mapState.map : null;
      bounds.extend(pos); any = true;
    }
    if (live && any && fit) {
      const dev = selected();
      if (dev?.position && (state.devices.length === 1 || state.follow)) {
        mapState.map.setCenter({ lat: dev.position.latitude, lng: dev.position.longitude });
        mapState.map.setZoom(Math.max(mapState.map.getZoom(), 16));
      } else mapState.map.fitBounds(bounds, 60);
    }
  }

  function clearHistoryLayer() {
    mapState.line?.setMap(null); mapState.line = null;
    mapState.histMarkers.forEach((m) => { m.map = null; }); mapState.histMarkers = [];
    if (mapState.playMarker) { mapState.playMarker.map = null; mapState.playMarker = null; }
  }

  async function reverseGeocode(pos) {
    const key = `${pos.latitude.toFixed(4)},${pos.longitude.toFixed(4)}`;
    if (mapState.geoCache.has(key)) return mapState.geoCache.get(key);
    try {
      await loadMaps();
      const { results } = await mapState.geocoder.geocode({ location: { lat: pos.latitude, lng: pos.longitude } });
      const a = results?.[0]?.formatted_address || null;
      mapState.geoCache.set(key, a);
      return a;
    } catch { return null; }
  }

  /* ===================================================================== views */
  const panel = () => $('#panel');
  const views = { live: viewLive, history: viewHistory, recharge: viewRecharge, settings: viewSettings };

  function deviceChips(onPick) {
    if (state.devices.length < 2) return null;
    return h('div', { class: 'chips' }, state.devices.map((d) => h('button', {
      class: `chip ${d.id === selected()?.id ? 'active' : ''}`, onclick: () => { state.selectedId = d.id; state.follow = true; onPick(); },
    }, d.name)));
  }

  const emptyDevices = () => h('div', { class: 'card empty' },
    h('h2', null, 'Add your tracker'),
    h('p', null, 'Register the device with the serial number (IMEI) printed on it to start tracking.'),
    h('a', { class: 'btn primary', href: '#/settings' }, 'Add device'));

  /* ---------------------------------------------------------------- live */
  const EVENT_LABEL = { ignition_on: 'Ignition on', ignition_off: 'Ignition off' };

  function simLine(dev) {
    const r = dev.recharge;
    if (r.status === 'none') return h('a', { href: `#/recharge?d=${dev.id}`, class: 'btn sm' }, 'Add SIM recharge');
    const cls = r.status === 'expired' ? 'bad' : r.status === 'expiring' ? 'warn' : 'ok';
    const txt = r.daysLeft < 0 ? `SIM expired ${-r.daysLeft}d ago` : r.daysLeft === 0 ? 'SIM expires today' : `SIM: ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`;
    return h('a', { href: `#/recharge?d=${dev.id}`, style: 'text-decoration:none' }, h('span', { class: `badge ${cls}` }, txt));
  }

  async function viewLive() {
    const root = panel();
    root.replaceChildren();
    if (!state.devices.length) { put(root, emptyDevices()); return; }
    const dev = selected();
    state.selectedId = dev.id;
    const p = dev.position;

    const ignBadge = dev.ignition === null ? h('span', { class: 'badge plain' }, 'Ignition unknown')
      : h('span', { class: `badge ${dev.ignition ? 'ok' : ''}` }, dev.ignition ? 'Ignition ON' : 'Ignition OFF');
    const onBadge = h('span', { class: `badge ${dev.online ? 'ok' : 'bad'}` }, dev.online ? 'Online' : 'Offline');
    const addr = h('span', { class: 'muted' }, p ? '…' : '—');

    const card = h('div', { class: 'card' },
      h('div', { class: 'row between wrap' }, h('h2', { style: 'margin:0' }, dev.name), h('div', { class: 'row' }, ignBadge, onBadge)),
      h('div', { class: 'row between', style: 'margin-top:16px' },
        h('div', { class: 'speed' }, p ? Math.round(p.speed || 0) : '—', ' ', h('small', null, 'km/h')),
        p ? h('div', { class: 'muted', style: 'text-align:right' }, `Heading ${compass(p.course)}`, h('br'), `${Math.round(p.course || 0)}°`) : null),
      h('dl', { class: 'kv' },
        h('dt', null, 'Last position'), h('dd', null, p ? agoEl(p.time) : 'No data yet'),
        h('dt', null, 'Last contact'), h('dd', null, agoEl(dev.lastSeen)),
        h('dt', null, 'Location'), h('dd', null, addr),
        p ? [h('dt', null, 'Coordinates'), h('dd', null, `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`),
          h('dt', null, 'Satellites'), h('dd', null, p.satellites ?? '—')] : null,
        dev.batteryLevel != null ? [h('dt', null, 'Tracker battery'), h('dd', null, bars(Math.min(dev.batteryLevel, 6), 6))] : null,
        dev.gsmLevel != null ? [h('dt', null, 'GSM signal'), h('dd', null, bars(Math.min(dev.gsmLevel, 4), 4))] : null),
      h('div', { class: 'btn-row' },
        h('button', { class: `btn ${state.follow ? 'primary' : ''}`, onclick: () => { state.follow = !state.follow; if (state.follow) syncMarkers({ fit: true }); viewLive(); } }, state.follow ? 'Following' : 'Follow'),
        p ? h('a', { class: 'btn', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}` }, 'Open in Google Maps') : null,
        p ? h('a', { class: 'btn', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}` }, 'Directions') : null));

    const sim = h('div', { class: 'card row between' }, simLine(dev),
      h('a', { class: 'small', href: `#/recharge?d=${dev.id}` }, 'Manage'));

    const evBox = h('div', { class: 'card flush' }, h('div', { style: 'padding:14px 16px 4px' }, h('h3', null, 'Recent activity')));
    put(root, deviceChips(render), card, sim, evBox);

    if (p) reverseGeocode(p).then((a) => { addr.textContent = a || 'Address unavailable'; });
    try {
      const { events } = await api('GET', `/api/devices/${dev.id}/events?limit=6`);
      if (state.view !== 'live' || selected()?.id !== dev.id) return;
      evBox.append(events.length
        ? h('ul', { class: 'list' }, events.map((e) => eventItem(e)))
        : h('p', { class: 'muted small', style: 'padding:0 16px 16px' }, 'Nothing yet. Ignition and alarm events will show up here.'));
    } catch { /* ignore */ }
  }

  function eventItem(e) {
    const kind = e.type === 'ignition_on' ? 'ok' : e.type.startsWith('alarm') ? 'bad' : '';
    return h('li', null, h('span', { class: `dot ${kind}` }),
      h('div', { class: 'grow' }, EVENT_LABEL[e.type] || e.message || e.type),
      h('div', { class: 'muted small' }, fmtDateTime(e.time)));
  }

  /* ---------------------------------------------------------------- history */
  async function viewHistory() {
    const root = panel();
    root.replaceChildren();
    clearHistoryLayer();
    if (!state.devices.length) { put(root, emptyDevices()); return; }
    const dev = selected();
    state.selectedId = dev.id;
    const date = state.params.get('date') || state.historyDate || todayLocal();
    state.historyDate = date;

    const go = (d) => { state.historyDate = d; state.params.set('date', d); viewHistory(); };
    const dateInput = h('input', { type: 'date', value: date, max: todayLocal(), 'aria-label': 'Date', onchange: (e) => e.target.value && go(e.target.value) });
    const body = h('div', null, h('div', { class: 'center-screen', style: 'min-height:120px' }, h('div', { class: 'spinner' })));
    put(root, deviceChips(render),
      h('div', { class: 'card row' },
        h('button', { class: 'btn', 'aria-label': 'Previous day', onclick: () => go(shiftDay(date, -1)) }, '‹'),
        h('div', { class: 'grow' }, dateInput),
        h('button', { class: 'btn', 'aria-label': 'Next day', disabled: date >= todayLocal(), onclick: () => go(shiftDay(date, 1)) }, '›')),
      body);

    let data;
    try { data = await api('GET', `/api/devices/${dev.id}/history?date=${date}`); }
    catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
    if (state.view !== 'history' || state.historyDate !== date || selected()?.id !== dev.id) return;

    const s = data.stats;
    const hh = Math.floor(s.movingMinutes / 60), mm = s.movingMinutes % 60;
    body.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'stats' },
        stat(`${s.distanceKm} km`, 'Distance'), stat(`${Math.round(s.maxSpeed)} km/h`, 'Top speed'),
        stat(hh ? `${hh}h ${mm}m` : `${mm} min`, 'Moving time'), stat(s.pointCount, 'GPS points'))),
      s.pointCount ? playback(data) : h('div', { class: 'card empty' }, h('p', null, `No GPS data on ${fmtDay(date)}.`)),
      h('div', { class: 'card flush' }, h('div', { style: 'padding:14px 16px 4px' }, h('h3', null, 'Events')),
        data.events.length ? h('ul', { class: 'list' }, data.events.map(eventItem))
          : h('p', { class: 'muted small', style: 'padding:0 16px 16px' }, 'No ignition or alarm events this day.')));

    drawRoute(data);
  }
  const stat = (v, l) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, l));

  function playback(data) {
    const pts = data.points;
    const info = h('div', { class: 'row between small' }, h('span', null, fmtTime(pts[0].time)), h('span', { class: 'muted' }, ''));
    const slider = h('input', {
      type: 'range', min: 0, max: pts.length - 1, step: 1, value: pts.length - 1, 'aria-label': 'Scrub through the route',
      oninput: (e) => movePlay(pts[+e.target.value], info),
    });
    state.playInfo = info;
    return h('div', { class: 'card' }, h('h3', null, 'Route playback'), slider, info);
  }
  async function movePlay(pt, info) {
    info.firstChild.textContent = fmtTime(pt.time);
    info.lastChild.textContent = `${Math.round(pt.speed || 0)} km/h`;
    try { await loadMaps(); } catch { return; }
    const pos = { lat: pt.latitude, lng: pt.longitude };
    if (!mapState.playMarker) {
      mapState.playMarker = new mapState.lib.AdvancedMarkerElement({ map: mapState.map, position: pos, content: h('div', { class: 'dotmark' }), zIndex: 20 });
    } else mapState.playMarker.position = pos;
    if (!mapState.map.getBounds()?.contains(pos)) mapState.map.panTo(pos);
  }

  async function drawRoute(data) {
    try { await loadMaps(); } catch { return; }
    if (state.view !== 'history') return;
    clearHistoryLayer();
    if (!data.points.length) return;
    const path = data.points.map((p) => ({ lat: p.latitude, lng: p.longitude }));
    mapState.line = new google.maps.Polyline({ path, strokeColor: '#1a73e8', strokeOpacity: 0.9, strokeWeight: 5, map: mapState.map });
    const { AdvancedMarkerElement } = mapState.lib;
    mapState.histMarkers.push(
      new AdvancedMarkerElement({ map: mapState.map, position: path[0], content: h('div', { class: 'dotmark start' }), title: 'Start' }),
      new AdvancedMarkerElement({ map: mapState.map, position: path.at(-1), content: h('div', { class: 'dotmark end' }), title: 'End' }));
    for (const e of data.events) {
      if (e.latitude == null) continue;
      const c = h('div', { class: 'dotmark', style: `background:${e.type === 'ignition_on' ? '#188038' : e.type === 'ignition_off' ? '#5f6368' : '#d93025'};width:12px;height:12px` });
      mapState.histMarkers.push(new AdvancedMarkerElement({ map: mapState.map, position: { lat: e.latitude, lng: e.longitude }, content: c, title: `${EVENT_LABEL[e.type] || e.message} ${fmtTime(e.time)}` }));
    }
    const b = new google.maps.LatLngBounds();
    path.forEach((p) => b.extend(p));
    mapState.map.fitBounds(b, 50);
    if (state.playInfo) movePlay(data.points.at(-1), state.playInfo);
  }

  /* ---------------------------------------------------------------- recharge */
  const REMINDER_DAYS = [0, 1, 2, 3, 5, 7, 10];
  const VALIDITY = [7, 15, 30, 60, 90];

  async function viewRecharge() {
    const root = panel();
    root.replaceChildren();
    if (!state.devices.length) { put(root, emptyDevices()); return; }
    const dev = selected();
    state.selectedId = dev.id;
    const body = h('div');
    put(root, h('h1', null, 'SIM recharge'), deviceChips(render), body);

    const load = async () => {
      const data = await api('GET', `/api/devices/${dev.id}/recharges`);
      dev.recharge = data.summary;
      body.replaceChildren(...rechargeCards(dev, data, load));
    };
    guard(load)();
  }

  function rechargeCards(dev, data, reload) {
    const r = data.summary;
    const cls = r.status === 'expired' ? 'bad' : r.status === 'expiring' ? 'warn' : '';
    const pct = r.daysLeft == null ? 0 : Math.max(0, Math.min(100, (r.daysLeft / 30) * 100));

    const status = h('div', { class: 'card' },
      r.status === 'none'
        ? h('div', null, h('h2', null, 'No recharge recorded'), h('p', { class: 'muted' }, 'Add your first recharge below to start tracking the SIM expiry.'))
        : h('div', null,
          h('div', { class: 'row between' },
            h('div', null, h('div', { class: 'big-days', style: `color:var(--${r.status === 'expired' ? 'bad' : r.status === 'expiring' ? 'warn' : 'ok'})` },
              r.daysLeft < 0 ? 'Expired' : r.daysLeft), r.daysLeft >= 0 ? h('div', { class: 'muted' }, r.daysLeft === 1 ? 'day left' : 'days left') : null),
            h('div', { style: 'text-align:right' }, h('div', { class: 'muted small' }, r.daysLeft < 0 ? 'Expired on' : 'Valid until'), h('b', null, fmtDay(r.expiresOn)))),
          h('div', { class: `bar ${cls}` }, h('i', { style: `width:${r.status === 'expired' ? 100 : pct}%` }))),
      h('dl', { class: 'kv' },
        h('dt', null, 'Total spent'), h('dd', null, money(r.totalSpent)),
        h('dt', null, 'Recharges'), h('dd', null, r.count),
        r.count ? [h('dt', null, 'Average'), h('dd', null, money(r.totalSpent / r.count))] : null,
        dev.simNumber ? [h('dt', null, 'SIM'), h('dd', null, `${dev.simNumber}${dev.simOperator ? ` (${dev.simOperator})` : ''}`)] : null));

    return [status, rechargeForm(dev, r, reload), reminderCard(dev, reload), historyCard(dev, data.recharges, reload)];
  }

  function rechargeForm(dev, summary, reload) {
    let mode = 'days';
    const amount = h('input', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: summary.lastAmount ? String(summary.lastAmount) : 'e.g. 300', value: '' });
    const on = h('input', { type: 'date', value: todayLocal(), max: todayLocal() });
    const days = h('input', { type: 'number', min: 1, max: 3650, step: 1, inputmode: 'numeric', value: 30 });
    const exp = h('input', { type: 'date', value: '' });
    const note = h('input', { type: 'text', maxlength: 200, placeholder: 'Optional (pack name, bKash ref…)' });
    const preview = h('p', { class: 'small muted' });
    const daysWrap = h('div', null,
      h('label', { class: 'field' }, 'Validity (days)', days),
      h('div', { class: 'chips', style: 'padding:8px 0 0' }, VALIDITY.map((v) => h('button', { type: 'button', class: 'chip', onclick: () => { days.value = v; update(); } }, `${v}d`))));
    const expWrap = h('label', { class: 'field hidden' }, 'Expiry date (last valid day)', exp);

    const computeExpiry = () => {
      if (mode === 'date') return exp.value || null;
      const n = parseInt(days.value, 10);
      if (!n || n < 1) return null;
      const cur = summary.expiresOn;
      return cur && cur >= on.value ? shiftDay(cur, n) : shiftDay(on.value, n - 1);
    };
    const update = () => {
      const e = computeExpiry();
      preview.textContent = e ? `New expiry: ${fmtDay(e)}${mode === 'days' && summary.expiresOn && summary.expiresOn >= on.value ? ' (added on top of the current pack)' : ''}` : '';
    };
    [on, days, exp].forEach((i) => i.addEventListener('input', update));
    update();

    const toggle = h('button', { type: 'button', class: 'btn sm', onclick: () => {
      mode = mode === 'days' ? 'date' : 'days';
      daysWrap.classList.toggle('hidden', mode !== 'days');
      expWrap.classList.toggle('hidden', mode !== 'date');
      toggle.textContent = mode === 'days' ? 'Enter expiry date instead' : 'Enter validity days instead';
      update();
    } }, 'Enter expiry date instead');

    const form = h('form', { class: 'card stack', onsubmit: guard(async (e) => {
      e.preventDefault();
      const payload = { amount: Number(amount.value), rechargedOn: on.value, note: note.value };
      if (mode === 'date') payload.expiresOn = exp.value; else payload.validDays = parseInt(days.value, 10);
      await api('POST', `/api/devices/${dev.id}/recharges`, payload);
      toast('Recharge saved', 'ok');
      await reload();
    }) },
      h('h2', null, 'Add recharge'),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Amount', amount), h('label', { class: 'field' }, 'Recharge date', on)),
      daysWrap, expWrap, toggle, preview,
      h('label', { class: 'field' }, 'Note', note),
      h('button', { class: 'btn primary block', type: 'submit' }, 'Save recharge'));
    amount.required = true;
    return form;
  }

  function reminderCard(dev, reload) {
    const chosen = new Set(dev.rechargeNotifyDays);
    const save = guard(async () => {
      if (!chosen.size) { toast('Pick at least one reminder day', 'error'); return; }
      const { device } = await api('PATCH', `/api/devices/${dev.id}`, { rechargeNotifyDays: [...chosen] });
      Object.assign(dev, device);
    });
    const enabled = h('input', { type: 'checkbox', checked: dev.notifyRecharge, onchange: guard(async (e) => {
      const { device } = await api('PATCH', `/api/devices/${dev.id}`, { notifyRecharge: e.target.checked });
      Object.assign(dev, device);
      if (e.target.checked && state.pushState !== 'subscribed') toast('Turn on notifications in Settings to receive reminders', '');
    }) });
    return h('div', { class: 'card' },
      h('label', { class: 'switch' }, h('span', null, h('b', null, 'Expiry reminders'), h('div', { class: 'muted small' }, 'Push notification before the SIM runs out (sent between 9am and 10pm)')), enabled),
      h('div', { class: 'small muted', style: 'margin:6px 0' }, 'Remind me this many days before expiry:'),
      h('div', { class: 'chips', style: 'flex-wrap:wrap;padding:0' }, REMINDER_DAYS.map((n) => {
        const b = h('button', { type: 'button', class: `chip ${chosen.has(n) ? 'active' : ''}`, onclick: () => {
          chosen.has(n) ? chosen.delete(n) : chosen.add(n);
          b.classList.toggle('active', chosen.has(n));
          save();
        } }, n === 0 ? 'On the day' : `${n}d`);
        return b;
      })));
  }

  function historyCard(dev, list, reload) {
    return h('div', { class: 'card flush' }, h('div', { style: 'padding:14px 16px 4px' }, h('h3', null, 'Recharge history')),
      list.length ? h('ul', { class: 'list' }, list.map((x) => h('li', null,
        h('div', { class: 'grow' }, h('b', null, money(x.amount)), h('div', { class: 'muted small' }, `${fmtDay(x.rechargedOn)} → ${fmtDay(x.expiresOn)}`, x.note ? ` · ${x.note}` : '')),
        h('button', { class: 'btn sm danger', 'aria-label': 'Delete recharge', onclick: guard(async () => {
          if (!confirm('Delete this recharge entry?')) return;
          await api('DELETE', `/api/devices/${dev.id}/recharges/${x.id}`);
          await reload();
        }) }, 'Delete'))))
        : h('p', { class: 'muted small', style: 'padding:0 16px 16px' }, 'No recharges yet.'));
  }

  /* ---------------------------------------------------------------- settings */
  async function pushStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000))]);
    if (!reg) return 'unsupported';
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'subscribed' : 'off';
  }

  const urlB64 = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission was not granted');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(state.config.vapidPublicKey) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  }

  async function viewSettings() {
    const root = panel();
    root.replaceChildren();
    state.pushState = await pushStatus();
    if (state.view !== 'settings') return;

    const u = state.user;
    put(root, h('h1', null, 'Settings'),
      h('div', { class: 'card row' },
        u.picture ? h('img', { src: u.picture, alt: '', width: 44, height: 44, referrerpolicy: 'no-referrer', style: 'border-radius:50%' }) : null,
        h('div', { class: 'grow' }, h('b', null, u.name), h('div', { class: 'muted small' }, u.email)),
        h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/auth/logout'); state.user = null; location.hash = ''; showLogin(); }) }, 'Sign out')),
      notifyCard(), deviceListCard(), addDeviceCard(), state.user.isAdmin ? h('div', { id: 'adminBox' }) : null,
      h('p', { class: 'muted small' }, `Tracker setup: set the device's server to ${location.hostname} on TCP port ${state.config.gpsPort}.`));
    if (u.isAdmin) loadAdmin();
  }

  function notifyCard() {
    const ps = state.pushState;
    const info = {
      unsupported: 'This browser does not support push notifications. On iPhone, add the app to your Home Screen first (Share → Add to Home Screen).',
      denied: 'Notifications are blocked for this site. Allow them in your browser/site settings, then reload.',
      off: 'Turn on to get alerts when your bike starts or stops and before your SIM expires.',
      subscribed: 'Notifications are on for this device.',
    }[ps];
    const rerender = () => viewSettings();
    return h('div', { class: 'card' }, h('h2', null, 'Notifications'), h('p', { class: 'muted' }, info),
      h('div', { class: 'btn-row', style: 'margin-top:0' },
        ps === 'off' ? h('button', { class: 'btn primary', onclick: guard(async () => { await enablePush(); toast('Notifications enabled', 'ok'); rerender(); }) }, 'Enable notifications') : null,
        ps === 'subscribed' ? [
          h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/push/test'); toast(r.sent ? 'Test notification sent' : 'No active subscription found', r.sent ? 'ok' : 'error'); }) }, 'Send test'),
          h('button', { class: 'btn danger', onclick: guard(async () => { await disablePush(); rerender(); }) }, 'Turn off')] : null));
  }

  function deviceListCard() {
    if (!state.devices.length) return h('div', { class: 'card muted' }, 'No devices yet. Add one below.');
    return h('div', null, state.devices.map(deviceSettings));
  }

  function deviceSettings(dev) {
    const name = h('input', { type: 'text', value: dev.name, maxlength: 60 });
    const sim = h('input', { type: 'tel', value: dev.simNumber || '', maxlength: 30, placeholder: '01XXXXXXXXX' });
    const op = h('input', { type: 'text', value: dev.simOperator || '', maxlength: 40, placeholder: 'e.g. Grameenphone' });
    const sw = (label, sub, key) => h('label', { class: 'switch' }, h('span', null, label, h('div', { class: 'muted small' }, sub)),
      h('input', { type: 'checkbox', checked: dev[key], onchange: guard(async (e) => {
        const { device } = await api('PATCH', `/api/devices/${dev.id}`, { [key]: e.target.checked }); Object.assign(dev, device);
      }) }));
    return h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, dev.name), h('span', { class: `badge ${dev.online ? 'ok' : ''}` }, dev.online ? 'Online' : 'Offline')),
      h('div', { class: 'muted small' }, `Serial ${dev.serial}`),
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'SIM number', sim), h('label', { class: 'field' }, 'Operator', op)),
      h('button', { class: 'btn', onclick: guard(async () => {
        const { device } = await api('PATCH', `/api/devices/${dev.id}`, { name: name.value, simNumber: sim.value, simOperator: op.value });
        Object.assign(dev, device); toast('Saved', 'ok'); syncMarkers(); viewSettings();
      }) }, 'Save details'),
      h('div', null,
        sw('Ignition alerts', 'Notify when the bike is started or turned off', 'notifyIgnition'),
        sw('Alarm alerts', 'Power cut, SOS, low battery, vibration…', 'notifyAlarms')),
      h('button', { class: 'btn danger', onclick: guard(async () => {
        if (!confirm(`Remove "${dev.name}"?\n\nIts location history, events and recharge records will be deleted permanently.`)) return;
        await api('DELETE', `/api/devices/${dev.id}`);
        await refreshDevices(); state.selectedId = null; viewSettings();
      }) }, 'Remove device'));
  }

  function addDeviceCard() {
    const serial = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'e.g. 868123456789012', required: true });
    const name = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. My bike' });
    return h('form', { class: 'card stack', onsubmit: guard(async (e) => {
      e.preventDefault();
      const { device } = await api('POST', '/api/devices', { serial: serial.value, name: name.value });
      toast(`Added ${device.name}`, 'ok');
      await refreshDevices(); state.selectedId = device.id; viewSettings();
    }) },
      h('h2', null, 'Add a device'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Enter the serial number / IMEI printed on the tracker. Only you will be able to see its data.'),
      h('label', { class: 'field' }, 'Serial number (IMEI)', serial),
      h('label', { class: 'field' }, 'Name', name),
      h('button', { class: 'btn primary', type: 'submit' }, 'Add device'));
  }

  async function loadAdmin() {
    const box = $('#adminBox');
    try {
      const { devices } = await api('GET', '/api/admin/devices');
      box.append(h('div', { class: 'card flush' }, h('div', { style: 'padding:14px 16px 4px' }, h('h3', null, 'Admin: all devices')),
        h('ul', { class: 'list' }, devices.map((d) => h('li', null, h('span', { class: `dot ${d.online ? 'ok' : ''}` }),
          h('div', { class: 'grow' }, h('b', null, d.name), h('div', { class: 'muted small' }, `${d.serial} · ${d.ownerEmail}`)),
          h('button', { class: 'btn sm danger', onclick: guard(async () => {
            if (!confirm(`Release ${d.serial} from ${d.ownerEmail}? All its data is deleted.`)) return;
            await api('DELETE', `/api/admin/devices/${d.id}`); await refreshDevices(); viewSettings();
          }) }, 'Release'))))));
    } catch { /* ignore */ }
  }

  /* ===================================================================== router / render */
  async function refreshDevices() {
    state.devices = (await api('GET', '/api/devices')).devices;
    if (!state.devices.some((d) => d.id === state.selectedId)) state.selectedId = state.devices[0]?.id ?? null;
  }

  function parseHash() {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    state.view = views[path] ? path : 'live';
    state.params = new URLSearchParams(qs || '');
    const d = Number(state.params.get('d'));
    if (d && state.devices.some((x) => x.id === d)) { state.selectedId = d; state.follow = true; }
  }

  async function render() {
    document.body.dataset.view = state.view;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
    if (state.view !== 'history') clearHistoryLayer();
    if (state.view === 'live' || state.view === 'history') {
      if (mapState.map) { google.maps.event.trigger(mapState.map, 'resize'); }
      syncMarkers({ fit: state.view === 'live' });
    }
    await views[state.view]();
  }

  /* ===================================================================== realtime */
  function connectWs() {
    clearTimeout(state.wsTimer);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      const reconnected = state.wsDelay > 1000;
      state.wsDelay = 1000;
      if (reconnected) refreshDevices().then(() => { if (state.view === 'live') viewLive(); syncMarkers(); }).catch(() => {});
    };
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ } };
    ws.onclose = () => {
      if (!state.user) return;
      state.wsTimer = setTimeout(connectWs, state.wsDelay);
      state.wsDelay = Math.min(state.wsDelay * 2, 30000);
    };
  }

  function onMessage(m) {
    const dev = state.devices.find((d) => d.id === m.deviceId);
    if (!dev) return;
    const liveVisible = state.view === 'live' && selected()?.id === dev.id;
    switch (m.type) {
      case 'position':
        dev.position = m.data; dev.lastSeen = new Date().toISOString(); dev.online = true;
        syncMarkers();
        if (state.follow && liveVisible && mapState.map) mapState.map.panTo({ lat: m.data.latitude, lng: m.data.longitude });
        if (liveVisible) viewLive();
        break;
      case 'ignition':
        dev.ignition = m.ignition;
        toast(`${dev.name} ${m.ignition ? 'started' : 'turned off'}`, m.ignition ? 'ok' : '');
        syncMarkers();
        if (state.view === 'live') viewLive();
        break;
      case 'presence':
        dev.online = m.online; syncMarkers(); if (state.view === 'live') viewLive();
        break;
      case 'status':
        dev.batteryLevel = m.batteryLevel; dev.gsmLevel = m.gsmLevel; dev.lastSeen = m.lastSeen;
        if (liveVisible) viewLive();
        break;
      case 'alarm':
        toast(`${dev.name}: ${m.message}`, 'error');
        break;
    }
  }

  /* ===================================================================== auth / boot */
  function showLogin(err) {
    $('#boot').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginErr').textContent = err || '';
    state.ws?.close();

    const box = $('#gbtn');
    if (!state.config.googleClientId) { box.textContent = ''; $('#loginErr').textContent = 'Server is missing GOOGLE_CLIENT_ID.'; return; }
    const init = () => {
      google.accounts.id.initialize({
        client_id: state.config.googleClientId,
        callback: async ({ credential }) => {
          try {
            const { user } = await api('POST', '/api/auth/google', { credential });
            state.user = user;
            await start();
          } catch (e) { $('#loginErr').textContent = e.message; }
        },
      });
      box.replaceChildren();
      google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
    };
    if (window.google?.accounts?.id) return init();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.onload = init;
    s.onerror = () => { $('#loginErr').textContent = 'Could not load Google sign-in.'; };
    document.head.append(s);
  }

  async function start() {
    $('#login').classList.add('hidden');
    $('#boot').classList.remove('hidden');
    await refreshDevices();
    $('#boot').classList.add('hidden');
    $('#app').classList.remove('hidden');
    parseHash();
    connectWs();
    if (state.config.mapsApiKey) loadMaps().catch(() => {}); else showMapMsg('Set GOOGLE_MAPS_API_KEY on the server to enable the map.');
    await render();
  }

  window.addEventListener('hashchange', () => { if (state.user) { parseHash(); render(); } });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user) refreshDevices().then(() => { if (state.view === 'live') viewLive(); syncMarkers(); }).catch(() => {});
  });

  (async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    try {
      state.config = await (await fetch('/api/config', { credentials: 'same-origin' })).json();
      state.user = state.config.user;
      if (state.user) await start(); else showLogin();
    } catch (e) {
      $('#boot').replaceChildren(h('p', { class: 'error' }, `Could not reach the server: ${e.message}`));
    }
  })();
})();

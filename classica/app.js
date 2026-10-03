(function () {
  'use strict';

  // ---------- Map ----------
  var HOME = [43.810, 11.832]; // Foreste Casentinesi: Fangacci – Eremo – La Lama
  var HOME_ZOOM = 14;

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('view') || 'null'); } catch (e) {}

  var map = L.map('map', {
    zoomControl: true,
    center: saved ? saved.c : HOME,
    zoom: saved ? saved.z : HOME_ZOOM,
    maxZoom: 18
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 19, maxNativeZoom: 18, opacity: 0.85,
    attribution: 'Sentieri: <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>'
  }).addTo(map);

  map.on('moveend', function () {
    var c = map.getCenter();
    try { localStorage.setItem('view', JSON.stringify({ c: [c.lat, c.lng], z: map.getZoom() })); } catch (e) {}
    updateZoomHint();
  });

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2800);
  }

  // ---------- GPS ----------
  var btnGps = document.getElementById('btnGps');
  var watchId = null, follow = false, dot = null, ring = null;

  btnGps.addEventListener('click', function () {
    if (!('geolocation' in navigator)) { toast('Questo browser non dà accesso al GPS.'); return; }
    if (watchId === null) {
      follow = true;
      btnGps.classList.add('on', 'follow');
      watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } else if (!follow) {
      follow = true; btnGps.classList.add('follow');
      if (dot) map.setView(dot.getLatLng(), Math.max(map.getZoom(), 15));
    } else {
      navigator.geolocation.clearWatch(watchId); watchId = null; follow = false;
      btnGps.classList.remove('on', 'follow');
      if (dot) { map.removeLayer(dot); map.removeLayer(ring); dot = ring = null; }
    }
  });
  map.on('dragstart', function () { if (follow) { follow = false; btnGps.classList.remove('follow'); } });

  function onPos(p) {
    var ll = [p.coords.latitude, p.coords.longitude];
    if (!dot) {
      ring = L.circle(ll, { radius: p.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12 }).addTo(map);
      dot = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [18, 18] }), interactive: false }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 15));
    } else {
      dot.setLatLng(ll); ring.setLatLng(ll).setRadius(p.coords.accuracy);
      if (follow) map.panTo(ll);
    }
  }
  function onPosErr(err) {
    if (err.code === 1) {
      toast('Posizione negata. Abilitala in Impostazioni → Privacy → Localizzazione → Safari.');
      navigator.geolocation.clearWatch(watchId); watchId = null; follow = false;
      btnGps.classList.remove('on', 'follow');
    } else {
      toast('Segnale GPS debole, sto riprovando…');
    }
  }

  document.getElementById('btnHome').addEventListener('click', function () { map.setView(HOME, HOME_ZOOM); });

  // ---------- Sheet / tabs ----------
  var sheet = document.getElementById('sheet');
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.panel');
  var titles = { giri: 'Giri del weekend', tracce: 'Tracce GPX', offline: 'Mappa offline' };
  var current = null;

  function openPanel(name, title) {
    if (current === name && !title) { closeSheet(); return; }
    current = name;
    sheet.hidden = false;
    sheet.scrollTop = 0;
    document.getElementById('sheetTitle').textContent = title || titles[name];
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.panel === name); });
    if (name === 'offline') refreshTileCount();
  }
  function closeSheet() {
    if (current === 'info') clearHighlight();
    current = null; sheet.hidden = true;
    tabs.forEach(function (t) { t.classList.remove('active'); });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { openPanel(t.dataset.panel); }); });
  document.getElementById('sheetClose').addEventListener('click', closeSheet);

  // ---------- GPX tracks (IndexedDB) ----------
  var COLORS = ['#7b2cbf', '#0077b6', '#e85d04', '#2b9348', '#d00070', '#6c584c'];
  var trackLayers = {};
  var dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('sentieri', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('tracks', { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function store(mode) { return db().then(function (d) { return d.transaction('tracks', mode).objectStore('tracks'); }); }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function parseGpx(text, filename) {
    var xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('bad');
    var segs = [];
    ['trkseg', 'rte'].forEach(function (tag) {
      Array.prototype.forEach.call(xml.getElementsByTagName(tag), function (s) {
        var pts = [];
        Array.prototype.forEach.call(s.getElementsByTagName(tag === 'rte' ? 'rtept' : 'trkpt'), function (p) {
          pts.push([+p.getAttribute('lat'), +p.getAttribute('lon')]);
        });
        if (pts.length > 1) segs.push(pts);
      });
    });
    var wpts = [];
    Array.prototype.forEach.call(xml.getElementsByTagName('wpt'), function (w) {
      var n = w.getElementsByTagName('name')[0];
      wpts.push({ ll: [+w.getAttribute('lat'), +w.getAttribute('lon')], name: n ? n.textContent : '' });
    });
    if (!segs.length && !wpts.length) throw new Error('empty');
    var nameEl = xml.querySelector('metadata > name, trk > name, rte > name');
    var name = (nameEl && nameEl.textContent.trim()) || filename.replace(/\.gpx$/i, '');
    return { name: name, segs: segs, wpts: wpts };
  }

  function lengthKm(segs) {
    var m = 0;
    segs.forEach(function (s) { for (var i = 1; i < s.length; i++) m += L.latLng(s[i - 1]).distanceTo(s[i]); });
    return m / 1000;
  }

  function drawTrack(t) {
    var g = L.featureGroup();
    t.segs.forEach(function (s) {
      L.polyline(s, { color: '#fff', weight: 8, opacity: 0.8, bubblingMouseEvents: false }).addTo(g);
      L.polyline(s, { color: t.color, weight: 5, opacity: 0.95, bubblingMouseEvents: false }).addTo(g);
    });
    t.wpts.forEach(function (w) { L.circleMarker(w.ll, { radius: 6, color: '#fff', weight: 2, fillColor: t.color, fillOpacity: 1 }).bindTooltip(w.name).addTo(g); });
    g.bindPopup('<b>' + escapeHtml(t.name) + '</b><br>' + lengthKm(t.segs).toFixed(1).replace('.', ',') + ' km');
    g.addTo(map);
    trackLayers[t.id] = g;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function renderList(tracks) {
    var ul = document.getElementById('trackList');
    ul.textContent = '';
    document.getElementById('trackEmpty').hidden = tracks.length > 0;
    tracks.forEach(function (t) {
      var li = document.createElement('li');
      var sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = t.color;
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = t.name;
      var km = document.createElement('span'); km.className = 'km'; km.textContent = lengthKm(t.segs).toFixed(1).replace('.', ',') + ' km';
      var go = document.createElement('button'); go.textContent = '⌖'; go.setAttribute('aria-label', 'Mostra ' + t.name);
      go.onclick = function () { var l = trackLayers[t.id]; if (l) { map.fitBounds(l.getBounds(), { padding: [30, 30] }); closeSheet(); } };
      var del = document.createElement('button'); del.textContent = '🗑'; del.setAttribute('aria-label', 'Elimina ' + t.name);
      del.onclick = function () {
        store('readwrite').then(function (s) { return reqP(s.delete(t.id)); }).then(function () {
          if (trackLayers[t.id]) { map.removeLayer(trackLayers[t.id]); delete trackLayers[t.id]; }
          loadTracks(false);
        });
      };
      li.append(sw, nm, km, go, del);
      ul.appendChild(li);
    });
  }

  function loadTracks(draw) {
    return store('readonly').then(function (s) { return reqP(s.getAll()); }).then(function (all) {
      all.sort(function (a, b) { return a.added - b.added; });
      if (draw) all.forEach(drawTrack);
      renderList(all);
      return all;
    }).catch(function () { renderList([]); return []; });
  }

  document.getElementById('gpxInput').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files);
    e.target.value = '';
    store('readonly').then(function (s) { return reqP(s.count()); }).then(function (n) {
      var lastLayer = null;
      return files.reduce(function (p, f, i) {
        return p.then(function () { return f.text(); }).then(function (txt) {
          var t;
          try { t = parseGpx(txt, f.name); } catch (err) { toast('“' + f.name + '” non è un GPX leggibile.'); return; }
          t.id = Date.now() + '-' + i; t.added = Date.now(); t.color = COLORS[(n + i) % COLORS.length];
          return store('readwrite').then(function (s) { return reqP(s.put(t)); }).then(function () { drawTrack(t); lastLayer = trackLayers[t.id]; });
        });
      }, Promise.resolve()).then(function () {
        loadTracks(false);
        if (lastLayer) { map.fitBounds(lastLayer.getBounds(), { padding: [30, 30] }); toast('Traccia salvata.'); closeSheet(); }
      });
    });
  });

  loadTracks(true);

  // ---------- Trail info (Waymarked Trails API) ----------
  var API = 'https://hiking.waymarkedtrails.org/api/v1';
  var GROUP = { IWN: 'Itinerario internazionale', NWN: 'Itinerario nazionale', RWN: 'Itinerario regionale', LWN: 'Sentiero locale' };
  var GROUP_ORDER = { LWN: 0, RWN: 1, NWN: 2, IWN: 3 };
  var DIFF = {
    T: 'Turistico: facile, su strade e mulattiere',
    E: 'Escursionistico: sentieri segnati, serve passo sicuro',
    EE: 'Esperti: tratti ripidi o esposti, terreno impervio',
    EEA: 'Esperti con attrezzatura: vie ferrate'
  };
  var infoBody = document.getElementById('infoBody');
  var highlight = null;
  var lastRoute = null;

  function getJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('errore ' + r.status); return r.json(); });
  }
  function mPerPx() { return 40075016.686 / (256 * Math.pow(2, map.getZoom())); }
  function bbox3857(b) {
    var sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
    return [sw.x, sw.y, ne.x, ne.y].map(function (v) { return v.toFixed(1); }).join(',');
  }
  function toLatLng(c) {
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) { var ll = L.CRS.EPSG3857.unproject(L.point(c[0], c[1])); return [ll.lat, ll.lng]; }
    return [c[1], c[0]];
  }
  function fmtKm(m) { return (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
  function refBox(it) {
    var cls = it.group === 'IWN' || it.group === 'NWN' ? 'refbox int' : 'refbox';
    return '<span class="' + cls + '">' + escapeHtml(it.ref || '–') + '</span>';
  }
  function sortLocalFirst(list) {
    return list.slice().sort(function (a, b) { return (GROUP_ORDER[a.group] || 0) - (GROUP_ORDER[b.group] || 0); });
  }
  function busy(msg) { infoBody.innerHTML = '<p class="note">' + escapeHtml(msg) + '</p>'; }

  function clearHighlight() { if (highlight) { map.removeLayer(highlight); highlight = null; } lastRoute = null; }

  function collectLines(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach(function (n) { collectLines(n, out); }); return out; }
    var g = node.geometry || (node.type && node.coordinates ? node : null);
    if (g && g.coordinates) {
      if (g.type === 'LineString') out.push(g.coordinates.map(toLatLng));
      else if (g.type === 'MultiLineString') g.coordinates.forEach(function (l) { out.push(l.map(toLatLng)); });
    }
    Object.keys(node).forEach(function (k) { if (k !== 'geometry' && k !== 'tags' && typeof node[k] === 'object') collectLines(node[k], out); });
    return out;
  }

  function drawHighlight(lines) {
    if (highlight) map.removeLayer(highlight);
    highlight = L.featureGroup();
    lines.forEach(function (l) {
      L.polyline(l, { color: '#ffffff', weight: 11, opacity: 0.85, interactive: false }).addTo(highlight);
      L.polyline(l, { color: '#ffb000', weight: 6, opacity: 1, interactive: false }).addTo(highlight);
    });
    highlight.addTo(map);
    var b = highlight.getBounds();
    if (b.isValid()) map.fitBounds(b, { paddingTopLeft: [24, 70], paddingBottomRight: [24, Math.round(window.innerHeight * 0.5)], maxZoom: 16 });
  }

  function showPicklist(list, title) {
    list = sortLocalFirst(list);
    openPanel('info', title);
    infoBody.innerHTML = '<p class="note">Qui passano più itinerari. Scegli quale vedere:</p><div class="picklist"></div>';
    var box = infoBody.querySelector('.picklist');
    list.forEach(function (it) {
      var b = document.createElement('button');
      b.innerHTML = refBox(it) + '<span class="t">' + escapeHtml(it.name || 'Senza nome') + '<small>' + escapeHtml(GROUP[it.group] || '') + '</small></span>';
      b.onclick = function () { showRoute(it.id); };
      box.appendChild(b);
    });
  }

  function showRoute(id) {
    openPanel('info', 'Sentiero');
    busy('Carico le informazioni…');
    getJSON(API + '/details/relation/' + id).then(function (d) {
      var t = d.tags || {};
      lastRoute = d;
      document.getElementById('sheetTitle').textContent = d.ref ? 'Sentiero ' + d.ref : 'Itinerario';
      var len = (d.route && d.route.length) || d.official_length;
      var diff = t.cai_scale || '';
      var facts = '';
      if (len) facts += '<div class="fact"><b>' + fmtKm(len) + '</b><span>Lunghezza</span></div>';
      if (diff) facts += '<div class="fact diff-' + escapeHtml(diff) + '"><b>' + escapeHtml(diff) + '</b><span>Difficoltà</span></div>';
      facts += '<div class="fact" id="eleFact" hidden><b></b><span>Quota min–max</span></div>';
      var rows = '';
      function row(k, v) { if (v) rows += '<dt>' + k + '</dt><dd>' + escapeHtml(v) + '</dd>'; }
      if (t.from || t.to) row('Percorso', (t.from || '…') + ' → ' + (t.to || '…'));
      if (diff && DIFF[diff]) row('Livello', DIFF[diff]);
      row('Gestore', d.operator || t.operator);
      if (t.roundtrip === 'yes') row('Tipo', 'Anello');
      if (t.duration) row('Tempo', t.duration);
      if (t.ascent) row('Salita', t.ascent + ' m');
      if (t.descent) row('Discesa', t.descent + ' m');
      if (t.survey_date || t['survey:date']) row('Rilevato', t.survey_date || t['survey:date']);
      var subs = d.subroutes ? Object.keys(d.subroutes).map(function (k) { return d.subroutes[k]; }) : [];
      var sups = d.superroutes ? Object.keys(d.superroutes).map(function (k) { return d.superroutes[k]; }) : [];

      infoBody.innerHTML =
        '<div class="rinfo">' +
          '<div class="head">' + refBox(d) + '<div><div class="nm">' + escapeHtml(d.name || 'Senza nome') + '</div><div class="net">' + escapeHtml(GROUP[d.group] || '') + '</div></div></div>' +
          '<div class="facts">' + facts + '</div>' +
          (rows ? '<dl>' + rows + '</dl>' : '') +
          ((d.description || d.note) ? '<p class="desc">' + escapeHtml(d.description || d.note) + '</p>' : '') +
          '<div class="acts"><button id="btnSaveRoute" class="btn primary">Salva nel telefono</button>' +
          '<a class="btn" target="_blank" rel="noopener" href="https://hiking.waymarkedtrails.org/#route?id=' + d.id + '">Waymarked</a></div>' +
          (sups.length ? '<h3>Fa parte di</h3><div class="picklist" id="supList"></div>' : '') +
          (subs.length ? '<h3>Tappe</h3><div class="picklist" id="subList"></div>' : '') +
          '<p class="note">Dati © OpenStreetMap, via Waymarked Trails.</p>' +
        '</div>';

      [['supList', sups], ['subList', subs]].forEach(function (p) {
        var el = document.getElementById(p[0]); if (!el) return;
        p[1].forEach(function (it) {
          var b = document.createElement('button');
          b.innerHTML = refBox(it) + '<span class="t">' + escapeHtml(it.name || 'Senza nome') + '<small>' + escapeHtml(GROUP[it.group] || '') + '</small></span>';
          b.onclick = function () { showRoute(it.id); };
          el.appendChild(b);
        });
      });

      var lines = collectLines(d.route, []);
      var linesP = lines.length ? Promise.resolve(lines)
        : (d.bbox ? getJSON(API + '/list/segments?relations=' + d.id + '&bbox=' + d.bbox.join(',')).then(function (gj) { return collectLines(gj.features || gj, []); }) : Promise.resolve([]));
      linesP.then(function (ls) {
        if (lastRoute !== d) return;
        d._lines = ls;
        if (ls.length) drawHighlight(ls);
      }).catch(function () {});

      document.getElementById('btnSaveRoute').onclick = function () {
        if (!d._lines || !d._lines.length) { toast('Traccia non ancora disponibile, riprova tra un attimo.'); return; }
        store('readonly').then(function (s) { return reqP(s.count()); }).then(function (n) {
          var tr = { id: 'wmt-' + d.id, added: Date.now(), color: COLORS[n % COLORS.length], name: (d.ref ? d.ref + ' · ' : '') + (d.name || 'Sentiero'), segs: d._lines, wpts: [] };
          return store('readwrite').then(function (s) { return reqP(s.put(tr)); }).then(function () {
            if (trackLayers[tr.id]) map.removeLayer(trackLayers[tr.id]);
            drawTrack(tr); loadTracks(false); toast('Salvato nelle Tracce: lo vedi anche offline.');
          });
        });
      };

      getJSON(API + '/details/relation/' + d.id + '/way-elevation').then(function (e) {
        if (lastRoute !== d || e.min_elevation == null) return;
        var f = document.getElementById('eleFact'); if (!f) return;
        f.querySelector('b').textContent = e.min_elevation + '–' + e.max_elevation + ' m';
        f.hidden = false;
      }).catch(function () {});
    }).catch(function () {
      busy(navigator.onLine ? 'Non riesco a caricare questo sentiero. Riprova tra poco.' : 'Sei offline: le info dei sentieri si vedono solo con connessione (tranne quelli già aperti prima).');
    });
  }

  map.on('click', function (e) {
    closeResults();
    if (map.getZoom() < 12) { toast('Avvicina la mappa per toccare un sentiero.'); return; }
    var p = L.CRS.EPSG3857.project(e.latlng), r = 14 * mPerPx();
    var bbox = [p.x - r, p.y - r, p.x + r, p.y + r].map(function (v) { return v.toFixed(1); }).join(',');
    getJSON(API + '/list/by_area?limit=20&bbox=' + bbox).then(function (res) {
      var list = res.results || [];
      if (!list.length) { if (current === 'info') closeSheet(); return; }
      if (list.length === 1) showRoute(list[0].id); else showPicklist(list, 'Sentieri qui');
    }).catch(function (err) { toast(navigator.onLine ? 'Info sentieri non disponibili (' + (err && err.message || 'rete') + ').' : 'Sei offline: le info dei sentieri richiedono connessione.'); });
  });

  // ---------- Search ----------
  var form = document.getElementById('searchForm');
  var input = document.getElementById('searchInput');
  var results = document.getElementById('results');
  var sclear = document.getElementById('searchClear');
  var searchSeq = 0;

  function closeResults() { results.hidden = true; }
  input.addEventListener('input', function () { sclear.hidden = !input.value; if (!input.value) closeResults(); });
  sclear.onclick = function () { input.value = ''; sclear.hidden = true; closeResults(); input.focus(); };
  input.addEventListener('focus', function () { if (results.childElementCount && input.value) results.hidden = false; });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    input.blur();
    var seq = ++searchSeq;
    results.hidden = false;
    results.innerHTML = '<div class="msg">Cerco…</div>';
    var ql = q.toLowerCase();

    var near = getJSON(API + '/list/by_area?limit=100&bbox=' + bbox3857(map.getBounds().pad(0.5))).then(function (r) {
      return (r.results || []).filter(function (it) {
        return (it.ref && it.ref.toLowerCase() === ql) || (it.name && it.name.toLowerCase().indexOf(ql) >= 0);
      });
    }).catch(function () { return []; });
    var far = getJSON(API + '/list/search?limit=15&query=' + encodeURIComponent(q)).then(function (r) { return r.results || []; }).catch(function () { return []; });
    var b = map.getBounds();
    var places = /^\d+$/.test(q) ? Promise.resolve([]) :
      getJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=it&q=' + encodeURIComponent(q) +
        '&viewbox=' + [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map(function (v) { return v.toFixed(4); }).join(',')).catch(function () { return []; });

    Promise.all([near, far, places]).then(function (all) {
      if (seq !== searchSeq) return;
      var seen = {};
      var nearL = sortLocalFirst(all[0]).filter(function (it) { return !seen[it.id] && (seen[it.id] = 1); });
      var farL = all[1].filter(function (it) { return !seen[it.id] && (seen[it.id] = 1); });
      results.innerHTML = '';
      function section(title, items, render) {
        if (!items.length) return;
        var h = document.createElement('h4'); h.textContent = title; results.appendChild(h);
        items.forEach(function (it) { results.appendChild(render(it)); });
      }
      function trailBtn(it) {
        var bt = document.createElement('button'); bt.className = 'r';
        bt.innerHTML = refBox(it) + '<span class="t">' + escapeHtml(it.name || 'Senza nome') + '<small>' + escapeHtml(GROUP[it.group] || '') + '</small></span>';
        bt.onclick = function () { closeResults(); showRoute(it.id); };
        return bt;
      }
      section('Sentieri in zona', nearL, trailBtn);
      section('Luoghi', all[2], function (pl) {
        var bt = document.createElement('button'); bt.className = 'r';
        var parts = (pl.display_name || '').split(', ');
        bt.innerHTML = '<span class="refbox place">📍</span><span class="t">' + escapeHtml(pl.name || parts[0]) + '<small>' + escapeHtml(parts.slice(1, 4).join(', ')) + '</small></span>';
        bt.onclick = function () {
          closeResults();
          var bb = pl.boundingbox;
          if (bb) map.fitBounds([[+bb[0], +bb[2]], [+bb[1], +bb[3]]], { maxZoom: 15 });
          else map.setView([+pl.lat, +pl.lon], 15);
        };
        return bt;
      });
      section('Sentieri altrove', farL, trailBtn);
      if (!results.childElementCount) {
        results.innerHTML = '<div class="msg">' + (navigator.onLine ? 'Nessun risultato per “' + escapeHtml(q) + '”.' : 'Sei offline: la ricerca richiede connessione.') + '</div>';
      }
    });
  });

  // ---------- Offline ----------
  var net = document.getElementById('netstate');
  function updateNet() { var on = navigator.onLine; net.textContent = on ? 'online' : 'offline'; net.classList.toggle('off', !on); }
  window.addEventListener('online', updateNet); window.addEventListener('offline', updateNet); updateNet();

  function updateZoomHint() {
    var el = document.getElementById('zoomHint');
    if (el) el.textContent = 'Zoom attuale: ' + map.getZoom() + '. Per camminare bastano i livelli 14, 15 e 16.';
  }
  updateZoomHint();

  function refreshTileCount() {
    var el = document.getElementById('tileCount');
    if (!('caches' in window)) { el.textContent = 'n/d'; return; }
    caches.open('tiles-v1').then(function (c) { return c.keys(); }).then(function (k) { el.textContent = k.length; }).catch(function () { el.textContent = '0'; });
  }

  var clearConfirm = document.getElementById('clearConfirm');
  document.getElementById('btnClear').onclick = function () { clearConfirm.hidden = false; };
  document.getElementById('btnClearNo').onclick = function () { clearConfirm.hidden = true; };
  document.getElementById('btnClearYes').onclick = function () {
    clearConfirm.hidden = true;
    if ('caches' in window) caches.delete('tiles-v1').then(function () { refreshTileCount(); toast('Mappe salvate eliminate.'); });
  };

  var swEl = document.getElementById('swState');
  if (swEl) swEl.textContent = ('serviceWorker' in navigator) ? (navigator.serviceWorker.controller ? 'offline attivo' : 'offline in preparazione') : 'offline non supportato';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {}); });
  }
})();

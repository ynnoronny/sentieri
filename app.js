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

  function openPanel(name) {
    if (current === name) { closeSheet(); return; }
    current = name;
    sheet.hidden = false;
    document.getElementById('sheetTitle').textContent = titles[name];
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.panel === name); });
    if (name === 'offline') refreshTileCount();
  }
  function closeSheet() {
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
      L.polyline(s, { color: '#fff', weight: 8, opacity: 0.8 }).addTo(g);
      L.polyline(s, { color: t.color, weight: 5, opacity: 0.95 }).addTo(g);
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

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();

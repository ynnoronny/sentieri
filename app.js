(function () {
  'use strict';
  var G = window.Geo;
  var API = 'https://hiking.waymarkedtrails.org/api/v1';
  var OVERPASS = 'https://overpass-api.de/api/interpreter';
  var DEFAULT_CENTER = [43.810, 11.832]; // Foreste Casentinesi
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- storage ----------------
  function load(k, d) { try { var v = localStorage.getItem('s.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem('s.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var routes = load('routes', {});        // id -> route
  var active = load('active', null);      // {id, dir}
  var offline = load('offline', {});      // id -> {tiles, at}
  var gpsEvery = load('gps', 30);
  var lastPos = load('pos', null);        // [lat, lng]
  function saveRoutes() {
    if (!save('routes', routes)) {
      // storage full: drop the oldest routes that are not active or offline
      var ids = Object.keys(routes).sort(function (a, b) { return (routes[a].used || 0) - (routes[b].used || 0); });
      for (var i = 0; i < ids.length && !save('routes', routes); i++) {
        if ((!active || String(active.id) !== ids[i]) && !offline[ids[i]]) delete routes[ids[i]];
      }
    }
  }

  // ---------------- helpers ----------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function getJSON(url, opts) {
    return fetch(url, opts).then(function (r) { if (!r.ok) throw new Error('errore ' + r.status); return r.json(); });
  }
  var toastT;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, ms || 3000);
  }
  function flagHTML(ref) {
    return '<span class="flag"><span></span><b>' + esc(ref || '·') + '</b><span></span></span>';
  }
  function diffHTML(d) { return d ? '<span class="diff ' + esc(d) + '">' + esc(d) + '</span>' : ''; }
  function kmTxt(m) { var f = G.fmtKm(m); return f.n + ' ' + f.u; }
  function minTxt(min) { var f = G.fmtMin(min); return (f.n + ' ' + f.u).trim(); }
  var DIFF_TXT = { T: 'Turistico', E: 'Escursionistico', EE: 'Per esperti', EEA: 'Esperti con attrezzatura' };

  function splitName(name) {
    var parts = String(name || '').split(/\s+[-–—]\s+|\s*→\s*/);
    return parts.length >= 2 ? [parts[0], parts[parts.length - 1]] : [null, null];
  }
  function ends(r) {
    var s = splitName(r.name);
    return { from: r.from || s[0] || 'inizio del sentiero', to: r.to || s[1] || 'fine del sentiero' };
  }

  // ---------------- screens ----------------
  var current = null, backStack = [];
  function show(name, noPush) {
    if (current && current !== name && !noPush) backStack.push(current);
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.id !== 'scr-' + name; });
    current = name;
    window.scrollTo(0, 0);
    if (name === 'walk') { renderWalk(); startGps(); } else if (name !== 'junction' && name !== 'sos') { stopGps(); }
    if (name === 'menu') renderMenu();
  }
  function back() {
    var prev = backStack.pop();
    if (!prev) prev = active ? 'walk' : 'home';
    show(prev, true);
  }
  document.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) { e.preventDefault(); var n = go.getAttribute('data-go'); if (n === 'prepare') openPrepare(); else if (n === 'history') openHistory(false); else if (n === 'offline') openHistory(true); else show(n); return; }
    if (e.target.closest('[data-back]')) { e.preventDefault(); back(); }
  });

  // ---------------- Waymarked + OSM data ----------------
  function fetchRoute(id) {
    return getJSON(API + '/details/relation/' + id).then(function (d) {
      var t = d.tags || {};
      var r = {
        id: d.id, ref: d.ref || t.ref || '', name: d.name || t.name || 'Sentiero', group: d.group,
        from: t.from || null, to: t.to || null, diff: t.cai_scale || null,
        desc: d.description || d.note || t.description || '', operator: d.operator || t.operator || '',
        roundtrip: t.roundtrip === 'yes', line: [], prof: [], pois: [], used: Date.now()
      };
      var lines = G.collectLines(d.route);
      var lineP = lines.length ? Promise.resolve(lines) :
        (d.bbox ? getJSON(API + '/list/segments?relations=' + d.id + '&bbox=' + d.bbox.join(',')).then(function (gj) { return G.collectLines(gj.features || gj); }) : Promise.resolve([]));
      return lineP.then(function (ls) {
        r.line = simplify(G.chain(ls), 8);
        r.len = r.line.length ? G.cumulative(r.line).pop() : (d.route && d.route.length) || 0;
        return Promise.all([
          getJSON(API + '/details/relation/' + id + '/way-elevation').then(function (e) {
            var cum = G.cumulative(r.line);
            r.prof = G.profile(r.line, cum, G.parseElevation(e)).map(function (p) { return [Math.round(p.along), Math.round(p.ele)]; });
          }).catch(function () {}),
          fetchPois(r).catch(function () {})
        ]);
      }).then(function () {
        routes[r.id] = r; saveRoutes();
        return r;
      });
    });
  }

  // Douglas–Peucker-ish thinning by minimum spacing, keeps storage small.
  function simplify(line, minM) {
    if (line.length < 3) return line;
    var out = [line[0]];
    for (var i = 1; i < line.length - 1; i++) if (G.dist(out[out.length - 1], line[i]) >= minM) out.push(line[i]);
    out.push(line[line.length - 1]);
    return out.map(function (p) { return [+p[0].toFixed(6), +p[1].toFixed(6)]; });
  }

  function bboxOf(line, padM) {
    var s = 90, w = 180, n = -90, e = -180;
    line.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); });
    var dl = (padM || 0) / 110540, dn = (padM || 0) / (111320 * Math.cos(s * Math.PI / 180));
    return [s - dl, w - dn, n + dl, e + dn];
  }

  function fetchPois(r) {
    if (!r.line.length) return Promise.resolve();
    var b = bboxOf(r.line, 150).map(function (v) { return v.toFixed(5); }).join(',');
    var q = '[out:json][timeout:25];(' +
      'node["amenity"="drinking_water"](' + b + ');node["natural"="spring"](' + b + ');' +
      'nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](' + b + ');nwr["amenity"="shelter"](' + b + ');' +
      'node["information"="guidepost"](' + b + ');node["natural"="peak"](' + b + ');node["waterway"="waterfall"](' + b + ');' +
      ');out center tags;';
    return getJSON(OVERPASS + '?data=' + encodeURIComponent(q)).then(function (res) {
      var cum = G.cumulative(r.line), pois = [];
      (res.elements || []).forEach(function (el) {
        var ll = el.lat != null ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null;
        if (!ll) return;
        var t = el.tags || {}, type;
        if (t.amenity === 'drinking_water' || t.natural === 'spring') type = 'water';
        else if (t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut') type = 'hut';
        else if (t.amenity === 'shelter') type = 'shelter';
        else if (t.information === 'guidepost') type = 'post';
        else if (t.natural === 'peak') type = 'peak';
        else if (t.waterway === 'waterfall') type = 'fall';
        else return;
        var s = G.snap(r.line, cum, ll);
        var maxOff = type === 'hut' || type === 'peak' ? 150 : 60;
        if (s.off > maxOff) return;
        pois.push({ type: type, name: t.name || '', ele: t.ele ? Math.round(parseFloat(t.ele)) : null, ll: [+ll[0].toFixed(6), +ll[1].toFixed(6)], along: Math.round(s.along), drinkable: t.drinking_water });
      });
      pois.sort(function (a, b) { return a.along - b.along; });
      r.pois = pois;
    });
  }

  var POI_LABEL = { water: 'Fonte', hut: 'Rifugio', shelter: 'Riparo', post: 'Palina', peak: 'Cima', fall: 'Cascata' };
  function poiIcon(type) {
    switch (type) {
      case 'water': return '<svg viewBox="0 0 24 24" width="18" height="18" class="ic water" aria-hidden="true"><path d="M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z"/></svg>';
      case 'hut': case 'shelter': return '<svg viewBox="0 0 24 24" width="18" height="18" class="ic" aria-hidden="true"><path d="M3 11l9-7 9 7M5 10v10h14V10"/></svg>';
      case 'post': return '<svg viewBox="0 0 24 24" width="18" height="18" class="ic yellow" aria-hidden="true"><path d="M12 21V4M12 5h7l2 2.5-2 2.5h-7M12 12H5l-2 2.5L5 17h7"/></svg>';
      case 'peak': return '<svg viewBox="0 0 24 24" width="18" height="18" class="ic" aria-hidden="true"><path d="M3 20l7-12 4 6 2-3 5 9z"/></svg>';
      case 'fall': return '<svg viewBox="0 0 24 24" width="18" height="18" class="ic water" aria-hidden="true"><path d="M6 4v9M10 4v14M14 4v11M18 4v8M4 20h16"/></svg>';
      default: return '<svg viewBox="0 0 24 24" width="18" height="18" class="ic" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/></svg>';
    }
  }
  function poiName(p) {
    if (!p.name) return POI_LABEL[p.type];
    return p.name.toLowerCase().indexOf(POI_LABEL[p.type].toLowerCase()) >= 0 ? p.name : POI_LABEL[p.type] + ' · ' + p.name;
  }

  // ---------------- the walk ----------------
  var walk = null; // computed view of the active route
  function activeRoute() { return active && routes[active.id]; }

  function computeWalk(pos) {
    var r = activeRoute(); if (!r || !r.line.length) return null;
    var cum = r._cum || (r._cum = G.cumulative(r.line));
    var prof = (r.prof || []).map(function (p) { return { along: p[0], ele: p[1] }; });
    var dir = active.dir || 1, len = cum[cum.length - 1];
    var startAlong = dir > 0 ? 0 : len, endAlong = dir > 0 ? len : 0;
    var s = pos ? G.snap(r.line, cum, pos) : null;
    var along = s && s.off < 3000 ? s.along : startAlong;
    var remaining = Math.abs(endAlong - along);
    var cl = G.climb(prof, along, endAlong);
    var minutes = G.walkMinutes(remaining / 1000, cl ? cl.up : 0, cl ? cl.down : 0);
    var ahead = (r.pois || []).map(function (p) { return { p: p, d: (p.along - along) * dir }; })
      .filter(function (x) { return x.d > -15; }).sort(function (a, b) { return a.d - b.d; });
    return { r: r, cum: cum, prof: prof, dir: dir, len: len, along: along, off: s ? s.off : null, remaining: remaining, climb: cl, minutes: minutes, ahead: ahead, endAlong: endAlong };
  }

  function renderWalk() {
    var r = activeRoute();
    if (!r) { show('home', true); return; }
    walk = computeWalk(lastPos);
    var e = ends(r), dir = active.dir || 1;
    $('wRef').textContent = r.ref || '·';
    $('wDest').textContent = 'Verso ' + (dir > 0 ? e.to : e.from);
    $('wSub').textContent = 'da ' + (dir > 0 ? e.from : e.to) + (r.diff ? ' · ' + (DIFF_TXT[r.diff] || r.diff) : '');
    if (!walk) return;
    var k = G.fmtKm(walk.remaining); $('sKm').textContent = k.n; $('sKmU').textContent = k.u;
    $('sUp').textContent = walk.climb ? walk.climb.up : '–';
    var tm = G.fmtMin(walk.minutes); $('sTime').textContent = tm.n; $('sTimeU').textContent = tm.u;

    // off-route warning
    var off = $('offRoute');
    if (walk.off != null && walk.off > 60) {
      off.hidden = false;
      off.textContent = walk.off > 2000
        ? 'Sei a ' + kmTxt(walk.off) + ' dal sentiero. I numeri partono dall\'inizio del percorso.'
        : 'Sei a ' + kmTxt(walk.off) + ' dal sentiero ' + (r.ref || '') + '. Controlla la mappa.';
    } else off.hidden = true;

    // next guidepost / junction
    var nj = walk.ahead.filter(function (x) { return x.p.type === 'post' && x.d < 700; })[0];
    var njb = $('nextJunction');
    if (nj) {
      njb.hidden = false;
      $('njText').innerHTML = nj.d < 30
        ? '<b>Sei a una palina</b>' + (nj.p.name ? ' · ' + esc(nj.p.name) : '') + '. Resta sul ' + esc(r.ref || 'sentiero')
        : '<b>Tra ' + esc(kmTxt(Math.max(10, nj.d))) + '</b> palina' + (nj.p.name ? ' «' + esc(nj.p.name) + '»' : '') + ': resta sul ' + esc(r.ref || 'sentiero');
      njb.onclick = function () { openJunction(nj); };
    } else njb.hidden = true;

    // ahead list: two points + arrival
    var ul = $('ahead'); ul.innerHTML = '';
    walk.ahead.filter(function (x) { return x.p.type !== 'post' && x.d > 20; }).slice(0, 2).forEach(function (x) {
      var li = document.createElement('li');
      li.innerHTML = poiIcon(x.p.type) + '<span class="grow">' + esc(poiName(x.p)) + '</span><span class="d">' + esc(kmTxt(x.d)) + '</span>';
      ul.appendChild(li);
    });
    var li = document.createElement('li');
    li.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" class="ic" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg><span class="grow">Arrivo · ' + esc(dir > 0 ? e.to : e.from) + '</span><span class="d">' + esc(kmTxt(walk.remaining)) + '</span>';
    ul.appendChild(li);

    renderMini();
    renderStatus();
  }

  function renderStatus() {
    var chip = $('offChip'), r = activeRoute();
    var isOff = r && offline[r.id];
    chip.className = 'chip' + (isOff || navigator.onLine ? ' ok' : '');
    $('offTxt').textContent = isOff ? 'Zona offline' : navigator.onLine ? 'Online' : 'Senza rete';
    $('gpsTxt').textContent = 'GPS ogni ' + (gpsEvery < 60 ? gpsEvery + ' s' : gpsEvery / 60 + ' min');
  }

  function renderMini() {
    var svg = $('miniSvg'), box = svg.getBoundingClientRect();
    var W = Math.max(200, box.width || 350), H = Math.max(120, box.height || 200), pad = 22;
    var r = walk.r, line = r.line;
    var b = bboxOf(line, 0), lat0 = (b[0] + b[2]) / 2, kx = Math.cos(lat0 * Math.PI / 180);
    var sx = (b[3] - b[1]) * kx || 1e-6, sy = (b[2] - b[0]) || 1e-6;
    var sc = Math.min((W - pad * 2) / sx, (H - pad * 2) / sy);
    var ox = (W - sx * sc) / 2, oy = (H - sy * sc) / 2;
    function P(p) { return [ox + (p[1] - b[1]) * kx * sc, oy + (b[2] - p[0]) * sc]; }
    function path(pts) { return pts.map(function (p, i) { var q = P(p); return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(''); }
    var cum = walk.cum, cut = 0;
    while (cut < cum.length && cum[cut] < walk.along) cut++;
    var here = G.pointAt(line, cum, walk.along);
    var a = line.slice(0, cut).concat([here]), z = [here].concat(line.slice(cut));
    var done = walk.dir > 0 ? a : z, todo = walk.dir > 0 ? z : a;
    var html = '<rect width="' + W + '" height="' + H + '" fill="none"/>';
    for (var i = 1; i < 5; i++) html += '<path d="M0 ' + (H * i / 5) + ' C ' + W * .3 + ' ' + (H * i / 5 - 18) + ', ' + W * .6 + ' ' + (H * i / 5 + 18) + ', ' + W + ' ' + (H * i / 5 - 6) + '" fill="none" stroke="#1d221b" stroke-width="1.5"/>';
    if (done.length > 1) html += '<path d="' + path(done) + '" fill="none" stroke="#ecebe4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    if (todo.length > 1) html += '<path d="' + path(todo) + '" fill="none" stroke="#d3352b" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 7"/>';
    (r.pois || []).forEach(function (p) {
      var q = P(p.ll);
      if (p.type === 'water' || p.type === 'fall') html += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="3.5" fill="#7fb3e6"/>';
      else if (p.type === 'hut' || p.type === 'shelter') html += '<rect x="' + (q[0] - 4) + '" y="' + (q[1] - 4) + '" width="8" height="8" fill="#ecebe4"/>';
      else if (p.type === 'post') html += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="2.5" fill="#f2c94c"/>';
    });
    var endP = P(walk.dir > 0 ? line[line.length - 1] : line[0]);
    html += '<circle cx="' + endP[0] + '" cy="' + endP[1] + '" r="6" fill="#0d0f0c" stroke="#ecebe4" stroke-width="2.5"/>';
    if (lastPos && walk.off != null && walk.off < 3000) {
      var me = P(lastPos);
      html += '<circle cx="' + me[0] + '" cy="' + me[1] + '" r="15" fill="#4c8fe8" fill-opacity=".2"/><circle cx="' + me[0] + '" cy="' + me[1] + '" r="6.5" fill="#4c8fe8" stroke="#0d0f0c" stroke-width="2.5"/>';
    }
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = html;
  }

  $('btnFlip').onclick = function () {
    if (!active) return;
    active.dir = -(active.dir || 1); save('active', active);
    renderWalk(); toast('Direzione invertita.');
  };
  $('btnMore').onclick = function () { show('menu'); };
  $('btnOpenMap').onclick = function () { openMap(); };
  $('homeMap').onclick = function () { openMap(); };
  $('rowMap').onclick = function () { openMap(); };
  $('menuBack').onclick = function () { show(active ? 'walk' : 'home'); backStack = []; };
  window.addEventListener('online', renderStatus); window.addEventListener('offline', renderStatus);

  // ---------------- GPS (interval, battery-friendly) ----------------
  var gpsTimer = null, gpsBusy = false;
  function fix(cb) {
    if (!('geolocation' in navigator)) { if (cb) cb(null); return; }
    if (gpsBusy) return; gpsBusy = true;
    navigator.geolocation.getCurrentPosition(function (p) {
      gpsBusy = false;
      lastPos = [p.coords.latitude, p.coords.longitude]; lastPos.acc = p.coords.accuracy;
      save('pos', [lastPos[0], lastPos[1]]);
      if (current === 'walk') renderWalk();
      if (mapReady) updateMapMe();
      if (cb) cb(lastPos);
    }, function (err) {
      gpsBusy = false;
      if (err.code === 1) { toast('Posizione negata: attivala in Impostazioni › Privacy › Localizzazione › Safari.', 5000); stopGps(); }
      if (cb) cb(null);
    }, { enableHighAccuracy: true, timeout: 25000, maximumAge: Math.min(gpsEvery, 30) * 500 });
  }
  function startGps() {
    stopGps(); fix();
    gpsTimer = setInterval(function () { if (!document.hidden) fix(); }, gpsEvery * 1000);
  }
  function stopGps() { if (gpsTimer) clearInterval(gpsTimer); gpsTimer = null; }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && current === 'walk') fix(); });

  // ---------------- junction ----------------
  function openJunction(x) {
    var r = walk.r, e = ends(r), p = x.p;
    $('jHead').textContent = 'Palina' + (p.ele ? ' · ' + p.ele + ' m' : '') + (p.name ? ' · ' + p.name : '');
    $('jTitle').textContent = 'Resta sul ' + (r.ref || 'sentiero');
    var fromAlong = p.along, rem = Math.abs(walk.endAlong - fromAlong);
    var cl = G.climb(walk.prof, fromAlong, walk.endAlong);
    var mins = G.walkMinutes(rem / 1000, cl ? cl.up : 0, cl ? cl.down : 0);
    $('jMine').innerHTML = flagHTML(r.ref) + '<div class="t"><b>' + esc(walk.dir > 0 ? e.to : e.from) + '</b><span>' + esc(kmTxt(rem)) + ' · ' + esc(minTxt(mins)) + '</span></div>' +
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="#f2c94c" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    $('jNote').textContent = cl ? 'Da qui all\'arrivo: ' + kmTxt(rem) + (cl.up ? ', ' + cl.up + ' m di salita' : '') + (cl.down ? (cl.up ? ' e ' : ', ') + cl.down + ' m di discesa' : '') + '.' : '';
    var others = $('jOthers'); others.innerHTML = '<div class="dim small">Cerco gli altri sentieri che passano qui…</div>';
    show('junction');
    var c = proj(p.ll), rr = 35;
    getJSON(API + '/list/by_area?limit=20&bbox=' + [c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr].map(function (v) { return v.toFixed(1); }).join(','))
      .then(function (res) {
        var list = (res.results || []).filter(function (it) { return it.id !== r.id && (!r.ref || it.ref !== r.ref) && it.group !== 'IWN' && it.group !== 'NWN'; });
        others.innerHTML = list.length ? '' : '<div class="dim small">Nessun altro sentiero segnato qui.</div>';
        list.slice(0, 5).forEach(function (it) {
          var d = document.createElement('div'); d.className = 'sign';
          d.innerHTML = flagHTML(it.ref) + '<div class="t"><b>' + esc(it.name || 'Sentiero') + '</b><span>altro sentiero</span></div>';
          others.appendChild(d);
        });
      }).catch(function () { others.innerHTML = '<div class="dim small">Senza rete non vedo gli altri sentieri di questo incrocio.</div>'; });
  }
  function proj(ll) {
    var x = ll[1] * 20037508.34 / 180;
    var y = Math.log(Math.tan((90 + ll[0]) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
    return [x, y];
  }

  // ---------------- SOS (press and hold) ----------------
  var sosBtn = $('btnSos'), sosT = null;
  function sosStart(e) {
    if (e) e.preventDefault();
    sosBtn.classList.add('holding'); $('sosHint').hidden = true;
    if (navigator.vibrate) navigator.vibrate(30);
    sosT = setTimeout(function () { sosBtn.classList.remove('holding'); sosT = null; if (navigator.vibrate) navigator.vibrate([80, 60, 80]); openSos(); }, 2000);
  }
  function sosCancel() {
    if (sosT) { clearTimeout(sosT); sosT = null; $('sosHint').hidden = false; setTimeout(function () { $('sosHint').hidden = true; }, 2500); }
    sosBtn.classList.remove('holding');
  }
  sosBtn.addEventListener('pointerdown', sosStart);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { sosBtn.addEventListener(ev, sosCancel); });
  sosBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  sosBtn.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat && !sosT) sosStart(e); });
  sosBtn.addEventListener('keyup', function (e) { if (e.key === 'Enter' || e.key === ' ') sosCancel(); });

  function fmtCoord(v, pos, neg) { return Math.abs(v).toFixed(5).replace('.', ',') + '° ' + (v >= 0 ? pos : neg); }
  function openSos() {
    show('sos');
    var box = $('sosCoords'), place = $('sosPlace');
    function paint(p) {
      if (!p) { box.textContent = 'Posizione non disponibile'; return; }
      box.innerHTML = esc(fmtCoord(p[0], 'N', 'S')) + '<br>' + esc(fmtCoord(p[1], 'E', 'O'));
      var r = activeRoute(), bits = [];
      if (p.acc) bits.push('precisione ±' + Math.round(p.acc) + ' m');
      if (r) bits.push('sentiero ' + (r.ref || '') + ' ' + r.name);
      place.textContent = bits.join(' · ');
    }
    paint(lastPos);
    fix(paint);
  }
  function sosText() {
    var p = lastPos; if (!p) return '';
    var r = activeRoute();
    return 'SOS – sono qui: ' + p[0].toFixed(5) + ', ' + p[1].toFixed(5) + (r ? ' (sentiero ' + (r.ref || '') + ' ' + r.name + ')' : '') +
      ' https://www.openstreetmap.org/?mlat=' + p[0].toFixed(5) + '&mlon=' + p[1].toFixed(5) + '#map=16/' + p[0].toFixed(5) + '/' + p[1].toFixed(5);
  }
  $('sosShare').onclick = function () {
    var t = sosText(); if (!t) { toast('Aspetto la posizione…'); return; }
    if (navigator.share) navigator.share({ text: t }).catch(function () {});
    else copy(t);
  };
  $('sosCopy').onclick = function () { var t = sosText(); if (t) copy(t); };
  function copy(t) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('Copiato.'); }, function () { toast(t, 8000); });
    else toast(t, 8000);
  }

  // ---------------- menu / search ----------------
  function renderMenu() {
    document.querySelectorAll('#gpsSeg button').forEach(function (b) { b.classList.toggle('on', +b.dataset.gps === gpsEvery); });
    var n = Object.keys(routes).length; $('histCount').textContent = n ? String(n) : '';
    var o = Object.keys(offline).length; $('offCount').textContent = o ? String(o) : '';
    $('menuBack').textContent = active ? 'Torna al cammino' : 'Indietro';
  }
  $('gpsSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    gpsEvery = +b.dataset.gps; save('gps', gpsEvery); renderMenu();
    toast('Posizione ogni ' + b.textContent + '.');
  });

  var searchSeq = 0;
  $('searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('q').value.trim(); if (!q) return;
    $('q').blur();
    var seq = ++searchSeq, box = $('searchRes');
    box.hidden = false; box.innerHTML = '<div class="dim small">Cerco…</div>';
    var c = lastPos || DEFAULT_CENTER, ql = q.toLowerCase();
    var near = getJSON(API + '/list/by_area?limit=100&bbox=' + bboxAround(c, 15000)).then(function (r) {
      return (r.results || []).filter(function (it) { return (it.ref && it.ref.toLowerCase() === ql) || (it.name && it.name.toLowerCase().indexOf(ql) >= 0); });
    }).catch(function () { return []; });
    var far = getJSON(API + '/list/search?limit=10&query=' + encodeURIComponent(q)).then(function (r) { return r.results || []; }).catch(function () { return []; });
    var places = /^\d+$/.test(q) ? Promise.resolve([]) : getJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=it&countrycodes=it&q=' + encodeURIComponent(q)).catch(function () { return []; });
    Promise.all([near, far, places]).then(function (all) {
      if (seq !== searchSeq) return;
      var seen = {}; box.innerHTML = '';
      function head(t) { var h = document.createElement('div'); h.className = 'reshead'; h.textContent = t; box.appendChild(h); }
      var nearL = all[0].filter(function (it) { return !seen[it.id] && (seen[it.id] = 1); });
      var farL = all[1].filter(function (it) { return !seen[it.id] && (seen[it.id] = 1); });
      if (nearL.length) { head('Sentieri vicini'); nearL.slice(0, 8).forEach(function (it) { box.appendChild(routeRow(it)); }); }
      if (all[2].length) {
        head('Luoghi: sentieri intorno');
        all[2].forEach(function (pl) {
          var b = document.createElement('button'); b.className = 'rcard';
          var parts = (pl.display_name || '').split(', ');
          b.innerHTML = '<div class="name">' + esc(pl.name || parts[0]) + '</div><div class="sub">' + esc(parts.slice(1, 4).join(', ')) + '</div>';
          b.onclick = function () { openPrepare([+pl.lat, +pl.lon], pl.name || parts[0]); };
          box.appendChild(b);
        });
      }
      if (farL.length) { head('Altrove'); farL.slice(0, 6).forEach(function (it) { box.appendChild(routeRow(it)); }); }
      if (!box.childElementCount) box.innerHTML = '<div class="empty">' + (navigator.onLine ? 'Nessun risultato per «' + esc(q) + '».' : 'Senza rete la ricerca non funziona. I sentieri già salvati sono in «I miei sentieri».') + '</div>';
    });
  });
  function routeRow(it) {
    var b = document.createElement('button'); b.className = 'rcard';
    b.innerHTML = '<div class="top">' + flagHTML(it.ref) + '<div class="grow"><div class="name">' + esc(it.name || 'Sentiero') + '</div></div></div>';
    b.onclick = function () { openRoute(it.id); };
    return b;
  }
  function bboxAround(c, m) {
    var p = proj(c); return [p[0] - m, p[1] - m, p[0] + m, p[1] + m].map(function (v) { return v.toFixed(0); }).join(',');
  }

  // ---------------- prepare (nearby) ----------------
  function openPrepare(center, label) {
    var c = center || lastPos || (mapReady ? [map.getCenter().lat, map.getCenter().lng] : DEFAULT_CENTER);
    $('prepWhere').textContent = label ? 'Intorno a ' + label : (lastPos && (!center || center === lastPos)) ? 'Intorno a te' : 'Foreste Casentinesi';
    var list = $('prepList');
    list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    show('prepare');
    if (!center && !lastPos) fix(function (p) { if (p && current === 'prepare') openPrepare(p); });
    getJSON(API + '/list/by_area?limit=40&bbox=' + bboxAround(c, 5000)).then(function (res) {
      var items = (res.results || []).filter(function (it) { return it.group === 'LWN' || it.group === 'RWN'; });
      if (!items.length) items = res.results || [];
      items = items.slice(0, 14);
      list.innerHTML = items.length ? '' : '<div class="empty">Nessun sentiero segnato qui intorno.</div>';
      items.forEach(function (it) {
        var b = document.createElement('button'); b.className = 'rcard';
        b.innerHTML = '<div class="top">' + flagHTML(it.ref) + '<div class="grow"><div class="name">' + esc(it.name || 'Sentiero') + '</div><div class="sub" data-sub>…</div></div><span data-diff></span></div><div class="facts" data-facts></div>';
        b.onclick = function () { openRoute(it.id); };
        list.appendChild(b);
        queue(function () {
          return getJSON(API + '/details/relation/' + it.id).then(function (d) {
            var t = d.tags || {}, len = (d.route && d.route.length) || d.official_length;
            var e = ends({ name: d.name, from: t.from, to: t.to });
            b.querySelector('[data-sub]').textContent = (t.from || t.to) ? e.from + ' → ' + e.to : (GROUP_TXT[d.group] || '');
            b.querySelector('[data-diff]').outerHTML = diffHTML(t.cai_scale);
            var f = [];
            if (len) f.push(kmTxt(len));
            if (t.roundtrip === 'yes') f.push('ad anello');
            b.querySelector('[data-facts]').innerHTML = f.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('');
          }).catch(function () { b.querySelector('[data-sub]').textContent = ''; });
        });
      });
    }).catch(function () {
      var saved = Object.keys(routes);
      list.innerHTML = '<div class="empty">Senza rete non posso cercare sentieri nuovi.' + (saved.length ? ' Quelli che hai già aperto sono in «I miei sentieri».' : '') + '</div>';
    });
  }
  var GROUP_TXT = { LWN: 'Sentiero locale', RWN: 'Itinerario regionale', NWN: 'Itinerario nazionale', IWN: 'Itinerario internazionale' };
  var running = 0, waiting = [];
  function queue(fn) { waiting.push(fn); pump(); }
  function pump() {
    while (running < 4 && waiting.length) {
      running++; waiting.shift()().finally(function () { running--; pump(); });
    }
  }

  // ---------------- route card ----------------
  function openRoute(id) {
    var body = $('routeBody');
    show('route');
    if (routes[id]) paintRoute(routes[id]);
    else body.innerHTML = '<div class="skeleton"></div><div class="dim small">Carico il sentiero, la salita e i punti utili…</div>';
    if (!routes[id] || navigator.onLine) {
      fetchRoute(id).then(function (r) { if (current === 'route') paintRoute(r); })
        .catch(function () { if (!routes[id]) body.innerHTML = '<div class="empty">Non riesco a caricare questo sentiero' + (navigator.onLine ? '. Riprova tra poco.' : ': sei senza rete.') + '</div>'; });
    }
  }
  function profileSVG(r) {
    if (!r.prof || r.prof.length < 2) return '';
    var W = 320, H = 56, len = r.len || r.prof[r.prof.length - 1][0];
    var min = Infinity, max = -Infinity;
    r.prof.forEach(function (p) { min = Math.min(min, p[1]); max = Math.max(max, p[1]); });
    var span = Math.max(50, max - min);
    var pts = r.prof.map(function (p) { return [(p[0] / len) * W, H - 4 - ((p[1] - min) / span) * (H - 10)]; });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
    return '<svg class="profile" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Profilo altimetrico da ' + min + ' a ' + max + ' m"><path d="' + d + 'L' + W + ' ' + H + 'L0 ' + H + 'Z" fill="#1d231b"/><path d="' + d + '" fill="none" stroke="#959a8f" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>' +
      '<div class="dim small">Quota da ' + min + ' a ' + max + ' m</div>';
  }
  function paintRoute(r) {
    var e = ends(r), prof = (r.prof || []).map(function (p) { return { along: p[0], ele: p[1] }; });
    var len = r.len || 0;
    var c1 = G.climb(prof, 0, len), c2 = G.climb(prof, len, 0);
    var m1 = G.walkMinutes(len / 1000, c1 ? c1.up : 0, c1 ? c1.down : 0);
    var m2 = G.walkMinutes(len / 1000, c2 ? c2.up : 0, c2 ? c2.down : 0);
    var water = (r.pois || []).filter(function (p) { return p.type === 'water'; }).length;
    var huts = (r.pois || []).filter(function (p) { return p.type === 'hut' || p.type === 'shelter'; }).length;
    var isOff = !!offline[r.id];
    var html =
      '<div class="rcard" style="cursor:default">' +
        '<div class="top">' + flagHTML(r.ref) + '<div class="grow"><div class="name">' + esc(r.name) + '</div><div class="sub">' + esc(e.from) + ' → ' + esc(e.to) + '</div></div>' + diffHTML(r.diff) + '</div>' +
        profileSVG(r) +
        '<div class="facts"><span>' + esc(kmTxt(len)) + '</span>' + (c1 ? '<span>+' + c1.up + ' m</span><span>−' + c1.down + ' m</span>' : '') + '<span>' + esc(minTxt(m1)) + '</span></div>' +
        ((water || huts) ? '<div class="sub">' + [water ? water + (water > 1 ? ' fonti' : ' fonte') : '', huts ? huts + (huts > 1 ? ' rifugi o ripari' : ' rifugio o riparo') : ''].filter(Boolean).join(' · ') + ' lungo il percorso</div>' : '') +
        (r.desc ? '<div class="sub">' + esc(r.desc) + '</div>' : '') +
      '</div>' +
      '<div class="stack">' +
        '<button class="btn primary" id="goFwd">Parti verso ' + esc(e.to) + '</button>' +
        '<button class="btn" id="goBack">Parti verso ' + esc(e.from) + ' · ' + esc(minTxt(m2)) + '</button>' +
        '<button class="btn ghost" id="goOff">' + (isOff ? 'Zona salvata offline ✓' : 'Salva la zona offline') + '</button>' +
        '<button class="btn ghost" id="goMap">Vedi sulla mappa</button>' +
      '</div>' +
      '<div class="dim small">Dati © OpenStreetMap, sentieri via Waymarked Trails. Tempi stimati.</div>';
    $('routeBody').innerHTML = html;
    $('goFwd').onclick = function () { startRoute(r, 1); };
    $('goBack').onclick = function () { startRoute(r, -1); };
    $('goOff').onclick = function () { saveOffline(r, $('goOff')); };
    $('goMap').onclick = function () { openMap(r); };
  }
  function startRoute(r, dir) {
    active = { id: r.id, dir: dir }; save('active', active);
    r.used = Date.now(); saveRoutes();
    backStack = [];
    show('walk');
    if (!offline[r.id] && navigator.onLine) saveOffline(r, null);
  }

  // ---------------- offline zones ----------------
  var TILE_LAYERS = [
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'
  ];
  function tilesFor(line) {
    var b = bboxOf(line, 400), out = [];
    for (var z = 12; z <= 15; z++) {
      var x0 = lon2x(b[1], z), x1 = lon2x(b[3], z), y0 = lat2y(b[2], z), y1 = lat2y(b[0], z);
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
        // keep only tiles near the trail
        var lon = (x + .5) / Math.pow(2, z) * 360 - 180;
        var n = Math.PI - 2 * Math.PI * (y + .5) / Math.pow(2, z);
        var lat = 180 / Math.PI * Math.atan(.5 * (Math.exp(n) - Math.exp(-n)));
        var tileM = 40075016 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
        if (z >= 14 && nearLine(line, [lat, lon]) > tileM * 1.2) continue;
        out.push([z, x, y]);
      }
    }
    return out.slice(0, 500);
  }
  function nearLine(line, p) { var best = Infinity; for (var i = 0; i < line.length; i += 3) best = Math.min(best, G.dist(line[i], p)); return best; }
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }

  function saveOffline(r, btn) {
    if (!r.line.length) { toast('Questo sentiero non ha un tracciato da salvare.'); return; }
    if (!navigator.onLine) { toast('Serve la rete per salvare la zona.'); return; }
    var tiles = tilesFor(r.line), urls = [];
    tiles.forEach(function (t) {
      TILE_LAYERS.forEach(function (tpl) { urls.push(tpl.replace('{s}', 'abc'[(t[1] + t[2]) % 3]).replace('{z}', t[0]).replace('{x}', t[1]).replace('{y}', t[2])); });
    });
    var done = 0, failed = 0, i = 0;
    if (btn) { btn.disabled = true; btn.textContent = 'Salvo la zona… 0%'; }
    function next() {
      if (i >= urls.length) return Promise.resolve();
      var u = urls[i++];
      return fetch(u, { mode: 'no-cors' }).then(function () { done++; }, function () { failed++; }).then(function () {
        if (btn) btn.textContent = 'Salvo la zona… ' + Math.round((done + failed) / urls.length * 100) + '%';
        return next();
      });
    }
    Promise.all([next(), next(), next()]).then(function () {
      offline[r.id] = { tiles: done, at: Date.now(), name: (r.ref ? r.ref + ' · ' : '') + r.name };
      save('offline', offline);
      if (btn) { btn.disabled = false; btn.textContent = 'Zona salvata offline ✓'; }
      else toast('Zona del sentiero salvata: funziona anche senza rete.');
      renderStatus();
    });
  }

  // ---------------- history / offline list ----------------
  function openHistory(onlyOffline) {
    $('histTitle').textContent = onlyOffline ? 'Zone offline' : 'I miei sentieri';
    var ids = Object.keys(onlyOffline ? offline : routes).filter(function (id) { return routes[id]; })
      .sort(function (a, b) { return (routes[b].used || 0) - (routes[a].used || 0); });
    var list = $('histList'); list.innerHTML = '';
    if (!ids.length) list.innerHTML = '<div class="empty">' + (onlyOffline ? 'Nessuna zona salvata. Quando parti su un sentiero con la rete, la sua zona si salva da sola.' : 'Ancora nessun sentiero. Aprine uno da «Prepara un giro» o dalla ricerca.') + '</div>';
    ids.forEach(function (id) {
      var r = routes[id], row = document.createElement('div'); row.className = 'rcard';
      row.innerHTML = '<div class="top">' + flagHTML(r.ref) + '<div class="grow"><div class="name">' + esc(r.name) + '</div><div class="sub">' + esc(kmTxt(r.len || 0)) + (offline[id] ? ' · offline' : '') + '</div></div></div>' +
        '<div style="display:flex;gap:8px"><button class="btn grow" data-open>Apri</button><button class="btn ghost" data-del>' + (onlyOffline ? 'Togli offline' : 'Elimina') + '</button></div>';
      row.querySelector('[data-open]').onclick = function () { openRoute(+id); };
      var del = row.querySelector('[data-del]');
      del.onclick = function () {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Sicuro?'; return; }
        delete offline[id]; save('offline', offline);
        if (!onlyOffline) { delete routes[id]; saveRoutes(); if (active && String(active.id) === id) { active = null; save('active', null); } }
        openHistory(onlyOffline);
      };
      list.appendChild(row);
    });
    show('history');
  }

  // ---------------- map (dark, contour lines + trails) ----------------
  var map = null, mapReady = false, meMarker = null, routeLayer = null;
  function openMap(focusRoute) {
    $('mapLayer').hidden = false;
    stopGps();
    if (!mapReady) {
      var c = lastPos || DEFAULT_CENTER;
      map = L.map('map', { zoomControl: false, attributionControl: true, center: c, zoom: 14, maxZoom: 17 });
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        subdomains: 'abc', maxZoom: 17, className: 'darkbase',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://opentopomap.org">OpenTopoMap</a>'
      }).addTo(map);
      L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
        maxZoom: 17, opacity: .9, attribution: '<a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>'
      }).addTo(map);
      map.on('click', onMapTap);
      mapReady = true;
    }
    setTimeout(function () { map.invalidateSize(); }, 50);
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    var r = focusRoute || activeRoute();
    if (r && r.line.length) {
      routeLayer = L.layerGroup([
        L.polyline(r.line, { color: '#000', weight: 9, opacity: .6, interactive: false }),
        L.polyline(r.line, { color: '#f2c94c', weight: 4, opacity: 1, interactive: false })
      ]).addTo(map);
      if (focusRoute || !lastPos) map.fitBounds(L.latLngBounds(r.line), { padding: [40, 40] });
    }
    updateMapMe();
    if (lastPos && !focusRoute && !r) map.setView(lastPos, 15);
  }
  function updateMapMe() {
    if (!mapReady || !lastPos) return;
    if (!meMarker) meMarker = L.marker(lastPos, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
    else meMarker.setLatLng(lastPos);
  }
  $('mapClose').onclick = function () {
    $('mapLayer').hidden = true; $('mapSheet').hidden = true;
    if (current === 'walk') startGps();
  };
  $('mapLocate').onclick = function () {
    fix(function (p) { if (p) map.setView(p, Math.max(map.getZoom(), 15)); else toast('Posizione non disponibile.'); });
  };
  function onMapTap(e) {
    if (map.getZoom() < 12) { toast('Avvicina la mappa per toccare un sentiero.'); return; }
    var p = proj([e.latlng.lat, e.latlng.lng]), rr = 14 * 40075016.686 / (256 * Math.pow(2, map.getZoom()));
    getJSON(API + '/list/by_area?limit=20&bbox=' + [p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr].map(function (v) { return v.toFixed(1); }).join(','))
      .then(function (res) {
        var list = (res.results || []).sort(function (a, b) { return (ORDER[a.group] || 0) - (ORDER[b.group] || 0); });
        var sh = $('mapSheet');
        if (!list.length) { sh.hidden = true; return; }
        sh.innerHTML = '';
        list.slice(0, 6).forEach(function (it) {
          var b = routeRow(it);
          b.onclick = function () { $('mapLayer').hidden = true; sh.hidden = true; openRoute(it.id); };
          sh.appendChild(b);
        });
        sh.hidden = false;
      }).catch(function () { toast(navigator.onLine ? 'Info sentieri non disponibili ora.' : 'Senza rete non posso leggere i sentieri dalla mappa.'); });
  }
  var ORDER = { LWN: 0, RWN: 1, NWN: 2, IWN: 3 };

  // ---------------- start ----------------
  if (active && routes[active.id]) show('walk'); else show('home');
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {}); });
  }
  window.__sentieri = { fetchRoute: fetchRoute, routes: routes, computeWalk: computeWalk };
})();

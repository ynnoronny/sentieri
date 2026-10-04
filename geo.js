/* Sentieri – pure geometry and trail helpers (no DOM). */
(function (root) {
  'use strict';

  var R = 6371000;

  function toLatLng(c) {
    // [x, y] in Web Mercator metres, or [lon, lat]
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) {
      var lon = c[0] / 20037508.34 * 180;
      var lat = Math.atan(Math.exp(c[1] / 20037508.34 * Math.PI)) * 360 / Math.PI - 90;
      return [lat, lon];
    }
    return [c[1], c[0]];
  }

  function dist(a, b) {
    var p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
    var dp = p2 - p1, dl = (b[1] - a[1]) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* Collect LineStrings from a Waymarked route structure, in order. */
  function collectLines(node, out) {
    out = out || [];
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach(function (n) { collectLines(n, out); }); return out; }
    var g = node.geometry || (node.type && node.coordinates ? node : null);
    if (g && g.coordinates) {
      if (g.type === 'LineString') out.push(g.coordinates.map(toLatLng));
      else if (g.type === 'MultiLineString') g.coordinates.forEach(function (l) { out.push(l.map(toLatLng)); });
    }
    var keys = node.main ? ['main'] : Object.keys(node);
    keys.forEach(function (k) {
      if (k !== 'geometry' && k !== 'tags' && node[k] && typeof node[k] === 'object') collectLines(node[k], out);
    });
    return out;
  }

  /* Join pieces into one continuous polyline, flipping pieces as needed. */
  function chain(lines) {
    lines = lines.filter(function (l) { return l && l.length > 1; });
    if (!lines.length) return [];
    var used = lines.map(function () { return false; });
    var first = lines[0].slice();
    used[0] = true;
    if (lines.length > 1) {
      var n = lines[1];
      var dStart = Math.min(dist(first[0], n[0]), dist(first[0], n[n.length - 1]));
      var dEnd = Math.min(dist(first[first.length - 1], n[0]), dist(first[first.length - 1], n[n.length - 1]));
      if (dStart < dEnd) first.reverse();
    }
    var out = first;
    for (var k = 1; k < lines.length; k++) {
      // pick the unused piece closest to the current end
      var end = out[out.length - 1], best = -1, bestD = Infinity, flip = false;
      for (var i = 0; i < lines.length; i++) {
        if (used[i]) continue;
        var l = lines[i], a = dist(end, l[0]), b = dist(end, l[l.length - 1]);
        if (a < bestD) { bestD = a; best = i; flip = false; }
        if (b < bestD) { bestD = b; best = i; flip = true; }
      }
      if (best < 0) break;
      used[best] = true;
      if (bestD > 1500) continue; // a detached appendix: skip it
      var piece = lines[best].slice();
      if (flip) piece.reverse();
      if (dist(end, piece[0]) < 1) piece.shift();
      out = out.concat(piece);
    }
    return out;
  }

  function cumulative(line) {
    var c = [0];
    for (var i = 1; i < line.length; i++) c.push(c[i - 1] + dist(line[i - 1], line[i]));
    return c;
  }

  /* Nearest point on the polyline: {along, off, idx} (metres). */
  function snap(line, cum, p) {
    var lat0 = p[0] * Math.PI / 180, kx = Math.cos(lat0) * 111320, ky = 110540;
    var px = p[1] * kx, py = p[0] * ky, best = { along: 0, off: Infinity, idx: 0 };
    for (var i = 1; i < line.length; i++) {
      var ax = line[i - 1][1] * kx, ay = line[i - 1][0] * ky, bx = line[i][1] * kx, by = line[i][0] * ky;
      var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      var qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
      if (d < best.off) best = { along: cum[i - 1] + t * (cum[i] - cum[i - 1]), off: d, idx: i };
    }
    return best;
  }

  function pointAt(line, cum, along) {
    if (along <= 0) return line[0];
    for (var i = 1; i < line.length; i++) {
      if (cum[i] >= along) {
        var t = (along - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
        return [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])];
      }
    }
    return line[line.length - 1];
  }

  /* Elevation points from Waymarked's way-elevation answer, whatever its exact shape. */
  function parseElevation(data) {
    var pts = [];
    function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        if (n.length >= 3 && typeof n[0] === 'number' && typeof n[2] === 'number' && n.length <= 4) {
          pts.push({ x: n[0], y: n[1], ele: n[2] }); return;
        }
        n.forEach(walk); return;
      }
      if (typeof n.ele === 'number' && typeof n.x === 'number') { pts.push({ x: n.x, y: n.y, ele: n.ele }); return; }
      Object.keys(n).forEach(function (k) { walk(n[k]); });
    }
    walk(data && data.segments);
    return pts.map(function (p) { return { ll: toLatLng([p.x, p.y]), ele: p.ele }; });
  }

  /* Elevation profile along the line: sorted [{along, ele}]. */
  function profile(line, cum, elePts) {
    var prof = [];
    elePts.forEach(function (e) {
      var s = snap(line, cum, e.ll);
      if (s.off < 150) prof.push({ along: s.along, ele: e.ele });
    });
    prof.sort(function (a, b) { return a.along - b.along; });
    return prof;
  }

  /* Up/down between two along positions (in either direction of travel). */
  function climb(prof, from, to) {
    var up = 0, down = 0;
    if (prof.length < 2) return null;
    var lo = Math.min(from, to), hi = Math.max(from, to);
    var seg = prof.filter(function (p) { return p.along >= lo - 3 && p.along <= hi + 3; });
    if (to < from) seg.reverse();
    for (var i = 1; i < seg.length; i++) {
      var d = seg[i].ele - seg[i - 1].ele;
      if (d > 0) up += d; else down -= d;
    }
    return { up: Math.round(up), down: Math.round(down) };
  }

  /* Walking time (DIN 33466, as used on Alpine signposts), in minutes. */
  function walkMinutes(km, up, down) {
    var h = km / 4, v = (up || 0) / 300 + (down || 0) / 500;
    return Math.round((Math.max(h, v) + Math.min(h, v) / 2) * 60);
  }

  function fmtKm(m) {
    if (m < 1000) return { n: String(Math.round(m / 10) * 10), u: 'm' };
    return { n: (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ','), u: 'km' };
  }
  function fmtMin(min) {
    if (min < 60) return { n: String(min), u: 'min' };
    var h = Math.floor(min / 60), m = min % 60;
    return { n: h + ':' + (m < 10 ? '0' : '') + m, u: 'h' };
  }

  root.Geo = {
    toLatLng: toLatLng, dist: dist, collectLines: collectLines, chain: chain, cumulative: cumulative,
    snap: snap, pointAt: pointAt, parseElevation: parseElevation, profile: profile, climb: climb,
    walkMinutes: walkMinutes, fmtKm: fmtKm, fmtMin: fmtMin
  };
})(typeof window !== 'undefined' ? window : globalThis);

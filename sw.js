// Sentieri: offline support.
var VERSION = 'c3';
var SHELL = 'compagno-' + VERSION;
var TILES = 'tiles-v1';
var DATA = 'data-v1';
var FILES = ['./', 'index.html', 'app.css?v=3', 'geo.js?v=3', 'app.js?v=3', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(FILES.map(function (f) { return c.add(new Request(f, { cache: 'no-cache' })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return (k.indexOf('compagno-') === 0 && k !== SHELL) || k.indexOf('app-') === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function trim(cache, max) {
  return cache.keys().then(function (k) { if (k.length > max) return Promise.all(k.slice(0, k.length - max).map(function (x) { return cache.delete(x); })); });
}
function cacheFirst(req, name, max) {
  return caches.open(name).then(function (c) {
    return c.match(req.url).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) c.put(req.url, res.clone()).then(function () { return trim(c, max); });
        return res;
      });
    });
  });
}
function networkFirst(req, name, max) {
  return fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(name).then(function (c) { c.put(req.url, copy).then(function () { return trim(c, max); }); }); }
    return res;
  }).catch(function () {
    return caches.open(name).then(function (c) { return c.match(req.url); }).then(function (hit) { if (hit) return hit; throw new Error('offline'); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url), h = u.hostname;
  if (/tile\.opentopomap\.org$/.test(h) || /basemaps\.cartocdn\.com$/.test(h) || (h === 's3.amazonaws.com' && u.pathname.indexOf('/elevation-tiles-prod/') === 0) || h === 'tile.waymarkedtrails.org' || h === 'fonts.gstatic.com' || h === 'fonts.googleapis.com') {
    e.respondWith(cacheFirst(req, TILES, 12000)); return;
  }
  if ((h === 'hiking.waymarkedtrails.org' && u.pathname.indexOf('/api/') === 0) || h === 'overpass-api.de' || h === 'it.wikipedia.org' || h === 'api.inaturalist.org' || (h === 'nominatim.openstreetmap.org' && u.pathname === '/reverse')) {
    e.respondWith(networkFirst(req, DATA, 2000)); return;
  }
  if (u.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(function (c) {
      return fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () {
        return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || c.match('index.html'); });
      });
    }));
  }
});

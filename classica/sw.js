// Service worker: keeps the app usable offline and saves every map tile you look at.
var SHELL = 'shell-v3';
var API = 'api-v1';
var TILES = 'tiles-v1';
var MAX_TILES = 6000;
var SHELL_FILES = [
  './', 'index.html', 'style.css?v=3', 'app.js?v=3', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css',
  'vendor/images/layers.png', 'vendor/images/layers-2x.png',
  'vendor/images/marker-icon.png', 'vendor/images/marker-icon-2x.png', 'vendor/images/marker-shadow.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== TILES; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isTile(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) || url.hostname === 'tile.waymarkedtrails.org';
}

function trim(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= MAX_TILES) return;
    return Promise.all(keys.slice(0, keys.length - MAX_TILES).map(function (k) { return cache.delete(k); }));
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (isTile(url)) {
    // Tiles: saved copy first (works offline), otherwise network and save it.
    e.respondWith(caches.open(TILES).then(function (cache) {
      return cache.match(req.url).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req.url, res.clone()).then(function () { return trim(cache); });
          }
          return res;
        }).catch(function () { return new Response('', { status: 504 }); });
      });
    }));
    return;
  }

  if (url.hostname === 'hiking.waymarkedtrails.org' && url.pathname.indexOf('/api/') === 0) {
    // Trail info: fresh when online, last saved copy when offline.
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(API).then(function (c) { c.put(req.url, copy); }); }
      return res;
    }).catch(function () {
      return caches.open(API).then(function (c) { return c.match(req.url); }).then(function (hit) { return hit || new Response('{"error":"offline"}', { status: 504, headers: { 'Content-Type': 'application/json' } }); });
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    // App files: network first so updates arrive, saved copy when offline.
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('index.html'); });
    }));
  }
});

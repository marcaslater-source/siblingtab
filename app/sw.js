// Lets SiblingTab open quickly and be installed to the home screen.
// Family data is never cached here: it always comes fresh from the database.
var CACHE = 'siblingtab-v1';
var SHELL = ['./', 'index.html', 'styles.css?v=1', 'config.js?v=1', 'logic.js?v=1', 'app.js?v=1',
  'vendor/supabase-2.118.0.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Network first (so updates show up right away), falling back to the saved copy when offline.
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(e.request).then(function (r) { return r || caches.match('index.html'); });
  }));
});

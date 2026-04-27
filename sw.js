var CACHE = 'ctct-songbook-v7';
var FILES = [
  '/ctct-songbook/',
  '/ctct-songbook/index.html',
  '/ctct-songbook/songs_final.json',
  '/ctct-songbook/manifest.json'
];
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(FILES); }));
  self.skipWaiting();
});
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener('fetch', function(e) {
  e.respondWith(caches.match(e.request).then(function(r) {
    return r || fetch(e.request).then(function(res) {
      var clone = res.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
      return res;
    });
  }).catch(function() { return caches.match('/ctct-songbook/index.html'); }));
});

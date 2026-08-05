var CACHE = 'ctct-songbook-v10';
// BASE is wherever this service worker is actually registered from - works
// identically whether the app is served at the domain root (local network
// server) or under a subfolder (e.g. GitHub Pages project sites), with no
// hardcoded folder name.
var BASE = self.registration.scope;
var FILES = [BASE, BASE + 'index.html', BASE + 'songs_final.json', BASE + 'manifest.json'];

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
  if(e.request.url.includes('/slide')||e.request.url.includes('/events')||
     e.request.url.includes('/status')||e.request.url.includes('/auth-control')||
     e.request.url.includes('/current')){
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(function(r) {
    return r || fetch(e.request).then(function(res) {
      var clone = res.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
      return res;
    });
  }).catch(function() { return caches.match(BASE + 'index.html'); }));
});

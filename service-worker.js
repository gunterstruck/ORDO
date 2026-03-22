// Dynamisch den Basis-Pfad ermitteln – funktioniert unter /ORDO/ und überall sonst
const BASE_URL = new URL('./', self.location.href).href;

// Version hochzählen bei jedem Deploy → löscht automatisch alten Cache
const CACHE_VERSION = 'v2';
const CACHE_NAME = `haushalt-${CACHE_VERSION}`;

// App-Shell-Dateien: immer zuerst Netzwerk, dann Cache-Fallback
const APP_SHELL = [
  BASE_URL,
  BASE_URL + 'index.html',
  BASE_URL + 'style.css',
  BASE_URL + 'app.js',
  BASE_URL + 'brain.js',
  BASE_URL + 'manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  // Neuen SW sofort aktivieren, ohne auf Tab-Schließen zu warten
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  // Alle offenen Tabs sofort übernehmen
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // API-Calls nie cachen
  if (event.request.url.includes('generativelanguage.googleapis.com')) return;

  const url = event.request.url;
  const isAppShell = APP_SHELL.some(asset => url === asset || url.startsWith(asset + '?'));

  if (isAppShell) {
    // NETWORK FIRST: immer frische Version holen, Cache nur als Fallback
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // CACHE FIRST für alles andere (Bilder, Fonts, etc.)
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => {
          if (event.request.destination === 'document') {
            return caches.match(BASE_URL + 'index.html');
          }
        });
      })
    );
  }
});

// Nachricht an alle Tabs schicken, wenn ein Update verfügbar ist
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

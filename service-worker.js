// Dynamisch den Basis-Pfad ermitteln – funktioniert unter /ORDO/ und überall sonst
const BASE_URL = new URL('./', self.location.href).href;

// Version hochzählen bei jedem Deploy → löscht automatisch alten Cache
const CACHE_VERSION = 'v38';
const CACHE_NAME = `ordo-${CACHE_VERSION}`;

// App-Shell-Dateien
const APP_SHELL = [
  BASE_URL,
  BASE_URL + 'index.html',
  BASE_URL + 'style.css',
  BASE_URL + 'app.js',
  BASE_URL + 'brain.js',
  BASE_URL + 'ai.js',
  BASE_URL + 'chat.js',
  BASE_URL + 'brain-view.js',
  BASE_URL + 'photo-flow.js',
  BASE_URL + 'onboarding.js',
  BASE_URL + 'settings.js',
  BASE_URL + 'camera.js',
  BASE_URL + 'modal.js',
  BASE_URL + 'quest.js',
  BASE_URL + 'organizer.js',
  BASE_URL + 'report.js',
  BASE_URL + 'overlay-manager.js',
  BASE_URL + 'item-detail.js',
  BASE_URL + 'warranty-view.js',
  BASE_URL + 'smart-photo.js',
  BASE_URL + 'local-intents.js',
  BASE_URL + 'companion.js',
  BASE_URL + 'voice-input.js',
  BASE_URL + 'spatial-3d.js',
  BASE_URL + 'marble-api.js',
  BASE_URL + 'pcm-processor.js',
  BASE_URL + 'dialog-stream.js',
  BASE_URL + 'ui-blocks.js',
  BASE_URL + 'ordo-agent.js',
  BASE_URL + 'session-log.js',
  BASE_URL + 'manifest.json',
  BASE_URL + 'icon-192.png',
  BASE_URL + 'icon-512.png',
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
  if (event.request.url.includes('api.worldlabs.ai')) return;

  const url = event.request.url;
  const isAppShell = APP_SHELL.some(asset => url === asset || url.startsWith(asset + '?'));

  if (isAppShell) {
    // STALE-WHILE-REVALIDATE: sofort aus Cache liefern, im Hintergrund aktualisieren
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);

        // Im Hintergrund neu laden und Cache aktualisieren
        const networkFetch = fetch(event.request).then(response => {
          if (response && response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        }).catch(() => null);

        // Sofort aus Cache liefern, falls vorhanden – sonst auf Netzwerk warten
        return cached || networkFetch;
      })
    );
  } else {
    // CACHE FIRST für alles andere (Bilder, Fonts, etc.)
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.ok) {
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

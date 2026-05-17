// Minimal service worker — required to register the PWA for "Add to Home Screen".
// No caching: the app is local-LAN-only and we want fresh data every load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* let network handle everything */ });

// Service worker minimal, DOAR pentru eligibilitatea de instalare (PWA) --
// Chrome/Edge nu ofera "Instaleaza aplicatia" fara un service worker inregistrat
// cu un handler de fetch. Nu cacheaza nimic -- las totul sa treaca direct la
// retea, ca sa nu servesc pagini/date vechi (acelasi motiv ca la Cache-Control:
// no-store de pe HTML: un cache gresit aici ar insemna date de firma vechi).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });

/* Scoped to /llamaknight/. Never prefetch large art before asset consent.
 * Network-first keeps GitHub Pages bug fixes fresh; cached shell files are
 * used only during a temporary network outage. Game textures are NOT cached.
 */
const CACHE_NAME = 'llamaknight-pwa-shell-v1';
const CACHE_PREFIX = 'llamaknight-pwa-shell-';
const ROOT = new URL(self.registration.scope);

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name =>
            name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
        ).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
    // Respect pre-download user consent. Do not opportunistically cache large
    // game assets, including sprite sheets, audio or the menu PNG.
    if (url.pathname.startsWith(ROOT.pathname + 'assets/')) return;
    const shell = request.mode === 'navigate' ||
        url.pathname.endsWith('.js') || url.pathname.endsWith('.css') ||
        url.pathname.endsWith('.webmanifest') ||
        url.pathname.startsWith(ROOT.pathname + 'icons/');
    if (!shell) return;

    event.respondWith((async () => {
        try {
            const response = await fetch(request);
            if (response.ok && response.type === 'basic') {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
            }
            return response;
        } catch (error) {
            const cache = await caches.open(CACHE_NAME);
            const saved = await cache.match(request);
            if (saved) return saved;
            throw error;
        }
    })());
});

const CACHE_PREFIX = 'cardgamesmp-app-';
const CACHE_VERSION = 'v24';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add('/')));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function cacheable(response) {
  return response.ok && response.type === 'basic';
}

async function put(request, response) {
  if (cacheable(response)) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    } catch { /* a cache failure must not hide a valid network response */ }
  }
  return response;
}

async function networkFirst(request, navigation = false) {
  try {
    return await put(request, await fetch(request));
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (navigation) {
      const shell = await caches.match('/');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    return await put(request, await fetch(request));
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

function isImmutableMedia(request, url) {
  const media = ['image', 'audio', 'video'].includes(request.destination);
  const versioned = /[._-][a-f0-9]{8,}[._-]/i.test(url.pathname) || url.searchParams.has('v');
  return media && versioned;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, true));
  } else if (isImmutableMedia(request, url)) {
    event.respondWith(cacheFirst(request));
  } else if (['script', 'style', 'worker', 'font', 'image', 'audio', 'video'].includes(request.destination)) {
    event.respondWith(networkFirst(request));
  }
});

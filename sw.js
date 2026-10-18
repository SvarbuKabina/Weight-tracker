// Network first, cache as fallback: when online you always get the newest version
// (so updates show up on the next launch), and the app still opens offline.
const CACHE = 'weight-tracker-v3';
const PENDING = 'weight-tracker-pending'; // messages from notifications to the app (gym.js reads it)
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'gym.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/badge-96.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PENDING).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The rest timer notification: "Stop rest" stops it without opening the app; a tap opens the app.
self.addEventListener('notificationclick', event => {
  const data = event.notification.data || {};
  event.notification.close();
  if (data.kind === 'rest' && event.action === 'stop') event.waitUntil(stopRest(data));
  else event.waitUntil(openApp(data.url));
});

async function stopRest(data) {
  const msg = { type: 'rest-stop', sessionId: data.sessionId, start: data.start, at: Date.now() };
  // Hand the stop (and when it was pressed) to the app: now if it's running, else on its next open.
  const pending = await caches.open(PENDING);
  await pending.put('rest-stop', new Response(JSON.stringify(msg), { headers: { 'Content-Type': 'application/json' } }));
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach(w => w.postMessage(msg));

  // Confirm briefly in the shade.
  const secs = Math.round((msg.at - msg.start) / 1000);
  const title = secs > 30 * 60 ? 'Rest timer stopped' : `Rest ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} saved`;
  await self.registration.showNotification(title, {
    tag: 'rest-timer', silent: true, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { kind: 'rest-saved', url: data.url },
  });
  await new Promise(resolve => setTimeout(resolve, 4000));
  const shown = await self.registration.getNotifications({ tag: 'rest-timer' });
  shown.forEach(n => { if (n.data && n.data.kind === 'rest-saved') n.close(); });
}

async function openApp(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find(w => 'focus' in w);
  if (open) return open.focus();
  return self.clients.openWindow(url || './');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }), 4000);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./');
      if (shell) return shell;
    }
    return Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

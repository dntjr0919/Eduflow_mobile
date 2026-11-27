// 배포 시 버전을 올리면(예: v5 -> v6) activate 단계에서 이전 캐시가 자동 정리됩니다.
const CACHE_VERSION = 'v9';
const CACHE_NAME = `eduflow-mobile-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/student.js',
  '/teacher.js',
  '/admin/',
  '/admin/index.html',
  '/admin/admin.js',
  '/manifest.json',
  '/icon.svg',
  '/badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        STATIC_ASSETS.map((asset) =>
          fetch(asset, { cache: 'no-store' })
            .then((resp) => (resp && resp.ok ? cache.put(asset, resp) : undefined))
            .catch((err) => { console.warn('[SW asset cache]', asset, err && err.message ? err.message : err); })
        )
      ))
      .catch((err) => { console.warn('[SW install]', err && err.message ? err.message : err); })
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const reqUrl = new URL(url);
  // 프록시 API(/api/*), Apps Script API 및 비-GET 요청은 캐시하지 않고 네트워크 직결
  if (
    reqUrl.pathname.startsWith('/api/') ||
    url.includes('script.google.com') ||
    event.request.method !== 'GET'
  ) {
    return;
  }
  const isSameOrigin = url.startsWith(self.location.origin);
  const fetchReq = isSameOrigin && event.request.cache !== 'only-if-cached'
    ? new Request(event.request, { cache: 'no-cache' })
    : event.request;
  event.respondWith(
    fetch(fetchReq)
      .then((resp) => {
        if (resp && resp.status === 200 && isSameOrigin) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let data = {
    title: 'EduFlow 알림',
    body: '새로운 학급 알림이 도착했습니다.',
    icon: '/icon.svg',
    badge: '/badge-96.png',
    url: '/'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch (_) {
      data.body = event.data.text() || data.body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/badge-96.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && targetUrl) {
            return client.navigate(targetUrl).catch(() => client);
          }
          return client;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

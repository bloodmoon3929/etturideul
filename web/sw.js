// 서비스 워커 (PLAN 13.5). 한 번 준비하면 신호가 없어도 인터뷰 전체가 진행되게 한다.
//
//  - 앱 셸(HTML/JS/CSS)과 데이터(JSON, embeddings.bin): 네트워크 우선, 느리거나 끊기면 캐시
//    → 온라인일 때는 항상 최신 버전, 오프라인이면 마지막으로 받은 버전
//  - 바뀌지 않는 큰 파일(vendor, 썸네일, 아이콘): 캐시 우선
//  - 모델 파일(/models/, Hugging Face): 건드리지 않는다. transformers.js가 'transformers-cache'에 직접 저장한다

const VERSION = '0.1.1';
const SHELL_CACHE = `etturi-shell-${VERSION}`;
// 썸네일 파일 이름 규칙을 바꾸면서(게시물 번호 → 사진 id) v2로 올렸다. 예전 캐시는 activate 때 지운다
const ASSET_CACHE = 'etturi-assets-v2';
const NETWORK_TIMEOUT_MS = 3000;
const IMMUTABLE = /\/(vendor|thumbs|icons)\//;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('etturi-shell-') && name !== SHELL_CACHE) await caches.delete(name);
      if (name.startsWith('etturi-assets-') && name !== ASSET_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const fromNetwork = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const response = await Promise.race([fromNetwork, timeout]);
    if (response) return response;
  } catch { /* 오프라인: 아래에서 캐시로 응답 */ }
  let hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  if (!hit && request.mode === 'navigate') {
    // "/"나 "/m0/"처럼 디렉터리로 들어온 요청은 그 디렉터리의 index.html로 응답한다
    const dir = request.url.split(/[?#]/)[0].replace(/[^/]*$/, '');
    hit = await cache.match(new URL('index.html', dir).href);
  }
  if (hit) return hit;
  return fromNetwork;   // 캐시에도 없으면 느리더라도 네트워크 응답을 기다린다
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const target = new URL(request.url);
  if (request.method !== 'GET' || target.origin !== self.location.origin) return;
  if (target.pathname.includes('/models/')) return;
  if (request.headers.has('range')) return;
  event.respondWith(IMMUTABLE.test(target.pathname) ? cacheFirst(request) : networkFirst(request));
});

// 게시물 데이터와 검색 계산. 게시물이 100개 수준이라 모든 계산을 그 자리에서 한다 (PLAN 3장).

import { url, EMBED_DIM, W_IMG, W_TXT, TIER_SAME, TIER_SIMILAR, DEFAULT_SEARCH_BACKEND, SERVER_API_BASE, DEFAULT_PRESET } from './config.js';
import { ml } from './ml.js';
import { kv } from './store.js';
import { squash } from './util.js';

export const db = {
  posts: [], byId: new Map(), index: new Map(),
  emb: null,          // { img, txt, combined }: Float32Array(게시물 수 × 512)
  meta: null, similar: {}, calib: null, graph: null, protocol: null, manifest: null,
  sources: new Map(),
  gallery: [],        // 가상 갤러리에 깔아 두는 일상 사진 (scripts/make_gallery.py)
};

// 연구자 콘솔에서 바꾸는 설정 (기기에 저장)
export const settings = { preset: DEFAULT_PRESET, searchBackend: DEFAULT_SEARCH_BACKEND, showRaw: false };

export async function loadSettings() {
  Object.assign(settings, await kv.get('settings', {}));
}
export function saveSettings(patch) {
  Object.assign(settings, patch);
  return kv.set('settings', { ...settings });
}

const getJson = async (path, optional = false) => {
  try {
    const res = await fetch(url(path));
    if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw new Error(`${path} 로드 실패: ${err.message || err}`);
  }
};

export async function loadData() {
  const [posts, meta, similar, calib, sources, protocol, graph, manifest, gallery, bin] = await Promise.all([
    getJson('data/posts.json'), getJson('data/embeddings_meta.json'), getJson('data/similar.json'),
    getJson('data/calibration.json'), getJson('data/image_sources.json'),
    getJson('data/protocol.json', true), getJson('data/graph.json', true), getJson('data/manifest.json', true),
    getJson('data/gallery.json', true),
    fetch(url('data/embeddings.bin')).then((r) => r.arrayBuffer()),
  ]);
  const all = new Float32Array(bin);
  const block = meta.count * meta.dim;
  if (all.length !== block * 3) throw new Error('embeddings.bin 크기가 embeddings_meta.json과 맞지 않습니다');
  db.posts = posts;
  db.byId = new Map(posts.map((p) => [p.id, p]));
  db.index = new Map(meta.ids.map((id, i) => [id, i]));
  db.emb = { img: all.subarray(0, block), txt: all.subarray(block, block * 2), combined: all.subarray(block * 2) };
  Object.assign(db, { meta, similar, calib, protocol, graph, manifest, gallery: gallery || [] });
  db.sources = new Map(sources.map((s) => [s.id, s]));
  return db;
}

// ── 점수 ──────────────────────────────────────────────────────────────
export function dotAt(matrix, row, vec) {
  let sum = 0;
  const base = row * EMBED_DIM;
  for (let i = 0; i < EMBED_DIM; i++) sum += matrix[base + i] * vec[i];
  return sum;
}

// 원시 코사인 → 표시용 점수(0~1). 쿼리 종류별 구간 직선 (scripts/calibrate.py가 만든 값)
export function calibrate(kind, raw) {
  const knots = db.calib.curves[kind].knots;
  if (raw <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i], [x0, y0] = knots[i - 1];
    if (raw <= x1) return y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0);
  }
  return knots[knots.length - 1][1];
}

export const tierOf = (score) => (score >= TIER_SAME ? 'same' : score >= TIER_SIMILAR ? 'similar' : 'low');
export const TIER_LABEL = { same: '같은 상품', similar: '비슷한 상품', low: '관련 낮음' };

export function combine(imgVec, txtVec) {
  const out = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    out[i] = W_IMG * imgVec[i] + W_TXT * txtVec[i];
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) out[i] /= norm;
  return out;
}

// 쿼리 벡터로 모든 게시물의 순위를 매긴다. kind: 'text' | 'image' | 'image_text'
export function rankByVector(vec, kind) {
  return db.posts.map((post, i) => {
    const raw = dotAt(db.emb.combined, i, vec);
    const score = calibrate(kind, raw);
    return {
      post, raw, score, tier: tierOf(score),
      // 추천 근거 패널용: 쿼리와 게시물 사진 / 게시물 글 각각의 유사도
      sim_img: dotAt(db.emb.img, i, vec), sim_txt: dotAt(db.emb.txt, i, vec),
    };
  }).sort((a, b) => b.raw - a.raw);
}

// 미리 계산한 비슷한 게시물 (모델 불필요)
export function similarPosts(postId) {
  return (db.similar[postId] || []).map((n) => {
    const score = calibrate('post', n.s);
    return { post: db.byId.get(n.id), raw: n.s, score, tier: tierOf(score), sim_img: n.si, sim_txt: n.st };
  });
}

export function priceStats(posts) {
  if (!posts.length) return null;
  const prices = posts.map((p) => p.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return {
    n: prices.length, min: prices[0], max: prices[prices.length - 1],
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    median: prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2),
  };
}

// ── 기존 방식 검색 (PLAN 9.2) ─────────────────────────────────────────
// 일반적인 온라인 마켓 수준: 제목·태그 부분 일치, 띄어쓰기·대소문자 무시. 유사도·오타 보정·동의어는 쓰지 않는다.
export function keywordSearch({ query = '', category = null, minPrice = null, maxPrice = null, sort = 'latest' }) {
  const whole = squash(query);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = db.posts.filter((p) => {
    if (category && p.category !== category) return false;
    if (minPrice != null && p.price < minPrice) return false;
    if (maxPrice != null && p.price > maxPrice) return false;
    if (!whole) return true;
    const hay = squash(`${p.title} ${p.tags.join(' ')}`);
    return hay.includes(whole) || tokens.every((t) => hay.includes(t));
  });
  if (sort === 'price') results.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  else results.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  return results;
}

export const latestPosts = () => keywordSearch({});

// ── AI 검색 (PLAN 5.2) ────────────────────────────────────────────────
// settings.searchBackend 하나로 임베딩 계산 위치가 바뀐다 (PLAN 6.4).
//   browser: 폰 안의 Web Worker / server: Plan B 검색 API. 순위 계산과 보정은 어느 쪽이든 폰에서 한다.
async function serverEmbed(path, body) {
  const t0 = performance.now();
  const res = await fetch(`${SERVER_API_BASE}${path}`, { method: 'POST', body });
  if (!res.ok) throw new Error(`검색 서버 오류 (${res.status})`);
  const { vector } = await res.json();
  return { vector: Float32Array.from(vector), ms: Math.round(performance.now() - t0) };
}

function embedText(text) {
  if (settings.searchBackend === 'server') {
    return serverEmbed('/search/text', new Blob([JSON.stringify({ query: text })], { type: 'application/json' }));
  }
  return ml.embedText(text);
}

function embedImage(blob) {
  if (settings.searchBackend === 'server') return serverEmbed('/search/image', blob);
  return ml.embedImage(blob);
}

export async function aiTextSearch(query) {
  const t0 = performance.now();
  const { vector, ms } = await embedText(query);
  const results = rankByVector(vector, 'text');
  return { mode: 'ai_text', results, embed_ms: ms, latency_ms: Math.round(performance.now() - t0) };
}

export async function aiPhotoSearch(blob, text = '') {
  const t0 = performance.now();
  const image = await embedImage(blob);
  let vector = image.vector, kind = 'image', mode = 'ai_photo';
  if (text.trim()) {
    const t = await embedText(text.trim());
    vector = combine(image.vector, t.vector);
    kind = 'image_text';
    mode = 'ai_photo_text';
  }
  return {
    mode, results: rankByVector(vector, kind), embed_ms: image.ms, width: image.width ?? null, height: image.height ?? null,
    image_vector: image.vector, latency_ms: Math.round(performance.now() - t0),
  };
}

export const thumbUrl = (post, large = false) => url(large ? post.image_large : post.image);

export function creditOf(post) {
  const s = db.sources.get(post.image_source_id);
  return s ? `사진: ${s.creator || '작성자 미상'} · ${s.license_name}` : '';
}

// 모듈 D: AI 판매 등록 (PLAN 9.1) — 제안 방식.
// 사진 먼저 → "이 상품인가요?" 후보 3개 → 제목·카테고리·시리즈·태그 자동 채움 + 같은 상품 시세와 추천 가격 → 수정 후 등록.
// 폼과 등록 완료 화면은 모듈 C의 것을 그대로 쓴다.

import { aiPhotoSearch, similarPosts, priceStats } from './data.js';
import { logger } from './logger.js';
import { nav } from './nav.js';
import { h } from './util.js';
import { postCard, toast, pickPhoto, keepPhoto, screenHeader } from './ui.js';
import { listingForm } from './mod-c-listing.js';

const N_CANDIDATES = 3;

// 순위가 높은 게시물부터 고르되, 이미 고른 후보와 "같은 상품"인 게시물은 건너뛰어 서로 다른 상품 3개를 만든다
function pickCandidates(results) {
  const chosen = [];
  const covered = new Set();
  for (const item of results) {
    if (covered.has(item.post.id)) continue;
    chosen.push(item);
    covered.add(item.post.id);
    for (const n of similarPosts(item.post.id)) if (n.tier === 'same') covered.add(n.post.id);
    if (chosen.length === N_CANDIDATES) break;
  }
  return chosen;
}

const mostCommon = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// 고른 후보와 그 "같은 상품" 게시물들에서 자동 채움 값을 만든다
function buildSuggestions(candidate) {
  const group = [candidate.post, ...similarPosts(candidate.post.id).filter((n) => n.tier === 'same').map((n) => n.post)];
  const tagCounts = new Map();
  for (const p of group) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const stats = priceStats(group);
  return {
    candidate_id: candidate.post.id,
    title: group.map((p) => p.title).sort((a, b) => b.length - a.length)[0],   // 가장 자세한 제목
    category: mostCommon(group.map((p) => p.category)),
    series: mostCommon(group.map((p) => p.series)),
    tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t),
    price: Math.round(stats.median / 1000) * 1000,
    stats,
  };
}

function candidatesScreen(photo, candidates) {
  let shown = false;
  const onShow = () => {
    if (shown) return;
    shown = true;
    logger.log('listing_candidates_shown', null, {
      candidates: candidates.map((c, i) => ({ post_id: c.post.id, rank: i + 1, score: Number(c.score.toFixed(4)), tier: c.tier })),
    });
  };
  const choose = (candidate, rank) => {
    logger.log('listing_candidate_pick', candidate ? 'candidate' : 'btn_none', {
      post_id: candidate?.post.id ?? null, rank: rank ?? null, score: candidate ? Number(candidate.score.toFixed(4)) : null,
    });
    nav.push(listingForm({ screenId: 'd_form', ai: true, photos: [photo], suggestions: candidate ? buildSuggestions(candidate) : null }));
  };
  const el = h('div', { class: 'module' },
    screenHeader('이 상품인가요?'),
    h('p', { class: 'hint' }, '올린 사진과 가장 비슷한 상품이에요. 맞는 것을 고르면 제목과 가격을 채워 드려요.'),
    h('div', { class: 'grid candidates' }, candidates.map((c, i) => postCard(c, { onOpen: () => choose(c, i + 1) }))),
    h('button', { class: 'btn block', type: 'button', onclick: () => choose(null) }, '해당하는 상품이 없어요 · 직접 입력'));
  return { id: 'd_candidates', el, onShow };
}

export function rootScreen() {
  const status = h('p', { class: 'hint center' });
  const button = h('button', {
    class: 'btn primary big', type: 'button',
    onclick: async () => {
      const picked = await pickPhoto('상품 사진 올리기');
      if (!picked) return;
      keepPhoto('listing', picked);
      button.disabled = true;
      status.textContent = 'AI가 어떤 상품인지 알아보는 중…';
      try {
        const out = await aiPhotoSearch(picked.file);
        logger.log('photo_pick', 'btn_photo', { source: picked.source, retake_no: 1, width: out.width, height: out.height, embed_ms: out.embed_ms, ...picked.meta });
        logger.log('listing_photo_add', 'btn_photo', { source: picked.source, n_photos: 1, ...picked.meta });
        nav.push(candidatesScreen(picked, pickCandidates(out.results)));
      } catch (err) {
        logger.log('error', 'listing_photo', { message: String(err.message || err) });
        toast(`사진을 분석하지 못했어요: ${err.message || err}`);
      } finally {
        button.disabled = false;
        status.textContent = '';
      }
    },
  }, '📷 사진 올리기');
  const el = h('div', { class: 'module center-col' },
    h('h2', { class: 'form-title' }, '판매 게시물 등록'),
    h('p', { class: 'hint center' }, '팔 굿즈의 사진을 먼저 올려 주세요. AI가 같은 상품을 찾아 나머지를 채워 드려요.'),
    button, status);
  return { id: 'd_photo', el };
}

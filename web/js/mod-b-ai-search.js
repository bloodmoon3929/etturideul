// 모듈 B: AI 검색 (PLAN 9.1) — 제안 방식.
// 글(자연어)·사진 검색, "같은 상품 / 비슷한 상품" 결과, 시세 요약, [비슷한 게시물 찾기], 추천 근거 패널.
// 게시물 데이터와 카드·상세 화면은 모듈 A와 같다. 다른 것은 검색 방식뿐이다.

import { aiTextSearch, aiPhotoSearch, similarPosts, latestPosts, settings, TIER_LABEL } from './data.js';
import { logger } from './logger.js';
import { ml } from './ml.js';
import { nav } from './nav.js';
import { task } from './task-frame.js';
import { h } from './util.js';
import { postGrid, emptyState, detailScreen, skeletonGrid, sheet, toast, pickPhoto, keepPhoto, screenHeader, tierSections, resultRows } from './ui.js';

function openDetail(item, ctx) {
  const actions = (it) => [
    h('button', { class: 'btn', type: 'button', onclick: () => nav.push(similarScreen(it.post, (ctx.chain_depth || 0) + 1)) }, '비슷한 게시물 찾기'),
    it.score != null ? h('button', { class: 'btn', type: 'button', onclick: () => explain(it, ctx) }, '추천 근거') : null,
  ];
  nav.push(detailScreen(item, { ...ctx, screenId: 'b_detail', actions }));
}

// [비슷한 게시물 찾기]: 미리 계산한 similar.json을 조회한다 (모델 불필요)
function similarScreen(post, chainDepth) {
  const items = similarPosts(post.id);
  const body = h('div', { class: 'results' });
  const { same, similar } = tierSections(body, items, {
    includeInStats: [post], onOpen: (item, pos) => openDetail(item, { from: 'b_similar', ...pos, chain_depth: chainDepth }),
  });
  logger.log('similar_open', 'btn_similar', {
    post_id: post.id, chain_depth: chainDepth, n_same: same.length, n_similar: similar.length,
    results: resultRows(items), target_rank: task.targetRank(items),
  });
  return { id: 'b_similar', el: h('div', { class: 'module' }, screenHeader(`'${post.title}'와 비슷한 게시물`), body) };
}

// 추천 근거 패널: 표시용 점수, 등급, 사진·글 각각의 유사도, 원시 코사인
function explain(item, ctx) {
  logger.log('explain_open', 'btn_explain', { post_id: item.post.id, score: item.score, tier: item.tier, from_screen: ctx.from ?? null });
  const bar = (label, value) => h('div', { class: 'explain-row' },
    h('span', null, label),
    h('div', { class: 'meter' }, h('i', { style: { width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` } })),
    h('b', null, value.toFixed(2)));
  const raw = h('p', { class: 'sheet-text small', hidden: !settings.showRaw }, `원시 코사인 값: ${item.raw.toFixed(4)}`);
  sheet({
    title: '이 게시물을 추천한 이유',
    content: [
      h('p', { class: 'sheet-text' }, `AI가 계산한 유사도는 ${Math.round(item.score * 100)}점이고, `,
        h('b', null, TIER_LABEL[item.tier]), '(으)로 분류했어요. 90점 이상이면 같은 상품, 65점 이상이면 비슷한 상품으로 봅니다.'),
      bar('사진과 닮은 정도', item.sim_img),
      bar('글과 닮은 정도', item.sim_txt),
      h('p', { class: 'sheet-text small' }, '사진과 글의 값은 서로 기준이 달라 직접 비교하기보다 참고용으로 봐 주세요.'),
      raw,
      h('button', { class: 'link-btn', type: 'button', onclick: () => { raw.hidden = !raw.hidden; } }, '원시 점수 보기'),
    ],
  });
}

export function rootScreen() {
  let searchNo = 0;
  let photo = null;        // { file, objectUrl, source }
  let retakeNo = 0;
  let typing = false;
  let busy = false;

  const input = h('input', {
    class: 'input search-input', type: 'search', placeholder: '찾는 굿즈를 말하듯 적어 보세요', enterkeyhint: 'search', autocomplete: 'off',
    onfocus: () => { typing = false; },
    oninput: () => {
      if (typing) return;
      typing = true;
      logger.log('query_input_start', 'search_box', { field: 'query', has_photo: !!photo });
    },
  });
  const cameraBtn = h('button', { class: 'btn camera-btn', type: 'button', onclick: choosePhoto });
  const photoChip = h('div', { class: 'photo-chip', hidden: true });
  const form = h('form', { class: 'search-bar', onsubmit: (e) => { e.preventDefault(); input.blur(); submit(); } },
    cameraBtn, input, h('button', { class: 'btn primary', type: 'submit' }, '검색'));
  const status = h('div', { class: 'result-count' });
  const list = h('div', { class: 'results' });

  // 이미지 인코더는 홈 화면이 뜬 뒤 백그라운드로 로드된다. 준비될 때까지 "준비 중" (PLAN 6.3)
  const visionReady = () => settings.searchBackend === 'server' || ml.isReady('vision');
  const refreshCamera = () => {
    cameraBtn.textContent = visionReady() ? '📷 사진' : '📷 준비 중';
    cameraBtn.disabled = !visionReady() || busy;
  };
  const unsubscribe = ml.onChange((e) => { if (e.type === 'ready') refreshCamera(); });
  refreshCamera();

  function showFeed() {
    const items = latestPosts().map((post) => ({ post }));
    status.textContent = `전체 ${items.length}개`;
    list.replaceChildren(postGrid(items, { section: 'feed', onOpen: (item, c) => openDetail(item, { from: 'b_results', ...c, chain_depth: 0 }) }));
  }

  function setPhoto(next) {
    if (photo) URL.revokeObjectURL(photo.objectUrl);
    photo = next;
    photoChip.hidden = !photo;
    if (!photo) return;
    photoChip.replaceChildren(
      h('img', { src: photo.objectUrl, alt: '검색에 쓰는 사진' }),
      h('span', null, '이 사진으로 찾는 중 · 글을 더하면 함께 반영해요'),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': '사진 빼기',
        onclick: () => { logger.log('query_clear', 'btn_photo_remove', { field: 'photo' }); setPhoto(null); },
      }, '✕'));
  }

  async function choosePhoto() {
    const picked = await pickPhoto('사진으로 찾기');
    if (!picked) return;
    retakeNo += 1;
    setPhoto({ ...picked, objectUrl: URL.createObjectURL(picked.file) });
    keepPhoto('search', picked);
    await submit({ photoJustPicked: true });
  }

  async function submit({ photoJustPicked = false } = {}) {
    const query = input.value.trim();
    if (busy || (!photo && !query)) return;
    busy = true;
    refreshCamera();
    list.replaceChildren(skeletonGrid());
    status.textContent = '';
    const slow = setTimeout(() => { status.textContent = 'AI가 비슷한 굿즈를 찾는 중…'; }, 1000);
    try {
      const out = photo ? await aiPhotoSearch(photo.file, query) : await aiTextSearch(query);
      if (photo && photoJustPicked) {
        logger.log('photo_pick', 'btn_camera', { source: photo.source, retake_no: retakeNo, width: out.width, height: out.height, embed_ms: out.embed_ms, ...photo.meta });
      }
      const { same, similar } = tierSections(list, out.results, { onOpen: (item, pos) => openDetail(item, { from: 'b_results', ...pos, chain_depth: 0 }) });
      status.textContent = `같은 상품 ${same.length}개 · 비슷한 상품 ${similar.length}개`;
      el.scrollTop = 0;
      logger.log('search_submit', photo ? 'btn_camera' : 'search_box', {
        search_id: `${task.run?.task_run_id ?? 'demo'}-s${++searchNo}`, mode: out.mode, trigger: 'submit', query,
        filters: null, sort: 'similarity', latency_ms: out.latency_ms, embed_ms: out.embed_ms,
        n_results: same.length + similar.length, n_same: same.length, n_similar: similar.length,
        results: resultRows(out.results), target_rank: task.targetRank(out.results),
        backend: settings.searchBackend,
      });
      lastSearch = { label: query || '사진 검색', results: out.results.slice(0, 5) };
      mapBtn.hidden = !task.demo;
    } catch (err) {
      logger.log('error', 'search', { message: String(err.message || err) });
      list.replaceChildren(emptyState('검색 중 문제가 생겼어요. 다시 시도해 주세요.'));
      toast(`검색 오류: ${err.message || err}`);
    } finally {
      clearTimeout(slow);
      busy = false;
      refreshCamera();
    }
  }

  // 검색 결과를 3D 지도에서 보기 (PLAN 12.3, 시연용이라 데모 모드에서만 보인다)
  let lastSearch = null;
  const mapBtn = h('button', {
    class: 'link-btn', type: 'button', hidden: true,
    onclick: async () => {
      const { graphScreen } = await import('./graph.js');
      nav.push(graphScreen({ search: lastSearch }));
    },
  }, '취향 지도에서 보기');

  const el = h('div', { class: 'module' },
    h('div', { class: 'module-head' }, form, photoChip),
    h('div', { class: 'status-row' }, status, mapBtn), list);
  showFeed();
  return { id: 'b_results', el, onDestroy: () => { unsubscribe(); setPhoto(null); } };
}

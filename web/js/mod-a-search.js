// 모듈 A: 원래 방식 검색 — 중고거래 앱처럼 목록을 내려 보거나 키워드로 검색한다 (카테고리·가격 필터, 정렬).
// 모듈 P: 제안 방식 — 모듈 A와 똑같은 화면에 [사진] 버튼 하나가 더 있다. 사진으로 같은 상품·비슷한 상품을 찾는다.
// 두 모듈은 이 파일 하나로 만들어서, 사진 검색 말고는 다른 것이 없게 한다.
// 키워드 검색은 제목·태그 부분 일치만 한다(유사도, 오타 보정, 동의어 없음).

import { CATEGORIES } from './config.js';
import { keywordSearch, aiPhotoSearch, settings } from './data.js';
import { logger } from './logger.js';
import { ml } from './ml.js';
import { nav } from './nav.js';
import { task } from './task-frame.js';
import { h } from './util.js';
import { chips, postGrid, emptyState, detailScreen, skeletonGrid, tierSections, resultRows, pickPhoto, keepPhoto, toast } from './ui.js';

const SORTS = [['latest', '최신순'], ['price', '낮은 가격순']];

function searchScreen({ photoSearch = false } = {}) {
  const prefix = photoSearch ? 'p' : 'a';
  const state = { query: '', category: null, minPrice: null, maxPrice: null, sort: 'latest' };
  let searchNo = 0;
  let typing = false;
  let photo = null;       // 사진 검색 중이면 { file, objectUrl, source, meta }
  let retakeNo = 0;
  let busy = false;
  const nextSearchId = () => `${task.run?.task_run_id ?? 'demo'}-s${++searchNo}`;

  const input = h('input', {
    class: 'input search-input', type: 'search', placeholder: '상품명, 캐릭터, 태그로 검색', enterkeyhint: 'search', autocomplete: 'off',
    onfocus: () => { typing = false; },
    oninput: () => {
      if (!typing) {
        typing = true;
        logger.log('query_input_start', 'search_box', { field: 'query', previous: state.query });
      }
      clearBtn.hidden = !input.value;
    },
  });
  const clearBtn = h('button', {
    class: 'icon-btn', type: 'button', hidden: true, 'aria-label': '검색어 지우기',
    onclick: () => {
      logger.log('query_clear', 'btn_clear', { field: 'query', from: input.value });
      input.value = '';
      clearBtn.hidden = true;
      input.focus();
    },
  }, '✕');
  const cameraBtn = photoSearch ? h('button', { class: 'btn camera-btn', type: 'button', onclick: choosePhoto }) : null;
  const form = h('form', {
    class: 'search-bar',
    onsubmit: (e) => {
      e.preventDefault();
      state.query = input.value.trim();
      input.blur();
      setPhoto(null);   // 글로 검색하면 사진 검색에서 빠져나온다
      run('submit');
    },
  }, cameraBtn, input, clearBtn, h('button', { class: 'btn primary', type: 'submit' }, '검색'));

  const categoryChips = chips([[null, '전체'], ...CATEGORIES.map((c) => [c, c])], {
    value: null, name: 'category',
    onChange: (to, from) => {
      state.category = to;
      logger.log('category_select', 'category_chips', { field: 'category', from, to });
      run('category');
    },
  });
  const priceInput = (field, placeholder) => h('input', {
    class: 'input price-input', type: 'number', inputmode: 'numeric', min: 0, step: 1000, placeholder,
    onchange: (e) => {
      const to = e.target.value === '' ? null : Number(e.target.value);
      const from = state[field];
      if (to === from) return;
      state[field] = to;
      logger.log('filter_change', `${field === 'minPrice' ? 'min' : 'max'}_price`, { field: field === 'minPrice' ? 'min_price' : 'max_price', from, to });
      run('filter');
    },
  });
  const sortSelect = h('select', {
    class: 'input sort-select', 'aria-label': '정렬',
    onchange: (e) => {
      const from = state.sort;
      state.sort = e.target.value;
      logger.log('sort_change', 'sort_select', { field: 'sort', from, to: state.sort });
      run('sort');
    },
  }, SORTS.map(([value, label]) => h('option', { value }, label)));
  // 필터와 정렬은 키워드 목록에만 쓴다. 사진 검색 결과가 떠 있는 동안에는 숨긴다
  const filters = h('div', { class: 'stack' },
    categoryChips,
    h('div', { class: 'filter-row' }, priceInput('minPrice', '최소 가격'), h('span', null, '~'), priceInput('maxPrice', '최대 가격'), sortSelect));
  const photoChip = h('div', { class: 'photo-chip', hidden: true });
  const count = h('div', { class: 'result-count' });
  const list = h('div', { class: 'results' });

  const openDetail = (item, { rank, section }) => {
    nav.push(detailScreen(item, { screenId: `${prefix}_detail`, from: `${prefix}_results`, rank, section, chain_depth: 0 }));
  };

  // 키워드 목록. trigger: submit(검색 버튼) / category / filter / sort / initial(처음 화면, 기록하지 않음)
  function run(trigger) {
    const t0 = performance.now();
    const items = keywordSearch(state).map((post) => ({ post }));
    const latency = Math.round(performance.now() - t0);
    count.textContent = state.query ? `'${state.query}' 검색 결과 ${items.length}개` : `전체 ${items.length}개`;
    list.replaceChildren(items.length ? postGrid(items, { section: 'results', onOpen: openDetail }) : emptyState('검색 결과가 없습니다'));
    el.scrollTop = 0;
    if (trigger === 'initial') return;
    logger.log('search_submit', trigger === 'submit' ? 'search_box' : trigger, {
      search_id: nextSearchId(), mode: 'keyword', trigger, query: state.query,
      filters: { category: state.category, min_price: state.minPrice, max_price: state.maxPrice }, sort: state.sort,
      latency_ms: latency, n_results: items.length,
      results: items.slice(0, 20).map((it, i) => ({ post_id: it.post.id, rank: i + 1, score: null, tier: null, section: 'results' })),
      target_rank: task.targetRank(items),
    });
  }

  // ── 사진 검색 (모듈 P에서만) ────────────────────────────────────────
  // 이미지 인코더는 앱이 뜬 뒤 백그라운드로 로드된다. 준비될 때까지 "준비 중"
  const visionReady = () => settings.searchBackend === 'server' || ml.isReady('vision');
  const refreshCamera = () => {
    if (!cameraBtn) return;
    cameraBtn.textContent = visionReady() ? '📷 사진' : '📷 준비 중';
    cameraBtn.disabled = !visionReady() || busy;
  };
  const unsubscribe = ml.onChange((e) => { if (e.type === 'ready') refreshCamera(); });
  refreshCamera();

  function setPhoto(next) {
    if (photo) URL.revokeObjectURL(photo.objectUrl);
    photo = next;
    photoChip.hidden = !photo;
    filters.hidden = !!photo;
    if (!photo) return;
    photoChip.replaceChildren(
      h('img', { src: photo.objectUrl, alt: '검색에 쓰는 사진' }),
      h('span', null, '이 사진과 비슷한 굿즈를 찾았어요'),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': '사진 검색 끝내기',
        onclick: () => {
          logger.log('query_clear', 'btn_photo_remove', { field: 'photo' });
          setPhoto(null);
          run('initial');
        },
      }, '✕'));
  }

  async function choosePhoto() {
    const picked = await pickPhoto('사진으로 찾기');
    if (!picked || busy) return;
    retakeNo += 1;
    input.value = '';
    clearBtn.hidden = true;
    state.query = '';
    setPhoto({ ...picked, objectUrl: URL.createObjectURL(picked.file) });
    keepPhoto('search', picked);
    busy = true;
    refreshCamera();
    list.replaceChildren(skeletonGrid());
    count.textContent = '';
    const slow = setTimeout(() => { count.textContent = 'AI가 비슷한 굿즈를 찾는 중…'; }, 1000);
    try {
      const out = await aiPhotoSearch(photo.file);
      logger.log('photo_pick', 'btn_camera', { source: photo.source, retake_no: retakeNo, width: out.width, height: out.height, embed_ms: out.embed_ms, ...photo.meta });
      const { same, similar } = tierSections(list, out.results, { onOpen: openDetail });
      count.textContent = `같은 상품 ${same.length}개 · 비슷한 상품 ${similar.length}개`;
      el.scrollTop = 0;
      logger.log('search_submit', 'btn_camera', {
        search_id: nextSearchId(), mode: 'ai_photo', trigger: 'submit', query: '', filters: null, sort: 'similarity',
        latency_ms: out.latency_ms, embed_ms: out.embed_ms, n_results: same.length + similar.length, n_same: same.length, n_similar: similar.length,
        results: resultRows(out.results), target_rank: task.targetRank(out.results), backend: settings.searchBackend,
      });
    } catch (err) {
      logger.log('error', 'search', { message: String(err.message || err) });
      setPhoto(null);
      run('initial');
      toast(`사진 검색 오류: ${err.message || err}`);
    } finally {
      clearTimeout(slow);
      busy = false;
      refreshCamera();
    }
  }

  const el = h('div', { class: 'module' }, h('div', { class: 'module-head' }, form, photoChip, filters), count, list);
  run('initial');
  return { id: `${prefix}_results`, el, onDestroy: () => { unsubscribe(); setPhoto(null); } };
}

export const rootScreen = () => searchScreen();
export const photoRootScreen = () => searchScreen({ photoSearch: true });

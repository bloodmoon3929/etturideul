// 모듈 R: 구매 추천 (Task 3).
// 1) 목록을 둘러보며 마음에 드는 굿즈를 5개 찜한다(인터뷰어가 시키는 준비 단계)
// 2) [구매 추천 보기] → 찜 목록을 바탕으로 가장 비슷한 계열의 굿즈를 추천하는 페이지가 열린다(핵심 측정).
//    [추천 더 보기]로 유사도 다음 순위의 굿즈를 계속 불러올 수 있다
//    추천 = 찜한 굿즈들의 통합 벡터 평균(취향 벡터)과 가까운 굿즈. 각 추천에는 가장 비슷한 찜 굿즈를 이유로 붙인다
// 3) 추천된 굿즈 중 사고 싶은 것을 찜하고 [완료]

import { CATEGORIES } from './config.js';
import { db, keywordSearch, recommendFromLikes, thumbUrl } from './data.js';
import { logger } from './logger.js';
import { nav } from './nav.js';
import { task } from './task-frame.js';
import { h } from './util.js';
import { chips, postGrid, detailScreen, screenHeader, toast } from './ui.js';

const needLikes = () => task.def?.n_likes ?? 5;
const shorten = (text, n = 12) => (text.length > n ? `${text.slice(0, n)}…` : text);

function openPost(item, ctx) {
  nav.push(detailScreen(item, { ...ctx, screenId: 'r_detail' }));
}

// 구매 추천 페이지. 처음엔 n_recommend개, [추천 더 보기]를 누를 때마다 유사도 다음 순위부터 같은 수만큼 더 보여 준다
function recommendScreen() {
  const basis = [...task.likes];
  const pageSize = task.def?.n_recommend ?? 8;
  let page = 0;
  let shown = 0;
  task.extra.basis ??= basis;   // 처음 추천을 본 때의 찜 목록. 그 뒤에 찜한 것이 추천에 대한 반응이다
  const strip = h('div', { class: 'basis-strip' }, basis.map((id) => {
    const post = db.byId.get(id);
    return h('img', { src: thumbUrl(post), alt: post.title, title: post.title });
  }));
  const list = h('div', { class: 'recommend-list' });
  const moreBtn = h('button', { class: 'btn block', type: 'button', onclick: () => loadMore() }, '추천 더 보기');

  function loadMore() {
    const recs = recommendFromLikes(basis, pageSize, shown);
    if (!recs.length) {
      moreBtn.hidden = true;
      return toast('더 추천할 굿즈가 없어요');
    }
    page += 1;
    const items = recs.map((r) => ({ post: r.post, note: `♥ '${shorten(r.reason.title)}' 계열` }));   // 가장 비슷한 찜 굿즈
    list.append(postGrid(items, {
      section: 'recommend', rankOffset: shown,
      onOpen: (item, pos) => openPost(item, { from: 'r_recommend', ...pos, chain_depth: 1 }),
    }));
    task.extra.recommended = [...new Set([...(task.extra.recommended || []), ...recs.map((r) => r.post.id)])];
    logger.log(page === 1 ? 'recommend_page_open' : 'recommend_more', page === 1 ? null : 'btn_more', {
      basis, page,
      results: recs.map((r, i) => ({ post_id: r.post.id, rank: shown + i + 1, score: Number(r.score.toFixed(4)), reason_post_id: r.reason.id })),
    });
    shown += recs.length;
  }

  const el = h('div', { class: 'module recommend-page' },
    screenHeader('구매 추천'),
    h('div', { class: 'recommend-head' },
      h('h2', null, '이런 굿즈는 어떠세요?'),
      h('p', { class: 'hint' }, `찜한 굿즈 ${basis.length}개와 비슷한 계열의 굿즈를 비슷한 순서대로 골랐어요.`),
      strip),
    list, moreBtn);
  let opened = false;
  return { id: 'r_recommend', el, onShow: () => { if (!opened) { opened = true; loadMore(); } } };
}

export function rootScreen() {
  let category = null;
  const count = h('div', { class: 'result-count' });
  const list = h('div', { class: 'results' });
  const likeCount = h('span', { class: 'like-count' });
  const recommendBtn = h('button', {
    class: 'btn primary small', type: 'button',
    onclick: () => {
      if (task.likes.size < needLikes()) return toast(`굿즈를 ${needLikes()}개 찜하면 추천을 볼 수 있어요 (지금 ${task.likes.size}개)`);
      nav.push(recommendScreen());
    },
  }, '구매 추천 보기');
  const refreshBar = () => {
    const n = task.likes.size;
    likeCount.textContent = `♥ 찜 ${n}/${needLikes()}`;
    recommendBtn.classList.toggle('disabled', n < needLikes());
  };
  const render = () => {
    const items = keywordSearch({ category }).map((post) => ({ post }));
    count.textContent = `${category ?? '전체'} ${items.length}개`;
    list.replaceChildren(postGrid(items, { section: 'feed', onOpen: (item, pos) => openPost(item, { from: 'r_feed', ...pos, chain_depth: 0 }) }));
    el.scrollTop = 0;
  };
  const categoryChips = chips([[null, '전체'], ...CATEGORIES.map((c) => [c, c])], {
    value: null, name: 'category',
    onChange: (to, from) => {
      category = to;
      logger.log('category_select', 'category_chips', { field: 'category', from, to });
      render();
    },
  });
  const el = h('div', { class: 'module' },
    h('div', { class: 'module-head' }, h('div', { class: 'like-bar' }, likeCount, recommendBtn), categoryChips),
    count, list);
  render();
  refreshBar();
  return { id: 'r_feed', el, onShow: refreshBar };
}

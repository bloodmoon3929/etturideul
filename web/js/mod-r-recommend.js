// 모듈 R: 비슷한 굿즈 추천.
// 목록에서 마음에 드는 굿즈를 고르면(게시물을 열면) 그 굿즈와 비슷한 굿즈를 게시물 아래에 추천한다.
// 추천은 미리 계산한 similar.json의 상위 N개다(모델 불필요). 추천된 굿즈를 열면 다시 그 굿즈 기준으로 추천한다.

import { CATEGORIES } from './config.js';
import { keywordSearch, similarPosts } from './data.js';
import { logger } from './logger.js';
import { nav } from './nav.js';
import { h } from './util.js';
import { chips, postGrid, detailScreen, resultRows } from './ui.js';

const N_RECOMMEND = 6;

// chain_depth: 목록에서 직접 고른 굿즈는 0, 추천을 따라 들어갈 때마다 1씩 늘어난다
function openPost(item, ctx) {
  const depth = ctx.chain_depth ?? 0;
  const items = similarPosts(item.post.id).slice(0, N_RECOMMEND);
  nav.push(detailScreen(item, {
    ...ctx, screenId: 'r_detail',
    below: () => [
      h('h3', { class: 'section-title' }, '이 굿즈와 비슷한 굿즈'),
      postGrid(items, { section: 'recommend', onOpen: (it, pos) => openPost(it, { from: 'r_detail', ...pos, chain_depth: depth + 1 }) }),
    ],
    onView: () => logger.log('recommend_shown', null, { post_id: item.post.id, chain_depth: depth, results: resultRows(items) }),
  }));
}

export function rootScreen() {
  let category = null;
  const count = h('div', { class: 'result-count' });
  const list = h('div', { class: 'results' });
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
  const el = h('div', { class: 'module' }, h('div', { class: 'module-head' }, categoryChips), count, list);
  render();
  return { id: 'r_feed', el };
}

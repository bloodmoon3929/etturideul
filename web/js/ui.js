// 공통 UI. 모듈 A와 B, C와 D가 같은 카드·상세·폼 컴포넌트를 쓰도록 여기에 모은다 (PLAN 9.2 통제 원칙).

import { h, won, daysAgo } from './util.js';
import { nav } from './nav.js';
import { logger } from './logger.js';
import { db, TIER_LABEL, thumbUrl, creditOf, settings, priceStats } from './data.js';
import { PHOTO_SOURCE, url } from './config.js';
import { task } from './task-frame.js';
import { photos } from './store.js';
import { isoNow } from './util.js';

// ── 알림·시트·대화상자 ────────────────────────────────────────────────
export function toast(message, ms = 2200) {
  const el = h('div', { class: 'toast' }, message);
  document.getElementById('toast-host').append(el);
  setTimeout(() => el.remove(), ms);
}

// 아래에서 올라오는 시트. 뒤로 가기로 닫힌다
export function sheet({ title, content, onClose, dismissable = true, className = '' }) {
  let removeOverlay = null;
  const close = () => {
    backdrop.remove();
    removeOverlay?.();
    onClose?.();
  };
  const panel = h('div', { class: `sheet ${className}`, role: 'dialog' },
    h('div', { class: 'sheet-head' },
      h('strong', null, title),
      dismissable && h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: close }, '✕')),
    h('div', { class: 'sheet-body' }, content));
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => { if (dismissable && e.target === backdrop) close(); } }, panel);
  document.getElementById('toast-host').replaceChildren();   // 남아 있는 알림이 시트 내용을 가리지 않게 한다
  document.body.append(backdrop);
  removeOverlay = nav.addOverlay(dismissable ? close : () => {});
  return { close, panel };
}

export function confirmDialog(message, { ok = '확인', cancel = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => { answered = true; s.close(); resolve(value); };
    const s = sheet({
      title: '확인',
      content: [
        h('p', { class: 'sheet-text' }, message),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => answer(false) }, cancel),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => answer(true) }, ok)),
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ── 작은 부품 ─────────────────────────────────────────────────────────
// 하나만 고르는 칩 묶음. options: 문자열 배열 또는 [값, 표시] 배열
export function chips(options, { value = null, onChange, allowNone = false, name = '' } = {}) {
  const el = h('div', { class: 'chips', role: 'radiogroup', dataset: { name } });
  const render = () => {
    el.replaceChildren(...options.map((opt) => {
      const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
      return h('button', {
        type: 'button', class: `chip ${val === value ? 'on' : ''}`, role: 'radio', 'aria-checked': String(val === value),
        onclick: () => {
          const next = allowNone && val === value ? null : val;
          if (next === value) return;
          const prev = value;
          value = next;
          render();
          onChange?.(value, prev);
        },
      }, label);
    }));
  };
  render();
  el.getValue = () => value;
  el.setValue = (v) => { value = v; render(); };
  return el;
}

export function tierBadge(item) {
  if (!item.tier || item.tier === 'low') return null;
  return h('span', { class: `tier tier-${item.tier}` },
    TIER_LABEL[item.tier], ' ', h('b', null, `${Math.round(item.score * 100)}`),
    settings.showRaw && item.raw != null ? h('small', null, ` (${item.raw.toFixed(3)})`) : null);
}

export function priceSummary(stats, label = '같은 상품 시세') {
  if (!stats) return null;
  return h('div', { class: 'price-summary' },
    h('div', { class: 'price-summary-title' }, `${label} · ${stats.n}개 게시물`),
    h('div', { class: 'price-summary-row' },
      h('div', null, h('small', null, '최저'), h('b', null, won(stats.min))),
      h('div', null, h('small', null, '평균'), h('b', null, won(stats.avg))),
      h('div', null, h('small', null, '최고'), h('b', null, won(stats.max)))));
}

export function emptyState(text) {
  return h('div', { class: 'empty' }, text);
}

export function skeletonGrid(n = 6) {
  return h('div', { class: 'grid' }, Array.from({ length: n }, () =>
    h('div', { class: 'card skeleton' }, h('div', { class: 'card-img' }), h('div', { class: 'card-body' }, h('i'), h('i')))));
}

// ── 결과 카드 ─────────────────────────────────────────────────────────
// item: { post, score?, tier?, raw? }. AI 모듈에서만 점수·등급 배지가 붙는다
export function postCard(item, { onOpen } = {}) {
  const { post } = item;
  return h('button', { class: 'card', type: 'button', dataset: { id: post.id }, onclick: () => onOpen?.(item) },
    h('div', { class: 'card-img' },
      h('img', { src: thumbUrl(post), alt: '', loading: 'lazy', decoding: 'async' }),
      tierBadge(item)),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title' }, post.title),
      h('div', { class: 'card-price' }, won(post.price)),
      h('div', { class: 'card-meta' }, h('span', { class: 'cond' }, post.condition), ` ${post.location} · ${daysAgo(post.created_at)}`)));
}

// 결과 목록. 카드가 화면에 절반 이상 보이면 result_impression, 누르면 result_click을 남긴다
export function postGrid(items, { section = 'results', rankOffset = 0, onOpen } = {}) {
  const grid = h('div', { class: 'grid' });
  const seen = new Set();
  const info = (item, rank) => ({
    post_id: item.post.id, rank, score: item.score ?? null, tier: item.tier ?? null, section, is_target: task.isTarget(item.post),
  });
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const rank = Number(entry.target.dataset.rank);
      if (seen.has(rank)) continue;
      seen.add(rank);
      observer.unobserve(entry.target);
      logger.log('result_impression', 'card', info(items[rank - 1 - rankOffset], rank));
    }
  }, { threshold: 0.5 });
  items.forEach((item, i) => {
    const rank = rankOffset + i + 1;
    const card = postCard(item, {
      onOpen: () => {
        logger.log('result_click', 'card', info(item, rank));
        onOpen?.(item, { rank, section });
      },
    });
    card.dataset.rank = rank;
    grid.append(card);
    observer.observe(card);
  });
  return grid;
}

// 로그에 남기는 결과 목록 (상위 20개)
export const resultRows = (items) => items.slice(0, 20).map((it, i) => ({
  post_id: it.post.id, rank: i + 1, score: Number(it.score.toFixed(4)), tier: it.tier, section: it.tier,
}));

// 유사도 결과를 등급별 구역(같은 상품 / 비슷한 상품 / 관련 낮음)으로 나눠 그린다. 순위는 구역을 이어서 매긴다
export function tierSections(container, items, { onOpen, includeInStats = [], lowLimit = 10 }) {
  const same = items.filter((it) => it.tier === 'same');
  const similar = items.filter((it) => it.tier === 'similar');
  const low = items.filter((it) => it.tier === 'low').slice(0, lowLimit);
  container.replaceChildren();
  if (same.length) {
    container.append(
      h('h3', { class: 'section-title' }, `${TIER_LABEL.same} ${same.length}개`),
      priceSummary(priceStats([...includeInStats, ...same.map((it) => it.post)])),
      postGrid(same, { section: 'same', onOpen }));
  }
  if (similar.length) {
    container.append(
      h('h3', { class: 'section-title' }, `${TIER_LABEL.similar} ${similar.length}개`),
      postGrid(similar, { section: 'similar', rankOffset: same.length, onOpen }));
  }
  if (!same.length && !similar.length) {
    container.append(emptyState('비슷한 굿즈를 찾지 못했어요. 다른 사진이나 표현으로 다시 찾아보세요.'));
  }
  if (low.length) {
    const more = h('div');
    container.append(h('button', {
      class: 'link-btn more-btn', type: 'button',
      onclick: (e) => {
        e.target.remove();
        logger.log('low_results_open', 'btn_more', { n: low.length });
        more.append(h('h3', { class: 'section-title' }, TIER_LABEL.low),
          postGrid(low, { section: 'low', rankOffset: same.length + similar.length, onOpen }));
      },
    }, '관련이 낮은 게시물 더 보기'), more);
  }
  return { same, similar };
}

// ── 게시물 상세 ───────────────────────────────────────────────────────
// ctx: { screenId, from, rank, section, chain_depth, actions?: (item) => 버튼 배열, below?: (item) => 본문 아래에 넣을 내용, onView?: 처음 보일 때 }
// 찾기 Task에서는 [이 상품이에요], 찜 Task에서는 [찜]이 주 버튼이 된다. AI 모듈은 actions로 버튼을 더한다
export function detailScreen(item, ctx) {
  const { post } = item;
  const likeBtn = h('button', { class: 'btn', type: 'button' });
  const answerBtn = h('button', { class: 'btn primary', type: 'button' });
  const refresh = () => {
    const liked = task.likes.has(post.id);
    likeBtn.textContent = liked ? '♥ 찜함' : '♡ 찜';
    likeBtn.classList.toggle('on', liked);
    likeBtn.classList.toggle('primary', task.wantsLikes() && !liked);
    const chosen = task.answerPostId === post.id;
    answerBtn.textContent = chosen ? '✓ 이 상품으로 골랐어요' : '이 상품이에요';
    answerBtn.classList.toggle('on', chosen);
  };
  likeBtn.onclick = () => { task.toggleLike(post, ctx); refresh(); };
  answerBtn.onclick = () => { task.submitAnswer(post, ctx); refresh(); };

  const el = h('div', { class: 'detail' },
    // 화면 위에 떠 있는 뒤로 가기 버튼. 스크롤해도 왼쪽 위에 남는다
    h('button', { class: 'detail-back', type: 'button', 'aria-label': '뒤로', onclick: () => nav.back('button') }, '←'),
    h('div', { class: 'detail-img' }, h('img', { src: thumbUrl(post, true), alt: post.title })),
    h('div', { class: 'detail-body' },
      tierBadge(item),
      h('h2', null, post.title),
      h('div', { class: 'detail-price' }, won(post.price)),
      h('div', { class: 'detail-meta' },
        h('span', { class: 'cond' }, post.condition), ` ${post.category} · ${post.location} · ${daysAgo(post.created_at)} · ${post.seller}`),
      h('p', { class: 'detail-desc' }, post.description),
      h('div', { class: 'tags' }, post.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))),
      h('div', { class: 'credit' }, creditOf(post)),
      ctx.below?.(item) ?? null),
    h('div', { class: 'detail-actions' },
      likeBtn,
      ...(ctx.actions?.(item) || []),
      task.wantsAnswer() ? answerBtn : null));
  let viewed = false;
  const onShow = () => {
    refresh();
    if (viewed) return;
    viewed = true;
    logger.log('post_view', 'detail', {
      post_id: post.id, from_screen: ctx.from ?? null, rank: ctx.rank ?? null, score: item.score ?? null, tier: item.tier ?? null,
      section: ctx.section ?? null, chain_depth: ctx.chain_depth ?? 0, is_target: task.isTarget(post),
    });
    ctx.onView?.();
  };
  return { id: ctx.screenId, el, onShow };
}

// 화면 위쪽 머리말 (뒤로 가기 + 제목)
export function screenHeader(title, { back = true } = {}) {
  return h('div', { class: 'screen-head' },
    back ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': '뒤로', onclick: () => nav.back('button') }, '←') : null,
    h('strong', null, title));
}

// ── 사진 고르기 ───────────────────────────────────────────────────────
// 결과: { file, source, meta } 또는 null(취소)
//   source: 'virtual_gallery'(앱 안의 가상 갤러리) / 'camera' / 'gallery'(폰 앨범)
//   meta  : 가상 갤러리에서 고른 경우 { photo_id, gallery_index, is_target_photo }
//
// Task 중에는 PHOTO_SOURCE 설정을 따른다. 기본값 'virtual'이면 실물이나 사진 카드를 건네지 않아도 되도록
// 가상 갤러리만 연다. 데모 모드에서는 가상 갤러리와 폰의 카메라·앨범을 모두 고를 수 있다.
export function pickPhoto(title = '사진 추가') {
  if (!task.demo && PHOTO_SOURCE === 'virtual') return virtualGallery(title);
  return new Promise((resolve) => {
    let picked = false;
    const finish = (value) => { picked = true; s.close(); resolve(value); };
    const input = (source) => h('input', {
      type: 'file', accept: 'image/*', hidden: true, capture: source === 'camera' ? 'environment' : null, dataset: { source },
      onchange: (e) => { if (e.target.files[0]) finish({ file: e.target.files[0], source, meta: {} }); },
    });
    const camera = input('camera'), gallery = input('gallery');
    const s = sheet({
      title,
      content: [
        camera, gallery,
        h('div', { class: 'stack' },
          task.demo ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
            picked = true;   // 시트를 닫아도 취소로 처리하지 않고 가상 갤러리의 결과를 돌려준다
            s.close();
            resolve(await virtualGallery(title));
          } }, '가상 갤러리에서 고르기') : null,
          h('button', { class: `btn ${task.demo ? '' : 'primary'}`, type: 'button', onclick: () => camera.click() }, '카메라로 찍기'),
          h('button', { class: 'btn', type: 'button', onclick: () => gallery.click() }, '앨범에서 고르기')),
      ],
      onClose: () => { if (!picked) resolve(null); },
    });
  });
}

// 가상 갤러리에 보일 사진. 맨 앞(가장 최근)이 지금 Task의 대상 사진이고, 그 뒤로 일상 사진이 이어진다.
// 데모 모드에서는 Task 대상 사진을 전부 앞에 넣어 둔다
function galleryItems() {
  const recent = [];
  if (task.target?.card_image) {
    recent.push({ id: `card:${task.run.set}_${task.run.task_id}`, file: task.target.card_image, is_target: true });
  } else if (task.demo) {
    for (const [set, tasks] of Object.entries(db.protocol?.targets || {})) {
      for (const [taskId, t] of Object.entries(tasks)) {
        if (t.card_image) recent.push({ id: `card:${set}_${taskId}`, file: t.card_image, is_target: false });
      }
    }
  }
  return [...recent, ...db.gallery.map((g) => ({ id: g.id, file: g.file, is_target: false }))];
}

// 폰 갤러리처럼 보이는 화면. 사진을 누르면 그 사진 파일을 돌려준다
function virtualGallery(title) {
  return new Promise((resolve) => {
    let picked = false;
    const items = galleryItems();
    logger.log('gallery_open', 'btn_photo', { n_photos: items.length, has_target_photo: items.some((it) => it.is_target) });
    const choose = async (item, index) => {
      if (picked) return;
      picked = true;
      try {
        const blob = await (await fetch(url(item.file))).blob();
        const file = new File([blob], item.file.split('/').pop(), { type: blob.type || 'image/webp' });
        s.close();
        resolve({ file, source: 'virtual_gallery', meta: { photo_id: item.id, gallery_index: index + 1, is_target_photo: item.is_target } });
      } catch (err) {
        picked = false;
        toast(`사진을 불러오지 못했어요: ${err.message || err}`);
      }
    };
    const s = sheet({
      title: `${title} · 갤러리`,
      className: 'gallery-sheet',
      content: [
        h('p', { class: 'hint' }, '최근 항목'),
        h('div', { class: 'gallery-grid' }, items.map((item, index) =>
          h('button', { class: 'gallery-item', type: 'button', 'aria-label': `사진 ${index + 1}`, dataset: { photo: item.id }, onclick: () => choose(item, index) },
            h('img', { src: url(item.file), alt: '', loading: 'lazy' })))),
      ],
      onClose: () => {
        if (picked) return;
        logger.log('gallery_close', null, { picked: false });
        resolve(null);
      },
    });
  });
}

// 사진 저장에 동의한 참여자가 폰에서 고른 사진만 기기에 남긴다. 가상 갤러리의 사진은 앱에 들어 있는 것이라 남기지 않는다.
// 업로드하지 않고 콘솔의 [사진 내보내기]로 꺼낸다 (PLAN 14.5)
export function keepPhoto(kind, picked) {
  const s = logger.session;
  if (!s?.consent?.photos || picked.source === 'virtual_gallery') return;
  const file = picked.file;
  photos.add({ session_id: s.session_id, task_run_id: logger.run?.task_run_id ?? null, kind, ts: isoNow(), name: file.name || 'photo.jpg', blob: file })
    .catch((err) => console.error('사진 저장 실패', err));
}

// 모듈 C: 기존 방식 판매 등록 (PLAN 9.1) — 비교 기준. 사진 + 직접 입력 폼.
// 모듈 D(AI 등록)도 이 폼과 등록 완료 화면을 그대로 쓴다. D는 자동 채움과 시세 제시만 더한 버전이다 (PLAN 9.2).

import { CATEGORIES, CONDITIONS } from './config.js';
import { logger } from './logger.js';
import { nav } from './nav.js';
import { task } from './task-frame.js';
import { h, won } from './util.js';
import { chips, toast, pickPhoto, keepPhoto, priceSummary } from './ui.js';

const MAX_PHOTOS = 5;
const FIELD_LABELS = { title: '제목', category: '카테고리', series: '작품·시리즈', condition: '상태', price: '가격', description: '설명', tags: '태그' };
const parseTags = (text) => [...new Set(text.split(/[,#\s]+/).map((t) => t.trim()).filter(Boolean))];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// options.suggestions: AI가 제안한 값 { title, category, series, tags, price, stats, candidate_id } (모듈 D에서만)
// options.photos: 이미 고른 사진 [{ file, source }] (모듈 D는 사진을 먼저 받는다)
export function listingForm({ screenId, ai = false, suggestions = null, photos: initialPhotos = [] } = {}) {
  const startedAt = Date.now();
  const sug = suggestions || {};
  const values = {
    title: sug.title ?? '', category: sug.category ?? null, series: sug.series ?? '', condition: null,
    price: sug.price ?? null, description: '', tags: sug.tags ?? [],
  };
  const fieldStats = Object.fromEntries(Object.keys(FIELD_LABELS).map((f) => [f, { time_ms: 0, n_changes: 0 }]));
  const photos = initialPhotos.map((p) => ({ ...p, objectUrl: URL.createObjectURL(p.file) }));
  let focus = null;   // { field, at }

  let opened = false;
  const onShow = () => {   // 폼이 화면에 뜬 뒤에 기록해야 screen 값이 이 폼으로 남는다
    if (opened) return;
    opened = true;
    logger.log('listing_start', null, { ai, has_suggestions: !!suggestions, candidate_id: sug.candidate_id ?? null, n_photos: photos.length });
    for (const field of ['title', 'category', 'series', 'tags', 'price']) {
      if (suggestions && sug[field] != null && !same(sug[field], field === 'tags' ? [] : '')) {
        logger.log('listing_suggest_shown', field, { field, suggested: sug[field] });
      }
    }
  };

  // 값이 바뀌면 listing_field_change. source는 사용자가 직접 바꾼 것이므로 항상 'user'다
  function change(field, value) {
    if (same(values[field], value)) return;
    const from = values[field];
    values[field] = value;
    const stat = fieldStats[field];
    stat.n_changes += 1;
    const elapsed = focus?.field === field ? Date.now() - focus.at : 0;
    logger.log('listing_field_change', field, { field, from, value, source: 'user', time_in_field_ms: elapsed, n_changes: stat.n_changes });
    markEdited(field);
  }
  const onFocus = (field) => () => {
    focus = { field, at: Date.now() };
    logger.log('listing_field_focus', field, { field });
  };
  const onBlur = (field) => () => {
    if (focus?.field === field) fieldStats[field].time_ms += Date.now() - focus.at;
    focus = null;
  };

  // "AI 제안" 표시. 사용자가 값을 바꾸면 "수정함"으로 바뀐다
  const badges = {};
  function label(field, required = false) {
    badges[field] = suggestions && sug[field] != null && !same(sug[field], field === 'tags' ? [] : '')
      ? h('span', { class: 'ai-badge' }, 'AI 제안') : null;
    return h('label', { class: 'field-label' }, FIELD_LABELS[field], required ? h('em', null, ' *') : null, badges[field]);
  }
  function markEdited(field) {
    const badge = badges[field];
    if (!badge) return;
    const kept = same(values[field], sug[field]);
    badge.textContent = kept ? 'AI 제안' : '수정함';
    badge.classList.toggle('edited', !kept);
  }

  const textInput = (field, attrs = {}) => h(attrs.multiline ? 'textarea' : 'input', {
    class: 'input', value: values[field] ?? '', dataset: { field }, ...attrs, multiline: null,
    onfocus: onFocus(field),
    onblur: (e) => { change(field, e.target.value.trim()); onBlur(field)(); },
  });

  // 사진
  const photoRow = h('div', { class: 'photo-row' });
  function renderPhotos() {
    photoRow.replaceChildren(
      ...photos.map((p, i) => h('div', { class: 'photo-thumb' },
        h('img', { src: p.objectUrl, alt: `사진 ${i + 1}` }),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': '사진 삭제',
          onclick: () => {
            URL.revokeObjectURL(p.objectUrl);
            photos.splice(i, 1);
            logger.log('listing_photo_remove', 'btn_photo_remove', { n_photos: photos.length });
            renderPhotos();
          },
        }, '✕'))),
      ...(photos.length < MAX_PHOTOS ? [h('button', { class: 'photo-add', type: 'button', onclick: addPhoto }, '＋', h('small', null, `${photos.length}/${MAX_PHOTOS}`))] : []));
  }
  async function addPhoto() {
    const picked = await pickPhoto('상품 사진 추가');
    if (!picked) return;
    photos.push({ ...picked, objectUrl: URL.createObjectURL(picked.file) });
    keepPhoto('listing', picked);
    logger.log('listing_photo_add', 'btn_photo_add', { source: picked.source, n_photos: photos.length, ...picked.meta });
    renderPhotos();
  }
  renderPhotos();

  const priceInput = h('input', {
    class: 'input', type: 'number', inputmode: 'numeric', min: 0, step: 1000, placeholder: '가격', value: values.price ?? '', dataset: { field: 'price' },
    onfocus: onFocus('price'),
    onblur: (e) => { change('price', e.target.value === '' ? null : Number(e.target.value)); onBlur('price')(); },
  });
  const tagsInput = h('input', {
    class: 'input', placeholder: '쉼표나 띄어쓰기로 구분', value: values.tags.join(', '), dataset: { field: 'tags' },
    onfocus: onFocus('tags'),
    onblur: (e) => { change('tags', parseTags(e.target.value)); onBlur('tags')(); },
  });

  function submit(e) {
    e.preventDefault();
    document.activeElement?.blur();   // 입력 중이던 칸의 값을 먼저 반영한다
    const missing = [
      !photos.length && '사진', !values.title && '제목', !values.category && '카테고리', !values.condition && '상태',
      !(values.price > 0) && '가격',
    ].filter(Boolean);
    if (missing.length) return toast(`${missing.join(', ')}을(를) 입력해 주세요`);

    const durationMs = Date.now() - startedAt;
    const suggested = ['title', 'category', 'series', 'tags', 'price'].filter((f) => suggestions && sug[f] != null && !same(sug[f], f === 'tags' ? [] : ''));
    const actions = suggested.map((field) => {
      const final = values[field];
      const empty = final == null || same(final, '') || same(final, []);
      const action = same(final, sug[field]) ? 'accept' : empty ? 'reject' : 'edit';
      logger.log('listing_suggest_action', field, { field, suggested: sug[field], final, action });
      return action;
    });
    const listing = {
      ...values, n_photos: photos.length, duration_ms: durationMs, ai,
      n_field_edits: Object.values(fieldStats).reduce((n, s) => n + s.n_changes, 0),
      field_times_ms: Object.fromEntries(Object.entries(fieldStats).map(([f, s]) => [f, s.time_ms])),
      ai_accept_rate: suggested.length ? actions.filter((a) => a === 'accept').length / suggested.length : null,
      candidate_id: sug.candidate_id ?? null,
    };
    logger.log('listing_submit', 'btn_submit', listing);
    nav.push(doneScreen(listing, photos[0], screenId.replace('_form', '_done')));
  }

  const el = h('form', { class: 'module listing-form', onsubmit: submit, novalidate: true },
    h('h2', { class: 'form-title' }, '판매 게시물 등록'),
    h('label', { class: 'field-label' }, '사진', h('em', null, ' *')), photoRow,
    label('title', true), textInput('title', { placeholder: '상품 이름을 적어 주세요', maxLength: 60 }),
    label('category', true), chips(CATEGORIES, { value: values.category, name: 'category', onChange: (v) => change('category', v) }),
    label('series'), textInput('series', { placeholder: '예: 건담, 포켓몬스터' }),
    label('condition', true), chips(CONDITIONS, { value: values.condition, name: 'condition', onChange: (v) => change('condition', v) }),
    label('price', true),
    ai && sug.stats ? priceSummary(sug.stats) : null,
    ai && sug.price ? h('p', { class: 'hint' }, `추천 가격 ${won(sug.price)} · 같은 상품 게시물의 중간값이에요. 상태에 맞게 고쳐 주세요.`) : null,
    h('div', { class: 'field-row' }, priceInput, h('span', null, '원')),
    label('description'), textInput('description', { multiline: true, rows: 3, placeholder: '상태, 구성품, 거래 방법 등을 적어 주세요' }),
    label('tags'), tagsInput,
    h('button', { class: 'btn primary block', type: 'submit' }, '등록하기'));
  return { id: screenId, el, onShow, onDestroy: () => photos.forEach((p) => URL.revokeObjectURL(p.objectUrl)) };
}

// 등록 완료 화면 (C와 D 공통). 등록한 게시물은 이 세션에만 남는다
function doneScreen(listing, photo, screenId) {
  const el = h('div', { class: 'module done' },
    h('div', { class: 'done-mark' }, '✓'),
    h('h2', null, '등록이 완료됐어요'),
    h('div', { class: 'card done-card' },
      h('div', { class: 'card-img' }, h('img', { src: photo.objectUrl, alt: '' })),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-title' }, listing.title),
        h('div', { class: 'card-price' }, won(listing.price)),
        h('div', { class: 'card-meta' }, h('span', { class: 'cond' }, listing.condition), ` ${listing.category}`))),
    h('button', { class: 'btn primary block', type: 'button', onclick: () => task.completeListing(listing) }, '확인'));
  return { id: screenId, el, onBack: () => true };   // 등록한 뒤에는 폼으로 돌아가지 않는다
}

export const rootScreen = () => listingForm({ screenId: 'c_form' });

// 공통 유틸: DOM 생성, 형식 변환, 시간.

// h('div', { class: 'card', onclick: fn }, '텍스트', h('span', null, '자식'))
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;

// ISO 8601, 기기 시간대 오프셋과 밀리초 포함 (예: 2026-10-15T14:00:03.120+09:00)
export function isoNow(ms = Date.now()) {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const local = new Date(ms + offset * 60000).toISOString().slice(0, 23);
  return `${local}${offset >= 0 ? '+' : '-'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export const uid = (n = 4) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function daysAgo(dateStr, base = Date.now()) {
  const days = Math.max(0, Math.round((base - new Date(dateStr).getTime()) / 86400000));
  return days === 0 ? '오늘' : `${days}일 전`;
}

export function downloadBlob(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 검색 비교용 정규화: 소문자, 공백 제거
export const squash = (text) => (text || '').toLowerCase().replace(/\s+/g, '');

// 길게 누르기(기본 1초). 참여자가 실수로 열지 않게 연구자 전용 동작에 쓴다
export function onLongPress(el, fn, ms = 1000) {
  let timer = null;
  const cancel = () => { el.classList.remove('holding'); clearTimeout(timer); };
  el.addEventListener('pointerdown', () => {
    el.classList.add('holding');
    timer = setTimeout(() => { cancel(); fn(); }, ms);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(type, cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

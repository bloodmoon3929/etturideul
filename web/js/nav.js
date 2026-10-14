// 화면 스택. 하단 탭 바 없이, Task 프레임 안에서만 화면이 쌓이고 빠진다 (PLAN 9장, 13.3).
// 안드로이드 뒤로 가기는 이 스택의 이전 화면으로만 가고, 스택의 첫 화면에서는 아무 일도 하지 않는다.
//
// 화면 객체: { id, el, onShow?, onHide?, onDestroy?, onBack? }  (onBack이 true를 돌려주면 뒤로 가기를 화면이 처리한 것)
//
// 스택에 있는 화면은 DOM에 그대로 두고 맨 위 화면만 보이게 한다. 떼었다 붙이면 세션 리플레이(rrweb)가
// 그때마다 목록 전체를 다시 기록해 용량이 수십 배로 커진다.

import { logger } from './logger.js';

const SCROLL_LOG_INTERVAL_MS = 500;
const stack = [];
const overlays = [];   // 열려 있는 시트·대화상자 닫기 함수
let shownAt = 0;
let maxDepth = 0;
let scrollTimer = null;
let pendingDepth = null;

const host = () => document.getElementById('screen-host');

function depthPct(el) {
  const range = el.scrollHeight - el.clientHeight;
  return range <= 0 ? 100 : Math.round(((el.scrollTop) / range) * 100);
}

function onScroll(event) {
  const depth = depthPct(event.currentTarget);
  maxDepth = Math.max(maxDepth, depth);
  pendingDepth = depth;
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => {   // 500ms 간격으로 묶어서 기록
    scrollTimer = null;
    logger.log('scroll', null, { depth_pct: pendingDepth, max_depth_pct: maxDepth });
  }, SCROLL_LOG_INTERVAL_MS);
}

function mount(screen, direction, from) {
  screen.el.classList.add('screen');
  screen.el.dataset.anim = direction;
  screen.el.hidden = false;
  if (screen.el.parentNode !== host()) host().append(screen.el);
  screen.el.scrollTop = screen.scrollTop || 0;
  screen.el.addEventListener('scroll', onScroll, { passive: true });
  shownAt = Date.now();
  maxDepth = 0;
  logger.screen = screen.id;
  history.replaceState({ guard: true }, '', `#/${screen.id}`);
  logger.log('screen_view', null, { from: from ?? null });
  screen.onShow?.();
}

function unmount(screen) {
  screen.scrollTop = screen.el.scrollTop;
  screen.el.removeEventListener('scroll', onScroll);
  clearTimeout(scrollTimer);
  scrollTimer = null;
  logger.log('screen_leave', null, { dwell_ms: Date.now() - shownAt, max_depth_pct: maxDepth });
  screen.el.hidden = true;
  screen.onHide?.();
}

function destroy(screen) {
  screen.el.remove();
  screen.onDestroy?.();
}

export const nav = {
  top: () => stack[stack.length - 1] || null,
  depth: () => stack.length,

  push(screen) {
    const prev = this.top();
    if (prev) unmount(prev);
    stack.push(screen);
    mount(screen, 'forward', prev?.id);
    window.dispatchEvent(new CustomEvent('etturi:push'));
  },

  pop() {
    if (stack.length < 2) return;
    const leaving = stack.pop();
    unmount(leaving);
    destroy(leaving);
    mount(this.top(), 'back', leaving.id);
  },

  // 스택을 비우고 새 화면 하나로 시작한다 (Task 시작, 콘솔 복귀 등)
  reset(screen) {
    this.closeOverlays();
    document.getElementById('toast-host')?.replaceChildren();   // 앞 화면의 알림이 새 화면에 겹쳐 보이지 않게
    const prev = this.top();
    if (prev) unmount(prev);
    while (stack.length) destroy(stack.pop());
    host().replaceChildren();
    stack.push(screen);
    mount(screen, 'fade', prev?.id);
  },

  // 뒤로 가기. 처리했으면 true. via: 'system'(안드로이드 뒤로 가기) / 'button'(화면의 ← 버튼)
  back(via = 'system') {
    if (overlays.length) {
      overlays[overlays.length - 1]();
      return true;
    }
    const top = this.top();
    if (top?.onBack?.()) return true;
    if (stack.length > 1) {
      logger.log('back', via === 'button' ? 'btn_back' : null, { from: top.id, to: stack[stack.length - 2].id, via });
      this.pop();
      return true;
    }
    return false;
  },

  addOverlay(close) {
    overlays.push(close);
    return () => {
      const i = overlays.indexOf(close);
      if (i >= 0) overlays.splice(i, 1);
    };
  },

  closeOverlays() {
    while (overlays.length) overlays[overlays.length - 1]();
  },
};

export function initBackGuard() {
  history.pushState({ guard: true }, '');
  window.addEventListener('popstate', () => {
    history.pushState({ guard: true }, '', location.hash);
    nav.back();
  });
}

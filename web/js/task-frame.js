// Task 프레임 (PLAN 9.1). Task 하나 = 화면 묶음 하나 = 로그 구간 하나.
//   위: Task 번호·안내문(접기 가능)   아래: [건너뛰기] [완료]
// Task 사이에는 연구자 콘솔을 거치지 않고 "다음 Task" 안내 화면(taskIntroScreen)으로 이어진다.
// 모듈(A~E)은 여기서 열리고, 정답·찜 같은 Task 상태는 task 객체가 갖는다.

import { db } from './data.js';
import { logger } from './logger.js';
import { nav } from './nav.js';
import { h, won, formatDuration, squash, onLongPress } from './util.js';
import { sheet, toast, confirmDialog, postCard } from './ui.js';
import { url } from './config.js';

const MODULES = {
  A: () => import('./mod-a-search.js'),
  P: () => import('./mod-a-search.js').then((m) => ({ rootScreen: m.photoRootScreen })),
  R: () => import('./mod-r-recommend.js'),
  B: () => import('./mod-b-ai-search.js'),
  C: () => import('./mod-c-listing.js'),
  D: () => import('./mod-d-ai-listing.js'),
  E: () => import('./graph.js'),
};
// 인터뷰에서 쓰는 화면은 A, P, R이다. 나머지(B~E)는 코드만 남아 있다(콘솔에서 열 수 없음)
export const MODULE_NAMES = {
  A: '원래 방식 검색', P: '사진 검색 (제안 방식)', R: '비슷한 굿즈 추천',
  B: 'AI 글·사진 검색', C: '기존 방식 판매 등록', D: 'AI 판매 등록', E: '3D 취향 지도',
};
const CONDITION_LABEL = { classic: '원래 방식', ai: '제안 방식' };
const LIKE_TYPES = new Set(['find_series', 'explore', 'recommend']);   // 찜으로 답하는 Task

export const task = {
  run: null,          // Task 실행 기록 (logger.session.task_runs의 한 항목). 데모면 임시 객체
  def: null,          // Task 정의 (protocol.tasks[...])
  target: null,       // Task 대상 (protocol.targets[세트][Task])
  demo: false,
  moduleId: null,
  answerPostId: null,
  likes: new Set(),
  onEnd: null,
  timer: null,

  get type() { return this.def?.type ?? null; },
  wantsAnswer() { return this.type === 'find_same' || this.type === 'find_named'; },
  wantsLikes() { return LIKE_TYPES.has(this.type) || this.demo; },

  // 이 게시물이 Task의 정답인가. Task와 무관하면 null (기록 시점에 계산해 로그에 넣는다, PLAN 14.6.2)
  isTarget(post) {
    const t = this.target;
    if (!t || !post) return null;
    if (this.type === 'find_series') return post.series === t.series && post.id !== t.seed_post;
    if (t.product_key) return post.product_key === t.product_key;
    return null;
  },

  // 결과 목록에서 정답이 처음 나오는 순위 (없으면 null)
  targetRank(items) {
    if (!this.target) return null;
    const i = items.findIndex((it) => this.isTarget(it.post ?? it));
    return i < 0 ? null : i + 1;
  },

  trueMinPrice() {
    const prices = db.posts.filter((p) => p.product_key === this.target?.product_key).map((p) => p.price);
    return prices.length ? Math.min(...prices) : null;
  },

  submitAnswer(post, ctx = {}) {
    this.answerPostId = post.id;
    logger.log('answer_submit', 'btn_answer', { post_id: post.id, is_correct: this.isTarget(post), from_screen: ctx.from ?? null, rank: ctx.rank ?? null });
    toast('이 상품으로 골랐어요. 아래 [완료]를 눌러 주세요');
    renderBottom();
  },

  toggleLike(post, ctx = {}) {
    const adding = !this.likes.has(post.id);
    if (adding) this.likes.add(post.id);
    else this.likes.delete(post.id);
    logger.log(adding ? 'like_add' : 'like_remove', 'btn_like', {
      post_id: post.id, is_target: this.isTarget(post), n_likes: this.likes.size, from_screen: ctx.from ?? logger.screen,
      chain_depth: ctx.chain_depth ?? null,
    });
    renderBottom();
  },

  // 등록 Task는 [등록하기]가 곧 완료다. listing: 폼의 최종 값
  completeListing(listing) {
    const t = this.target || {};
    const same = db.posts.filter((p) => p.product_key === t.product_key);
    const prices = same.map((p) => p.price);
    const answer = {
      listing,
      category_correct: same.length ? listing.category === same[0].category : null,
      series_correct: same.length ? squash(listing.series) === squash(same[0].series) : null,
      price_in_range: prices.length && listing.price != null ? listing.price >= Math.min(...prices) && listing.price <= Math.max(...prices) : null,
      market: prices.length ? { min: Math.min(...prices), max: Math.max(...prices), avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) } : null,
    };
    return finish('done', answer);
  },
};

// ── 프레임 화면 요소 ──────────────────────────────────────────────────
const top = () => document.getElementById('frame-top');
const bottom = () => document.getElementById('frame-bottom');
let instructionOpen = true;

// Task 안내문. AI 조건에서만 덧붙일 문장(instruction_ai)이 있으면 뒤에 붙인다
function instructionFor(def, target, condition) {
  const base = (def.instruction || '').replace('{product_name}', target?.product_name ?? '');
  return condition === 'ai' && def.instruction_ai ? `${base} ${def.instruction_ai}` : base;
}

// 안내문 아래에 보여 줄 Task 대상: 대상 사진 또는 기준 게시물
function targetPreview(def, target) {
  return [
    def.show_card_image && target?.card_image ? h('img', { class: 'task-card-img', src: url(target.card_image), alt: '찾을 굿즈 사진' }) : null,
    def.show_seed_post && target?.seed_post && db.byId.get(target.seed_post)
      ? h('div', { class: 'task-seed' }, postCard({ post: db.byId.get(target.seed_post) })) : null,
  ];
}

// "다음 Task" 안내 화면. 참여자가 안내문을 읽고 [시작]을 누르면 Task가 열리고, 그때부터 Task 시간을 잰다.
// Task 번호를 1초 이상 누르면 연구자 콘솔이 열린다(중단·메모용, 참여자에게는 알리지 않는다)
export function taskIntroScreen(run, { onStart, onResearcher }) {
  const def = db.protocol.tasks[run.task_id];
  const target = run.set ? db.protocol.targets[run.set]?.[run.task_id] : null;
  const number = h('span', { class: 'task-no intro-no' }, `Task ${run.order_index} / ${logger.session.task_runs.length}`);
  onLongPress(number, onResearcher);
  let started = false;
  const el = h('div', { class: 'module task-intro' },
    h('div', { class: 'task-title' }, number,
      run.condition ? h('span', { class: `cond-chip ${run.condition}` }, CONDITION_LABEL[run.condition]) : null),
    h('h2', null, def.name),
    h('p', { class: 'intro-text' }, instructionFor(def, target, run.condition)),
    targetPreview(def, target),
    h('button', { class: 'btn primary block big', type: 'button', onclick: () => {
      if (started) return;
      started = true;
      onStart();
    } }, '시작'));
  const onShow = () => logger.log('task_intro', null, {
    task_run_id: run.task_run_id, task_id: run.task_id, condition: run.condition, order_index: run.order_index,
  });
  return { id: 'task_intro', el, onShow, onBack: () => true };
}

function renderTop() {
  const { def, run, target } = task;
  const total = logger.session?.task_runs.length;
  const body = h('div', { class: 'task-instruction', hidden: !instructionOpen || !def.instruction },
    h('p', null, instructionFor(def, target, run.condition)),
    targetPreview(def, target));
  top().replaceChildren(
    h('div', { class: 'task-bar' },
      h('div', { class: 'task-title' },
        h('span', { class: 'task-no' }, task.demo ? '데모' : `Task ${run.order_index}${total ? `/${total}` : ''}`),
        h('strong', null, def.name),
        !task.demo && run.condition ? h('span', { class: `cond-chip ${run.condition}` }, CONDITION_LABEL[run.condition]) : null),
      def.instruction ? h('button', {
        class: 'link-btn', type: 'button',
        onclick: () => {
          instructionOpen = !instructionOpen;
          logger.log('instruction_toggle', 'btn_instruction', { open: instructionOpen });
          renderTop();
        },
      }, instructionOpen ? '안내 접기' : '안내 보기') : null),
    body);
  top().hidden = false;
}

// 첫 화면에서 다른 화면으로 들어가면 안내문을 한 번 접어 화면을 넓게 쓴다. [안내 보기]로 다시 펼 수 있다
let autoCollapsed = false;
window.addEventListener('etturi:push', () => {
  if (!task.run || autoCollapsed || !instructionOpen || !task.def?.instruction) return;
  autoCollapsed = true;
  instructionOpen = false;
  logger.log('instruction_toggle', null, { open: false, auto: true });
  renderTop();
});

function statusText() {
  const { def } = task;
  if (LIKE_TYPES.has(task.type)) return def.n_likes ? `찜 ${task.likes.size}/${def.n_likes}` : `찜 ${task.likes.size}개`;
  if (task.wantsAnswer()) return task.answerPostId ? '상품을 골랐어요' : '아직 고르지 않았어요';
  return '';
}

function renderBottom() {
  if (!task.run) return;
  if (task.demo) {
    bottom().replaceChildren(h('button', { class: 'btn', type: 'button', onclick: () => finish('done', null) }, '데모 닫기'));
  } else {
    // 등록 Task는 폼의 [등록하기]가 완료 역할을 하므로 [완료] 버튼을 두지 않는다
    const doneBtn = task.type === 'listing' ? [] : [h('button', { class: 'btn primary', type: 'button', onclick: done }, '완료')];
    bottom().replaceChildren(
      h('button', { class: 'btn ghost', type: 'button', onclick: skip }, '건너뛰기'),
      h('span', { class: 'task-status', id: 'task-status' }, statusText(), task.timer ? h('b', { id: 'task-timer' }) : null),
      ...doneBtn);
    updateTimer();
  }
  bottom().hidden = false;
}

function updateTimer() {
  const el = document.getElementById('task-timer');
  if (!el || !task.timer) return;
  const left = task.timer.limitMs - (Date.now() - task.timer.startedMs);
  el.textContent = ` · ${left > 0 ? `남은 시간 ${formatDuration(left)}` : '시간 종료'}`;
  if (left <= 0 && !task.timer.notified) {
    task.timer.notified = true;
    logger.log('time_limit_reached', null, { limit_s: task.timer.limitMs / 1000 });
    toast('시간이 다 됐어요. 마음에 드는 굿즈를 찜하고 [완료]를 눌러 주세요', 4000);
  }
}

function hideFrame() {
  top().hidden = true;
  bottom().hidden = true;
  top().replaceChildren();
  bottom().replaceChildren();
}

// ── 시작과 종료 ───────────────────────────────────────────────────────
export async function startTask(run, { demo = false, onEnd = null, resumed = false } = {}) {
  const protocol = db.protocol;
  const def = demo ? run.def : protocol.tasks[run.task_id];
  Object.assign(task, {
    run, def, demo, onEnd,
    target: demo ? null : (run.set ? protocol.targets[run.set]?.[run.task_id] : null) || null,
    moduleId: demo ? run.moduleId : def.modules[run.condition],
    answerPostId: null, likes: new Set(), timer: null,
  });
  instructionOpen = true;
  autoCollapsed = false;
  if (!demo && !resumed) await logger.beginRun(run);
  if (def.time_limit_s) {
    task.timer = { limitMs: def.time_limit_s * 1000, startedMs: run.started_ms ?? Date.now(), notified: false };
    task.timer.interval = setInterval(updateTimer, 1000);
  }
  renderTop();
  renderBottom();
  const mod = await MODULES[task.moduleId]();
  nav.reset(mod.rootScreen());
}

async function done() {
  const { def } = task;
  if (task.wantsAnswer()) {
    if (!task.answerPostId) return toast('먼저 게시물을 열고 [이 상품이에요]를 눌러 주세요');
    const post = db.byId.get(task.answerPostId);
    const answer = { post_id: post.id, is_correct: task.isTarget(post) };
    if (def.ask_min_price) Object.assign(answer, await askMinPrice());
    return finish('done', answer);
  }
  if (LIKE_TYPES.has(task.type)) {
    if (task.likes.size < (def.n_likes ?? 0)) return toast(`굿즈를 ${def.n_likes}개 찜해 주세요 (지금 ${task.likes.size}개)`);
    return finish('done', likeAnswer());
  }
  return finish('done', null);
}

function likeAnswer() {
  const liked = [...task.likes];
  const answer = { liked };
  if (task.type === 'find_series') answer.n_series_match = liked.filter((id) => task.isTarget(db.byId.get(id))).length;
  return answer;
}

// "가장 싸게 올라온 가격"을 묻는다. 답은 price_answer로 기록
function askMinPrice() {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type: 'number', inputmode: 'numeric', placeholder: '예: 35000', min: 0, step: 1000 });
    const submit = (price) => {
      const trueMin = task.trueMinPrice();
      const result = { price, true_min_price: trueMin, price_correct: price != null && trueMin != null ? price === trueMin : null };
      logger.log('price_answer', 'price_input', result);
      s.close();
      resolve(result);
    };
    const s = sheet({
      title: '가장 낮은 가격',
      dismissable: false,
      content: [
        h('p', { class: 'sheet-text' }, '방금 고른 상품이 가장 싸게 올라온 가격은 얼마였나요?'),
        h('div', { class: 'field-row' }, input, h('span', null, '원')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => submit(null) }, '모르겠어요'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => {
            if (input.value === '') return toast('가격을 적어 주세요');
            submit(Number(input.value));
          } }, '확인')),
      ],
    });
    input.focus();
  });
}

// [건너뛰기]: 그때까지 고른 답이 있으면 함께 남기고 다음 Task로 넘어간다
async function skip() {
  if (!(await confirmDialog('이 Task를 건너뛸까요?', { ok: '건너뛰기', cancel: '계속하기' }))) return;
  const partial = task.wantsAnswer()
    ? (task.answerPostId ? { post_id: task.answerPostId, is_correct: task.isTarget(db.byId.get(task.answerPostId)) } : null)
    : (task.likes.size ? likeAnswer() : null);
  finish('skipped', partial, { by: 'participant' });
}

async function finish(outcome, answer, extra = {}) {
  const { run, def, demo, onEnd } = task;
  if (!run) return;
  clearInterval(task.timer?.interval);
  nav.closeOverlays();
  hideFrame();
  if (!demo) await logger.endRun(outcome, answer, extra);
  Object.assign(task, { run: null, def: null, target: null, timer: null, onEnd: null, demo: false });
  onEnd?.({ run, def, outcome, answer });
}

// 연구자가 콘솔에서 강제로 끝낼 때 (참여자가 멈춰 있는 경우 등)
export const forceFinish = (outcome) => finish(outcome, null);

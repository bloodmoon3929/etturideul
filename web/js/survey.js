// 동의·설문 화면 (PLAN 14.1, 14.4). 모두 앱 안에서 받는다. 이름·연락처는 받지 않는다.
// 문항 문구는 초안이다. 확정되면 아래 상수만 고치면 된다.

import { CONSENT_DEFAULTS, SERVICE_NAME, SURVEYS, PHOTO_SOURCE } from './config.js';
import { db } from './data.js';
import { logger } from './logger.js';
import { h, onLongPress } from './util.js';
import { chips, toast } from './ui.js';

const PRE_QUESTIONS = [
  { q: 'market_freq', label: '중고거래 앱을 얼마나 자주 쓰시나요?', options: ['거의 매일', '주 1회 이상', '월 1회 이상', '거의 안 씀'] },
  { q: 'goods_exp', label: '키덜트 굿즈(피규어, 프라모델, 인형 등)를 사거나 판 적이 있나요?', options: ['사 본 적만 있음', '팔아 본 적만 있음', '둘 다 있음', '없음'] },
  { q: 'search_method', label: '굿즈를 찾을 때 주로 어떻게 검색하시나요?', text: true, placeholder: '예: 작품 이름 + 캐릭터 이름으로 검색' },
];

const SEQ = { q: 'SEQ', label: '전반적으로 이 Task는 얼마나 쉬웠나요?', scale: 7, low: '매우 어려웠다', high: '매우 쉬웠다' };
const CONFIDENCE = { q: 'confidence', label: '방금 한 답(또는 등록 내용)에 얼마나 확신하나요?', scale: 5, low: '전혀 확신 없음', high: '매우 확신' };

const CONDITION_NAMES = { classic: '기존 방식 (키워드 검색 · 직접 입력)', ai: 'AI 방식 (사진·글 검색 · 자동 채움)' };
const UMUX = [
  { key: '1', label: '이 방식의 기능은 내가 필요로 하는 것을 충족한다.' },
  { key: '2', label: '이 방식은 사용하기 쉽다.' },
];
const PREFERENCE = [['classic', '기존 방식'], ['ai', 'AI 방식'], ['none', '차이 없음']];
// 네 가지 UI 중 고르기: 찾기는 A·B, 등록은 C·D에서 하나씩 고른다 (기록 값은 classic / ai)
const UI_CHOICE = {
  pref_find: { label: '굿즈를 찾을 때', options: [['classic', '원래 방식 (목록·검색)'], ['ai', '사진 검색 (제안 방식)']] },
  pref_listing: { label: '판매 게시물을 등록할 때', options: [['classic', '기존 방식 등록 (직접 입력)'], ['ai', 'AI 등록 (사진으로 자동 채움)']] },
};

// 1~n 점 척도
function likert({ label, scale, low, high }, onChange) {
  let value = null;
  const row = h('div', { class: 'likert', role: 'radiogroup', 'aria-label': label });
  const render = () => row.replaceChildren(...Array.from({ length: scale }, (_, i) =>
    h('button', {
      type: 'button', class: `likert-btn ${value === i + 1 ? 'on' : ''}`, role: 'radio', 'aria-checked': String(value === i + 1),
      onclick: () => { value = i + 1; render(); onChange(value); },
    }, String(i + 1))));
  render();
  return h('div', { class: 'question' },
    h('p', { class: 'question-label' }, label), row,
    h('div', { class: 'likert-ends' }, h('span', null, low), h('span', null, high)));
}

function question(label, control) {
  return h('div', { class: 'question' }, h('p', { class: 'question-label' }, label), control);
}

const textArea = (placeholder = '') => h('textarea', { class: 'input', rows: 3, placeholder });

// ── 동의 ──────────────────────────────────────────────────────────────
export function consentScreen(onDone) {
  const replay = h('input', { type: 'checkbox', checked: CONSENT_DEFAULTS.replay });
  const photos = h('input', { type: 'checkbox', checked: CONSENT_DEFAULTS.photos });
  const behavior = h('input', { type: 'checkbox', checked: false });
  const askPhotos = PHOTO_SOURCE !== 'virtual';
  const el = h('div', { class: 'module form-screen' },
    h('h2', null, `${SERVICE_NAME} 사용성 조사 참여 동의`),
    h('p', { class: 'hint' }, '대학 수업 과제를 위한 조사입니다. 이름과 연락처는 받지 않으며, 기록은 참여자 번호로만 구분합니다. 원하시면 언제든 그만둘 수 있습니다.'),
    h('label', { class: 'check' }, behavior, h('span', null, h('b', null, '(필수) 앱 사용 행동 기록'), h('small', null, '어떤 화면을 보고 무엇을 눌렀는지, 검색어와 설문 응답을 기록합니다.'))),
    h('label', { class: 'check' }, replay, h('span', null, h('b', null, '(선택) 화면 기록'), h('small', null, '앱 화면의 움직임을 다시 볼 수 있게 기록합니다. 얼굴이나 목소리는 기록하지 않습니다.'))),
    // 가상 갤러리만 쓰면 참여자의 사진을 받지 않으므로 사진 저장 동의를 묻지 않는다
    askPhotos ? h('label', { class: 'check' }, photos, h('span', null, h('b', null, '(선택) 사진 저장'), h('small', null, '검색·등록에 쓴 사진을 이 휴대폰에만 저장합니다.'))) : null,
    h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
      if (!behavior.checked) return toast('필수 항목에 동의해야 참여할 수 있어요');
      await logger.setConsent({ behavior: true, replay: replay.checked, photos: askPhotos && photos.checked });
      onDone();
    } }, '동의하고 시작하기'));
  return { id: 'consent', el };
}

// ── 사전 질문 ─────────────────────────────────────────────────────────
export function preSurveyScreen(onDone) {
  const answers = {};
  const fields = PRE_QUESTIONS.map((item) => {
    if (item.text) {
      const area = textArea(item.placeholder);
      area.onchange = () => { answers[item.q] = area.value.trim(); };
      return question(item.label, area);
    }
    return question(item.label, chips(item.options, { name: item.q, onChange: (v) => { answers[item.q] = v; } }));
  });
  const el = h('div', { class: 'module form-screen' },
    h('h2', null, '시작 전에 몇 가지만 여쭤볼게요'), fields,
    h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
      document.activeElement?.blur();
      const missing = PRE_QUESTIONS.filter((item) => !item.text && !answers[item.q]);
      if (missing.length) return toast('선택 문항에 모두 답해 주세요');
      for (const item of PRE_QUESTIONS) await logger.addSurvey('pre', item.q, answers[item.q] ?? '');
      onDone();
    } }, '다음'));
  return { id: 'pre_survey', el };
}

// ── Task 후 설문: SEQ, 확신, 기타 의견 ────────────────────────────────
export function postTaskSurveyScreen(run, def, onDone) {
  const answers = {};
  const comment = textArea('불편했던 점, 좋았던 점 등 자유롭게 적어 주세요 (선택)');
  const el = h('div', { class: 'module form-screen' },
    h('h2', null, `'${def.name}' Task는 어떠셨나요?`),
    likert(SEQ, (v) => { answers.SEQ = v; }),
    likert(CONFIDENCE, (v) => { answers.confidence = v; }),
    question('기타 의견', comment),
    h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
      if (!answers.SEQ || !answers.confidence) return toast('두 문항에 모두 답해 주세요');
      await logger.addSurvey('task', 'SEQ', answers.SEQ, run.task_run_id);
      await logger.addSurvey('task', 'confidence', answers.confidence, run.task_run_id);
      await logger.addSurvey('task', 'comment', comment.value.trim(), run.task_run_id);
      onDone();
    } }, '다음'));
  return { id: 'post_task_survey', el };
}

// ── 세션 마지막 질문 ──────────────────────────────────────────────────
// 기본은 네 가지 UI 중 어느 쪽을 고를지만 묻는다. SURVEYS.finalDetail을 켜면 UMUX-Lite와 주관식이 함께 나온다
export function finalSurveyScreen(onDone) {
  const answers = {};
  const detail = SURVEYS.finalDetail;
  const reason = textArea('그렇게 고른 이유를 적어 주세요');
  const improve = textArea('바뀌었으면 하는 점이 있다면 적어 주세요 (선택)');
  const umux = Object.entries(CONDITION_NAMES).flatMap(([cond, name]) => [
    h('h3', { class: 'section-title' }, name),
    ...UMUX.map((item) => likert({ label: item.label, scale: 7, low: '전혀 그렇지 않다', high: '매우 그렇다' },
      (v) => { answers[`umux_${cond}_${item.key}`] = v; })),
  ]);
  const asked = db.protocol.final_questions ?? Object.keys(UI_CHOICE);   // 프로토콜에 적힌 선택 질문만 묻는다
  const choices = asked.map((q) => question(UI_CHOICE[q].label,
    chips(detail ? PREFERENCE : UI_CHOICE[q].options, { name: q, onChange: (v) => { answers[q] = v; } })));
  const required = [...(detail ? ['umux_classic_1', 'umux_classic_2', 'umux_ai_1', 'umux_ai_2'] : []), ...asked];
  const el = h('div', { class: 'module form-screen' },
    h('h2', null, detail ? '두 방식을 비교해 주세요' : '앞으로 쓴다면 어느 쪽을 고르시겠어요?'),
    detail ? umux : null,
    detail ? h('h3', { class: 'section-title' }, '어느 쪽이 더 좋았나요?') : null,
    choices,
    detail ? [question('이유', reason), question('개선 의견', improve)] : null,
    h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
      document.activeElement?.blur();
      if (required.some((q) => answers[q] == null)) return toast(detail ? '선택 문항에 모두 답해 주세요' : '하나를 골라 주세요');
      for (const q of required) await logger.addSurvey('session', q, answers[q]);
      if (detail) {
        await logger.addSurvey('session', 'pref_reason', reason.value.trim());
        await logger.addSurvey('session', 'improve', improve.value.trim());
      }
      onDone();
    } }, '제출'));
  return { id: 'final_survey', el };
}

// ── 휴대폰 돌려주기 ───────────────────────────────────────────────────
// 참여자가 콘솔로 넘어가지 못하게, 연구자가 버튼을 1초 이상 눌러야 열린다
export function handBackScreen(message, onUnlock) {
  const button = h('button', { class: 'btn ghost hold-btn', type: 'button' }, '연구자 전용 · 길게 눌러 열기');
  onLongPress(button, onUnlock);
  const el = h('div', { class: 'module center-col handback' },
    h('div', { class: 'done-mark' }, '✓'),
    h('h2', null, message),
    h('p', { class: 'hint center' }, '휴대폰을 연구자에게 건네주세요.'),
    button);
  return { id: 'hand_back', el };
}

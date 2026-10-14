// 연구자 콘솔: 오프라인 준비, 세션 시작, 세션 종료·저장.
// 참여자가 폰을 받은 뒤에는 콘솔을 거치지 않는다. 동의 → Task 안내 → Task → … → 마지막 질문까지 이어지고(advance),
// 모두 끝난 뒤 "휴대폰 돌려주기" 화면에서만 여기로 돌아온다. 중간에 열어야 하면 Task 안내 화면의 Task 번호를 길게 누른다.

import { APP_VERSION, SERVICE_NAME, PRESETS, UPLOAD_BACKEND, SURVEYS, url, MODEL_IDS } from './config.js';
import { db, settings, saveSettings, thumbUrl } from './data.js';
import { logger } from './logger.js';
import { ml } from './ml.js';
import { nav } from './nav.js';
import { kv, sessions, photos, deleteSession, events } from './store.js';
import { startTask, taskIntroScreen, MODULE_NAMES } from './task-frame.js';
import { consentScreen, preSurveyScreen, postTaskSurveyScreen, finalSurveyScreen, handBackScreen } from './survey.js';
import { uploadSession, exportSessionJson, exportPhotosZip } from './uploader.js';
import { startReplay, stopReplay } from './replay.js';
import { h, formatDuration, onLongPress } from './util.js';
import { toast, confirmDialog, screenHeader } from './ui.js';

const CONDITION_LABEL = { classic: '원래 방식', ai: '제안 방식' };
const STATUS_LABEL = { pending: '대기', running: '진행 중', done: '완료', give_up: '포기', skipped: '건너뜀' };
let wakeLock = null;

// ── 화면 꺼짐 방지 (세션 중) ──────────────────────────────────────────
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 지원하지 않거나 거부되면 무시 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && logger.active) keepAwake();
});

// ── 순서 배정 (PLAN 14.3, 2×2 라틴 방격) ──────────────────────────────
const participantNo = (p) => Number(String(p).replace(/\D/g, '')) || 1;
const autoGroup = (p) => ((participantNo(p) - 1) % 4) + 1;

// 참여자의 Task 실행 목록. 조건 블록(기존/AI) 안에서 Task를 순서대로 하고, 마지막에 공통 Task를 한다
export function buildPlan(participant, orderGroup) {
  const { order_groups: groups, sequence, targets } = db.protocol;
  const og = groups?.[orderGroup];
  const runs = [];
  const add = (taskId, condition, set) => runs.push({
    task_run_id: `${participant}-${String(runs.length + 1).padStart(2, '0')}`, task_id: taskId, condition,
    order_index: runs.length + 1, set, target_id: set ? targets[set]?.[taskId]?.target_id ?? null : null, status: 'pending',
  });
  if (sequence.runs) {   // 순서가 고정된 프로토콜: 참여자 번호와 관계없이 적힌 순서대로 진행한다
    sequence.runs.forEach((r) => add(r.task, r.condition ?? null, r.set ?? null));
    return runs;
  }
  og.conditions.forEach((condition, block) => sequence.paired.forEach((taskId) => add(taskId, condition, og.sets[block])));
  (sequence.after || []).forEach((taskId) => add(taskId, 'ai', null));
  return runs;
}

// ── 세션 흐름 ─────────────────────────────────────────────────────────
export function showConsole() {
  nav.reset(consoleScreen());
}

async function startSession({ participant, orderGroup, locationNote }) {
  const session = await logger.start({
    participant, order_group: orderGroup, location_note: locationNote,
    plan: buildPlan(participant, orderGroup), protocol_version: db.protocol.version, backend: ml.backendLabel(),
  });
  if (orderGroup != null && orderGroup !== autoGroup(participant)) logger.log('order_group_override', null, { auto: autoGroup(participant), chosen: orderGroup });
  for (const which of ['text', 'vision']) {
    const m = ml.models[which];
    if (m) logger.log('model_ready', which, { which, backend: `${m.device}/${m.dtype}`, load_ms: m.load_ms, fallback: m.fallback });
  }
  await kv.set('last_participant_no', participantNo(participant));
  keepAwake();
  showConsent(session);
}

// 동의 → (켜져 있으면) 사전 질문 → 첫 Task 안내
function showConsent(session) {
  nav.reset(consentScreen(async () => {
    if (session.consent.replay) startReplay(session.session_id).catch((err) => logger.log('error', 'replay', { message: String(err.message || err) }));
    const toTasks = async () => {
      session.step = 'tasks';
      await logger.save();
      advance();
    };
    if (SURVEYS.pre) nav.reset(preSurveyScreen(toTasks));
    else await toTasks();
  }));
}

// 참여자 흐름의 다음 화면으로 보낸다: 남은 Task의 안내 → (모두 끝나면) 마지막 질문 → 휴대폰 돌려주기
function advance() {
  const s = logger.session;
  const next = s.task_runs.find((r) => r.status === 'pending');
  if (next) {
    nav.reset(taskIntroScreen(next, { onStart: () => startTask(next, { onEnd: afterTask(next) }), onResearcher: showConsole }));
  } else if (!s.surveys.some((x) => x.scope === 'session')) {
    nav.reset(finalSurveyScreen(advance));
  } else {
    nav.reset(handBackScreen('모든 과정이 끝났습니다. 감사합니다!', showConsole));
  }
}

// Task가 끝난 뒤: (켜져 있으면) Task 후 설문을 거쳐 바로 다음으로 넘어간다
const afterTask = (run) => ({ def }) => {
  if (SURVEYS.postTask) nav.reset(postTaskSurveyScreen(run, def, advance));
  else advance();
};

// 남아 있는 세션을 지금의 Task 구성으로 이어 갈 수 있는가.
// Task 정의(protocol)가 바뀌면 예전 구성으로 만든 세션은 이어 갈 수 없다
export const sessionUsable = (session) => session.task_runs.every((r) => db.protocol.tasks[r.task_id]);

// 이어 갈 수 없는 세션을 닫는다. 기록은 지우지 않고 "저장 대기"로 옮긴다
export async function closeStaleSession(session) {
  logger.log('error', null, { message: 'protocol_changed', session_protocol: session.protocol_version, current_protocol: db.protocol.version });
  stopReplay();
  await logger.end();
}

// 진행 중인 세션을 이어 간다: 하던 Task가 있으면 그 Task의 첫 화면부터, 동의 전이면 동의 화면부터, 아니면 다음 Task 안내부터
function continueSession() {
  const s = logger.session;
  keepAwake();
  const running = s.task_runs.find((r) => r.status === 'running');
  if (running) startTask(running, { resumed: true, onEnd: afterTask(running) });
  else if (s.step === 'consent' || s.step === 'pre') showConsent(s);
  else advance();
}

// 앱을 열었는데 끝나지 않은 세션이 남아 있을 때. 곧바로 이어 가지 않고 먼저 묻는다:
// 인터뷰 중에 탭이 다시 열린 것이면 참여자가 [이어서 진행]을 누르고,
// 지난 세션이 남아 있는 것이면 연구자가 길게 눌러 콘솔로 가서 그 세션을 종료하고 새로 시작한다
export function showResumePrompt(session) {
  if (session.consent?.replay) startReplay(session.session_id).catch(() => {});
  const finished = session.task_runs.filter((r) => r.status === 'done' || r.status === 'skipped').length;
  const hold = h('button', { class: 'btn ghost hold-btn', type: 'button' }, '연구자 전용 · 길게 눌러 콘솔 열기');
  onLongPress(hold, showConsole);
  const el = h('div', { class: 'module center-col' },
    h('h2', null, '진행하던 세션이 있습니다'),
    h('p', { class: 'hint center' }, `${session.participant} · Task ${session.task_runs.length}개 중 ${finished}개 끝남 · ${session.started_at.slice(0, 16).replace('T', ' ')} 시작`),
    h('button', { class: 'btn primary big', type: 'button', onclick: continueSession }, '이어서 진행'),
    hold);
  nav.reset({ id: 'resume_prompt', el, onBack: () => true });
}

async function endSession(render) {
  if (!(await confirmDialog('세션을 종료할까요? 종료하면 이 참여자의 기록을 더 남길 수 없습니다.', { ok: '세션 종료', danger: true }))) return;
  stopReplay();
  const id = await logger.end();
  wakeLock?.release?.();
  const result = await uploadSession(id);
  if (result.ok) {
    await deleteSession(id);
    toast(`업로드 완료 (이벤트 ${result.n_events}건)`);
  } else {
    toast(UPLOAD_BACKEND === 'none' ? '세션을 종료했어요. [JSON 파일로 저장]으로 꺼내 주세요' : '업로드에 실패해 대기 상태로 두었어요', 4000);
  }
  render();
}

// ── 오프라인 준비 상태 (PLAN 13.5) ────────────────────────────────────
async function isCached(path) {
  return !!(await caches.match(url(path), { ignoreSearch: true }));
}

async function modelCached(which) {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(`/${MODEL_IDS[which]}/`) && req.url.endsWith('.onnx'));
  } catch {
    return false;
  }
}

async function readiness() {
  const m = db.manifest || { data: [], thumbs: [], shell: [] };
  const count = async (list) => (await Promise.all(list.map(isCached))).filter(Boolean).length;
  const [shell, data, thumbs, text, vision, persisted] = await Promise.all([
    count(m.shell || []), count(m.data), count(m.thumbs), modelCached('text'), modelCached('vision'),
    navigator.storage?.persisted?.() ?? false,
  ]);
  return [
    { label: '앱 파일', ok: shell === (m.shell || []).length, detail: `${shell}/${(m.shell || []).length}` },
    { label: '데이터', ok: data === m.data.length, detail: `${data}/${m.data.length}` },
    { label: '썸네일', ok: thumbs === m.thumbs.length, detail: `${thumbs}/${m.thumbs.length}` },
    { label: '텍스트 모델', ok: text && ml.isReady('text'), detail: ml.isReady('text') ? '로드됨' : text ? '캐시됨' : '없음' },
    { label: '이미지 모델', ok: vision && ml.isReady('vision'), detail: ml.isReady('vision') ? '로드됨' : vision ? '캐시됨' : '없음' },
    { label: '저장 공간 보호', ok: persisted, detail: persisted ? '적용됨' : '미적용(브라우저가 지울 수 있음)' },
  ];
}

// 필요한 파일을 전부 미리 받아 캐시에 넣는다. 전날 Wi-Fi에서 한 번 실행해 둔다
async function prepareOffline(onProgress) {
  const m = db.manifest || { data: [], thumbs: [], shell: [] };
  const files = ['./', 'data/manifest.json', ...(m.shell || []), ...m.data, ...m.thumbs];
  let done = 0;
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(files.slice(i, i + 8).map((path) => fetch(url(path)).catch(() => null)));
    done = Math.min(files.length, i + 8);
    onProgress(`파일 받는 중 ${done}/${files.length}`);
  }
  onProgress('모델 준비 중');
  await ml.load('text');
  await ml.load('vision');
  await navigator.storage?.persist?.();
}

// ── 이미지 출처 (PLAN 4.3.2) ──────────────────────────────────────────
function sourcesScreen() {
  const link = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);
  const el = h('div', { class: 'module' },
    screenHeader('이미지 출처'),
    h('p', { class: 'hint' }, '게시물 사진은 CC 라이선스 이미지이며, 크기를 줄여 사용했습니다. 게시물의 제목·설명·가격은 모두 가상입니다.'),
    h('div', { class: 'source-list' }, db.posts.map((post) => {
      const s = db.sources.get(post.image_source_id);
      return h('div', { class: 'source-item' },
        h('img', { src: thumbUrl(post), alt: '', loading: 'lazy' }),
        h('div', null,
          h('div', null, link(s?.landing_url, s?.title || '(제목 없음)')),
          h('small', null, `작성자: ${s?.creator || '미상'} · `, link(s?.license_url, s?.license_name || ''), ` · ${s?.modified || ''}`)));
    })),
    db.gallery.length ? h('h3', { class: 'section-title' }, '가상 갤러리의 일상 사진') : null,
    h('div', { class: 'source-list' }, db.gallery.map((g) => h('div', { class: 'source-item' },
      h('img', { src: url(g.file), alt: '', loading: 'lazy' }),
      h('div', null,
        h('div', null, link(g.landing_url, g.title || '(제목 없음)')),
        h('small', null, `작성자: ${g.creator || '미상'} · `, link(g.license_url, g.license_name || ''), ` · ${g.modified || ''}`))))));
  return { id: 'sources', el };
}

// ── 콘솔 화면 ─────────────────────────────────────────────────────────
function consoleScreen() {
  const el = h('div', { class: 'module console' });
  const status = h('p', { class: 'hint' });
  let alive = true;
  let refreshOffline = null;   // 오프라인 준비 목록만 다시 그리는 함수

  const section = (title, ...children) => h('section', { class: 'panel' }, h('h3', null, title), children);

  function statusLine() {
    const part = (which, name) => {
      const m = ml.models[which];
      return `${name} ${m ? `${m.device}/${m.dtype}` : ml.loading[which] ? '로드 중…' : '대기'}`;
    };
    return `${part('text', '텍스트')} · ${part('vision', '이미지')} · 검색 ${settings.searchBackend === 'server' ? '서버' : '기기'} · ${navigator.onLine ? '온라인' : '오프라인'}`;
  }

  async function newSessionPanel() {
    const next = (await kv.get('last_participant_no', 0)) + 1;
    const participant = h('input', { class: 'input', value: `P${String(next).padStart(2, '0')}`, 'aria-label': '참여자 번호' });
    const group = h('select', { class: 'input', 'aria-label': '순서 그룹' });
    const fixedOrder = !!db.protocol.sequence.runs;   // 순서가 고정이면 순서 그룹을 고르지 않는다
    group.hidden = fixedOrder;
    const fillGroups = () => {
      if (fixedOrder) return;
      const auto = autoGroup(participant.value);
      group.replaceChildren(...Object.entries(db.protocol.order_groups).map(([id, g]) => h('option', { value: id, selected: Number(id) === auto },
        `그룹 ${id}: ${g.conditions.map((c) => CONDITION_LABEL[c]).join(' → ')}, 세트 ${g.sets.join(' → ')}${Number(id) === auto ? ' (자동)' : ''}`)));
    };
    participant.oninput = fillGroups;
    fillGroups();
    const note = h('input', { class: 'input', placeholder: '장소 메모 (예: 카페)', 'aria-label': '장소 메모' });
    return section('새 세션',
      h('div', { class: 'stack' }, participant, group, note,
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          const p = participant.value.trim().toUpperCase();
          if (!/^P\d+$/.test(p)) return toast('참여자 번호는 P01 형식으로 적어 주세요');
          startSession({ participant: p, orderGroup: fixedOrder ? null : Number(group.value), locationNote: note.value.trim() });
        } }, '세션 시작 · 참여자에게 건네기')));
  }

  function activeSessionPanel(s) {
    const next = s.task_runs.find((r) => r.status === 'pending');
    const running = s.task_runs.find((r) => r.status === 'running');
    const finalDone = s.surveys.some((x) => x.scope === 'session');
    const beforeConsent = s.step === 'consent' || s.step === 'pre';
    const continueLabel = running ? `이어서 진행: ${running.task_id} Task 처음부터 다시`
      : beforeConsent ? '이어서 진행: 동의 화면부터'
        : next ? `이어서 진행: ${next.task_id} (${CONDITION_LABEL[next.condition]})부터` : '이어서 진행: 마지막 질문';
    const rows = s.task_runs.map((r) => {
      const def = db.protocol.tasks[r.task_id];
      const correct = r.answer?.is_correct;
      return h('div', { class: `run-row ${r.status}` },
        h('span', { class: 'run-no' }, r.order_index),
        h('span', { class: 'run-name' }, `${r.task_id} ${def?.name ?? ''}`,
          h('small', null, ` ${CONDITION_LABEL[r.condition] ?? ''}`)),
        h('span', { class: 'run-status' }, STATUS_LABEL[r.status], correct === true ? ' ○' : correct === false ? ' ✕' : ''),
        r === next ? h('button', { class: 'link-btn', type: 'button', onclick: async () => {
          if (await confirmDialog(`${r.task_id} Task를 건너뛸까요?`, { ok: '건너뛰기' })) { await logger.skipRun(r); render(); }
        } }, '건너뛰기') : null);
    });
    const noteInput = h('textarea', { class: 'input', rows: 2, placeholder: '관찰 메모 (시각이 함께 저장됩니다)' });
    const lastRun = [...s.task_runs].reverse().find((r) => r.status !== 'pending');
    return section(`진행 중: ${s.participant}${s.order_group ? ` · 그룹 ${s.order_group}` : ''} · ${formatDuration(Date.now() - s.started_ms)} 경과`,
      h('div', { class: 'run-list' }, rows),
      !finalDone || running ? h('button', { class: 'btn primary block', type: 'button', onclick: continueSession }, `${continueLabel} · 참여자에게 건네기`) : null,
      finalDone && !running ? h('p', { class: 'hint' }, '모든 Task와 마지막 질문이 끝났습니다. 세션을 종료해 주세요.') : null,
      h('p', { class: 'hint' }, '이 세션을 그만두고 새로 시작하려면 아래 [세션 종료]를 누릅니다. 기록은 지워지지 않고 "저장 대기"로 옮겨집니다.'),
      h('div', { class: 'stack' }, noteInput,
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!noteInput.value.trim()) return;
          await logger.addNote(noteInput.value.trim(), lastRun?.task_run_id ?? null);
          render();
        } }, '메모 추가')),
      s.notes.length ? h('ul', { class: 'note-list' }, s.notes.map((n) => h('li', null, h('small', null, `${n.ts.slice(11, 19)} ${n.task_run_id ?? ''}`), ` ${n.text}`))) : null,
      h('button', { class: 'btn danger block', type: 'button', onclick: () => endSession(render) }, '세션 종료'));
  }

  async function pendingPanel() {
    const ended = (await sessions.all()).filter((s) => s.status !== 'active');
    if (!ended.length) return section('저장 대기', h('p', { class: 'hint' }, '대기 중인 세션이 없습니다 (0건).'));
    const rows = await Promise.all(ended.map(async (s) => {
      const n = (await events.of(s.session_id)).length;
      return h('div', { class: 'pending-row' },
        h('div', null, h('b', null, s.session_id), h('small', null, ` 이벤트 ${n}건 · ${s.exported_at ? '파일 저장됨' : '아직 저장 안 함'}`)),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            const out = await exportSessionJson(s.session_id);
            toast(`저장했어요 (이벤트 ${out.n_events}건)`);
            render();
          } }, 'JSON 파일로 저장'),
          UPLOAD_BACKEND === 'firebase' ? h('button', { class: 'btn', type: 'button', onclick: async () => {
            const result = await uploadSession(s.session_id);
            if (result.ok) { await deleteSession(s.session_id); toast(`업로드 완료 (이벤트 ${result.n_events}건)`); } else toast('업로드 실패. 신호를 확인해 주세요');
            render();
          } }, '다시 업로드') : null,
          h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
            const message = s.exported_at ? '이 세션의 기기 안 기록을 지울까요? (파일로 저장한 것은 그대로 남습니다)'
              : '아직 파일로 저장하지 않은 세션입니다. 지우면 기록을 되찾을 수 없습니다. 그래도 지울까요?';
            if (await confirmDialog(message, { ok: '지우기', danger: true })) { await deleteSession(s.session_id); render(); }
          } }, '지우기')));
    }));
    return section(`저장 대기 ${ended.length}건`, rows);
  }

  async function offlinePanel() {
    const list = h('ul', { class: 'check-list' });
    const progress = h('p', { class: 'hint' });
    const refresh = async () => {
      const items = await readiness();
      list.replaceChildren(...items.map((it) => h('li', { class: it.ok ? 'ok' : 'no' }, `${it.ok ? '✓' : '·'} ${it.label}`, h('small', null, ` ${it.detail}`))));
    };
    await refresh();
    refreshOffline = refresh;
    return section('오프라인 준비 상태', list, progress,
      h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await prepareOffline((text) => { progress.textContent = text; });
          progress.textContent = '준비 완료';
        } catch (err) {
          progress.textContent = `준비 실패: ${err.message || err}`;
        }
        e.target.disabled = false;
        await refresh();
      } }, '지금 준비하기'));
  }

  async function settingsPanel() {
    const nPhotos = (await photos.all()).length;
    const select = (value, options, onChange) => h('select', { class: 'input', onchange: (e) => onChange(e.target.value) },
      options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
    return section('설정',
      h('label', { class: 'field-label' }, '모델 조합'),
      select(settings.preset, Object.keys(PRESETS).map((k) => [k, { q8: 'q8 · WASM', fp16: 'fp16 · WebGPU', mixed: '이미지 fp16·WebGPU + 텍스트 q8' }[k]]), async (v) => {
        await saveSettings({ preset: v });
        toast('모델을 다시 불러옵니다');
        await ml.init(v);
        ml.load('text').then(() => ml.load('vision')).then(render).catch((err) => toast(`모델 로드 실패: ${err.message || err}`));
        render();
      }),
      h('label', { class: 'field-label' }, '검색 임베딩 위치'),
      select(settings.searchBackend, [['browser', '이 기기 (브라우저 추론)'], ['server', '서버 (Plan B)']], async (v) => {
        await saveSettings({ searchBackend: v });
        logger.log('search_backend_change', null, { value: v });
        render();
      }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: settings.showRaw, onchange: (e) => saveSettings({ showRaw: e.target.checked }) }),
        h('span', null, '원시 코사인 값도 함께 표시')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const n = await exportPhotosZip();
          toast(n ? `사진 ${n}장을 ZIP으로 저장했어요` : '저장된 사진이 없습니다');
        } }, `사진 내보내기 (${nPhotos}장)`),
        h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
          if (await confirmDialog('기기에 저장된 참여자 사진을 모두 지울까요?', { ok: '지우기', danger: true })) { await photos.clear(); render(); }
        } }, '사진 지우기')),
      h('button', { class: 'link-btn', type: 'button', onclick: () => nav.push(sourcesScreen()) }, '이미지 출처 보기'));
  }

  function demoPanel() {
    return section('데모 (기록하지 않음)',
      h('p', { class: 'hint' }, 'Task와 무관하게 각 모듈을 열어 봅니다. 세션이 진행 중일 때는 열 수 없습니다.'),
      h('div', { class: 'chips' }, Object.entries(MODULE_NAMES).map(([id, name]) => h('button', {
        class: 'chip', type: 'button',
        onclick: () => startTask({ task_id: 'demo', moduleId: id, order_index: 0, condition: null, def: { type: 'demo', name } }, { demo: true, onEnd: showConsole }),
      }, `${id} ${name}`))));
  }

  async function render() {
    if (!alive) return;
    const s = logger.session;
    status.textContent = statusLine();
    const parts = [
      h('header', { class: 'console-head' },
        h('h1', null, `${SERVICE_NAME} 연구자 콘솔`),
        h('small', null, `v${APP_VERSION} · 데이터 ${db.manifest?.data_version ?? '-'} · 게시물 ${db.posts.length}개`),
        status),
      s ? activeSessionPanel(s) : await newSessionPanel(),
      await pendingPanel(),
      await offlinePanel(),
      await settingsPanel(),
      s ? null : demoPanel(),
    ];
    if (alive) el.replaceChildren(...parts.filter(Boolean));
  }

  // 모델 상태가 바뀌면 상태 줄만 고친다. 화면 전체를 다시 그리면 입력 중이던 값이 지워진다
  const unsubscribe = ml.onChange((e) => {
    if (e.type !== 'ready' && e.type !== 'error') return;
    status.textContent = statusLine();
    refreshOffline?.();
  });
  const onOnline = () => { status.textContent = statusLine(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
  return {
    id: 'console', el, onShow: render,
    onDestroy: () => { alive = false; unsubscribe(); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOnline); },
  };
}

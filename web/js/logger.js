// 인터뷰 로그 (PLAN 14.6). 이벤트 한 줄 = 한 행(long 형식)으로 IndexedDB에 바로 쓴다.
// 이벤트 이름과 data 필드는 docs/event_dictionary.md에 정의한다. 새 이벤트를 추가하면 사전도 함께 고친다.
//
// 세션이 없을 때(데모 모드)는 아무것도 기록하지 않는다.

import { APP_VERSION, MODEL_VERSION } from './config.js';
import { events, sessions, kv, replay } from './store.js';
import { isoNow, uid } from './util.js';

const ACTIVE_KEY = 'active_session_id';

export const logger = {
  session: null,    // 진행 중인 세션 기록
  run: null,        // 진행 중인 Task 실행 (session.task_runs의 한 항목)
  screen: null,     // 현재 화면 id

  get active() { return !!this.session; },

  async start({ participant, order_group, location_note, plan, protocol_version, backend }) {
    const now = Date.now();
    const day = isoNow(now).slice(0, 10).replaceAll('-', '');
    this.session = {
      session_id: `S${day}-${participant}-${uid(4)}`,
      participant, order_group, location_note,
      started_at: isoNow(now), started_ms: now, ended_at: null,
      consent: null,
      app_version: APP_VERSION, model_version: MODEL_VERSION, protocol_version,
      device: { ua: navigator.userAgent, screen: `${screen.width}x${screen.height}`, backend },
      status: 'active', step: 'consent',
      pre_survey: [], task_runs: plan, surveys: [], notes: [], seq: 0,
    };
    this.run = null;
    await this.save();
    await kv.set(ACTIVE_KEY, this.session.session_id);
    this.log('session_start', null, { participant, order_group, location_note });
    return this.session;
  },

  // 탭이 다시 열렸을 때(메모리 부족 등) 진행 중이던 세션을 이어받는다
  async resume() {
    const id = await kv.get(ACTIVE_KEY);
    const record = id ? await sessions.get(id) : null;
    if (!record || record.status !== 'active') return null;
    this.session = record;
    this.run = record.task_runs.find((r) => r.status === 'running') || null;
    this.log('error', null, { message: 'app_reloaded', resumed_run: this.run?.task_run_id ?? null });
    return record;
  },

  save() {
    return this.session ? sessions.put(this.session) : Promise.resolve();
  },

  // 이벤트 기록. 정답 관련 값(is_target 등)은 호출하는 쪽에서 계산해 data에 넣는다
  log(event, target = null, data = {}) {
    const s = this.session;
    if (!s) return null;
    const now = Date.now();
    const run = this.run;
    const row = {
      session_id: s.session_id,
      seq: ++s.seq,
      ts: isoNow(now),
      t_session_ms: now - s.started_ms,
      t_task_ms: run?.started_ms ? now - run.started_ms : null,
      task_run_id: run?.task_run_id ?? null,
      task_id: run?.task_id ?? null,
      condition: run?.condition ?? null,
      screen: this.screen,
      event, target, data,
    };
    events.add(row).catch((err) => console.error('이벤트 저장 실패', err, row));
    return row;
  },

  async setConsent(consent) {
    this.session.consent = consent;
    this.session.step = 'pre';
    this.log('consent', null, consent);
    await this.save();
  },

  async addSurvey(scope, q, a, taskRunId = null) {
    const entry = { scope, task_run_id: taskRunId, q, a };
    (scope === 'pre' ? this.session.pre_survey : this.session.surveys).push(entry);
    this.log('survey_answer', q, { scope, q, a, task_run_id: taskRunId });
    await this.save();
  },

  async addNote(text, taskRunId = null) {
    const now = Date.now();
    this.session.notes.push({ ts: isoNow(now), t_session_ms: now - this.session.started_ms, task_run_id: taskRunId, text });
    this.log('researcher_note', null, { text, task_run_id: taskRunId });
    await this.save();
  },

  async beginRun(run) {
    const now = Date.now();
    Object.assign(run, { status: 'running', started_at: isoNow(now), started_ms: now });
    this.run = run;
    this.log('task_start', null, { task_id: run.task_id, condition: run.condition, order_index: run.order_index, target_id: run.target_id });
    await this.save();
  },

  async endRun(outcome, answer = null, extra = {}) {
    const run = this.run;
    if (!run) return;
    this.log('task_end', null, { outcome, answer, ...extra });
    Object.assign(run, { status: outcome, outcome, answer, ended_at: isoNow() });
    this.run = null;
    await this.save();
  },

  async skipRun(run) {
    Object.assign(run, { status: 'skipped', outcome: 'skipped', answer: null });
    this.log('task_end', null, { outcome: 'skipped', by: 'researcher', task_run_id: run.task_run_id, task_id: run.task_id });
    await this.save();
  },

  async end() {
    const s = this.session;
    if (!s) return null;
    if (this.run) await this.endRun('skipped', null, { by: 'researcher', reason: 'session_end' });
    this.log('session_end', null, { n_events: s.seq + 1 });
    s.ended_at = isoNow();
    s.status = 'ended';
    s.step = 'done';
    await this.save();
    await kv.set(ACTIVE_KEY, null);
    this.session = null;
    this.run = null;
    return s.session_id;
  },
};

// 세션 묶음 (PLAN 14.6.1): 업로드·파일 저장 단위
export async function buildBundle(sessionId) {
  const s = await sessions.get(sessionId);
  if (!s) throw new Error(`세션을 찾을 수 없습니다: ${sessionId}`);
  const rows = (await events.of(sessionId)).sort((a, b) => a.seq - b.seq);
  return {
    schema_version: 1,
    session: {
      session_id: s.session_id, participant: s.participant, order_group: s.order_group,
      started_at: s.started_at, ended_at: s.ended_at, location_note: s.location_note, consent: s.consent,
      app_version: s.app_version, model_version: s.model_version, protocol_version: s.protocol_version, device: s.device,
    },
    pre_survey: s.pre_survey.map(({ q, a }) => ({ q, a })),
    task_runs: s.task_runs.map((r) => ({
      task_run_id: r.task_run_id, task_id: r.task_id, condition: r.condition, order_index: r.order_index,
      target_set: r.set, target_id: r.target_id, started_at: r.started_at ?? null, ended_at: r.ended_at ?? null,
      outcome: r.outcome ?? 'skipped', answer: r.answer ?? null,
    })),
    events: rows.map(({ session_id, ...event }) => event),
    surveys: s.surveys,
    notes: s.notes,
  };
}

export async function buildReplay(sessionId) {
  return { schema_version: 1, session_id: sessionId, events: (await replay.of(sessionId)).flat() };
}

window.addEventListener('error', (e) => logger.log('error', null, { message: String(e.message), source: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => logger.log('error', null, { message: String(e.reason?.message || e.reason) }));

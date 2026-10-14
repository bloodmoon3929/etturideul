// 임베딩 워커(ml-worker.js)를 메인 스레드에서 쓰기 위한 얇은 클라이언트.

import { MODEL_IDS, MODEL_SOURCE, ORT_BASE, PRESETS, DEFAULT_PRESET } from './config.js';

export class ML {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.env = null;                       // { webgpu, threads, isolated }
    this.models = { text: null, vision: null };
    this.loading = { text: null, vision: null };
    this.preset = DEFAULT_PRESET;
    this.listeners = new Set();            // 진행·상태 변화 알림
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  async init(preset = DEFAULT_PRESET) {
    this.terminate();
    this.preset = preset;
    this.worker = new Worker(new URL('./ml-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => {
      const error = new Error(e.message || '임베딩 워커 오류');
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.emit({ type: 'error', message: error.message });
    };
    const { result } = await this.call('init', {
      config: { ids: MODEL_IDS, source: MODEL_SOURCE, ortBase: ORT_BASE, preset: PRESETS[preset] },
    });
    this.env = result;
    return result;
  }

  handle(msg) {
    if (msg.type === 'progress') return this.emit(msg);
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve({ result: msg.result, ms: msg.ms });
    else entry.reject(new Error(msg.error));
  }

  call(type, payload = {}) {
    if (!this.worker) return Promise.reject(new Error('임베딩 워커가 시작되지 않았습니다'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  // 같은 모델을 동시에 여러 번 요청해도 한 번만 로드한다
  load(which) {
    if (this.models[which]) return Promise.resolve(this.models[which]);
    if (!this.loading[which]) {
      this.loading[which] = this.call('load', { which })
        .then(({ result }) => {
          this.models[which] = result;
          this.emit({ type: 'ready', ...result });
          return result;
        })
        .finally(() => { this.loading[which] = null; });
    }
    return this.loading[which];
  }

  isReady(which) {
    return !!this.models[which];
  }

  // 텍스트 → Float32Array(512). 반환값의 ms는 워커 안에서 걸린 시간
  async embedText(text) {
    await this.load('text');
    const { result, ms } = await this.call('embedText', { texts: [text] });
    return { vector: result.vectors, ms };
  }

  async embedTexts(texts) {
    await this.load('text');
    const { result, ms } = await this.call('embedText', { texts });
    return { vectors: result.vectors, ms };
  }

  // 사진(Blob/File) → Float32Array(512). 사진은 기기 밖으로 나가지 않는다
  async embedImage(blob) {
    await this.load('vision');
    const { result, ms } = await this.call('embedImage', { blob });
    return { ...result, ms };
  }

  async dispose(which) {
    await this.call('dispose', { which });
    this.models[which] = null;
  }

  // 진행 중인 추론이 끝날 때까지 기다린다 (3D 지도가 GPU를 쓰기 전에 호출)
  async idle() {
    const busy = () => [...this.pending.values()].some((p) => p.type.startsWith('embed'));
    while (busy()) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  backendLabel() {
    const part = (m) => (m ? `${m.device}/${m.dtype}` : '-');
    return `텍스트 ${part(this.models.text)}, 이미지 ${part(this.models.vision)}`;
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.models = { text: null, vision: null };
    this.loading = { text: null, vision: null };
    this.pending.clear();
  }
}

export const ml = new ML();

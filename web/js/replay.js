// 세션 리플레이 (rrweb, PLAN 14장). 화면 기록에 동의한 세션에서만 켠다.
// 이벤트 로그와는 별도 스트림으로 IndexedDB에 쌓고, rrweb의 timestamp(ms)로 이벤트와 시간을 맞춘다.

import { url } from './config.js';
import { replay } from './store.js';

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_SIZE = 200;
let stopFn = null;
let buffer = [];
let timer = null;
let sessionId = null;
let libPromise = null;

function loadLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url('vendor/rrweb/record.umd.min.js');
      script.onload = resolve;
      script.onerror = () => reject(new Error('rrweb 로드 실패'));
      document.head.append(script);
    });
  }
  return libPromise;
}

function flush() {
  if (!buffer.length || !sessionId) return;
  const chunk = buffer;
  buffer = [];
  replay.add(sessionId, chunk).catch((err) => console.error('리플레이 저장 실패', err));
}

export async function startReplay(id) {
  if (stopFn) return;
  await loadLib();
  const record = window.rrwebRecord?.record || window.rrwebRecord;
  sessionId = id;
  stopFn = record({
    emit: (event) => {
      buffer.push(event);
      if (buffer.length >= FLUSH_SIZE) flush();
    },
    sampling: { mousemove: false, scroll: 150, input: 'last' },
    recordCanvas: false,   // 3D 지도 캔버스는 기록하지 않는다(용량). 지도 조작은 graph_* 이벤트로 남는다
  });
  timer = setInterval(flush, FLUSH_INTERVAL_MS);
}

export function stopReplay() {
  stopFn?.();
  stopFn = null;
  clearInterval(timer);
  flush();
  sessionId = null;
}

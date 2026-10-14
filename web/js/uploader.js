// 세션 묶음 업로드와 내보내기 (PLAN 14.5, 14.8).
//
// 세션 중 기록은 IndexedDB에만 쌓이고, [세션 종료] 때 한 번 올린다.
// 지금은 업로드 없이 [JSON 파일로 저장]으로만 꺼낸다 (config.js의 UPLOAD_BACKEND = 'none').

import { UPLOAD_BACKEND } from './config.js';
import { buildBundle, buildReplay } from './logger.js';
import { sessions, photos } from './store.js';
import { downloadBlob } from './util.js';

// ──────────────────────────────────────────────────────────────────────
// TODO(firebase): Firestore 일괄 업로드. Google 서비스에 접속할 수 있는 환경에서 구현한다.
//
//  준비
//   - Firebase 프로젝트 생성(Spark 요금제), Hosting · Firestore · Authentication(익명, Google) 사용 설정
//   - 웹 클라이언트 설정값(apiKey, authDomain, projectId, appId)을 web/js/firebase-config.js에 둔다.
//     공개돼도 되는 값이지만, 그 대신 Firestore 보안 규칙으로 접근을 막는다.
//   - Firebase JS SDK(app, auth, firestore)를 web/vendor/firebase/에 로컬 사본으로 둔다(오프라인 동작).
//
//  업로드 (세션 종료 때 한 번, writeBatch)
//   - signInAnonymously()로 익명 인증
//   - sessions/{session_id}                    session, pre_survey, task_runs, surveys, notes (문서 1개)
//   - sessions/{session_id}/events/{chunk_no}  이벤트 500개씩 묶은 배열 (문서당 1MB 미만 유지)
//   - sessions/{session_id}/replay/{chunk_no}  rrweb 청크 (buildReplay 결과를 1MB 미만으로 나눔)
//   - 성공하면 { ok: true, n_events }를 돌려준다. 호출한 쪽(console.js)이 로컬 데이터를 정리한다.
//   - 실패(신호 없음 등)하면 { ok: false, reason }을 돌려주고 데이터는 "업로드 대기"로 남긴다.
//
//  보안 규칙 (firestore.rules, 에뮬레이터로 테스트 작성)
//   - 익명 인증 사용자: 자기 세션 경로에 create만 가능 (read · update · delete 불가)
//   - 연구자 Google 계정 UID: read · delete 가능
//
//  함께 만들 파일: firebase.json(Hosting 캐시 헤더 · COOP/COEP 헤더), firestore.rules, firestore.indexes.json
// ──────────────────────────────────────────────────────────────────────
export async function uploadSession(sessionId) {
  if (UPLOAD_BACKEND !== 'firebase') return { ok: false, reason: 'not_configured' };
  // const bundle = await buildBundle(sessionId);
  // const replay = await buildReplay(sessionId);
  // const { db, auth } = await import('./firebase-config.js');
  // await signInAnonymously(auth);
  // const batch = writeBatch(db);
  // batch.set(doc(db, 'sessions', sessionId), { session: bundle.session, pre_survey: bundle.pre_survey, ... });
  // for (let i = 0; i * 500 < bundle.events.length; i++) {
  //   batch.set(doc(db, 'sessions', sessionId, 'events', String(i)), { events: bundle.events.slice(i * 500, (i + 1) * 500) });
  // }
  // await batch.commit();
  // return { ok: true, n_events: bundle.events.length };
  return { ok: false, reason: 'not_implemented' };
}

const jsonBlob = (obj) => new Blob([JSON.stringify(obj)], { type: 'application/json' });

// [JSON 파일로 저장]: 폰의 다운로드 폴더에 세션 묶음 파일을 만든다. 분석 스크립트가 이 파일을 그대로 읽는다
export async function exportSessionJson(sessionId) {
  const bundle = await buildBundle(sessionId);
  const prefix = bundle.session.test ? 'TEST_' : '';   // 테스트 세션은 파일 이름으로도 구분한다
  downloadBlob(jsonBlob(bundle), `${prefix}${sessionId}.json`);
  // 리플레이는 용량이 커서 gzip으로 묶어 따로 저장한다 (압축을 지원하지 않는 브라우저에서는 그대로 저장)
  const replay = await buildReplay(sessionId);
  if (replay.events.length) {
    if (typeof CompressionStream === 'function') {
      const zipped = await new Response(jsonBlob(replay).stream().pipeThrough(new CompressionStream('gzip'))).blob();
      downloadBlob(new Blob([zipped], { type: 'application/gzip' }), `${prefix}${sessionId}_replay.json.gz`);
    } else {
      downloadBlob(jsonBlob(replay), `${prefix}${sessionId}_replay.json`);
    }
  }
  const record = await sessions.get(sessionId);
  record.exported_at = new Date().toISOString();
  await sessions.put(record);
  return { n_events: bundle.events.length, n_replay: replay.events.length };
}

// ── 사진 내보내기 (ZIP, 무압축) ───────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {   // files: [{ name, bytes }]
  const encoder = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, file.bytes.length, true); local.setUint32(22, file.bytes.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, file.bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, file.bytes.length, true); entry.setUint32(24, file.bytes.length, true);
    entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    central.push(entry.buffer, name);
    offset += 30 + name.length + file.bytes.length;
  }
  const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// 동의한 참여자의 사진을 ZIP으로 꺼낸다. 사진은 업로드하지 않는다 (PLAN 14.5)
export async function exportPhotosZip() {
  const all = await photos.all();
  if (!all.length) return 0;
  const files = [];
  for (const [i, p] of all.entries()) {
    const ext = (p.name.match(/\.\w+$/) || ['.jpg'])[0];
    files.push({
      name: `${p.session_id}/${String(i + 1).padStart(3, '0')}_${p.task_run_id ?? 'none'}_${p.kind}${ext}`,
      bytes: new Uint8Array(await p.blob.arrayBuffer()),
    });
  }
  downloadBlob(zip(files), `etturi_photos_${new Date().toISOString().slice(0, 10)}.zip`);
  return all.length;
}

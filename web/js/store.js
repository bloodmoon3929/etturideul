// 로컬 저장소 (IndexedDB). 세션 중 모든 기록은 여기에만 쌓이고 네트워크를 쓰지 않는다 (PLAN 14.5).
//
//   kv        설정·진행 상태 (key → value)
//   sessions  세션 기록 (session_id → 세션 정보, Task 실행, 설문, 메모)
//   events    이벤트 로그 (한 줄 = 한 이벤트)
//   replay    rrweb 세션 리플레이 묶음
//   photos    동의한 참여자의 검색·등록 사진 (기기 밖으로 올리지 않는다)

const DB_NAME = 'etturi';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('kv', { keyPath: 'key' });
        db.createObjectStore('sessions', { keyPath: 'session_id' });
        for (const name of ['events', 'replay', 'photos']) {
          db.createObjectStore(name, { autoIncrement: true }).createIndex('session_id', 'session_id');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const bySession = (storeName, sessionId) =>
  run(storeName, 'readonly', (s) => s.index('session_id').getAll(sessionId));

async function deleteBySession(storeName, sessionId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const cursorReq = tx.objectStore(storeName).index('session_id').openCursor(IDBKeyRange.only(sessionId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export const kv = {
  get: async (key, fallback = null) => (await run('kv', 'readonly', (s) => s.get(key)))?.value ?? fallback,
  set: (key, value) => run('kv', 'readwrite', (s) => s.put({ key, value })),
};

export const sessions = {
  get: (id) => run('sessions', 'readonly', (s) => s.get(id)),
  put: (record) => run('sessions', 'readwrite', (s) => s.put(record)),
  all: () => run('sessions', 'readonly', (s) => s.getAll()),
};

export const events = {
  add: (event) => run('events', 'readwrite', (s) => s.add(event)),
  of: (sessionId) => bySession('events', sessionId),
};

export const replay = {
  add: (sessionId, chunk) => run('replay', 'readwrite', (s) => s.add({ session_id: sessionId, chunk })),
  of: async (sessionId) => (await bySession('replay', sessionId)).map((r) => r.chunk),
};

export const photos = {
  add: (photo) => run('photos', 'readwrite', (s) => s.add(photo)),
  of: (sessionId) => bySession('photos', sessionId),
  all: () => run('photos', 'readonly', (s) => s.getAll()),
  clear: () => run('photos', 'readwrite', (s) => s.clear()),
};

// 업로드(또는 파일 저장)가 끝난 세션의 로컬 데이터를 지운다. 사진은 따로 내보낸 뒤 지운다
export async function deleteSession(sessionId) {
  await deleteBySession('events', sessionId);
  await deleteBySession('replay', sessionId);
  await run('sessions', 'readwrite', (s) => s.delete(sessionId));
}

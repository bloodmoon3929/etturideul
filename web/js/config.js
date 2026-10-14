// 앱 전역 설정. 서비스 이름·모델 경로·기본 동작을 여기서만 바꾼다.

export const SERVICE_NAME = '에뚜리들';
export const APP_VERSION = '0.1.1';

// index.html이 있는 디렉터리. 하위 경로에 배포해도 동작하도록 모든 경로를 여기 기준으로 만든다.
export const APP_BASE = new URL('..', import.meta.url).href;
export const url = (path) => new URL(path, APP_BASE).href;

// ── 모델 ──────────────────────────────────────────────────────────────
// scripts/common.py의 VISION_MODEL_ID / TEXT_MODEL_ID와 같아야 한다.
export const MODEL_IDS = { vision: 'etturi-clip-vision', text: 'etturi-clip-text-ml' };

// 모델 파일을 받는 곳 (PLAN 6.3, 13.2). 주소는 host + pathTemplate + 파일 이름으로 만들어진다.
// 지금은 앱과 같은 출처의 models/ 에서 받는다(개발용, scripts/dev_server.py가 models/ 디렉터리를 연결).
export const MODEL_SOURCE = { host: APP_BASE, pathTemplate: 'models/{model}/', revision: 'main' };
// 배포 시에는 Hugging Face Hub의 본인 저장소로 바꾸고, revision을 커밋 해시로 고정해 재배포 때 다시 받지 않게 한다.
// export const MODEL_SOURCE = {
//   host: 'https://huggingface.co/',
//   pathTemplate: '<HF 사용자>/<저장소>/resolve/{revision}/{model}/',
//   revision: '<커밋 해시>',
// };

// 인코더별 실행 조합. M0 측정 결과로 DEFAULT_PRESET을 확정한다.
//  q8    : 둘 다 int8 / WASM (합계 약 232MB, 모든 기기에서 동작)
//  fp16  : 둘 다 fp16 / WebGPU (합계 약 446MB)
//  mixed : 이미지 fp16 / WebGPU + 텍스트 q8 / WASM (합계 약 312MB)
export const PRESETS = {
  q8: { text: { device: 'wasm', dtype: 'q8' }, vision: { device: 'wasm', dtype: 'q8' } },
  fp16: { text: { device: 'webgpu', dtype: 'fp16' }, vision: { device: 'webgpu', dtype: 'fp16' } },
  mixed: { text: { device: 'wasm', dtype: 'q8' }, vision: { device: 'webgpu', dtype: 'fp16' } },
};
export const DEFAULT_PRESET = 'q8';
export const MODEL_VERSION = 'clip-b32-ml-r1';

export const ORT_BASE = url('vendor/ort/');

// ── 검색 ──────────────────────────────────────────────────────────────
// 'browser': 폰 안에서 임베딩 / 'server': Plan B 검색 API(PLAN 15장)로 요청. 연구자 콘솔에서 바꿀 수 있다.
export const DEFAULT_SEARCH_BACKEND = 'browser';
export const SERVER_API_BASE = '';   // Plan B 서버 주소 (예: https://search.example.duckdns.org)

export const W_IMG = 0.6;
export const W_TXT = 0.4;
export const TIER_SAME = 0.90;
export const TIER_SIMILAR = 0.65;
export const EMBED_DIM = 512;

// ── 인터뷰 기록 ───────────────────────────────────────────────────────
// 동의 화면의 기본 선택값 (PLAN 17-5, 사용자 확정 전 기본값)
export const CONSENT_DEFAULTS = { behavior: true, replay: true, photos: false };

// Task 중 사진을 고르는 곳.
//  'virtual': 앱 안의 가상 갤러리. 일상 사진들 맨 앞(가장 최근)에 Task 대상 사진이 들어 있어, 실물이나 사진 카드를 건네지 않아도 된다
//  'device' : 폰의 카메라·앨범
// 데모 모드에서는 설정과 관계없이 둘 다 고를 수 있다.
export const PHOTO_SOURCE = 'virtual';

// 설문 단계. 지금은 설문을 모두 끄고, 세션 마지막에 네 가지 UI 중 어느 쪽을 고를지만 묻는다.
//  pre         사전 질문 (중고거래 앱 사용 빈도 등)
//  postTask    Task 후 설문 (SEQ, 확신, 기타 의견)
//  finalDetail 세션 마지막의 UMUX-Lite 문항, 이유·개선 의견, "차이 없음" 선택지
export const SURVEYS = { pre: false, postTask: false, finalDetail: false };

// 세션 묶음 업로드 방식 (PLAN 14.5).
//  'none'    : 업로드하지 않고 [JSON 파일로 저장]만 쓴다 (현재)
//  'firebase': Firestore에 일괄 업로드 — js/uploader.js의 TODO(firebase) 참고
export const UPLOAD_BACKEND = 'none';

export const CATEGORIES = ['피규어', '프라모델', '아크릴 스탠드', '랜덤 굿즈/뱃지', '인형'];
export const CONDITIONS = ['미개봉', '거의 새것', '사용감 있음', '박스 없음'];

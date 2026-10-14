// 앱 진입점: 데이터 로드 → 세션 복구 → 연구자 콘솔. 모델은 화면이 뜬 뒤 백그라운드로 불러온다.

import { SERVICE_NAME, url } from './config.js';
import { loadData, loadSettings, settings } from './data.js';
import { logger } from './logger.js';
import { ml } from './ml.js';
import { nav, initBackGuard } from './nav.js';
import { showConsole, showResumePrompt, sessionUsable, closeStaleSession } from './console.js';
import { toast } from './ui.js';
import { h } from './util.js';

function fatal(message) {
  document.getElementById('screen-host').replaceChildren(
    h('div', { class: 'module center-col' },
      h('h2', null, '앱을 시작하지 못했어요'),
      h('p', { class: 'hint center' }, message),
      h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, '다시 시도')));
}

// 텍스트 인코더를 먼저, 이미지 인코더는 그다음에 로드한다 (PLAN 6.3)
async function loadModels() {
  try {
    await ml.init(settings.preset);
    for (const which of ['text', 'vision']) {
      const m = await ml.load(which);
      logger.log('model_ready', which, { which, backend: `${m.device}/${m.dtype}`, load_ms: m.load_ms, fallback: m.fallback });
    }
  } catch (err) {
    logger.log('error', 'model', { message: String(err.message || err) });
    console.error('모델 로드 실패', err);
  }
}

async function main() {
  document.title = SERVICE_NAME;
  initBackGuard();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(url('sw.js')).catch((err) => console.warn('서비스 워커 등록 실패', err));
  }
  navigator.storage?.persist?.();
  try {
    await loadSettings();
    await loadData();
  } catch (err) {
    return fatal(String(err.message || err));
  }
  const session = await logger.resume();
  if (!session) {
    showConsole();
  } else if (sessionUsable(session)) {
    showResumePrompt(session);
  } else {
    // Task 구성이 바뀌기 전에 만든 세션은 이어 갈 수 없다. 닫고 콘솔에서 새로 시작하게 한다
    await closeStaleSession(session);
    showConsole();
    toast('Task 구성이 바뀌어 이전 세션을 종료했습니다. 기록은 "저장 대기"에 남아 있습니다.', 6000);
  }
  loadModels();
}

window.etturi = { nav, logger, ml };   // 디버깅·자동 점검용
main();

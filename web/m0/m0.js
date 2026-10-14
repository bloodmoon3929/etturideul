// M0 브라우저 추론 검증 (PLAN 8.1). 앱과 같은 워커(js/ml-worker.js)를 그대로 써서 측정한다.
// 측정값은 localStorage에 쌓이고, [결과 저장]으로 JSON 파일을 내려받아 reports/m0_feasibility.md에 옮긴다.

import { ML } from '../js/ml.js';
import { APP_VERSION } from '../js/config.js';
import { isoNow } from '../js/util.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'm0_results';
const STABILITY_KEY = 'm0_stability';
const CRITERIA = { size_mb: 250, start_ms: 5000, text_ms: 500, image_ms: 2000, cos: 0.98 };

const log = (msg) => {
  $('log').textContent += `${new Date().toLocaleTimeString()} ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
};
const setStatus = (msg) => { $('status').textContent = msg; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const loadResults = () => JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
const saveResults = (rs) => localStorage.setItem(STORE_KEY, JSON.stringify(rs));

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

async function memoryMB() {
  try {
    if (performance.measureUserAgentSpecificMemory) {
      const m = await Promise.race([
        performance.measureUserAgentSpecificMemory(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      return Math.round(m.bytes / 1e6);
    }
  } catch { /* 지원하지 않거나 시간 초과면 아래 값으로 대체 */ }
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
}

function deviceInfo(env) {
  const gpu = env?.webgpu;
  return {
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height} @${devicePixelRatio}`,
    cores: navigator.hardwareConcurrency ?? null,
    device_memory_gb: navigator.deviceMemory ?? null,
    isolated: self.crossOriginIsolated === true,
    webgpu: gpu ? `${gpu.vendor} ${gpu.architecture} ${gpu.description}`.trim() + (gpu.f16 ? ' (f16)' : ' (f16 없음)') : '사용 불가',
    wasm_threads: env?.threads ?? null,
    online: navigator.onLine,
  };
}

function renderDevice(info) {
  const labels = { ua: 'User-Agent', screen: '화면', cores: 'CPU 코어', device_memory_gb: '메모리(GB, 근사)',
    isolated: '교차 출처 격리(멀티스레드)', webgpu: 'WebGPU', wasm_threads: 'WASM 스레드', online: '온라인' };
  $('device').innerHTML = Object.entries(labels)
    .map(([k, label]) => `<tr><th>${label}</th><td style="white-space:normal">${info[k] ?? '-'}</td></tr>`).join('');
}

function renderResults() {
  const rs = loadResults();
  const mark = (ok) => (ok == null ? '' : ok ? ' class="num ok"' : ' class="num bad"');
  const head = ['시각', '조합', '실제 백엔드', '다운로드(MB)', '시작→텍스트(ms)', '텍스트 1건(ms)', '사진 1건(ms)',
    '코사인 텍스트', '코사인 사진', '메모리(MB)', '오프라인', '안정성'];
  $('results').innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>` + rs.map((r) => `<tr>
    <td>${r.at.slice(5, 16).replace('T', ' ')}</td><td>${r.preset}${r.cached ? ' (캐시)' : ''}</td><td>${r.backend ?? '-'}</td>
    <td${mark(r.size_mb == null ? null : r.size_mb <= CRITERIA.size_mb)}>${r.size_mb ?? '-'}</td>
    <td${mark(r.cached && r.start_ms != null ? r.start_ms <= CRITERIA.start_ms : null)}>${r.start_ms ?? '-'}</td>
    <td${mark(r.text_ms == null ? null : r.text_ms <= CRITERIA.text_ms)}>${r.text_ms ?? '-'}</td>
    <td${mark(r.image_ms == null ? null : r.image_ms <= CRITERIA.image_ms)}>${r.image_ms ?? '-'}</td>
    <td${mark(r.text_cos_min == null ? null : r.text_cos_min >= CRITERIA.cos)}>${r.text_cos_min?.toFixed(4) ?? '-'}</td>
    <td${mark(r.image_cos_min == null ? null : r.image_cos_min >= CRITERIA.cos)}>${r.image_cos_min?.toFixed(4) ?? '-'}</td>
    <td class="num">${r.memory_mb ?? '-'}</td><td>${r.offline ? '예' : '아니오'}</td><td>${r.stability ?? '-'}</td></tr>`).join('');
}

let ml = null;

async function measure(preset, { auto = false } = {}) {
  const startedAt = performance.now();
  const record = { at: isoNow(), app_version: APP_VERSION, preset, offline: !navigator.onLine, errors: [] };
  const files = {};
  let fromNetwork = false;
  ml?.terminate();
  ml = new ML();
  ml.onChange((e) => {
    if (e.type !== 'progress') return;
    files[e.file] = e.total;
    $('bar').hidden = false;
    $('bar').value = e.total ? e.loaded / e.total : 0;
    setStatus(`${e.which === 'text' ? '텍스트' : '이미지'} 모델 받는 중: ${e.file} ${(e.loaded / 1e6).toFixed(0)}/${(e.total / 1e6).toFixed(0)}MB`);
  });
  try {
    const before = await cachedBytes();
    const env = await ml.init(preset);
    record.device = deviceInfo(env);
    renderDevice(record.device);
    const ref = await (await fetch('./ref.json')).json();

    setStatus('텍스트 인코더 로드 중');
    const text = await ml.load('text');
    record.text_load_ms = text.load_ms;
    const first = await ml.embedText(ref.texts[0].text);
    // 페이지를 연 시점부터 첫 텍스트 임베딩까지. 자동 실행(새로고침) 때만 "앱 시작 → 검색 가능" 값으로 쓴다
    record.start_ms = auto ? Math.round(performance.now()) : Math.round(performance.now() - startedAt);
    record.text_first_ms = first.ms;
    log(`텍스트 인코더 ${text.device}/${text.dtype} 로드 ${text.load_ms}ms, 첫 추론 ${first.ms}ms`);

    const textTimes = [], textCos = [];
    for (const item of ref.texts) {
      const t0 = performance.now();
      const { vector } = await ml.embedText(item.text);
      textTimes.push(performance.now() - t0);
      textCos.push(cosine(vector, item.ref));
    }
    record.text_ms = Math.round(median(textTimes));
    record.text_ms_max = Math.round(Math.max(...textTimes));
    record.text_cos_min = Math.min(...textCos);
    record.text_cos_mean = textCos.reduce((a, b) => a + b, 0) / textCos.length;
    log(`텍스트 10건: 중앙값 ${record.text_ms}ms, 코사인 최소 ${record.text_cos_min.toFixed(4)}`);

    setStatus('이미지 인코더 로드 중');
    const vision = await ml.load('vision');
    record.vision_load_ms = vision.load_ms;
    record.backend = `텍스트 ${text.device}/${text.dtype}, 이미지 ${vision.device}/${vision.dtype}`;
    record.fallback = [text.fallback, vision.fallback].filter(Boolean).join(' / ') || null;
    const imageTimes = [], preTimes = [], imageCos = [];
    for (const [i, item] of ref.images.entries()) {
      const blob = await (await fetch(`./${item.file}`)).blob();
      const t0 = performance.now();
      const out = await ml.embedImage(blob);
      const elapsed = performance.now() - t0;
      if (i === 0) record.image_first_ms = Math.round(elapsed);
      else imageTimes.push(elapsed);
      preTimes.push(out.pre_ms);
      imageCos.push(cosine(out.vector, item.ref));
    }
    record.image_ms = Math.round(median(imageTimes));
    record.image_ms_max = Math.round(Math.max(...imageTimes));
    record.image_pre_ms = Math.round(median(preTimes));
    record.image_cos_min = Math.min(...imageCos);
    record.image_cos_mean = imageCos.reduce((a, b) => a + b, 0) / imageCos.length;
    log(`이미지 인코더 ${vision.device}/${vision.dtype} 로드 ${vision.load_ms}ms, 사진 중앙값 ${record.image_ms}ms(전처리 ${record.image_pre_ms}ms), 코사인 최소 ${record.image_cos_min.toFixed(4)}`);

    const onnxBytes = Object.entries(files).filter(([f]) => f.endsWith('.onnx')).reduce((s, [, n]) => s + n, 0);
    record.size_mb = onnxBytes ? Math.round(onnxBytes / 1e5) / 10 : null;
    record.files = files;
    const after = await cachedBytes();
    fromNetwork = after > before + 1e6;
    record.cached = !fromNetwork;
    record.cache_mb = Math.round(after / 1e6);
    record.memory_mb = await memoryMB();
    record.total_ms = Math.round(performance.now() - startedAt);
    setStatus(`완료: ${record.backend}`);
  } catch (err) {
    record.errors.push(String(err?.message || err));
    log(`오류: ${err?.message || err}`);
    setStatus(`오류: ${err?.message || err}`);
  }
  $('bar').hidden = true;
  saveResults([...loadResults(), record]);
  renderResults();
  return record;
}

// transformers.js가 모델을 저장하는 Cache Storage의 사용량
async function cachedBytes() {
  try {
    const est = await navigator.storage.estimate();
    return est.usageDetails?.caches ?? est.usage ?? 0;
  } catch {
    return 0;
  }
}

// 10분 동안 20초마다 텍스트·사진 검색을 한 번씩(총 30회씩) 돌린다. 탭이 죽으면 다음에 열 때 기록으로 알 수 있다
async function stabilityTest() {
  if (!ml?.isReady('text') || !ml?.isReady('vision')) {
    setStatus('먼저 [측정 시작]을 한 번 실행해 주세요');
    return;
  }
  const ref = await (await fetch('./ref.json')).json();
  const state = { started: Date.now(), searches: 0, errors: 0, finished: false };
  const rounds = 30;
  for (let i = 0; i < rounds; i++) {
    try {
      await ml.embedText(ref.texts[i % ref.texts.length].text);
      const blob = await (await fetch(`./${ref.images[i % ref.images.length].file}`)).blob();
      await ml.embedImage(blob);
      state.searches += 2;
    } catch (err) {
      state.errors += 1;
      log(`안정성 테스트 오류: ${err?.message || err}`);
    }
    localStorage.setItem(STABILITY_KEY, JSON.stringify(state));
    setStatus(`안정성 테스트 ${i + 1}/${rounds} (검색 ${state.searches}회, 오류 ${state.errors})`);
    await new Promise((r) => setTimeout(r, 20000));
  }
  state.finished = true;
  localStorage.removeItem(STABILITY_KEY);
  const rs = loadResults();
  if (rs.length) {
    rs[rs.length - 1].stability = state.errors ? `오류 ${state.errors}회` : `통과 (${state.searches}회, ${Math.round((Date.now() - state.started) / 60000)}분)`;
    rs[rs.length - 1].stability_memory_mb = await memoryMB();
    saveResults(rs);
    renderResults();
  }
  setStatus('안정성 테스트 완료');
}

function checkInterruptedStability() {
  const raw = localStorage.getItem(STABILITY_KEY);
  if (!raw) return;
  const state = JSON.parse(raw);
  localStorage.removeItem(STABILITY_KEY);
  const rs = loadResults();
  if (rs.length) {
    rs[rs.length - 1].stability = `중단됨: 검색 ${state.searches}회 후 탭 재시작`;
    saveResults(rs);
  }
  log(`지난 안정성 테스트가 끝나지 않았습니다(검색 ${state.searches}회 후 탭이 다시 열림).`);
}

const selectedPreset = () => document.querySelector('input[name=preset]:checked').value;

$('run').onclick = async () => {
  $('run').disabled = true;
  await measure(selectedPreset());
  $('run').disabled = false;
};
$('stability').onclick = stabilityTest;
$('reload').onclick = () => { location.search = `?auto=${selectedPreset()}`; };
$('clear').onclick = () => { localStorage.removeItem(STORE_KEY); renderResults(); };
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(loadResults(), null, 1));
  setStatus('결과를 클립보드에 복사했습니다');
};
$('save').onclick = () => {
  const blob = new Blob([JSON.stringify(loadResults(), null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `m0_results_${Date.now()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
};

// 오프라인 확인을 위해 앱의 서비스 워커를 함께 등록하고, 이 페이지가 쓰는 파일을 한 번 더 받아 캐시에 넣는다
// (처음 열었을 때는 서비스 워커가 아직 요청을 가로채지 못해 캐시에 남지 않는다)
async function warmCache() {
  await navigator.serviceWorker.register('../sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  const ref = await (await fetch('./ref.json')).json();
  const files = ['./', './index.html', './m0.js', '../js/ml.js', '../js/ml-worker.js', '../js/config.js', '../js/util.js',
    '../vendor/transformers/transformers.min.js', '../vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', '../vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
    ...ref.images.map((item) => `./${item.file}`)];
  await Promise.all(files.map((f) => fetch(f)));
  log('오프라인용 파일 캐시 완료');
}
if ('serviceWorker' in navigator && navigator.onLine) warmCache().catch((e) => log(`오프라인 캐시 실패: ${e.message}`));
navigator.storage?.persist?.();

checkInterruptedStability();
renderDevice(deviceInfo(null));
renderResults();
window.m0 = { measure, loadResults };   // 자동 점검 스크립트에서 호출

const auto = new URLSearchParams(location.search).get('auto');
if (auto) {
  document.querySelector(`input[name=preset][value=${auto}]`).checked = true;
  measure(auto, { auto: true });
}

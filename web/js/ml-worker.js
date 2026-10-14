// 임베딩 Web Worker (PLAN 6.3). 화면이 멈추지 않게 transformers.js를 여기서만 실행한다.
// 메인 스레드와는 postMessage로 통신한다. 요청마다 id를 붙이고 같은 id로 응답한다.
//
//   init        { config }                 → 환경 설정
//   load        { which: 'text'|'vision' } → 모델 로드 (진행 상황은 { type: 'progress' }로 알림)
//   embedText   { texts: string[] }        → { vectors: Float32Array(n×512, L2 정규화) }
//   embedImage  { blob }                   → { vector: Float32Array(512, L2 정규화) }
//   dispose     { which }                  → 모델 해제(메모리 회수)

import { env, AutoTokenizer, AutoModel, CLIPVisionModelWithProjection, Tensor }
  from '../vendor/transformers/transformers.min.js';

const MAX_SEQ_LEN = 128;
const CLIP_SIZE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
// 카메라 원본(수천 px)은 먼저 브라우저의 고품질 축소로 줄인 뒤 CLIP 규격 리사이즈를 한다
const PRESCALE_LONG_SIDE = 1344;

let config = null;
let webgpuInfo = null;         // null: 확인 전, false: 사용 불가, 객체: 어댑터 정보
const models = { text: null, vision: null };   // { model, tokenizer?, device, dtype, load_ms }

function setupEnv(c) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: c.ortBase + 'ort-wasm-simd-threaded.asyncify.mjs',
    wasm: c.ortBase + 'ort-wasm-simd-threaded.asyncify.wasm',
  };
  env.useWasmCache = false;      // WASM 런타임은 서비스 워커가 캐시한다
  env.useBrowserCache = true;    // 모델 파일은 Cache Storage('transformers-cache')에 저장
  // 모델은 앱 버전에 고정한 경로에서만 받는다 (config.js의 MODEL_SOURCE)
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = c.source.host;
  env.remotePathTemplate = c.source.pathTemplate;
}

async function checkWebGPU() {
  if (webgpuInfo !== null) return webgpuInfo;
  try {
    const adapter = await self.navigator.gpu?.requestAdapter();
    if (!adapter) return (webgpuInfo = false);
    const info = adapter.info || {};
    webgpuInfo = {
      vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '',
      description: info.description || '', f16: adapter.features.has('shader-f16'),
    };
  } catch {
    webgpuInfo = false;
  }
  return webgpuInfo;
}

// 요청한 조합을 쓸 수 없으면 q8/WASM으로 내려간다 (PLAN 6.3 자동 전환)
async function resolveTarget(target) {
  if (target.device !== 'webgpu') return target;
  const gpu = await checkWebGPU();
  if (!gpu || (target.dtype === 'fp16' && !gpu.f16)) return { device: 'wasm', dtype: 'q8', fallback: 'WebGPU 사용 불가' };
  return target;
}

async function loadModel(which, requestId) {
  if (models[which]) return describe(which);
  const t0 = performance.now();
  let target = await resolveTarget(config.preset[which]);
  const id = config.ids[which];
  const lastSent = {};
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.file) return;
    const now = performance.now();
    if (p.loaded !== p.total && now - (lastSent[p.file] || 0) < 150) return;
    lastSent[p.file] = now;
    self.postMessage({ type: 'progress', which, file: p.file, loaded: p.loaded, total: p.total });
  };
  const options = (t) => ({
    device: t.device, dtype: t.dtype, progress_callback, revision: config.source.revision,
  });
  const Model = which === 'vision' ? CLIPVisionModelWithProjection : AutoModel;
  let model;
  try {
    model = await Model.from_pretrained(id, options(target));
  } catch (err) {
    if (target.device === 'wasm') throw err;
    target = { device: 'wasm', dtype: 'q8', fallback: `WebGPU 로드 실패: ${String(err.message || err).slice(0, 120)}` };
    model = await Model.from_pretrained(id, options(target));
  }
  const entry = { model, ...target };
  if (which === 'text') entry.tokenizer = await AutoTokenizer.from_pretrained(id, options(target));
  entry.load_ms = Math.round(performance.now() - t0);
  models[which] = entry;
  return describe(which);
}

function describe(which) {
  const m = models[which];
  return m ? { which, device: m.device, dtype: m.dtype, load_ms: m.load_ms, fallback: m.fallback || null } : null;
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const inv = 1 / Math.sqrt(sum || 1);
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

async function embedText(texts) {
  const { model, tokenizer } = models.text;
  const enc = tokenizer(texts, { padding: true, truncation: true, max_length: MAX_SEQ_LEN });
  const out = await model({ input_ids: enc.input_ids, attention_mask: enc.attention_mask });
  const data = out.sentence_embedding.data;
  const dim = data.length / texts.length;
  const vectors = new Float32Array(data.length);
  for (let i = 0; i < texts.length; i++) {
    vectors.set(l2normalize(Float32Array.from(data.subarray(i * dim, (i + 1) * dim))), i * dim);
  }
  return vectors;
}

// ── CLIP 전처리 (Pillow의 BICUBIC 리사이즈와 같은 계산) ────────────────
// 브라우저 canvas의 축소는 구현마다 달라 파이썬 전처리와 결과가 벌어진다.
// 그래서 디코딩만 브라우저에 맡기고 리사이즈·크롭·정규화는 직접 계산한다.
function bicubicKernel(x) {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

function resampleCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = 2 * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const coeffs = new Float64Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const count = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let sum = 0;
    for (let x = 0; x < count; x++) {
      const w = bicubicKernel((x + xmin - center + 0.5) / filterScale);
      coeffs[xx * ksize + x] = w;
      sum += w;
    }
    if (sum !== 0) for (let x = 0; x < count; x++) coeffs[xx * ksize + x] /= sum;
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = count;
  }
  return { bounds, coeffs, ksize };
}

const clip8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// src: RGBA Uint8ClampedArray(sw×sh) → RGB Uint8Array(dw×dh). 가로 → 세로 순서로 두 번 통과한다
function resizeBicubic(src, sw, sh, dw, dh) {
  const h = resampleCoeffs(sw, dw);
  const mid = new Uint8Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let xx = 0; xx < dw; xx++) {
      const xmin = h.bounds[xx * 2], count = h.bounds[xx * 2 + 1], k = xx * h.ksize;
      let r = 0, g = 0, b = 0;
      for (let x = 0; x < count; x++) {
        const w = h.coeffs[k + x], p = (y * sw + xmin + x) * 4;
        r += src[p] * w; g += src[p + 1] * w; b += src[p + 2] * w;
      }
      const o = (y * dw + xx) * 3;
      mid[o] = clip8(r); mid[o + 1] = clip8(g); mid[o + 2] = clip8(b);
    }
  }
  const v = resampleCoeffs(sh, dh);
  const out = new Uint8Array(dw * dh * 3);
  for (let yy = 0; yy < dh; yy++) {
    const ymin = v.bounds[yy * 2], count = v.bounds[yy * 2 + 1], k = yy * v.ksize;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < count; y++) {
        const w = v.coeffs[k + y], p = ((ymin + y) * dw + x) * 3;
        r += mid[p] * w; g += mid[p + 1] * w; b += mid[p + 2] * w;
      }
      const o = (yy * dw + x) * 3;
      out[o] = clip8(r); out[o + 1] = clip8(g); out[o + 2] = clip8(b);
    }
  }
  return out;
}

async function preprocessImage(blob) {
  let bitmap = await createImageBitmap(blob);   // EXIF 방향은 브라우저가 반영한다
  const original = { width: bitmap.width, height: bitmap.height };
  const longSide = Math.max(bitmap.width, bitmap.height);
  if (longSide > PRESCALE_LONG_SIDE * 1.5) {
    const ratio = PRESCALE_LONG_SIDE / longSide;
    const scaled = await createImageBitmap(bitmap, {
      resizeWidth: Math.round(bitmap.width * ratio), resizeHeight: Math.round(bitmap.height * ratio), resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = scaled;
  }
  const sw = bitmap.width, sh = bitmap.height;
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, sw, sh).data;

  // 짧은 변을 224로 맞추고(비율 유지) 가운데 224×224를 잘라낸다
  const dw = sw <= sh ? CLIP_SIZE : Math.trunc((CLIP_SIZE * sw) / sh);
  const dh = sw <= sh ? Math.trunc((CLIP_SIZE * sh) / sw) : CLIP_SIZE;
  const rgb = resizeBicubic(rgba, sw, sh, dw, dh);
  const left = Math.trunc((dw - CLIP_SIZE) / 2), top = Math.trunc((dh - CLIP_SIZE) / 2);
  const plane = CLIP_SIZE * CLIP_SIZE;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < CLIP_SIZE; y++) {
    for (let x = 0; x < CLIP_SIZE; x++) {
      const p = ((y + top) * dw + x + left) * 3, o = y * CLIP_SIZE + x;
      for (let c = 0; c < 3; c++) data[c * plane + o] = (rgb[p + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }
  return { tensor: new Tensor('float32', data, [1, 3, CLIP_SIZE, CLIP_SIZE]), original };
}

async function embedImage(blob) {
  const t0 = performance.now();
  const { tensor, original } = await preprocessImage(blob);
  const pre_ms = performance.now() - t0;
  const out = await models.vision.model({ pixel_values: tensor });
  const vector = l2normalize(Float32Array.from(out.image_embeds.data));
  return { vector, pre_ms: Math.round(pre_ms), ...original };
}

self.onmessage = async (event) => {
  const { id, type, ...msg } = event.data;
  const t0 = performance.now();
  try {
    let result, transfer = [];
    switch (type) {
      case 'init':
        config = msg.config;
        setupEnv(config);
        result = { webgpu: await checkWebGPU(), threads: env.backends.onnx.wasm.numThreads ?? null,
                   isolated: self.crossOriginIsolated === true };
        break;
      case 'load':
        result = await loadModel(msg.which, id);
        break;
      case 'embedText': {
        if (!models.text) await loadModel('text', id);
        const vectors = await embedText(msg.texts);
        result = { vectors };
        transfer = [vectors.buffer];
        break;
      }
      case 'embedImage': {
        if (!models.vision) await loadModel('vision', id);
        result = await embedImage(msg.blob);
        transfer = [result.vector.buffer];
        break;
      }
      case 'dispose':
        if (models[msg.which]) {
          await models[msg.which].model.dispose?.();
          models[msg.which] = null;
        }
        result = {};
        break;
      case 'status':
        result = { text: describe('text'), vision: describe('vision'), webgpu: webgpuInfo };
        break;
      default:
        throw new Error(`알 수 없는 요청: ${type}`);
    }
    self.postMessage({ id, ok: true, ms: Math.round(performance.now() - t0), result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

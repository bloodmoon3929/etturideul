# vendor — 외부 라이브러리 로컬 사본

오프라인 동작(PLAN 13.5)을 위해 CDN 대신 로컬 사본을 쓴다. 파일은 저장소에 넣지 않고 `python3 scripts/fetch_vendor.py`로 받는다(버전·SHA-256 고정). 버전을 올릴 때는 그 스크립트의 목록과 이 표를 함께 고친다.

| 파일 | 패키지@버전 | 라이선스 | 출처 |
|---|---|---|---|
| transformers/transformers.min.js | @huggingface/transformers@4.3.1 | Apache-2.0 | cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js |
| ort/ort-wasm-simd-threaded.asyncify.{mjs,wasm} | onnxruntime-web@1.31.0-dev.20260914-8d85527a0 (transformers.js 4.3.1이 고정한 버전) | MIT | cdn.jsdelivr.net/npm/onnxruntime-web@…/dist/ |
| 3d-force-graph/3d-force-graph.min.js | 3d-force-graph@1.80.1 (three r186 포함) | MIT | cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/dist/ |
| three/three.module.min.js, three.core.js(=three.core.min.js, 모듈이 이 이름으로 불러온다) | three@0.186.1 | MIT | cdn.jsdelivr.net/npm/three@0.186.1/build/ |
| rrweb/record.umd.min.js | @rrweb/record@2.1.7 | MIT | cdn.jsdelivr.net/npm/@rrweb/record@2.1.7/dist/record.umd.min.cjs |

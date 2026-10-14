"""외부 라이브러리 로컬 사본(web/vendor/)을 받는다.

라이브러리 파일은 저장소에 넣지 않는다. 용량이 크고(WASM 27MB), 압축된 코드 안의 문자열이 GitHub의 비밀값 검사에
걸리기도 한다(transformers.js의 클래스 이름이 API 키 형식으로 오인됨). 대신 버전을 고정한 주소에서 받고 SHA-256으로 확인한다.
로컬에서 처음 받을 때와 GitHub Actions 배포 때 같은 스크립트를 쓴다. 표준 라이브러리만 쓴다.

사용법  python3 scripts/fetch_vendor.py
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

VENDOR = Path(__file__).resolve().parent.parent / "web" / "vendor"

# (web/vendor 안의 경로, 받을 주소, SHA-256). 버전을 올리면 web/vendor/README.md와 함께 고친다
FILES = [
    ("transformers/transformers.min.js", "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js",
     "8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743"),
    ("ort/ort-wasm-simd-threaded.asyncify.mjs", "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.mjs",
     "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611"),
    ("ort/ort-wasm-simd-threaded.asyncify.wasm", "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm",
     "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082"),
    ("3d-force-graph/3d-force-graph.min.js", "https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/dist/3d-force-graph.min.js",
     "13088340aad408156064fd120c3bc3a47c93a3cc45b8f132d6284b20e2223be9"),
    ("three/three.module.min.js", "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js",
     "3bc833fceb6577bd1a380388f832ae61cd6e2f78ad02b0bf0d5adf5a4a9334fe"),
    ("three/three.core.js", "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.core.min.js",
     "3b346151f65ffdfca3e4c002bd58966b78c423087fb48a873f83200de1bffc48"),
    ("rrweb/record.umd.min.js", "https://cdn.jsdelivr.net/npm/@rrweb/record@2.1.7/dist/record.umd.min.cjs",
     "46d0efdc8cfc90ddf097d19e81ea050fb7cabbe3bb2074f19e08117bcb6e41f6"),
]


def main() -> None:
    failed = False
    for rel, url, sha in FILES:
        dest = VENDOR / rel
        if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha:
            print(f"있음  {rel}")
            continue
        req = urllib.request.Request(url, headers={"User-Agent": "etturideul-fetch-vendor"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
        if hashlib.sha256(data).hexdigest() != sha:
            print(f"오류  {rel}: SHA-256이 다릅니다 ({url})")
            failed = True
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        print(f"받음  {rel} ({len(data) / 1e6:.1f}MB)")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

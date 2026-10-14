"""로컬 확인용 정적 서버.

Firebase 에뮬레이터(`firebase emulators:start`) 대신 쓴다. 배포 환경과 같은 조건을 맞추기 위해
  - web/ 을 사이트 루트로, models/ 를 /models/ 로 제공하고
  - WASM 멀티스레드에 필요한 교차 출처 격리 헤더(COOP/COEP)를 붙인다.

사용법
  python scripts/dev_server.py                 # http://127.0.0.1:8000
  python scripts/dev_server.py --host 0.0.0.0  # 같은 네트워크의 다른 기기에서 접속(단, http라 폰에서는 WebGPU·서비스 워커 불가)

폰에서 측정할 때는 `adb reverse tcp:8000 tcp:8000` 후 폰 Chrome에서 http://localhost:8000 을 연다.
"""
from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from common import MODELS, WEB


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json", ".onnx": "application/octet-stream",
        ".bin": "application/octet-stream", ".webp": "image/webp",
    }

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/models/"):
            return str(MODELS / Path(clean[len("/models/"):]))
        return super().translate_path(path)

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        # 개발 중에는 항상 새 파일을 받는다. 배포 시 캐시 정책은 호스팅 설정에서 따로 준다
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        if getattr(self.server, "quiet", False):
            return
        super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(WEB)))
    server.quiet = args.quiet
    print(f"에뚜리들 로컬 서버: http://{args.host}:{args.port}/  (M0 측정: /m0/)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

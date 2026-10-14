"""스크립트 공통 경로·설정·유틸."""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
IMAGES = DATA / "images"
MODELS = ROOT / "models"
WEB = ROOT / "web"
WEB_DATA = WEB / "data"
THUMBS = WEB / "thumbs"
REPORTS = ROOT / "reports"

SERVICE_NAME = "에뚜리들"
EMBED_DIM = 512

# 브라우저(transformers.js)가 읽는 모델 디렉터리 이름. web/js/config.js의 MODEL_IDS와 같아야 한다.
VISION_MODEL_ID = "etturi-clip-vision"
TEXT_MODEL_ID = "etturi-clip-text-ml"

# 원본 모델
ST_IMAGE_MODEL = "sentence-transformers/clip-ViT-B-32"
ST_TEXT_MODEL = "sentence-transformers/clip-ViT-B-32-multilingual-v1"
HF_CLIP_MODEL = "openai/clip-vit-base-patch32"

# 통합 벡터 가중치 (PLAN 5.1)
W_IMG = 0.6
W_TXT = 0.4

# 등급 구간 (PLAN 5.3, 재보정된 표시용 점수 기준)
TIER_SAME = 0.90
TIER_SIMILAR = 0.65

CATEGORIES = ["피규어", "프라모델", "아크릴 스탠드", "랜덤 굿즈/뱃지", "인형"]

# 허용 라이선스 (PLAN 4.3.2). ND 계열과 라이선스 불명은 제외한다.
ALLOWED_LICENSES = {"cc0", "pdm", "by", "by-sa", "by-nc", "by-nc-sa"}


def load_env() -> dict[str, str]:
    """.env(git 제외)를 읽어 os.environ에 없는 값만 채운다."""
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return dict(os.environ)


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, obj, indent: int | None = 2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=indent), encoding="utf-8")


def write_manifest() -> str:
    """web/data/manifest.json: 오프라인 준비 때 미리 받아 둘 파일 목록과 데이터 버전."""
    import hashlib

    data_files = sorted(f"data/{f.name}" for f in WEB_DATA.iterdir() if f.name != "manifest.json")
    thumbs = sorted(f"thumbs/{f.name}" for f in THUMBS.glob("*.webp"))
    # 앱 셸: 화면을 띄우는 데 필요한 파일 전부 (데이터·썸네일·M0 측정 페이지·연구자 대시보드 제외)
    skip = ("data/", "thumbs/", "m0/", "admin/")
    shell = sorted(
        rel for f in WEB.rglob("*")
        if f.is_file() and not (rel := f.relative_to(WEB).as_posix()).startswith(skip) and f.suffix != ".md"
    )
    digest = hashlib.sha1()
    for rel in data_files:
        digest.update((WEB / rel).read_bytes())
    version = digest.hexdigest()[:10]
    write_json(WEB_DATA / "manifest.json", {"data_version": version, "data": data_files, "thumbs": thumbs, "shell": shell})
    return version

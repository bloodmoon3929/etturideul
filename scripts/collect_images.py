"""CC 라이선스 실물 사진 수집 (PLAN 4.3). 공식 API만 사용한다.

출처
  - Openverse  : 키 없이 사용(익명 한도: 분당 20회, 하루 200회, 페이지당 최대 20장)
  - Wikimedia  : .env에 CONTACT(이메일 또는 URL)가 있을 때만 사용 (User-Agent 정책)
  - Flickr     : .env에 FLICKR_API_KEY가 있을 때만 사용

사용법
  python scripts/collect_images.py                 # 전체 검색어
  python scripts/collect_images.py --only gunpla   # 검색어에 gunpla가 들어간 것만
  python scripts/collect_images.py --dry-run       # 다운로드 없이 검색 결과 수만 확인

결과
  data/images/img_NNNN.jpg      긴 변 1280px 이하 JPEG (원본에서 크기만 줄임)
  data/image_sources.json       출처·작성자·라이선스 기록 (앱 화면 표기용)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import re
import sys
import time
from datetime import date

import requests
import yaml
from PIL import Image

from common import ALLOWED_LICENSES, DATA, IMAGES, load_env, read_json, write_json

SOURCES_PATH = DATA / "image_sources.json"
QUERIES_PATH = DATA / "collect_queries.yaml"
MIN_SHORT_SIDE = 400
MAX_LONG_SIDE = 1280
REQUEST_DELAY = 3.2   # Openverse 익명 한도(분당 20회)를 넘지 않도록 3초 이상
DOWNLOAD_DELAY = 1.0

LICENSE_NAMES = {
    "cc0": "CC0 1.0", "pdm": "Public Domain Mark 1.0", "by": "CC BY", "by-sa": "CC BY-SA",
    "by-nc": "CC BY-NC", "by-nc-sa": "CC BY-NC-SA",
}


def user_agent(env: dict) -> str:
    contact = env.get("CONTACT", "").strip()
    base = "etturideul-ux-prototype/0.1 (university coursework; non-commercial"
    return f"{base}; {contact})" if contact else f"{base})"


def strip_html(text: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text or "")).strip()


# ── Openverse ─────────────────────────────────────────────────────────
def search_openverse(session: requests.Session, q: str, page: int, page_size: int) -> list[dict]:
    resp = session.get(
        "https://api.openverse.org/v1/images/",
        params={"q": q, "license": ",".join(sorted(ALLOWED_LICENSES)), "page": page, "page_size": page_size},
        timeout=30,
    )
    remaining = resp.headers.get("x-ratelimit-available-anon_sustained")
    if resp.status_code == 429:
        raise RuntimeError(f"Openverse 사용 한도 초과(429). 남은 하루 한도: {remaining}")
    resp.raise_for_status()
    out = []
    for r in resp.json().get("results", []):
        lic = (r.get("license") or "").lower()
        if lic not in ALLOWED_LICENSES:
            continue
        version = r.get("license_version") or ""
        out.append({
            "source": "openverse",
            "source_id": r["id"],
            "provider": r.get("provider") or r.get("source"),
            "original_url": r["url"],
            "landing_url": r.get("foreign_landing_url"),
            "title": r.get("title") or "",
            "creator": r.get("creator") or "",
            "creator_url": r.get("creator_url") or "",
            "license": lic,
            "license_name": f"{LICENSE_NAMES[lic]} {version}".strip() if lic.startswith("by") else LICENSE_NAMES[lic],
            "license_url": r.get("license_url") or "",
            "tags": [t["name"] for t in (r.get("tags") or []) if t.get("name")][:15],
            "orig_width": r.get("width"),
            "orig_height": r.get("height"),
        })
    if remaining is not None:
        print(f"    (Openverse 남은 하루 한도: {remaining})")
    return out


# ── Wikimedia Commons ─────────────────────────────────────────────────
def _wikimedia_license(short: str) -> str | None:
    s = short.lower().replace("-", " ")
    if "nd" in s.split():
        return None
    if "cc0" in s:
        return "cc0"
    if "public domain" in s or s.startswith("pd"):
        return "pdm"
    if s.startswith("cc by nc sa"):
        return "by-nc-sa"
    if s.startswith("cc by nc"):
        return "by-nc"
    if s.startswith("cc by sa"):
        return "by-sa"
    if s.startswith("cc by"):
        return "by"
    return None  # GFDL 단독, 불명 등은 제외


def search_wikimedia(session: requests.Session, q: str, page: int, page_size: int) -> list[dict]:
    resp = session.get(
        "https://commons.wikimedia.org/w/api.php",
        params={
            "action": "query", "format": "json", "generator": "search",
            "gsrsearch": f"{q} filetype:bitmap", "gsrnamespace": 6, "gsrlimit": page_size,
            "gsroffset": (page - 1) * page_size, "prop": "imageinfo",
            "iiprop": "url|extmetadata|size|mime", "iiurlwidth": MAX_LONG_SIDE,
        },
        timeout=30,
    )
    resp.raise_for_status()
    out = []
    for p in (resp.json().get("query", {}).get("pages", {}) or {}).values():
        info = (p.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        short = (meta.get("LicenseShortName") or {}).get("value", "")
        lic = _wikimedia_license(short)
        if not lic or info.get("mime") not in ("image/jpeg", "image/png"):
            continue
        out.append({
            "source": "wikimedia",
            "source_id": str(p.get("pageid")),
            "provider": "wikimedia",
            "original_url": info.get("thumburl") or info.get("url"),
            "landing_url": info.get("descriptionurl"),
            "title": re.sub(r"^File:|\.\w+$", "", p.get("title", "")),
            "creator": strip_html((meta.get("Artist") or {}).get("value")),
            "creator_url": "",
            "license": lic,
            "license_name": short,
            "license_url": (meta.get("LicenseUrl") or {}).get("value", ""),
            "tags": [],
            "orig_width": info.get("width"),
            "orig_height": info.get("height"),
        })
    return out


# ── Flickr ────────────────────────────────────────────────────────────
# Flickr 라이선스 id → 내부 코드 (ND 계열 3, 6과 All Rights Reserved 0은 제외)
FLICKR_LICENSES = {"1": "by-nc-sa", "2": "by-nc", "4": "by", "5": "by-sa", "9": "cc0", "10": "pdm"}


def search_flickr(session: requests.Session, q: str, page: int, page_size: int, api_key: str) -> list[dict]:
    resp = session.get(
        "https://www.flickr.com/services/rest/",
        params={
            "method": "flickr.photos.search", "api_key": api_key, "text": q,
            "license": ",".join(FLICKR_LICENSES), "content_type": 1, "safe_search": 1,
            "media": "photos", "sort": "relevance", "per_page": page_size, "page": page,
            "extras": "license,owner_name,url_l,url_c,tags,o_dims", "format": "json", "nojsoncallback": 1,
        },
        timeout=30,
    )
    resp.raise_for_status()
    out = []
    for p in resp.json().get("photos", {}).get("photo", []):
        url = p.get("url_l") or p.get("url_c")
        lic = FLICKR_LICENSES.get(str(p.get("license")))
        if not url or not lic:
            continue
        out.append({
            "source": "flickr",
            "source_id": p["id"],
            "provider": "flickr",
            "original_url": url,
            "landing_url": f"https://www.flickr.com/photos/{p['owner']}/{p['id']}",
            "title": p.get("title", ""),
            "creator": p.get("ownername", ""),
            "creator_url": f"https://www.flickr.com/photos/{p['owner']}",
            "license": lic,
            "license_name": LICENSE_NAMES[lic],
            "license_url": "",
            "tags": (p.get("tags") or "").split()[:15],
            "orig_width": int(p.get("width_l") or p.get("width_c") or 0),
            "orig_height": int(p.get("height_l") or p.get("height_c") or 0),
        })
    return out


# ── 다운로드 ──────────────────────────────────────────────────────────
def download(session: requests.Session, url: str) -> tuple[Image.Image, str] | None:
    try:
        resp = session.get(url, timeout=40)
        if resp.status_code != 200 or len(resp.content) < 5_000:
            return None
        img = Image.open(io.BytesIO(resp.content))
        img.load()
    except Exception as exc:  # 깨진 파일, 타임아웃 등은 건너뛴다
        print(f"      ! 다운로드 실패: {exc}")
        return None
    if min(img.size) < MIN_SHORT_SIDE:
        return None
    return img.convert("RGB"), hashlib.sha1(resp.content).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="이 문자열이 들어간 검색어만 실행")
    ap.add_argument("--dry-run", action="store_true", help="다운로드하지 않고 검색 결과 수만 출력")
    ap.add_argument("--max-per-query", type=int, default=12, help="검색어당 저장할 최대 장수")
    args = ap.parse_args()

    env = load_env()
    session = requests.Session()
    session.headers["User-Agent"] = user_agent(env)
    use_wikimedia = bool(env.get("CONTACT", "").strip())
    flickr_key = env.get("FLICKR_API_KEY", "").strip()
    print(f"출처: Openverse{' + Wikimedia' if use_wikimedia else ''}{' + Flickr' if flickr_key else ''}")
    if not use_wikimedia:
        print("  (Wikimedia 직접 검색은 .env의 CONTACT가 없어 건너뜀. Openverse가 Wikimedia·Flickr 사진을 일부 포함함)")
    if not flickr_key:
        print("  (Flickr 직접 검색은 FLICKR_API_KEY가 없어 건너뜀)")

    cfg = yaml.safe_load(QUERIES_PATH.read_text(encoding="utf-8"))
    defaults = cfg.get("defaults", {})
    sources: list[dict] = read_json(SOURCES_PATH, [])
    seen_urls = {s["original_url"] for s in sources}
    seen_hash = {s["sha1"] for s in sources}
    done_queries = {s["query"] for s in sources}
    next_no = max((int(s["id"].split("_")[1]) for s in sources), default=0) + 1
    IMAGES.mkdir(parents=True, exist_ok=True)

    for entry in cfg["queries"]:
        q = entry["q"]
        if args.only and args.only not in q:
            continue
        if q in done_queries and not args.only:
            print(f"- {q}: 이미 수집함, 건너뜀")
            continue
        print(f"- {q}")
        candidates: list[dict] = []
        for page in range(1, entry.get("pages", defaults.get("pages", 1)) + 1):
            page_size = defaults.get("page_size", 20)
            try:
                candidates += search_openverse(session, q, page, page_size)
                time.sleep(REQUEST_DELAY)
                if use_wikimedia:
                    candidates += search_wikimedia(session, q, page, page_size)
                    time.sleep(1.0)
                if flickr_key:
                    candidates += search_flickr(session, q, page, page_size, flickr_key)
                    time.sleep(1.0)
            except RuntimeError as exc:
                print(f"  ! {exc}")
                write_json(SOURCES_PATH, sources)
                sys.exit(1)
            except requests.RequestException as exc:
                print(f"  ! 검색 실패: {exc}")
        print(f"    후보 {len(candidates)}건")
        if args.dry_run:
            continue

        saved = 0
        for c in candidates:
            if saved >= args.max_per_query:
                break
            if c["original_url"] in seen_urls:
                continue
            seen_urls.add(c["original_url"])
            if c["orig_width"] and c["orig_height"] and min(c["orig_width"], c["orig_height"]) < MIN_SHORT_SIDE:
                continue
            got = download(session, c["original_url"])
            time.sleep(DOWNLOAD_DELAY)
            if not got:
                continue
            img, sha1 = got
            if sha1 in seen_hash:
                continue
            seen_hash.add(sha1)
            resized = max(img.size) > MAX_LONG_SIDE
            if resized:
                img.thumbnail((MAX_LONG_SIDE, MAX_LONG_SIDE), Image.LANCZOS)
            img_id = f"img_{next_no:04d}"
            next_no += 1
            img.save(IMAGES / f"{img_id}.jpg", "JPEG", quality=90)
            sources.append({
                "id": img_id,
                "file": f"images/{img_id}.jpg",
                **{k: c[k] for k in ("source", "source_id", "provider", "original_url", "landing_url", "title",
                                      "creator", "creator_url", "license", "license_name", "license_url", "tags")},
                "query": q,
                "category_hint": entry.get("category"),
                "series_hint": entry.get("series"),
                "group_hint": entry.get("group"),
                "collected_at": date.today().isoformat(),
                "modified": "크기 축소, JPEG 재저장" if resized else "JPEG 재저장",
                "width": img.size[0],
                "height": img.size[1],
                "sha1": sha1,
            })
            saved += 1
        print(f"    저장 {saved}장 (누적 {len(sources)}장)")
        write_json(SOURCES_PATH, sources)

    print(f"\n완료: {len(sources)}장 → {SOURCES_PATH}")


if __name__ == "__main__":
    main()

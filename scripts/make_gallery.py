"""가상 갤러리용 사진 준비 (일상 사진 + 다른 굿즈 사진).

참여자에게 실물이나 사진 카드를 건네지 않아도 되도록, 앱 안에 폰 갤러리처럼 보이는 화면을 둔다.
거기에 깔아 둘 일상 사진을 Openverse에서 CC0 / Public Domain만 받아 온다. 과업 대상 사진은 앱이 맨 앞에 끼워 넣는다.

대상 사진만 굿즈라 티가 나지 않도록, 수집해 둔 굿즈 사진 몇 장(gallery.goods)을 일상 사진 사이에 섞는다.

입력  data/collect_queries.yaml 의 gallery 항목, data/image_sources.json(굿즈 사진 출처)
출력  data/gallery/gal_NN.jpg, data/gallery_sources.json   원본과 출처 기록
      web/gallery/gal_NN.webp, web/data/gallery.json       앱이 쓰는 사진과 목록

이미 받은 검색어는 다시 받지 않는다. 사진을 바꾸려면 skip에 Openverse id를 적고 다시 실행한다.
"""
from __future__ import annotations

import random
import time
from datetime import date

import requests
import yaml
from PIL import Image

from collect_images import DOWNLOAD_DELAY, REQUEST_DELAY, download, user_agent
from common import DATA, WEB, WEB_DATA, load_env, read_json, write_json, write_manifest

SOURCES_PATH = DATA / "gallery_sources.json"
RAW_DIR = DATA / "gallery"
OUT_DIR = WEB / "gallery"
SIZE = 720
SEED = 7   # 굿즈 사진을 섞는 위치 (바꾸지 않으면 매번 같은 순서)
LICENSE_NAMES = {"cc0": "CC0 1.0", "pdm": "Public Domain Mark 1.0"}


def search(session: requests.Session, q: str) -> list[dict]:
    resp = session.get("https://api.openverse.org/v1/images/",
                       params={"q": q, "license": "cc0,pdm", "category": "photograph", "page_size": 20}, timeout=30)
    if resp.status_code == 429:
        raise SystemExit("Openverse 사용 한도 초과(429)")
    resp.raise_for_status()
    return resp.json().get("results", [])


def main() -> None:
    cfg = yaml.safe_load((DATA / "collect_queries.yaml").read_text(encoding="utf-8"))["gallery"]
    skip = set(cfg.get("skip") or [])
    session = requests.Session()
    session.headers["User-Agent"] = user_agent(load_env())
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    sources = [s for s in read_json(SOURCES_PATH, []) if s["source_id"] not in skip]
    done = {s["query"] for s in sources}
    used = {s["source_id"] for s in sources}
    for q in cfg["queries"]:
        if q in done:
            continue
        results = search(session, q)
        time.sleep(REQUEST_DELAY)
        for r in results:
            if r["id"] in skip or r["id"] in used or (r.get("license") or "").lower() not in LICENSE_NAMES:
                continue
            got = download(session, r["url"])
            time.sleep(DOWNLOAD_DELAY)
            if not got:
                continue
            img, sha1 = got
            n = max((int(s["id"].split("_")[1]) for s in sources), default=0) + 1
            gid = f"gal_{n:02d}"
            img.thumbnail((1280, 1280), Image.LANCZOS)
            img.save(RAW_DIR / f"{gid}.jpg", "JPEG", quality=90)
            lic = r["license"].lower()
            sources.append({
                "id": gid, "source": "openverse", "source_id": r["id"], "provider": r.get("provider"), "query": q,
                "original_url": r["url"], "landing_url": r.get("foreign_landing_url"), "title": r.get("title") or "",
                "creator": r.get("creator") or "", "license": lic, "license_name": LICENSE_NAMES[lic],
                "license_url": r.get("license_url") or "", "collected_at": date.today().isoformat(), "modified": "크기 축소, 재저장",
                "sha1": sha1,
            })
            used.add(r["id"])
            print(f"- {q}: {gid} ({r.get('provider')}, {LICENSE_NAMES[lic]}) {r.get('title') or ''}"[:110])
            break
        else:
            print(f"- {q}: 쓸 수 있는 사진을 찾지 못함")
    write_json(SOURCES_PATH, sources)

    # 굿즈 사진: 이미 수집한 사진(data/images)을 쓴다
    image_sources = {s["id"]: s for s in read_json(DATA / "image_sources.json", [])}
    goods = []
    for img_id in cfg.get("goods") or []:
        s = image_sources[img_id]
        goods.append({**s, "id": f"goods_{img_id}", "raw": DATA / s["file"], "kind": "goods"})
    daily = [{**s, "raw": RAW_DIR / f"{s['id']}.jpg", "kind": "daily"} for s in sources]

    # 일상 사진 사이사이에 굿즈 사진을 끼워 넣는다 (위치는 SEED로 고정)
    order = list(daily)
    rng = random.Random(SEED)
    for g, pos in zip(goods, sorted(rng.sample(range(1, len(daily) + len(goods)), len(goods)))):
        order.insert(pos, g)

    # 앱용 파일. 지난 실행의 남은 파일은 지운다
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    keep = set()
    for s in order:
        img = Image.open(s["raw"]).convert("RGB")
        img.thumbnail((SIZE, SIZE), Image.LANCZOS)
        img.save(OUT_DIR / f"{s['id']}.webp", "WEBP", quality=80, method=6)
        keep.add(f"{s['id']}.webp")
    for old in OUT_DIR.glob("*.webp"):
        if old.name not in keep:
            old.unlink()
    keys = ("id", "kind", "title", "creator", "license_name", "license_url", "landing_url", "modified")
    write_json(WEB_DATA / "gallery.json", [{**{k: s.get(k) for k in keys}, "file": f"gallery/{s['id']}.webp"} for s in order], indent=None)
    write_manifest()
    print(f"가상 갤러리: 일상 사진 {len(daily)}장 + 굿즈 사진 {len(goods)}장 → {OUT_DIR}")
    print("  순서(대상 사진 다음부터):", " ".join(("[굿즈]" if s["kind"] == "goods" else "·") for s in order))


if __name__ == "__main__":
    main()

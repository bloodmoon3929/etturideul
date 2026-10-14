"""더미 게시물 생성 (PLAN 4.1, 4.2, M2).

입력
  data/draft_curation.json   사진별 게시물 문구(제목·설명·가격·상태·태그)와 같은 상품 그룹(product_key)
  data/extra_posts.yaml      Task용으로 더하는 게시물(같은 상품 여러 개, 이름 없는 제목, 일괄 판매)과 기존 게시물 수정
  data/image_review.json     (있으면) 사람 검수 결과. rejected 사진의 게시물은 빼고, 검수자가 고친 값으로 덮어쓴다
출력
  data/posts.json            게시물 (PLAN 4.1 스키마 + title_style, product_name, seller)
  data/users.json            3D 취향 지도용 가상 사용자 (PLAN 4.2.1)

판매자·위치·날짜는 모두 가상 값이며, 같은 입력이면 항상 같은 결과가 나온다(시드 고정).
"""
from __future__ import annotations

import argparse
import random
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import yaml

from common import CATEGORIES, DATA, read_json, write_json

SEED = 20261014
BASE_DATE = date(2026, 10, 12)
LOCATIONS = ["별빛동", "솔내음동", "은하수동", "달맞이동", "새벽동", "가람동", "한울동", "꽃내동"]
SELLER_WORDS = ["굿즈창고", "덕질졸업", "피규어정리", "책상비우기", "수집가", "이사정리", "굿즈나눔", "취미방"]
CONDITIONS = ["미개봉", "거의 새것", "사용감 있음", "박스 없음"]
TITLE_STYLES = ["formal", "abbr", "typo", "char_only", "no_series", "english", "generic"]   # generic: "인형 팝니다"처럼 상품 이름이 없는 제목

# 가상 사용자: 어떤 게시물을 찜했을지 고르는 규칙
PERSONAS = [
    {"id": "u1", "name": "피규어 수집가", "desc": "스케일·액션 피규어 위주로 모음", "category": "피규어", "n": 12},
    {"id": "u2", "name": "건프라 빌더", "desc": "건담 프라모델만 찾음", "series": "건담", "n": 10},
    {"id": "u3", "name": "미쿠 팬", "desc": "보컬로이드 굿즈라면 종류 불문", "series": "보컬로이드", "n": 9},
    {"id": "u4", "name": "인형 덕후", "desc": "폭신한 인형 위주", "category": "인형", "n": 10},
    {"id": "u5", "name": "포켓몬 트레이너", "desc": "포켓몬스터 굿즈 전반", "series": "포켓몬스터", "n": 8},
    {"id": "u6", "name": "랜덤 굿즈 러버", "desc": "가챠·블라인드 박스·뱃지 수집", "category": "랜덤 굿즈/뱃지", "n": 8},
    {"id": "u7", "name": "잡식 수집가", "desc": "분야를 가리지 않고 이것저것", "n": 12},
]


def card_images() -> set[str]:
    """Task 대상 사진(protocol.yaml의 card_image_source). 게시물에서는 뺀다(검색 대상에 같은 사진이 있으면 Task가 너무 쉬워진다)."""
    path = DATA / "protocol.yaml"
    if not path.exists():
        return set()
    protocol = yaml.safe_load(path.read_text(encoding="utf-8"))
    return {t["card_image_source"] for tasks in protocol.get("targets", {}).values() for t in tasks.values()
            if isinstance(t, dict) and t.get("card_image_source")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(DATA / "draft_curation.json"), help="게시물 문구 파일")
    args = ap.parse_args()
    rng = random.Random(SEED)
    curation = read_json(Path(args.input))
    if not curation:
        raise SystemExit(f"{args.input}이 없습니다")
    held_out = card_images()
    # Task용 추가 게시물과 기존 게시물 수정
    extra_path = DATA / "extra_posts.yaml"
    extra = yaml.safe_load(extra_path.read_text(encoding="utf-8")) if extra_path.exists() else {}
    overrides = extra.get("overrides") or {}
    curation["posts"] = [{**e, **overrides.get(e["image_id"], {})} for e in curation["posts"]]
    curation["posts"] += [{"image_id": p["image"], **{k: v for k, v in p.items() if k != "image"}} for p in extra.get("posts") or []]
    review = {r["image_id"]: r for r in (read_json(DATA / "image_review.json", {}) or {}).get("items", [])}
    sources = {s["id"] for s in read_json(DATA / "image_sources.json", [])}

    entries, dropped = [], []
    for e in curation["posts"]:
        r = review.get(e["image_id"])
        if e["image_id"] in held_out:
            continue
        if r and r.get("status") == "rejected":
            dropped.append(e["image_id"])
            continue
        if r:  # 검수자가 고친 값 반영
            e = {**e, **{k: r[k] for k in ("category", "series", "product_key") if r.get(k)}}
        problems = []
        if e["image_id"] not in sources:
            problems.append("출처 기록 없음")
        if e["category"] not in CATEGORIES:
            problems.append(f"카테고리 '{e['category']}'")
        if e["condition"] not in CONDITIONS:
            problems.append(f"상태 '{e['condition']}'")
        if e["title_style"] not in TITLE_STYLES:
            problems.append(f"title_style '{e['title_style']}'")
        if problems:
            raise SystemExit(f"{e['image_id']}: {', '.join(problems)}")
        entries.append(e)

    # '최신순' 정렬에서 같은 상품이 나란히 나오지 않도록 순서와 날짜를 섞는다
    rng.shuffle(entries)
    posts = []
    for i, e in enumerate(entries, 1):
        posts.append({
            "id": f"p{i:03d}",
            "title": e["title"],
            "description": e["description"],
            "price": int(e["price"]),
            "category": e["category"],
            "series": e["series"],
            "product_key": e["product_key"],
            "product_name": e.get("product_name", ""),
            "condition": e["condition"],
            "tags": e["tags"],
            "title_style": e["title_style"],
            # 썸네일 이름은 게시물 번호가 아니라 사진 id로 짓는다. 폰은 썸네일을 한 번 받으면 캐시에서만 꺼내므로,
            # 번호로 지으면 데이터를 다시 만들어 번호가 다른 사진에 붙었을 때 예전 사진이 새 제목 옆에 뜬다
            "image": f"thumbs/{e['image_id']}.webp",
            "image_large": f"thumbs/{e['image_id']}_l.webp",
            "image_source_id": e["image_id"],
            "augmented": "_a" in e["image_id"],
            # 판매가와 실제 가격이 다른 게시물(본문에서만 가격을 바꿈, 일괄 판매)의 실제 가격. 평가에만 쓴다
            **({"real_prices": e["real_prices"]} if e.get("real_prices") else {}),
            "location": rng.choice(LOCATIONS),
            "seller": f"{rng.choice(SELLER_WORDS)}{rng.randint(10, 99)}",
            "created_at": (BASE_DATE - timedelta(days=rng.randint(0, 29))).isoformat(),
        })
    write_json(DATA / "posts.json", posts)

    users = []
    for p in PERSONAS:
        pool = [x for x in posts if all(x.get(k) == p[k] for k in ("category", "series") if k in p)]
        likes = rng.sample(pool, min(p["n"], len(pool)))
        if len(likes) < 5:
            print(f"  ! 가상 사용자 '{p['name']}': 조건에 맞는 게시물이 {len(likes)}개뿐이라 제외")
            continue
        users.append({"id": p["id"], "name": p["name"], "desc": p["desc"], "likes": sorted(x["id"] for x in likes)})
    write_json(DATA / "users.json", users)

    groups = defaultdict(list)
    for x in posts:
        groups[x["product_key"]].append(x["id"])
    multi = {k: v for k, v in groups.items() if len(v) >= 2}
    print(f"게시물 {len(posts)}개 (검수에서 제외 {len(dropped)}개, Task 대상 사진으로 뺀 사진 {len(held_out)}장), 가상 사용자 {len(users)}명")
    no_text = sorted(i for i, r in review.items() if r.get("status") == "approved" and i not in {e["image_id"] for e in curation["posts"]})
    if no_text:
        print(f"  ! 검수에서 승인했지만 게시물 문구가 없는 사진 {len(no_text)}장: {', '.join(no_text[:20])}{' …' if len(no_text) > 20 else ''}")
    print("카테고리:", dict(Counter(x["category"] for x in posts)))
    print("제목 유형:", dict(Counter(x["title_style"] for x in posts)))
    print(f"같은 상품 그룹(2개 이상): {len(multi)}개, 시리즈 {len({x['series'] for x in posts})}종")
    if len(posts) < 60 or len(multi) < 15:
        print("  ! PLAN 4.2 기준(게시물 60개 이상, 같은 상품 그룹 15개 이상)에 못 미칩니다 → 사진 추가 수집 또는 증강(augment_images.py) 필요")


if __name__ == "__main__":
    main()

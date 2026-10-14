"""게시물 색인 생성 (PLAN 5장, 6.3, M2). 폰이 쓰는 것과 같은 ONNX 모델로 임베딩한다.

입력   data/posts.json, data/images/, data/image_sources.json, data/protocol.yaml
출력   web/thumbs/pNNN.webp(목록용), pNNN_l.webp(상세용)
       web/data/posts.json            게시물
       web/data/embeddings.bin        Float32, [3종(img, txt, 통합) × 게시물 수 × 512]
       web/data/embeddings_meta.json  id 순서, 모델 변형, 가중치
       web/data/similar.json          게시물별 비슷한 게시물 상위 K개 (원시 코사인)
       web/data/image_sources.json    화면 표기용 출처(작성자·라이선스·원본 링크)
       web/data/protocol.json         과업 정의 (protocol.yaml을 브라우저가 읽을 수 있게 변환)
       web/data/manifest.json         오프라인 준비용 파일 목록

사용법  python scripts/build_index.py [--variant q8|fp16|fp32]
"""
from __future__ import annotations

import argparse
import re

import numpy as np
import yaml
from PIL import Image

from common import DATA, EMBED_DIM, IMAGES, THUMBS, W_IMG, W_TXT, WEB_DATA, read_json, write_json, write_manifest
from embedder import Embedder, normalize, post_text

TOP_K = 12
THUMB_SIZE, LARGE_SIZE = 360, 960


def make_thumbs(posts: list[dict]) -> None:
    THUMBS.mkdir(parents=True, exist_ok=True)
    keep = set()
    for p in posts:
        src = Image.open(IMAGES / f"{p['image_source_id']}.jpg").convert("RGB")
        for rel, size, quality in ((p["image"], THUMB_SIZE, 78), (p["image_large"], LARGE_SIZE, 82)):
            img = src.copy()
            img.thumbnail((size, size), Image.LANCZOS)
            out = THUMBS.parent / rel
            img.save(out, "WEBP", quality=quality, method=6)
            keep.add(out.name)
    for old in THUMBS.glob("*.webp"):   # 지난 빌드의 남은 파일 정리 (과업 카드 이미지는 build_protocol이 다시 만든다)
        if old.name not in keep:
            old.unlink()


# ── 판매가와 본문 금액 비교 ────────────────────────────────────────────
# 본문에서 "15,000원", "2만원" 같은 금액을 찾아 판매가와 비교한다. 앱은 결과가 있는 게시물에 "가격 확인" 안내를 띄운다.
AMOUNT = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)\s*원|(\d+(?:\.\d+)?)\s*만\s*원?")
SKIP_WORDS = ("택배", "배송", "배달", "정가", "원가")   # 판매가와 상관없는 금액이 나오는 문장은 건너뛴다


def price_check(post: dict) -> dict | None:
    found = []
    # 쉼표는 천 단위 구분(30,000)이 아닐 때만 문장을 나눈다
    for clause in re.split(r"\n|,(?!\d{3})|[/·]|(?<=[.!?])\s", post["description"]):
        if any(word in clause for word in SKIP_WORDS):
            continue
        prev_end = 0
        for m in AMOUNT.finditer(clause):
            amount = int(m.group(1).replace(",", "")) if m.group(1) else int(float(m.group(2)) * 10000)
            label = re.sub(r"\s+", " ", clause[prev_end:m.start()]).strip(" :-")   # 금액 바로 앞의 말(상품 이름 등)
            found.append({"label": label, "price": amount})
            prev_end = m.end()
    if not found:
        return None
    listed = post["price"]
    if listed <= 1000:   # 일괄 판매: 판매가를 1원처럼 임시로 적고 본문에 가격을 쓴 경우
        return {"status": "bundle", "listed": listed, "mentioned": found}
    if any(abs(f["price"] - listed) / listed > 0.03 for f in found):
        return {"status": "mismatch", "listed": listed, "mentioned": found}
    return None


def build_protocol(protocol: dict, posts: list[dict]) -> dict:
    """과업 대상의 사진 id를 앱이 쓰는 값(과업 카드 이미지 경로, 게시물 id)으로 바꾸고, 대상이 실제로 있는지 확인한다."""
    by_image = {p["image_source_id"]: p["id"] for p in posts}
    keys = {p["product_key"] for p in posts}
    series = {p["series"] for p in posts}
    for set_name, tasks in protocol.get("targets", {}).items():
        for task_id, t in tasks.items():
            where = f"targets.{set_name}.{task_id}"
            if t.get("product_key") and t["product_key"] not in keys:
                print(f"  ! {where}: product_key '{t['product_key']}'인 게시물이 없습니다")
            if t.get("series") and t["series"] not in series:
                print(f"  ! {where}: series '{t['series']}'인 게시물이 없습니다")
            if t.get("card_image_source"):
                rel = f"thumbs/card_{t['card_image_source']}.webp"   # 사진 id로 이름을 지어 캐시가 엇갈리지 않게 한다
                img = Image.open(IMAGES / f"{t['card_image_source']}.jpg").convert("RGB")
                img.thumbnail((LARGE_SIZE, LARGE_SIZE), Image.LANCZOS)
                img.save(THUMBS.parent / rel, "WEBP", quality=82, method=6)
                t["card_image"] = rel
            if t.get("seed_image"):
                t["seed_post"] = by_image.get(t["seed_image"])
                if not t["seed_post"]:
                    print(f"  ! {where}: seed_image '{t['seed_image']}'가 게시물에 없습니다")
    return protocol


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="q8", choices=["q8", "fp16", "fp32"], help="폰이 쓰는 모델 변형과 맞춘다")
    args = ap.parse_args()

    posts = read_json(DATA / "posts.json")
    if not posts:
        raise SystemExit("data/posts.json이 없습니다. 먼저 make_dummy.py를 실행하세요")
    print(f"[1/4] 썸네일 {len(posts)}개")
    make_thumbs(posts)

    print(f"[2/4] 임베딩 ({args.variant})")
    emb = Embedder(args.variant)
    v_img = emb.images([IMAGES / f"{p['image_source_id']}.jpg" for p in posts])
    v_txt = emb.texts([post_text(p) for p in posts])
    v = normalize(W_IMG * v_img + W_TXT * v_txt)
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    np.stack([v_img, v_txt, v]).astype(np.float32).tofile(WEB_DATA / "embeddings.bin")
    write_json(WEB_DATA / "embeddings_meta.json", {
        "ids": [p["id"] for p in posts], "count": len(posts), "dim": EMBED_DIM,
        "kinds": ["img", "txt", "combined"], "model_variant": args.variant, "w_img": W_IMG, "w_txt": W_TXT,
    })

    print(f"[3/4] 비슷한 게시물 상위 {TOP_K}개")
    sim, sim_img, sim_txt = v @ v.T, v_img @ v_img.T, v_txt @ v_txt.T
    np.fill_diagonal(sim, -1)
    similar = {}
    for i, p in enumerate(posts):
        order = np.argsort(-sim[i])[:TOP_K]
        similar[p["id"]] = [{"id": posts[j]["id"], "s": round(float(sim[i, j]), 4),
                             "si": round(float(sim_img[i, j]), 4), "st": round(float(sim_txt[i, j]), 4)} for j in order]
    write_json(WEB_DATA / "similar.json", similar, indent=None)

    print("[4/4] 게시물·출처·과업 정의·파일 목록")
    flagged = 0
    for p in posts:
        check = price_check(p)
        if check:
            p["price_check"] = check
            flagged += 1
    print(f"  판매가와 본문 금액이 다른 게시물 {flagged}개")
    write_json(WEB_DATA / "posts.json", posts, indent=None)
    used = {p["image_source_id"] for p in posts}
    credit_keys = ("id", "title", "creator", "creator_url", "license_name", "license_url", "landing_url", "provider", "modified")
    write_json(WEB_DATA / "image_sources.json",
               [{k: s.get(k) for k in credit_keys} for s in read_json(DATA / "image_sources.json") if s["id"] in used], indent=None)
    protocol_path = DATA / "protocol.yaml"
    if protocol_path.exists():
        write_json(WEB_DATA / "protocol.json", build_protocol(yaml.safe_load(protocol_path.read_text(encoding="utf-8")), posts), indent=None)
    else:
        print("  ! data/protocol.yaml이 없어 protocol.json을 만들지 않음")

    version = write_manifest()
    size = sum(f.stat().st_size for f in THUMBS.glob("*.webp")) / 1e6
    print(f"완료: 게시물 {len(posts)}개, 썸네일 {size:.1f}MB, 데이터 버전 {version}")
    print("다음: python scripts/calibrate.py && python scripts/build_graph.py")


if __name__ == "__main__":
    main()

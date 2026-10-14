"""점수 재보정 (PLAN 5.3, M4).

CLIP 코사인은 쿼리 종류에 따라 분포가 크게 다르다(텍스트↔이미지는 보통 0.2~0.35).
그래서 쿼리 종류별로 정답 쌍의 분포를 보고, 원시 코사인을 표시용 점수(0~1)로 옮기는 구간별 직선을 만든다.

  표시용 0.90 = "같은 상품"과 그 밖을 가장 잘 가르는 원시 점수 (F1 최대)
  표시용 0.65 = "같은 상품·같은 시리즈"와 무관한 게시물을 가장 잘 가르는 원시 점수 (F1 최대)

쿼리 종류
  post        게시물 → 게시물 (통합 벡터끼리, [비슷한 게시물 찾기])
  text        글 검색 → 게시물 통합 벡터
  image       사진 검색 → 게시물 통합 벡터
  image_text  사진 + 글 검색 → 게시물 통합 벡터

입력  web/data/embeddings.bin (브라우저용 모델로 만든 벡터), data/posts.json
출력  web/data/calibration.json (클라이언트가 그대로 사용), reports/calibration.md

분포 히스토그램 PNG와 Recall@5 표는 evaluate.py(M4)에서 만든다.
"""
from __future__ import annotations

import numpy as np

from common import DATA, REPORTS, TIER_SAME, TIER_SIMILAR, W_IMG, W_TXT, WEB_DATA, read_json, write_json, write_manifest
from embedder import Embedder, load_index, normalize

LABELS = ("same", "series", "other")


def best_f1(pos: np.ndarray, neg: np.ndarray) -> tuple[float, float, float, float]:
    """pos와 neg를 가르는 임계값 중 F1이 가장 큰 값. → (임계값, 정밀도, 재현율, F1)"""
    best = (float(np.median(pos)) if len(pos) else 0.0, 0.0, 0.0, 0.0)
    if not len(pos) or not len(neg):
        return best
    for thr in np.unique(np.quantile(np.concatenate([pos, neg]), np.linspace(0, 1, 400))):
        tp, fp = (pos >= thr).sum(), (neg >= thr).sum()
        if tp == 0:
            continue
        precision, recall = tp / (tp + fp), tp / len(pos)
        f1 = 2 * precision * recall / (precision + recall)
        if f1 > best[3]:
            best = (float(thr), float(precision), float(recall), float(f1))
    return best


def make_curve(scores: dict[str, np.ndarray]) -> dict:
    same, series, other = (scores[k] for k in LABELS)
    thr_same, p_same, r_same, f_same = best_f1(same, np.concatenate([series, other]))
    thr_sim, p_sim, r_sim, f_sim = best_f1(np.concatenate([same, series]), other)
    thr_sim = min(thr_sim, thr_same - 0.01)
    everything = np.concatenate([same, series, other])
    lo = min(float(np.quantile(everything, 0.01)), thr_sim - 0.01)
    hi = max(float(np.quantile(same, 0.99)) if len(same) else thr_same + 0.05, thr_same + 0.01)
    return {
        "knots": [[round(lo, 4), 0.0], [round(thr_sim, 4), TIER_SIMILAR], [round(thr_same, 4), TIER_SAME], [round(hi, 4), 1.0]],
        "n": {k: int(len(scores[k])) for k in LABELS},
        "median": {k: round(float(np.median(scores[k])), 4) if len(scores[k]) else None for k in LABELS},
        "same": {"threshold": round(thr_same, 4), "precision": round(p_same, 3), "recall": round(r_same, 3), "f1": round(f_same, 3)},
        "similar": {"threshold": round(thr_sim, 4), "precision": round(p_sim, 3), "recall": round(r_sim, 3), "f1": round(f_sim, 3)},
    }


def collect(sim: np.ndarray, q_keys: list[str], q_series: list[str], posts: list[dict], skip_self: list[int] | None) -> dict:
    """쿼리×게시물 점수 행렬을 정답 관계(같은 상품 / 같은 시리즈 / 그 밖)별로 나눈다."""
    out = {k: [] for k in LABELS}
    for qi in range(sim.shape[0]):
        for pj, post in enumerate(posts):
            if skip_self is not None and skip_self[qi] == pj:
                continue
            if post["product_key"] == q_keys[qi]:
                out["same"].append(sim[qi, pj])
            elif post["series"] == q_series[qi] and post["series"] != "기타":
                out["series"].append(sim[qi, pj])
            else:
                out["other"].append(sim[qi, pj])
    return {k: np.array(v, dtype=np.float32) for k, v in out.items()}


def main() -> None:
    posts = read_json(DATA / "posts.json")
    meta, v_img, v_txt, v = load_index(WEB_DATA)
    assert meta["ids"] == [p["id"] for p in posts], "posts.json과 embeddings.bin의 순서가 다릅니다. build_index.py를 다시 실행하세요"
    keys = [p["product_key"] for p in posts]
    series = [p["series"] for p in posts]
    own = list(range(len(posts)))

    # 글 검색 쿼리: 게시물 제목(실제 사용자가 칠 법한 표현) + 상품 그룹의 정식 명칭
    emb = Embedder(meta["model_variant"])
    t_title = emb.texts([p["title"] for p in posts])
    names = sorted({(p["product_key"], p["series"], p["product_name"]) for p in posts if p.get("product_name")})
    t_name = emb.texts([n[2] for n in names]) if names else np.zeros((0, v.shape[1]), dtype=np.float32)

    text_title = collect(t_title @ v.T, keys, series, posts, own)
    text_name = collect(t_name @ v.T, [n[0] for n in names], [n[1] for n in names], posts, None)
    q_image_text = normalize(W_IMG * v_img + W_TXT * t_title)
    scores = {
        "post": collect(v @ v.T, keys, series, posts, own),
        "text": {k: np.concatenate([text_title[k], text_name[k]]) for k in LABELS},
        "image": collect(v_img @ v.T, keys, series, posts, own),
        "image_text": collect(q_image_text @ v.T, keys, series, posts, own),
    }
    curves = {kind: make_curve(s) for kind, s in scores.items()}
    write_json(WEB_DATA / "calibration.json", {
        "model_variant": meta["model_variant"], "tiers": {"same": TIER_SAME, "similar": TIER_SIMILAR}, "curves": curves,
    })
    write_manifest()

    titles = {"post": "게시물 → 게시물", "text": "글 검색", "image": "사진 검색", "image_text": "사진 + 글 검색"}
    lines = [
        "# 점수 재보정 결과 (PLAN 5.3)", "",
        f"- 모델 변형: {meta['model_variant']} (브라우저용 모델로 만든 벡터 기준), 게시물 {len(posts)}개",
        "- 표시용 점수 0.90 이상 = 같은 상품, 0.65~0.90 = 비슷한 상품. 아래 '원시 임계값'이 각각 0.90 / 0.65에 대응한다.",
        "- 정밀도·재현율은 같은 데이터로 임계값을 고른 값이라 낙관적이다(게시물 수가 적어 따로 나누지 않음).", "",
        "| 쿼리 종류 | 쌍 수 (같은 상품 / 같은 시리즈 / 그 밖) | 원시 중앙값 (같은 / 시리즈 / 그 밖) | 같은 상품 임계값 | 정밀도 | 재현율 | 비슷한 상품 임계값 | 정밀도 | 재현율 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for kind, c in curves.items():
        n, med = c["n"], c["median"]
        lines.append(
            f"| {titles[kind]} | {n['same']} / {n['series']} / {n['other']} | {med['same']} / {med['series']} / {med['other']} "
            f"| {c['same']['threshold']} | {c['same']['precision']} | {c['same']['recall']} "
            f"| {c['similar']['threshold']} | {c['similar']['precision']} | {c['similar']['recall']} |")
        print(f"{titles[kind]:10s} 같은 상품 ≥{c['same']['threshold']} (P {c['same']['precision']}, R {c['same']['recall']})  "
              f"비슷한 상품 ≥{c['similar']['threshold']} (P {c['similar']['precision']}, R {c['similar']['recall']})  n={n}")
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "calibration.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"완료 → {WEB_DATA / 'calibration.json'}, {REPORTS / 'calibration.md'}")


if __name__ == "__main__":
    main()

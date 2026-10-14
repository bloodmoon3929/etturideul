"""3D 취향 지도용 유사도 그래프 (PLAN 12.1, M6).

  노드   게시물. UMAP 3차원 좌표, 자동 군집 id, 연결 수
  엣지   통합 벡터 코사인 상위 k개 중 표시용 점수 0.65 이상. tier = same(0.90 이상) / similar
  군집   HDBSCAN. 라벨은 소속 게시물의 시리즈(없으면 카테고리) 최빈값
  사용자 가상 사용자의 취향 벡터(찜한 게시물 통합 벡터 평균)를 같은 UMAP 공간에 투영

입력  web/data/embeddings.bin, web/data/calibration.json, data/posts.json, data/users.json
출력  web/data/graph.json
"""
from __future__ import annotations

import warnings
from collections import Counter

import numpy as np

from common import DATA, TIER_SAME, TIER_SIMILAR, WEB_DATA, read_json, write_json, write_manifest
from embedder import load_index, normalize

warnings.filterwarnings("ignore")
SEED = 42
TOP_K = 5
EXTENT = 120.0   # 좌표를 이 범위(±)로 맞춘다


def calibrate(raw: np.ndarray, knots: list[list[float]]) -> np.ndarray:
    xs, ys = zip(*knots)
    return np.interp(raw, xs, ys)


def cluster_label(members: list[dict]) -> str:
    series = Counter(p["series"] for p in members if p["series"] != "기타")
    if series:
        name, count = series.most_common(1)[0]
        if count >= len(members) * 0.5:
            return name
    return Counter(p["category"] for p in members).most_common(1)[0][0]


def main() -> None:
    import umap
    from sklearn.cluster import HDBSCAN

    posts = read_json(DATA / "posts.json")
    users = read_json(DATA / "users.json", [])
    meta, _, _, v = load_index(WEB_DATA)
    knots = read_json(WEB_DATA / "calibration.json")["curves"]["post"]["knots"]
    index = {pid: i for i, pid in enumerate(meta["ids"])}

    reducer = umap.UMAP(n_components=3, n_neighbors=10, min_dist=0.3, metric="cosine", random_state=SEED)
    coords = reducer.fit_transform(v)
    center = coords.mean(0)
    scale = EXTENT / np.abs(coords - center).max()
    xyz = (coords - center) * scale

    labels = HDBSCAN(min_cluster_size=4, min_samples=2).fit_predict(coords)
    clusters = []
    for cid in sorted(set(labels) - {-1}):
        idx = np.where(labels == cid)[0]
        clusters.append({"id": int(cid), "label": cluster_label([posts[i] for i in idx]), "size": int(len(idx)),
                         **dict(zip("xyz", np.round(xyz[idx].mean(0), 1).tolist()))})
    seen = Counter()
    for c in clusters:   # 같은 이름의 군집이 여러 개면 번호를 붙인다
        seen[c["label"]] += 1
        if sum(1 for x in clusters if x["label"] == c["label"]) > 1:
            c["label"] = f"{c['label']} {seen[c['label']]}"

    sim = v @ v.T
    np.fill_diagonal(sim, -1)
    display = calibrate(sim, knots)
    links, degree = {}, Counter()
    for i in range(len(posts)):
        for j in np.argsort(-sim[i])[:TOP_K]:
            if display[i, j] < TIER_SIMILAR:
                continue
            key = (min(i, j), max(i, j))
            if key in links:
                continue
            links[key] = {"s": posts[key[0]]["id"], "t": posts[key[1]]["id"], "score": round(float(display[i, j]), 3),
                          "tier": "same" if display[i, j] >= TIER_SAME else "similar"}
            degree[key[0]] += 1
            degree[key[1]] += 1

    nodes = [{"id": p["id"], **dict(zip("xyz", np.round(xyz[i], 1).tolist())), "cluster": int(labels[i]), "deg": degree[i]}
             for i, p in enumerate(posts)]

    user_nodes = []
    for u in users:
        liked = [index[pid] for pid in u["likes"] if pid in index]
        taste = normalize(v[liked].mean(0))
        pos = (reducer.transform(taste[None, :])[0] - center) * scale
        order = [int(j) for j in np.argsort(-(v @ taste)) if int(j) not in liked][:5]
        user_nodes.append({"id": u["id"], "name": u["name"], "desc": u["desc"], **dict(zip("xyz", np.round(pos, 1).tolist())),
                           "likes": [posts[i]["id"] for i in liked], "recs": [posts[j]["id"] for j in order]})

    write_json(WEB_DATA / "graph.json", {"nodes": nodes, "links": list(links.values()), "clusters": clusters, "users": user_nodes}, indent=None)
    write_manifest()
    tiers = Counter(l["tier"] for l in links.values())
    print(f"노드 {len(nodes)}개, 엣지 {len(links)}개(same {tiers['same']}, similar {tiers['similar']}), "
          f"군집 {len(clusters)}개(미분류 {int((labels == -1).sum())}개), 사용자 {len(user_nodes)}명")
    print("군집:", ", ".join(f"{c['label']}({c['size']})" for c in clusters))


if __name__ == "__main__":
    main()

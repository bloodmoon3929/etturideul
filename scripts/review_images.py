"""수집한 사진의 사람 검수 페이지 (PLAN 4.3.3, 필수 단계).

  python scripts/review_images.py            # 검수 서버 실행 → 브라우저에서 http://127.0.0.1:8765 열기
  python scripts/review_images.py --build    # reports/image_review.html만 다시 만들기(서버 없이 열면 저장 대신 파일 내려받기)

검수 기준
  - 상품이 잘 보이는가 / 사람 얼굴·개인정보가 없는가 / 워터마크가 없는가
  - 같은 상품 사진끼리 같은 product_key를 주었는가

자동 보조
  - 거의 같은 사진(이미지 코사인 0.98 이상)을 "중복 의심"으로 표시
  - 검색어와 유사도가 낮은 사진을 "상품 아님 의심"으로 표시
  - data/draft_curation.json(초안 선별)이 있으면 승인/제외·카테고리·시리즈·product_key를 미리 채워 둔다

결과는 data/image_review.json에 저장되고, make_dummy.py가 읽어 제외된 사진의 게시물을 빼고 고친 값을 반영한다.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from common import CATEGORIES, DATA, IMAGES, REPORTS, ROOT, read_json, write_json

REVIEW_PATH = DATA / "image_review.json"
HTML_PATH = REPORTS / "image_review.html"
CACHE_PATH = DATA / "review_embeddings.npz"
DUP_THRESHOLD = 0.98
SUSPECT_QUANTILE = 0.10

PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>에뚜리들 사진 검수</title>
<style>
  body { margin:0; font:14px/1.45 system-ui,"Noto Sans KR",sans-serif; color:#2b2622; background:#faf6f0; }
  header { position:sticky; top:0; z-index:5; background:#fff; border-bottom:1px solid #e7dfd4; padding:10px 16px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  header b { font-size:16px; } button, select, input { font:inherit; }
  button { min-height:34px; padding:0 12px; border-radius:8px; border:1px solid #e7dfd4; background:#fff; cursor:pointer; }
  button.primary { background:#d9582b; border-color:#d9582b; color:#fff; font-weight:600; }
  button.on { background:#2b2622; color:#fff; border-color:#2b2622; }
  #grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:12px; padding:16px; }
  .item { background:#fff; border:2px solid #e7dfd4; border-radius:12px; overflow:hidden; }
  .item.approved { border-color:#2e7d4f; } .item.rejected { border-color:#b3261e; opacity:.55; }
  .item img { width:100%; height:220px; object-fit:contain; background:#f1eae0; cursor:zoom-in; }
  .body { padding:8px 10px 10px; display:flex; flex-direction:column; gap:6px; }
  .meta { font-size:12px; color:#756b62; overflow-wrap:anywhere; }
  .flags span { display:inline-block; font-size:11px; padding:0 6px; border-radius:6px; background:#fbe6dc; color:#d9582b; margin-right:4px; }
  .row { display:flex; gap:6px; } .row > * { flex:1; min-width:0; }
  input[type=text], select { min-height:32px; border:1px solid #e7dfd4; border-radius:8px; padding:2px 8px; width:100%; }
  #zoom { position:fixed; inset:0; background:rgba(0,0,0,.8); display:none; align-items:center; justify-content:center; z-index:10; }
  #zoom img { max-width:95vw; max-height:95vh; }
  .guide { padding:12px 16px 0; color:#756b62; }
</style></head><body>
<header>
  <b>사진 검수</b><span id="count"></span>
  <span id="filters"></span>
  <button class="primary" id="save">저장</button><span id="saved"></span>
</header>
<p class="guide">확인할 것: ① 상품이 잘 보이는지 ② 사람 얼굴·개인정보가 없는지 ③ 워터마크가 없는지 ④ 같은 상품 사진끼리 같은 product_key인지.
미리 채워진 값은 초안이므로 틀린 곳만 고치면 됩니다. 사진을 누르면 크게 보입니다.</p>
<div id="grid"></div><div id="zoom"><img alt=""></div>
<datalist id="keys"></datalist><datalist id="series"></datalist>
<script>
const ITEMS = __ITEMS__, CATEGORIES = __CATEGORIES__, IMG_BASE = __IMG_BASE__, CAN_SAVE = location.protocol.startsWith('http');
const FILTERS = [['all','전체'],['undecided','미정'],['approved','승인'],['rejected','제외'],['dup','중복 의심'],['suspect','상품 아님 의심'],['groups','같은 상품 그룹']];
let filter = 'all';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function groupCounts() { const m = {}; for (const it of ITEMS) if (it.status === 'approved' && it.product_key) m[it.product_key] = (m[it.product_key] || 0) + 1; return m; }
function visible(it, groups) {
  if (filter === 'all') return true;
  if (filter === 'dup') return it.dup_of.length > 0;
  if (filter === 'suspect') return it.suspect;
  if (filter === 'groups') return it.status === 'approved' && groups[it.product_key] >= 2;
  return it.status === filter;
}
function render() {
  const groups = groupCounts();
  const list = ITEMS.filter((it) => visible(it, groups));
  if (filter === 'groups') list.sort((a, b) => a.product_key.localeCompare(b.product_key));
  $('grid').innerHTML = list.map((it) => `
    <div class="item ${it.status}" data-id="${it.id}">
      <img loading="lazy" src="${IMG_BASE}${it.id}.jpg" alt="">
      <div class="body">
        <div><b>${it.id}</b> <span class="meta">${esc(it.query)}</span></div>
        <div class="meta">${esc(it.title)} · ${esc(it.creator)} · ${esc(it.license_name)}</div>
        <div class="flags">${it.dup_of.length ? `<span>중복 의심: ${it.dup_of.join(', ')}</span>` : ''}${it.suspect ? '<span>상품 아님 의심</span>' : ''}${it.reason ? `<span>${esc(it.reason)}</span>` : ''}</div>
        <div class="row">
          <button data-status="approved" class="${it.status === 'approved' ? 'on' : ''}">승인</button>
          <button data-status="rejected" class="${it.status === 'rejected' ? 'on' : ''}">제외</button>
          <button data-status="undecided" class="${it.status === 'undecided' ? 'on' : ''}">미정</button>
        </div>
        <select data-field="category">${['', ...CATEGORIES].map((c) => `<option ${c === (it.category || '') ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <div class="row">
          <input type="text" data-field="series" list="series" placeholder="시리즈" value="${esc(it.series)}">
          <input type="text" data-field="product_key" list="keys" placeholder="product_key" value="${esc(it.product_key)}">
        </div>
      </div>
    </div>`).join('');
  const approved = ITEMS.filter((it) => it.status === 'approved').length;
  const nGroups = Object.values(groups).filter((n) => n >= 2).length;
  $('count').textContent = `승인 ${approved}장 / 전체 ${ITEMS.length}장 · 같은 상품 그룹(2장 이상) ${nGroups}개 · 목표: 승인 100장, 그룹 15개`;
  $('filters').innerHTML = FILTERS.map(([k, label]) => `<button data-filter="${k}" class="${k === filter ? 'on' : ''}">${label}</button>`).join(' ');
  $('keys').innerHTML = [...new Set(ITEMS.map((it) => it.product_key).filter(Boolean))].map((k) => `<option value="${esc(k)}">`).join('');
  $('series').innerHTML = [...new Set(ITEMS.map((it) => it.series).filter(Boolean))].map((k) => `<option value="${esc(k)}">`).join('');
}
const byId = Object.fromEntries(ITEMS.map((it) => [it.id, it]));
document.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (e.target.dataset.filter) { filter = e.target.dataset.filter; render(); }
  else if (item && e.target.dataset.status) { byId[item.dataset.id].status = e.target.dataset.status; byId[item.dataset.id].reason = ''; render(); }
  else if (item && e.target.tagName === 'IMG') { $('zoom').querySelector('img').src = e.target.src; $('zoom').style.display = 'flex'; }
  else if (e.target.closest('#zoom')) $('zoom').style.display = 'none';
});
document.addEventListener('change', (e) => {
  const item = e.target.closest('.item');
  if (item && e.target.dataset.field) byId[item.dataset.id][e.target.dataset.field] = e.target.value.trim();
});
$('save').onclick = async () => {
  const payload = { reviewed_at: new Date().toISOString(), items: ITEMS.map(({ id, status, category, series, product_key, reason }) => ({ image_id: id, status, category, series, product_key, reason })) };
  if (CAN_SAVE) {
    const res = await fetch('/save', { method: 'POST', body: JSON.stringify(payload) });
    $('saved').textContent = res.ok ? `저장됨 ${new Date().toLocaleTimeString()}` : '저장 실패';
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
    a.download = 'image_review.json'; a.click();
    $('saved').textContent = '내려받은 image_review.json을 data/ 폴더에 넣어 주세요';
  }
  render();
};
render();
</script></body></html>
"""


def embeddings(sources: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """사진 벡터와 (사진, 검색어) 유사도. 한 번 계산하면 data/review_embeddings.npz에 남긴다."""
    ids = [s["id"] for s in sources]
    if CACHE_PATH.exists():
        cached = np.load(CACHE_PATH, allow_pickle=False)
        if list(cached["ids"]) == ids:
            return cached["img"], cached["query_sim"]
    from embedder import Embedder

    print(f"사진 {len(ids)}장 임베딩 중(자동 보조용)…")
    emb = Embedder("fp32")
    img = emb.images([IMAGES / f"{i}.jpg" for i in ids])
    queries = sorted({s["query"] for s in sources})
    q_vec = dict(zip(queries, emb.texts(queries)))
    query_sim = np.array([float(img[k] @ q_vec[s["query"]]) for k, s in enumerate(sources)], dtype=np.float32)
    np.savez(CACHE_PATH, ids=np.array(ids), img=img, query_sim=query_sim)
    return img, query_sim


def build() -> None:
    sources = read_json(DATA / "image_sources.json", [])
    if not sources:
        raise SystemExit("data/image_sources.json이 없습니다. 먼저 collect_images.py를 실행하세요")
    img, query_sim = embeddings(sources)
    sim = img @ img.T
    np.fill_diagonal(sim, 0)
    suspect_below = float(np.quantile(query_sim, SUSPECT_QUANTILE))

    draft = read_json(DATA / "draft_curation.json", {}) or {}
    draft_posts = {p["image_id"]: p for p in draft.get("posts", [])}
    draft_rejected = {r["image_id"]: r.get("reason", "") for r in draft.get("rejected", [])}
    saved = {r["image_id"]: r for r in (read_json(REVIEW_PATH, {}) or {}).get("items", [])}

    items = []
    for k, s in enumerate(sources):
        post = draft_posts.get(s["id"])
        item = {
            "id": s["id"], "query": s["query"], "title": s["title"], "creator": s["creator"], "license_name": s["license_name"],
            "status": "approved" if post else "rejected" if s["id"] in draft_rejected else "undecided",
            "category": (post or {}).get("category") or s.get("category_hint") or "",
            "series": (post or {}).get("series") or s.get("series_hint") or "",
            "product_key": (post or {}).get("product_key", ""),
            "reason": draft_rejected.get(s["id"], ""),
            "dup_of": [sources[j]["id"] for j in np.where(sim[k] >= DUP_THRESHOLD)[0]],
            "suspect": bool(query_sim[k] < suspect_below),
        }
        if s["id"] in saved:   # 이미 검수한 값이 우선
            item.update({f: saved[s["id"]].get(f, item[f]) for f in ("status", "category", "series", "product_key", "reason")})
        items.append(item)

    html = (PAGE.replace("__ITEMS__", json.dumps(items, ensure_ascii=False))
            .replace("__CATEGORIES__", json.dumps(CATEGORIES, ensure_ascii=False))
            .replace("__IMG_BASE__", json.dumps("../data/images/")))
    REPORTS.mkdir(exist_ok=True)
    HTML_PATH.write_text(html, encoding="utf-8")
    n = {k: sum(1 for it in items if it["status"] == k) for k in ("approved", "rejected", "undecided")}
    print(f"검수 페이지: {HTML_PATH}")
    print(f"  초안 기준 승인 {n['approved']}장, 제외 {n['rejected']}장, 미정 {n['undecided']}장 / "
          f"중복 의심 {sum(1 for it in items if it['dup_of'])}장, 상품 아님 의심 {sum(1 for it in items if it['suspect'])}장")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/reports/image_review.html")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path != "/save":
            self.send_error(404)
            return
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        write_json(REVIEW_PATH, payload)
        n = sum(1 for it in payload["items"] if it["status"] == "approved")
        print(f"[{datetime.now():%H:%M:%S}] 저장: 승인 {n}장 → {REVIEW_PATH}")
        self.send_response(200)
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="HTML만 만들고 서버는 띄우지 않는다")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    build()
    if args.build:
        return
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    print(f"검수 서버: http://127.0.0.1:{args.port}/  (끝내려면 Ctrl+C)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

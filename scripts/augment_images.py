"""증강 사진 만들기 (PLAN 4.3.4). 같은 상품 게시물을 늘릴 때 "다른 판매자가 찍은 것처럼" 보이는 변형을 만든다.

data/extra_posts.yaml에서 "img_0100_a1"처럼 _aN이 붙은 사진 id를 찾아, 원본(img_0100)을
자르기(78~90%)·회전(±6°)·밝기·색온도 변화로 바꿔 data/images/img_0100_a1.jpg로 저장한다.
출처 기록(data/image_sources.json)에는 원본의 작성자·라이선스를 그대로 두고 augmented_from과 변경 내용을 적는다.
같은 id는 항상 같은 결과가 나온다(시드 = id).

사용법  python scripts/augment_images.py
"""
from __future__ import annotations

import hashlib
import random
import re

import yaml
from PIL import Image, ImageEnhance

from common import DATA, IMAGES, read_json, write_json

AUG_ID = re.compile(r"^(img_\d{4})_a(\d+)$")


def augment(src: Image.Image, seed: str) -> Image.Image:
    rng = random.Random(int(hashlib.sha1(seed.encode()).hexdigest()[:8], 16))
    img = src.convert("RGB")
    # 회전한 뒤 가장자리 빈 곳이 보이지 않게 가운데를 잘라 낸다
    angle = rng.uniform(-6, 6)
    img = img.rotate(angle, resample=Image.BICUBIC, expand=False)
    w, h = img.size
    scale = rng.uniform(0.78, 0.90)
    cw, ch = int(w * scale), int(h * scale)
    left = rng.randint(int(w * 0.05), w - cw - int(w * 0.05))
    top = rng.randint(int(h * 0.05), h - ch - int(h * 0.05))
    img = img.crop((left, top, left + cw, top + ch))
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.88, 1.12))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.92, 1.08))
    warm = rng.uniform(-0.06, 0.06)   # 색온도: 빨강·파랑 채널을 반대로 조금씩
    r, g, b = img.split()
    r = r.point(lambda v: min(255, int(v * (1 + warm))))
    b = b.point(lambda v: min(255, int(v * (1 - warm))))
    return Image.merge("RGB", (r, g, b))


def main() -> None:
    spec = yaml.safe_load((DATA / "extra_posts.yaml").read_text(encoding="utf-8"))
    wanted = sorted({p["image"] for p in spec.get("posts", []) if AUG_ID.match(p["image"])})
    sources = read_json(DATA / "image_sources.json", [])
    by_id = {s["id"]: s for s in sources}
    for aug_id in wanted:
        base_id, _ = AUG_ID.match(aug_id).groups()
        out = augment(Image.open(IMAGES / f"{base_id}.jpg"), aug_id)
        out.save(IMAGES / f"{aug_id}.jpg", "JPEG", quality=90)
        base = by_id[base_id]
        entry = {**base, "id": aug_id, "file": f"images/{aug_id}.jpg", "augmented_from": base_id,
                 "modified": "자르기·회전·밝기·색감 변경(증강)", "width": out.size[0], "height": out.size[1]}
        if aug_id in by_id:
            sources[sources.index(by_id[aug_id])] = entry
        else:
            sources.append(entry)
        print(f"{aug_id} ← {base_id} ({out.size[0]}x{out.size[1]})")
    write_json(DATA / "image_sources.json", sources)
    print(f"증강 사진 {len(wanted)}장")


if __name__ == "__main__":
    main()

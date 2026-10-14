"""브라우저용 ONNX 모델로 임베딩을 계산한다 (PLAN 5.3-3, 11장).

색인·보정은 폰이 실제로 쓰는 모델(양자화 포함)로 만든 벡터를 기준으로 해야 구간이 어긋나지 않는다.
그래서 PyTorch 원본이 아니라 models/ 의 ONNX 파일을 onnxruntime으로 실행한다.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

from common import MODELS, TEXT_MODEL_ID, VISION_MODEL_ID

SUFFIX = {"fp32": "", "fp16": "_fp16", "q8": "_quantized"}
MAX_SEQ_LEN = 128
CLIP_SIZE = 224
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def normalize(v: np.ndarray) -> np.ndarray:
    return v / np.clip(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12, None)


def preprocess(image: Image.Image) -> np.ndarray:
    """CLIP 전처리. web/js/ml-worker.js의 preprocessImage와 같은 계산이다."""
    image = image.convert("RGB")
    w, h = image.size
    if w <= h:
        size = (CLIP_SIZE, int(CLIP_SIZE * h / w))
    else:
        size = (int(CLIP_SIZE * w / h), CLIP_SIZE)
    image = image.resize(size, Image.BICUBIC)
    left, top = (size[0] - CLIP_SIZE) // 2, (size[1] - CLIP_SIZE) // 2
    image = image.crop((left, top, left + CLIP_SIZE, top + CLIP_SIZE))
    arr = (np.asarray(image, dtype=np.float32) / 255.0 - CLIP_MEAN) / CLIP_STD
    return arr.transpose(2, 0, 1)


class Embedder:
    def __init__(self, variant: str = "q8") -> None:
        self.variant = variant
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 8
        vision = MODELS / VISION_MODEL_ID / "onnx" / f"vision_model{SUFFIX[variant]}.onnx"
        text = MODELS / TEXT_MODEL_ID / "onnx" / f"model{SUFFIX[variant]}.onnx"
        self.vision = ort.InferenceSession(str(vision), opts, providers=["CPUExecutionProvider"])
        self.text = ort.InferenceSession(str(text), opts, providers=["CPUExecutionProvider"])
        self.tokenizer = Tokenizer.from_file(str(MODELS / TEXT_MODEL_ID / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("[PAD]"), pad_token="[PAD]")

    def images(self, paths: list[Path], batch: int = 16) -> np.ndarray:
        out = []
        for i in range(0, len(paths), batch):
            pixels = np.stack([preprocess(Image.open(p)) for p in paths[i:i + batch]]).astype(np.float32)
            out.append(self.vision.run(None, {"pixel_values": pixels})[0])
        return normalize(np.concatenate(out).astype(np.float32))

    def texts(self, texts: list[str], batch: int = 16) -> np.ndarray:
        out = []
        for i in range(0, len(texts), batch):
            enc = self.tokenizer.encode_batch(texts[i:i + batch])
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            out.append(self.text.run(None, {"input_ids": ids, "attention_mask": mask})[0])
        return normalize(np.concatenate(out).astype(np.float32))


def post_text(post: dict) -> str:
    """게시물의 텍스트 벡터에 쓰는 문자열: 제목 + 설명 + 태그 (PLAN 5.1)."""
    return " ".join([post["title"], post["description"], " ".join(post["tags"])]).strip()


def load_index(web_data: Path) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray]:
    """web/data/embeddings.bin → (meta, v_img, v_txt, v)."""
    import json

    meta = json.loads((web_data / "embeddings_meta.json").read_text(encoding="utf-8"))
    arr = np.fromfile(web_data / "embeddings.bin", dtype=np.float32).reshape(3, meta["count"], meta["dim"])
    return meta, arr[0], arr[1], arr[2]

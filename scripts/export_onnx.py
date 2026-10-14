"""모델 변환·양자화·정확도 검증 (PLAN 6.1, M0/M3).

  이미지 인코더: clip-ViT-B-32 비전 타워 + 투영층        → models/etturi-clip-vision/onnx/vision_model*.onnx
  텍스트 인코더: DistilBERT(다국어) + 평균 풀링 + Dense  → models/etturi-clip-text-ml/onnx/model*.onnx
  변형: fp32(원본), fp16(WebGPU용), q8(int8 동적 양자화, WASM용)

디렉터리 구조와 파일 이름은 transformers.js가 읽는 규칙을 따른다
(config.json, preprocessor_config.json, tokenizer.json, onnx/<이름>[_fp16|_quantized].onnx).

사용법
  python scripts/export_onnx.py            # 변환 + 검증 + M0 기준값 생성
  python scripts/export_onnx.py --verify   # 이미 변환된 모델로 검증만 다시
  python scripts/export_onnx.py --from-fp32  # fp16/q8 변형만 다시 생성
"""
from __future__ import annotations

import argparse
import shutil
import warnings
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image
from sentence_transformers import SentenceTransformer

from common import DATA, IMAGES, MODELS, REPORTS, ST_IMAGE_MODEL, ST_TEXT_MODEL, TEXT_MODEL_ID, VISION_MODEL_ID, WEB, write_json

warnings.filterwarnings("ignore")
OPSET = 17
MAX_SEQ_LEN = 128
VARIANTS = {"fp32": "", "fp16": "_fp16", "q8": "_quantized"}
N_PARITY = 50
N_M0 = 10


class VisionWrapper(torch.nn.Module):
    """pixel_values → image_embeds(512). CLIP 비전 타워 + 투영층."""

    def __init__(self, clip):
        super().__init__()
        self.vision_model = clip.vision_model
        self.visual_projection = clip.visual_projection

    def forward(self, pixel_values):
        pooled = self.vision_model(pixel_values=pixel_values).pooler_output
        return self.visual_projection(pooled)


class TextWrapper(torch.nn.Module):
    """input_ids, attention_mask → sentence_embedding(512). DistilBERT + 평균 풀링 + Dense(768→512)."""

    def __init__(self, bert, dense):
        super().__init__()
        self.bert = bert
        self.dense = dense

    def forward(self, input_ids, attention_mask):
        hidden = self.bert(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        mask = attention_mask.unsqueeze(-1).to(hidden.dtype)
        pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        return self.dense(pooled)


def export_fp32(module, args, path: Path, input_names, output_name) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    dynamic_axes = {name: ({0: "batch", 1: "sequence"} if name != "pixel_values" else {0: "batch"}) for name in input_names}
    dynamic_axes[output_name] = {0: "batch"}
    with torch.no_grad():
        torch.onnx.export(
            module, args, str(path), input_names=input_names, output_names=[output_name],
            dynamic_axes=dynamic_axes, opset_version=OPSET, do_constant_folding=True, dynamo=False,
        )
    # 외부 데이터 파일로 나뉘지 않게 하나의 파일로 다시 저장한다(브라우저 로딩 단순화)
    model = onnx.load(str(path), load_external_data=True)
    for extra in path.parent.glob(path.name + "*data*"):
        extra.unlink()
    # 그래프 입력을 같은 형식으로 다시 Cast하는 노드(아무 일도 안 함)를 지운다. 남겨 두면 fp16 변환기가 연결을 잘못 바꾼다
    input_types = {i.name: i.type.tensor_type.elem_type for i in model.graph.input}
    for node in list(model.graph.node):
        to = next((a.i for a in node.attribute if a.name == "to"), None)
        if node.op_type == "Cast" and input_types.get(node.input[0]) == to:
            for other in model.graph.node:
                for k, name in enumerate(other.input):
                    if name == node.output[0]:
                        other.input[k] = node.input[0]
            model.graph.node.remove(node)
    onnx.save(model, str(path))


def make_fp16(src: Path, dst: Path) -> None:
    from onnxconverter_common import float16

    model = float16.convert_float_to_float16(onnx.load(str(src)), keep_io_types=True)
    # 변환기는 그래프 안쪽 Cast(to=float32)를 그대로 두어 형식이 어긋난다. 입출력 경계에 새로 넣은 Cast만 빼고 float16으로 맞춘다
    graph_outputs = {o.name for o in model.graph.output}
    for node in model.graph.node:
        if node.op_type != "Cast" or graph_outputs & set(node.output):
            continue
        for attr in node.attribute:
            if attr.name == "to" and attr.i == onnx.TensorProto.FLOAT:
                attr.i = onnx.TensorProto.FLOAT16
    onnx.save(model, str(dst))


def make_q8(src: Path, dst: Path) -> None:
    """int8 동적 양자화. 설정은 여러 조합을 PyTorch 원본과 비교해 고른 것이다(reports/onnx_parity.md 참고).

    - 가중치는 부호 있는 int8 + 채널별(per-channel) 스케일: 텍스트 최소 코사인 0.963 → 0.991
    - 이미지 인코더는 MatMul만 양자화한다. 패치 임베딩 Conv는 ConvInteger가 부호 있는 가중치를 지원하지 않고,
      양자화하면 오차가 가장 크다(최소 코사인 0.948 → 0.977)
    """
    from onnxruntime.quantization import QuantType, quantize_dynamic

    ops = {node.op_type for node in onnx.load(str(src), load_external_data=False).graph.node}
    quantize_dynamic(
        str(src), str(dst), weight_type=QuantType.QInt8, per_channel=True, reduce_range=False,
        op_types_to_quantize=["MatMul"] if "Conv" in ops else None,
        extra_options={"EnableSubgraph": True, "MatMulConstBOnly": True},
    )


def write_vision_configs(clip, out: Path) -> None:
    cfg = clip.config.to_dict()
    cfg["model_type"] = "clip"
    write_json(out / "config.json", cfg)
    # transformers.js가 읽는 CLIP 전처리 규격. 브라우저 전처리가 이 값과 같아야 한다(PLAN 6.3)
    write_json(out / "preprocessor_config.json", {
        "image_processor_type": "CLIPImageProcessor",
        "do_convert_rgb": True,
        "do_resize": True, "size": {"shortest_edge": 224}, "resample": 3,
        "do_center_crop": True, "crop_size": {"height": 224, "width": 224},
        "do_rescale": True, "rescale_factor": 1 / 255,
        "do_normalize": True,
        "image_mean": [0.48145466, 0.4578275, 0.40821073],
        "image_std": [0.26862954, 0.26130258, 0.27577711],
    })


def write_text_configs(st_text, out: Path) -> None:
    cfg = st_text[0].auto_model.config.to_dict()
    cfg["model_type"] = "distilbert"
    write_json(out / "config.json", cfg)
    st_text.tokenizer.save_pretrained(str(out))
    if not (out / "tokenizer.json").exists():
        raise SystemExit("tokenizer.json이 만들어지지 않았습니다(빠른 토크나이저 필요)")


def cosines(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    b = b / np.linalg.norm(b, axis=1, keepdims=True)
    return (a * b).sum(1)


def run_text(path: Path, tokenizer, sentences: list[str]) -> np.ndarray:
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    out = []
    for i in range(0, len(sentences), 16):
        enc = tokenizer(sentences[i:i + 16], padding=True, truncation=True, max_length=MAX_SEQ_LEN, return_tensors="np")
        out.append(sess.run(None, {"input_ids": enc["input_ids"].astype(np.int64),
                                    "attention_mask": enc["attention_mask"].astype(np.int64)})[0])
    return np.concatenate(out).astype(np.float32)


def run_vision(path: Path, pixel_values: np.ndarray) -> np.ndarray:
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    out = [sess.run(None, {"pixel_values": pixel_values[i:i + 16]})[0] for i in range(0, len(pixel_values), 16)]
    return np.concatenate(out).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true", help="변환을 건너뛰고 검증만 다시 실행")
    ap.add_argument("--from-fp32", action="store_true", help="fp32 변환은 건너뛰고 fp16/q8 변형만 다시 생성")
    args = ap.parse_args()

    torch.set_grad_enabled(False)
    st_img = SentenceTransformer(ST_IMAGE_MODEL, device="cpu")
    st_txt = SentenceTransformer(ST_TEXT_MODEL, device="cpu")
    clip = st_img[0].auto_model.eval()
    processor = st_img[0].processor
    vision_dir, text_dir = MODELS / VISION_MODEL_ID, MODELS / TEXT_MODEL_ID
    vision = {v: vision_dir / "onnx" / f"vision_model{s}.onnx" for v, s in VARIANTS.items()}
    text = {v: text_dir / "onnx" / f"model{s}.onnx" for v, s in VARIANTS.items()}

    if not args.verify and not args.from_fp32:
        print("[1/4] ONNX 변환 (fp32)")
        export_fp32(VisionWrapper(clip).eval(), (torch.randn(1, 3, 224, 224),), vision["fp32"], ["pixel_values"], "image_embeds")
        sample = st_txt.tokenizer(["변환용 예시 문장", "a short example"], padding=True, return_tensors="pt")
        export_fp32(TextWrapper(st_txt[0].auto_model.eval(), st_txt[2].linear).eval(),
                    (sample["input_ids"], sample["attention_mask"]), text["fp32"],
                    ["input_ids", "attention_mask"], "sentence_embedding")
        write_vision_configs(clip, vision_dir)
        write_text_configs(st_txt, text_dir)

    if not args.verify:
        print("[2/4] fp16 / q8 변형 생성")
        for files in (vision, text):
            make_fp16(files["fp32"], files["fp16"])
            make_q8(files["fp32"], files["q8"])

    print("[3/4] 정확도 검증 (PyTorch 원본 대비 코사인)")
    sentences = [s for s in (DATA / "parity_sentences.txt").read_text(encoding="utf-8").splitlines() if s.strip()][:N_PARITY]
    image_paths = sorted(IMAGES.glob("*.jpg"))[:N_PARITY]
    images = [Image.open(p).convert("RGB") for p in image_paths]
    ref_txt = st_txt.encode(sentences, convert_to_numpy=True, normalize_embeddings=False, batch_size=16)
    rows = []
    for variant, path in text.items():
        cos = cosines(ref_txt, run_text(path, st_txt.tokenizer, sentences))
        rows.append(("텍스트", variant, path, len(sentences), cos))
    if images:
        ref_img = st_img.encode(images, convert_to_numpy=True, normalize_embeddings=False, batch_size=16)
        pixel_values = processor(images=images, return_tensors="np")["pixel_values"].astype(np.float32)
        for variant, path in vision.items():
            cos = cosines(ref_img, run_vision(path, pixel_values))
            rows.append(("이미지", variant, path, len(images), cos))
    else:
        print("  ! data/images에 사진이 없어 이미지 검증을 건너뜀 (수집 후 --verify로 다시 실행)")

    lines = [
        "# ONNX 변환 정확도 검증 (PLAN 6.1)", "",
        f"- 기준: PyTorch 원본(`{ST_IMAGE_MODEL}`, `{ST_TEXT_MODEL}`) 출력과의 코사인 유사도",
        "- 통과 기준: fp32·fp16 최솟값 0.99 이상, q8 최솟값 0.98 이상",
        "- 실행 환경: onnxruntime CPU (브라우저 WASM과 같은 연산 커널 계열). 브라우저 전처리까지 포함한 값은 `reports/m0_feasibility.md` 참고",
        "", "| 인코더 | 변형 | 파일 크기(MB) | 표본 수 | 코사인 최소 | 평균 | 판정 |", "|---|---|---|---|---|---|---|",
    ]
    for kind, variant, path, n, cos in rows:
        limit = 0.98 if variant == "q8" else 0.99
        verdict = "통과" if cos.min() >= limit else "미달"
        size = path.stat().st_size / 1e6
        lines.append(f"| {kind} | {variant} | {size:.1f} | {n} | {cos.min():.4f} | {cos.mean():.4f} | {verdict} |")
        print(f"  {kind} {variant:5s} {size:7.1f}MB  min={cos.min():.4f} mean={cos.mean():.4f}  {verdict}")
    sizes = {v: (vision[v].stat().st_size + text[v].stat().st_size) / 1e6 for v in VARIANTS}
    lines += ["", "## 다운로드 크기 합계 (이미지 + 텍스트 인코더)", "",
              "| 조합 | 합계(MB) | 250MB 이하 |", "|---|---|---|"]
    combos = {**{v: sizes[v] for v in ("fp16", "q8")},
              "이미지 fp16 + 텍스트 q8": (vision["fp16"].stat().st_size + text["q8"].stat().st_size) / 1e6}
    for name, total in combos.items():
        lines.append(f"| {name} | {total:.1f} | {'예' if total <= 250 else '아니오'} |")
        print(f"  합계 {name}: {total:.1f}MB")
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "onnx_parity.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("[4/4] M0 측정 페이지용 기준값 (web/m0/ref.json)")
    m0 = WEB / "m0"
    (m0 / "img").mkdir(parents=True, exist_ok=True)
    ko, en = sentences[:25], sentences[25:]
    m0_texts = ko[:N_M0 // 2] + en[:N_M0 // 2]
    ref = {"texts": [{"text": t, "ref": np.round(v, 5).tolist()}
                     for t, v in zip(m0_texts, st_txt.encode(m0_texts, convert_to_numpy=True))], "images": []}
    step = max(1, len(image_paths) // N_M0)
    for p in image_paths[::step][:N_M0]:
        shutil.copy(p, m0 / "img" / p.name)
        vec = st_img.encode([Image.open(p).convert("RGB")], convert_to_numpy=True)[0]
        ref["images"].append({"file": f"img/{p.name}", "ref": np.round(vec, 5).tolist()})
    write_json(m0 / "ref.json", ref, indent=None)
    print(f"완료 → {REPORTS / 'onnx_parity.md'}")


if __name__ == "__main__":
    main()

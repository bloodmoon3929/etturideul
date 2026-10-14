# 에뚜리들 — 키덜트 굿즈 유사 매물 추천 프로토타입

대학 과제(AI UX 서비스 설계)용 웹 프로토타입이다. 연구자의 안드로이드 폰을 참여자에게 건네 Task 네 개를 시키고 사용 행동을 기록한다.

1. 원래 방식으로 찾기: 중고거래 앱처럼 목록을 내려 보거나 키워드로 검색해서, 사진 속 굿즈를 가장 싸게 살 수 있는 게시물을 고른다.
2. 사진으로 찾기: 1과 같은 화면에 사진 검색만 더했다. 갤러리의 사진으로 같은 일을 한다.
3. 가격 안내와 함께 찾기: 1과 같은 화면에 가격 확인 안내만 더했다. 판매가와 본문 금액이 다르면 [⚠ 가격 확인]이 붙는다.
4. 구매 추천 받기: 마음에 드는 굿즈 5개를 찜하면, 찜 목록을 바탕으로 비슷한 계열의 굿즈를 추천하는 페이지가 열린다. [추천 더 보기]로 유사도 다음 순위를 계속 불러온다.

사진 검색과 가격 확인 안내는 서로 다른 Task에 하나씩만 넣어 따로 볼 수 있게 했다. 순서는 고정이고, 1~3은 서로 다른 굿즈(세이버 피그마, 리볼텍 단보, RG 건담)를 쓴다. 굿즈마다 같은 상품이 여러 개 올라와 있고 구조가 같다: 제목에 이름이 없는 게시물("피규어 팝니다"), 본문에서만 가격을 내린 게시물(본문 가격이 가장 낮음), 판매가 1원 일괄 판매, 일반 게시물(`data/extra_posts.yaml`).

정답·오답은 매기지 않는다. 일괄 구매 할인이 마음에 들어 고를 수도 있으므로, 고른 게시물과 그 판매가·실제 가격, 참고용 최저 실제 가격만 남긴다. 세션 끝의 "앞으로 어느 쪽을 쓰겠냐" 질문도 뺐다(만든 사람 앞에서는 듣기 좋은 답을 하기 쉽다, The Mom Test). 처음 설계는 `../PLAN.md`에 있지만 Task 구성·순서·설문은 위와 같이 바꿨다(`data/protocol.yaml`).

## 인터뷰 당일 체크리스트

1. 전날 Wi-Fi에서 앱을 열어 콘솔의 [지금 준비하기]를 누르고, "오프라인 준비 상태"가 모두 ✓인지 확인한다.
2. 폰을 충전하고 보조 배터리를 챙긴다.
3. 콘솔의 "저장 대기"가 0건인지 확인한다(지난 세션은 [JSON 파일로 저장] 후 [지우기]).
4. 참여자 번호를 확인한다.
5. 세션마다 [세션 종료] 후 [JSON 파일로 저장]을 눌러 파일이 폰의 다운로드 폴더에 생겼는지 확인한다.

실물 굿즈나 인쇄한 카드는 필요 없다. Task 대상 사진은 안내문에 보이고, 앱 안의 가상 갤러리에 가장 최근 사진으로 들어 있다.

## 지금 상태

| 마일스톤 | 상태 |
|---|---|
| M0 브라우저 추론 검증 | 워크스테이션 쪽 완료, 폰 측정 대기 (`reports/m0_feasibility.md`) |
| M1 사진 수집·검수 | 수집 완료(421장), 사람 검수 대기 (`scripts/review_images.py`) |
| M2 더미 게시물·색인 | 초안 데이터로 생성. 검수 뒤 다시 만든다 |
| M3 모델 변환 | 변환·정확도 검증 완료, 모델 호스팅(Hugging Face Hub) 미정 |
| M4 보정·평가 | 보정(`calibrate.py`) 완료, 평가(`evaluate.py`)와 히스토그램은 아직 |
| M5 Task 화면 | Task 3개(원래 방식 검색, 사진 검색, 추천) 구현, 워크스테이션 Chrome에서 동작 확인. 폰 확인 대기 |
| M6 3D 취향 지도 | 구현했지만 인터뷰에서는 쓰지 않는다(코드만 남아 있음) |
| M7 로그·설문·내보내기 | 앱 쪽 구현(JSON 파일 저장). 분석 스크립트(`analyze_logs.py`)와 대시보드는 아직 |
| M8 배포 | Firebase 대신 GitHub Pages로 배포(https://bloodmoon3929.github.io/etturideul/). 모델은 Hugging Face Hub. 로그 업로드(Firestore)는 미구현, 코드에 `TODO(firebase)` 주석만 있다 |
| M9 마무리 | 아직 |

아직 만들지 않은 스크립트: `prune_vocab.py`, `evaluate.py`, `make_qr.py`, `analyze_logs.py`, `server_fallback/`(Plan B). 인쇄용 카드(`make_task_cards.py`)는 가상 갤러리를 쓰면서 필요 없어졌다.

### 초안 데이터에서 확인된 한계

게시물 95개(같은 상품 그룹 17개), q8 모델 기준이다. 사람 검수 전의 초안 데이터라 숫자는 바뀔 수 있다.

- 사진 검색의 순위는 쓸 만하다. 같은 상품이 1위에 오는 비율 0.77, 5위 안에 드는 비율 0.86(같은 상품이 있는 게시물 35개를 하나씩 쿼리로 썼을 때).
- 전역 임계값으로는 "같은 상품"과 "같은 시리즈"가 잘 갈리지 않는다. "같은 상품" 등급의 정밀도는 게시물→게시물 0.25, 사진 검색 0.39다(`reports/calibration.md`). 그래서 시세 요약에 다른 상품이 섞일 수 있다.
- 상품 이름으로 하는 AI 글 검색은 부정확하다(예: "세이버"를 치면 세이버가 19위 밖). PyTorch 원본 모델로도 같아서 모델의 한계다. 그래서 인터뷰 화면에서는 글 검색을 원래 방식과 제안 방식 모두 키워드 검색으로 하고, AI는 사진 검색과 추천에만 쓴다.
- 이미지 인코더 q8은 정확도 기준(0.98)에 못 미친다(`reports/m0_feasibility.md`).
- 아크릴 스탠드 카테고리는 쓸 수 있는 CC 사진이 없어 0개다.

### Firebase가 들어갈 자리

이 워크스테이션에서는 Google 서비스를 쓸 수 없어 구현을 미뤘다. `grep -rn "TODO(firebase)"`로 찾는다.

- `web/js/uploader.js`: 세션 묶음 Firestore 업로드(익명 인증, 배치 쓰기), 보안 규칙 요약
- `web/admin/index.html`: 연구자 대시보드(Google 로그인)
- `.env.example`: 로그 내보내기용 서비스 계정
- 만들 파일: `firebase.json`(Hosting 캐시·COOP/COEP 헤더), `firestore.rules`, `firestore.indexes.json`, `web/js/firebase-config.js`

그동안 세션 기록은 콘솔의 [JSON 파일로 저장]으로 꺼낸다. `web/js/config.js`의 `UPLOAD_BACKEND`가 `'none'`이면 업로드를 시도하지 않는다.

## 실행

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements-build.txt

# 모델 변환 (M0, M3) — models/ 에 ONNX fp32 / fp16 / q8 생성, reports/onnx_parity.md
.venv/bin/python scripts/export_onnx.py

# 사진 수집 → 사람 검수
.venv/bin/python scripts/collect_images.py
.venv/bin/python scripts/augment_images.py    # data/extra_posts.yaml에 쓰는 증강 사진
.venv/bin/python scripts/review_images.py      # http://127.0.0.1:8765 에서 검수 후 [저장]

# 게시물 → 색인 → 보정 → 그래프 (web/data, web/thumbs 생성)
.venv/bin/python scripts/make_dummy.py
.venv/bin/python scripts/build_index.py
.venv/bin/python scripts/calibrate.py
.venv/bin/python scripts/build_graph.py
.venv/bin/python scripts/make_gallery.py      # 가상 갤러리용 일상 사진 (CC0 / Public Domain)

# 로컬 확인 (Firebase 에뮬레이터 대신)
.venv/bin/python scripts/dev_server.py         # http://127.0.0.1:8000  /  M0 측정: /m0/
```

폰에서 열려면 HTTPS 또는 localhost여야 한다(WebGPU, 서비스 워커). `adb reverse tcp:8000 tcp:8000` 후 폰 Chrome에서 `http://localhost:8000`을 연다.

## 배포

- 앱: `main`에 push하면 GitHub Actions(`.github/workflows/pages.yml`)가 `web/`을 GitHub Pages에 올린다. 주소는 https://bloodmoon3929.github.io/etturideul/ 이다. 폰에서 이 주소를 열면 된다(adb 불필요).
- 외부 라이브러리(`web/vendor/`)는 저장소에 없다. 배포 때와 처음 로컬에서 받을 때 `python3 scripts/fetch_vendor.py`가 버전·SHA-256을 고정한 주소에서 받는다.
- 모델: Hugging Face Hub의 [bloodmoon3929/etturideul-models](https://huggingface.co/bloodmoon3929/etturideul-models)(q8, fp16). 앱은 `web/js/config.js`의 `MODEL_SOURCE`에 적힌 커밋 해시의 파일만 받는다. 모델을 바꾸면 새로 올리고 그 해시를 고친다. localhost에서 열면 로컬 `models/`를 쓴다.
- GitHub Pages는 응답 헤더를 지정할 수 없어 교차 출처 격리가 꺼져 있다. 그래서 WASM은 스레드 하나로 돈다(WebGPU 경로는 상관없음).
- 데이터(`web/data/`, `web/thumbs/`)를 다시 만들었으면 커밋해서 push해야 배포에 반영된다.

## 앱 사용 흐름

1. 연구자: 콘솔에서 참여자 번호를 넣고 [세션 시작]을 누른 뒤 폰을 건넨다.
2. 참여자: 동의 → "Task 1 / 4" 안내 화면에서 [시작] → Task 수행 → [완료] 또는 [건너뛰기] → 다음 Task 안내 → … 끝까지 혼자 진행한다.
3. Task 4가 끝나면 "휴대폰을 연구자에게 건네주세요" 화면이 나온다.
4. 연구자: [연구자 전용] 버튼을 1초 이상 눌러 콘솔로 돌아와 [세션 종료] → [JSON 파일로 저장].

- Task 시간은 안내 화면의 [시작]을 누른 순간부터 잰다. 안내문을 읽는 시간은 따로 남는다(`task_intro` → `task_start`).
- Task 1~3은 화면이 같고, Task 2에는 검색창 옆 [사진] 버튼이, Task 3에는 [⚠ 가격 확인] 안내만 더 있다. 글로 검색하면 모두 키워드 검색이다.
- [사진] 버튼을 누르면 폰의 카메라 대신 앱 안의 가상 갤러리가 열린다. 맨 앞(가장 최근)이 그 Task의 대상 사진이고, 그 뒤로 일상 사진 12장과 다른 굿즈 사진 6장이 섞여 있다(대상 사진만 굿즈라 티가 나지 않게). 굿즈 사진은 `data/collect_queries.yaml`의 `gallery.goods`에서 바꾼다. 폰의 카메라·앨범을 쓰게 하려면 `web/js/config.js`의 `PHOTO_SOURCE`를 `'device'`로 바꾼다.
- Task 4는 굿즈를 5개 찜해야 [구매 추천 보기]가 켜진다. 추천은 찜한 굿즈들의 벡터 평균과 가까운 순서이고 처음 8개, [추천 더 보기]마다 8개씩 더 나온다. 각 카드에 가장 비슷한 찜 굿즈를 "○○ 계열"로 적는다.
- [⚠ 가격 확인]은 Task 3 화면에만 있다. 본문에서 "○○원" 금액을 찾아 판매가와 비교하는 규칙 기반 검사다(`scripts/build_index.py`의 price_check).
- 연습이나 점검을 할 때는 콘솔의 [테스트 세션 시작]을 쓴다. 번호가 T01, T02…로 따로 매겨지고 실제 참여자 번호는 늘어나지 않으며, 기록(`session.test`)과 파일 이름(`TEST_…`)에 테스트로 표시된다.
- 연구자 콘솔: 위에 상태 요약(AI 모델, 오프라인 준비, 저장 대기), 가운데에 새 세션 또는 진행 중인 세션, 아래에 저장 대기 목록과 접힌 "도구"(오프라인 준비 자세히, 모델 설정, 이미지 출처, M0 측정 페이지)가 있다. 오프라인 준비 타일이 "준비 필요"면 눌러서 바로 준비할 수 있다.
- 세션 중간에 콘솔을 열어야 하면(중단, 관찰 메모) Task 안내 화면의 "Task n / 4" 글자를 1초 이상 누른다. 콘솔의 [이어서 진행]으로 돌아간다.
- 끝나지 않은 세션이 있는 상태로 앱을 열면 "진행하던 세션이 있습니다" 화면이 먼저 뜬다. 인터뷰 중에 탭이 다시 열린 것이면 참여자가 [이어서 진행]을 누른다(로그에 `error / app_reloaded`가 남는다). 지난 세션이 남아 있는 것이면 [연구자 전용] 버튼을 1초 이상 눌러 콘솔로 가서 [세션 종료]를 누르고 새 세션을 시작한다.
- 설문(사전 질문, Task 후 설문, UMUX-Lite·주관식)은 꺼 두었다. `web/js/config.js`의 `SURVEYS`에서 다시 켤 수 있다.
- Task 중 안드로이드 뒤로 가기는 Task 안의 이전 화면으로만 간다. 게시물 상세에는 화면에 ← 버튼이 있다.

## 구성

```
scripts/      오프라인 파이프라인 (워크스테이션 전용)
data/         원본 데이터: 수집 사진, 출처, 게시물 문구, Task 정의(protocol.yaml)
models/       변환한 ONNX 모델 + 토크나이저 (transformers.js가 읽는 구조)
web/          배포 디렉터리 (정적 파일만)
  js/         app, console, task-frame, mod-a-search(Task 1·2), mod-r-recommend(Task 3), ml-worker, logger, survey …
  data/       posts.json, embeddings.bin, similar.json, calibration.json, graph.json, protocol.json
  m0/         M0 측정 페이지
  vendor/     외부 라이브러리 로컬 사본 (vendor/README.md)
docs/event_dictionary.md   로그 이벤트 사전
reports/      검증 결과
```

Task 문구·대상·순서는 `data/protocol.yaml`, 마지막 질문과 설문 문항은 `web/js/survey.js` 위쪽 상수, 설문 단계 켜고 끄기와 모델 조합·경로는 `web/js/config.js`에서 바꾼다.

## 데이터와 라이선스

- 게시물 사진은 Openverse API로 받은 CC 라이선스 이미지다(CC0, PD, BY, BY-SA, BY-NC, BY-NC-SA. ND 계열 제외). 출처·작성자·라이선스는 `data/image_sources.json`에 있고, 앱의 게시물 상세와 콘솔의 "이미지 출처"에 표기한다.
- 가상 갤러리의 일상 사진 12장은 CC0 / Public Domain 사진이다(`data/gallery_sources.json`). 함께 섞은 굿즈 사진 6장은 수집한 CC 사진 중 게시물로 쓰지 않은 것이다.
- 게시물의 제목·설명·가격·판매자·위치는 모두 가상이다.
- 모델: CLIP ViT-B/32(OpenAI, MIT), clip-ViT-B-32-multilingual-v1(sentence-transformers, Apache-2.0)을 ONNX로 변환·양자화했다.
- 참여자 기록: 이름·연락처는 받지 않고 참여자 번호로만 구분한다. 세션 기록은 폰의 IndexedDB에 있다가 JSON 파일로 꺼낸 뒤 콘솔에서 지운다. 가상 갤러리를 쓰는 동안에는 참여자의 사진을 받지 않는다(`PHOTO_SOURCE`를 `'device'`로 바꾸면 동의한 경우에만 폰에 저장하고 업로드하지 않는다).
- 보관 기간과 삭제 요청 처리 절차는 아직 정하지 않았다.

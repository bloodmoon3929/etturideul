# 로그 이벤트 사전

앱이 남기는 이벤트의 이름과 `data` 필드 정의다. 기록 코드는 `web/js/logger.js`의 `logger.log(event, target, data)` 한 곳을 거친다.
새 이벤트를 추가하거나 필드를 바꾸면 이 문서를 반드시 함께 고친다.

## 공통 필드 (모든 이벤트)

| 필드 | 형식 | 설명 |
|---|---|---|
| `seq` | int | 세션 안 순번. 1부터 빠짐없이 증가한다(정렬·누락 확인용) |
| `ts` | ISO 8601 (+09:00, ms) | 발생 시각 |
| `t_session_ms` | int | 세션 시작부터 경과 시간 |
| `t_task_ms` | int \| null | Task 시작부터 경과 시간. Task 밖이면 null |
| `task_run_id`, `task_id`, `condition` | str \| null | 진행 중인 Task 실행. Task 밖이면 null. condition은 `classic` / `ai` |
| `screen` | str | 화면 id (아래 표) |
| `event` | str | 이벤트 이름 |
| `target` | str \| null | 조작한 요소 id |
| `data` | object | 이벤트별 상세 |

정답 관련 값(`is_target`, `is_correct`, `target_rank`)은 기록 시점에 계산해 넣는다. Task와 무관한 경우 null이다.

- `is_target`: 찾기 Task(T1~T3)에서 게시물의 `product_key`가 Task 대상과 같은지(가격은 따지지 않음). 구매 추천 Task(T4)에는 대상이 없어 null이다.
- 세션 묶음의 `session.test`가 true면 [테스트 세션 시작]으로 만든 세션이다. 파일 이름도 `TEST_`로 시작한다. 분석에서는 빼면 된다.
- `target_rank`: 결과 목록에서 정답 게시물이 처음 나오는 순위(1부터). 없으면 null.

## 화면 id

| id | 화면 |
|---|---|
| `console`, `sources` | 연구자 콘솔, 이미지 출처 |
| `resume_prompt` | 앱을 열었는데 끝나지 않은 세션이 남아 있을 때 뜨는 화면([이어서 진행] / 연구자 전용 콘솔 열기) |
| `consent`, `task_intro`, `final_survey`, `hand_back` | 동의, 다음 Task 안내([시작] 전), 마지막 질문(UI 선택), 휴대폰 돌려주기 |
| `pre_survey`, `post_task_survey` | 사전 질문, Task 후 설문 (설문을 켰을 때만) |
| `a_results`, `a_detail` | T1 원래 방식: 목록·검색 결과, 게시물 상세 |
| `p_results`, `p_detail` | T2 원래 방식 + 사진 검색 |
| `w_results`, `w_detail` | T3 원래 방식 + 가격 확인 안내 |
| `r_feed`, `r_detail`, `r_recommend` | T4 구매 추천: 굿즈 목록(찜 n/5, [구매 추천 보기]), 게시물 상세, 구매 추천 페이지 |
| `b_*`, `c_*`, `d_*`, `e_*` | 인터뷰에서는 쓰지 않는 화면(AI 글·사진 검색, 판매 등록, 3D 취향 지도). 코드만 남아 있고 콘솔에서 열 수 없다 |

## 세션·Task

| event | 언제 | data |
|---|---|---|
| `session_start` | 연구자가 [세션 시작] 또는 [테스트 세션 시작] | participant(테스트는 T01…), order_group(순서가 고정이라 지금은 null), location_note |
| `consent` | 동의 화면 제출 | behavior, replay, photos |
| `task_intro` | 다음 Task 안내 화면이 보임 | task_run_id, task_id, condition, order_index. 이 이벤트에서 `task_start`까지가 안내문을 읽은 시간이다 |
| `task_start` | 참여자가 안내 화면의 [시작]을 누름. Task 시간은 여기서부터 잰다 | task_id, condition, order_index, target_id |
| `task_end` | Task 종료 | outcome(`done` / `skipped`), answer, by(건너뛴 경우: `participant` = Task 화면의 [건너뛰기], `researcher` = 콘솔에서 시작 전에 건너뜀. 이때는 task_run_id, task_id를 data에 넣는다). Task 도중에 연구자가 세션을 종료한 경우에는 by가 `researcher`, reason이 `session_end`다 |
| `instruction_toggle` | Task 안내문 접기·펴기 | open, auto(첫 화면 이동 때 자동으로 접힌 경우 true) |
| `researcher_note` | 콘솔에서 관찰 메모 추가 | text, task_run_id |
| `session_end` | 연구자가 [세션 종료] | n_events |

`task_end.data.answer` 형식

참여자가 [건너뛰기]를 누른 경우에도 그때까지 고른 답이 있으면 answer에 남는다.

- T1~T3(가장 싸게 살 수 있는 게시물 고르기): `{post_id, product_key, same_product, contains_target, price, real_price, cheapest_price, price_flag}`. 정답·오답은 매기지 않는다(일괄 구매가 마음에 들어 고를 수도 있다). `price`는 판매가, `real_price`는 그 게시물에서 대상 상품의 실제 가격(본문에서만 가격을 바꾼 게시물·일괄 판매 게시물은 `data/extra_posts.yaml`의 real_prices), `cheapest_price`는 참고용 대상 상품의 가장 낮은 실제 가격, `price_flag`는 고른 게시물이 일괄 판매(`bundle`)·가격 불일치(`mismatch`) 게시물이었는지다
- T4(구매 추천): `{liked, basis, recommended, liked_after, liked_from_recommend}`. basis는 처음 추천을 열었을 때의 찜 목록, recommended는 보여 준 추천, liked_after는 추천을 본 뒤에 찜한 것, liked_from_recommend는 그중 추천 목록에 있던 것이다

Task 정의에 `ask_min_price: true`를 넣으면 찾기 Task가 끝날 때 최저가를 묻고 `price`, `true_min_price`, `price_correct`가 추가된다(지금은 끔).

## 화면

| event | 언제 | data |
|---|---|---|
| `screen_view` | 화면이 보임 | from(직전 화면 id) |
| `screen_leave` | 화면을 떠남 | dwell_ms, max_depth_pct |
| `back` | 뒤로 가기로 이전 화면으로 이동 | from, to, via(`system`: 안드로이드 뒤로 가기 / `button`: 화면의 ← 버튼. 이때 target은 `btn_back`) |
| `scroll` | 스크롤(500ms 간격으로 묶음) | depth_pct, max_depth_pct |

## 검색

| event | 언제 | data |
|---|---|---|
| `query_input_start` | 검색창에 입력을 시작 | field, previous(모듈 A: 직전 검색어), has_photo(모듈 B) |
| `query_clear` | 검색어 또는 검색 사진을 지움 | field(`query` / `photo`), from |
| `search_submit` | 결과 목록이 새로 만들어짐 | 아래 참고 |
| `category_select` | 카테고리 칩 선택 (모듈 A) | field, from, to |
| `filter_change` | 가격 범위 변경 (모듈 A) | field(`min_price` / `max_price`), from, to |
| `sort_change` | 정렬 변경 (모듈 A) | field, from, to |
| `gallery_open` | 가상 갤러리가 열림 | n_photos, has_target_photo |
| `gallery_close` | 사진을 고르지 않고 가상 갤러리를 닫음 | picked(false) |
| `photo_pick` | 사진을 고르고 임베딩까지 끝남 | source(`virtual_gallery` / `camera` / `gallery`), retake_no, width, height, embed_ms. 가상 갤러리에서 고른 경우 photo_id, gallery_index(1 = 가장 최근), is_target_photo |
| `low_results_open` | [관련이 낮은 게시물 더 보기] (모듈 B) | n |

`search_submit.data`

| 필드 | 설명 |
|---|---|
| `search_id` | `<task_run_id>-s<번호>` |
| `mode` | `keyword`(글로 검색. T1, T2 공통) / `ai_photo`(사진 검색. T2). `ai_text`, `ai_photo_text`는 데모 화면에서만 나온다 |
| `trigger` | `submit`(검색 실행) / `category` / `filter` / `sort` / `preset`(Task 정의의 initial_query로 미리 검색해 둔 목록. T3 시작 화면). 검색 횟수를 셀 때는 `submit`만 센다 |
| `query` | 검색어 |
| `filters` | `{category, min_price, max_price}` (모듈 B는 null) |
| `sort` | `latest` / `price` / `similarity` |
| `latency_ms` | 검색 시작부터 결과 준비까지 |
| `embed_ms` | 임베딩 계산 시간 (모듈 B) |
| `n_results` | 결과 수. 모듈 B는 같은 상품 + 비슷한 상품 수이며 `n_same`, `n_similar`를 함께 남긴다 |
| `results` | 상위 20개: `{post_id, rank, score, tier, section}` (모듈 A는 score·tier가 null) |
| `target_rank` | 정답 상품의 순위 |
| `backend` | `browser` / `server` (모듈 B) |

가상 갤러리: Task 중 사진은 앱 안의 갤러리 화면에서 고른다(`web/js/config.js`의 `PHOTO_SOURCE = 'virtual'`). 맨 앞(가장 최근)이 그 Task의 대상 사진이고 뒤로 일상 사진이 이어진다. `photo_id`는 대상 사진이면 `card:<세트>_<Task>`, 일상 사진이면 `gal_NN`, 함께 섞어 둔 다른 굿즈 사진이면 `goods_img_NNNN`이다.

게시물의 `hidden_in`에 지금 Task가 있으면 그 Task에서는 목록·검색·사진 검색·추천 어디에도 나오지 않는다(예: T3용 1원 일괄 판매는 T1·T2에서 안 보임). 결과 목록과 순위는 보이는 게시물만으로 매긴다.

## 결과·상세

| event | 언제 | data |
|---|---|---|
| `result_impression` | 결과 카드가 절반 이상 화면에 보임(카드당 한 번) | post_id, rank, score, tier, section, is_target, price_flag(카드에 가격 확인 안내가 붙었으면 그 종류) |
| `result_click` | 결과 카드를 누름 | post_id, rank, score, tier, section, is_target |
| `post_view` | 게시물 상세가 열림 | post_id, from_screen, rank, score, tier, section, chain_depth, is_target |
| `similar_open` | [비슷한 게시물 찾기] | post_id, chain_depth, n_same, n_similar, results, target_rank |
| `explain_open` | [추천 근거] | post_id, score, tier, from_screen |
| `recommend_page_open` | T4에서 [구매 추천 보기]로 추천 페이지가 열림(첫 n_recommend개) | basis(찜 목록), page(1), results(추천: post_id, rank, score(취향 벡터와의 코사인), reason_post_id(가장 비슷한 찜 굿즈)) |
| `recommend_more` | [추천 더 보기]로 유사도 다음 순위의 추천을 더 불러옴 | basis, page(2, 3 …), results(위와 같은 형식, rank는 이어서 매김) |
| `price_warning_open` | [⚠ 가격 확인]을 누름 (T3 화면에만 있음) | post_id, status(`bundle` = 판매가 1원 등 일괄 판매 / `mismatch` = 판매가와 본문 금액이 다름), listed, mentioned(본문 금액), rank, section |
| `like_add`, `like_remove` | 찜 / 찜 해제 | post_id, is_target, n_likes, from_screen, chain_depth(T4에서 1이면 구매 추천 페이지에서 연 굿즈) |

`section`: `results`(키워드 목록) / `same` / `similar` / `low`(사진 검색 결과의 등급별 구역) / `feed`(T4의 굿즈 목록) / `recommend`(T4 구매 추천 페이지).
`chain_depth`: 목록·검색 결과에서 연 상세는 0, 구매 추천 페이지에서 연 상세는 1이다.

## 정답

| event | 언제 | data |
|---|---|---|
| `answer_submit` | [이걸로 살래요] | 위 T1·T2 answer의 필드, from_screen, rank |
| `price_answer` | 최저가 답변 | price, true_min_price, price_correct |

## 등록

| event | 언제 | data |
|---|---|---|
| `listing_start` | 등록 폼이 열림 | ai, has_suggestions, candidate_id, n_photos |
| `listing_photo_add`, `listing_photo_remove` | 사진 추가 / 삭제 | source, n_photos. 가상 갤러리에서 고른 경우 photo_id, gallery_index, is_target_photo |
| `listing_field_focus` | 입력 칸에 들어감 | field |
| `listing_field_change` | 입력 칸의 값이 바뀜 | field, from, value, source(`user`), time_in_field_ms, n_changes |
| `listing_submit` | [등록하기] | 폼 최종 값(title, category, series, condition, price, description, tags), n_photos, duration_ms, ai, n_field_edits, field_times_ms, ai_accept_rate, candidate_id |
| `listing_candidates_shown` | "이 상품인가요?" 후보 표시 (모듈 D) | candidates: `[{post_id, rank, score, tier}]` |
| `listing_candidate_pick` | 후보 선택 (모듈 D) | post_id(해당 없음이면 null), rank, score |
| `listing_suggest_shown` | 자동 채움 값 표시 (모듈 D, 필드마다) | field, suggested |
| `listing_suggest_action` | 등록 시점의 자동 채움 처리 결과 (모듈 D, 필드마다) | field, suggested, final, action(`accept` / `edit` / `reject`) |

자동 채움 값 자체는 `listing_suggest_shown`의 suggested로 남고, 사용자가 고친 내용은 `listing_field_change`(source = `user`)로 남는다.

## 3D 취향 지도

| event | 언제 | data |
|---|---|---|
| `graph_enter` | 지도가 열림 | n_nodes, n_links, from_search |
| `graph_node_tap` | 노드를 누름 | node_id, cluster_id, is_target, n_neighbors |
| `graph_cluster_tap` | 군집 라벨을 누름 | cluster_id, label |
| `graph_toggle` | 색상 기준·배치·사용자 취향 전환 | mode(`color` / `layout` / `user`), value |
| `graph_camera` | 카메라가 움직였을 때 1초 간격 | camera: `{x, y, z}`, target(선택한 노드 id) |

## 설문

| event | 언제 | data |
|---|---|---|
| `survey_answer` | 설문 제출(문항마다) | scope(`pre` / `task` / `session`), q, a, task_run_id |

문항 id

지금은 설문을 모두 끄고(`web/js/config.js`의 `SURVEYS`), 세션 끝의 선택 질문도 묻지 않는다(`protocol.yaml`의 `final_questions: []`). 참여자에게 "앞으로 어느 쪽을 쓰겠냐"고 물으면 듣기 좋은 답을 하기 쉬워서다(The Mom Test).

- `final_questions`에 넣으면: `pref_find`(찾기: 원래 방식 / 사진 검색), `pref_listing`(등록: 원래 방식 / AI 등록). 값은 `classic` / `ai`
- `SURVEYS.pre`를 켜면: `market_freq`, `goods_exp`, `search_method`
- `SURVEYS.postTask`를 켜면: `SEQ`(1~7), `confidence`(1~5), `comment`
- `SURVEYS.finalDetail`을 켜면: `umux_classic_1`, `umux_classic_2`, `umux_ai_1`, `umux_ai_2`(1~7), `pref_reason`, `improve`가 추가되고 `pref_*`에 `none`(차이 없음) 선택지가 생긴다

## 시스템

| event | 언제 | data |
|---|---|---|
| `model_ready` | 임베딩 모델 로드 완료(세션 시작 때 이미 로드된 모델도 한 번 기록) | which(`text` / `vision`), backend(예: `wasm/q8`), load_ms, fallback |
| `perf` | 3D 지도 첫 2초 평균 프레임 | fps, light_mode |
| `search_backend_change` | 콘솔에서 검색 임베딩 위치를 바꿈 | value |
| `error` | 처리하지 못한 오류, 검색·모델·지도 오류 | message, source. `message`가 `app_reloaded`면 세션 중 탭이 다시 열린 것이며 `resumed_run`에 이어받은 Task가 남는다 |

## 세션 리플레이

rrweb 기록은 이벤트 로그와 별도 스트림이다(`<session_id>_replay.json.gz`). rrweb 이벤트의 `timestamp`(epoch ms)에서 세션 시작 시각을 빼면 `t_session_ms`와 같은 기준이 된다.
3D 지도 캔버스는 기록하지 않으며, 지도 조작은 `graph_*` 이벤트로 본다.

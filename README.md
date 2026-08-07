# BMScope

BMS 채보 파일을 브라우저에서 파싱해 **분석 · 시각화 · 재생**하는 사이트.
직접 연 파일은 업로드하지 않으며, Render PostgreSQL에 미리 저장한 채보도 불러올 수 있다.

**→ https://khanwul.github.io/BMScope/**

`.bms` `.bme` `.bml` `.pms` 지원. 파일을 끌어다 놓으면 끝.

## 기능

- **채보 프리뷰** — 전체 보기(한 화면에 통째로) / 재생 모드(스크롤 + 합성 히트음). 키음 파일 불필요.
- **구간별 패턴 분석** — [bmspc](https://github.com/khanwul/bmspc)를 JS로 포팅. PELT로 구간을 자르고 `stream` `jack` `trill` `chord` `denim` `stair` `long` `scratch` `soflan` `rest` `mix` 11종 태그를 멀티라벨로 붙인다.
- **밀도 그래프** — 종류별 노트 수 · 순간 최대 밀도 · BPM 변화를 마디별/시간별로.
- **레이더 6축** — 노트수 · 순간 nps · 스크래치 · 소프란 · 롱 · 동시치기. BMScope 자체 기준(IIDX 산식 아님).
- **타임라인 구간 선택** — 끌어서 A–B 지정, 그 구간만 반복 재생.
- **빠른 탐색·내보내기** — 구간 목록 클릭, 키보드 이동, 분석 JSON 복사, `#RANDOM` 분기 선택.
- **통계 · 레인별 분포**, 인코딩 자동 판별(UTF-8 → Shift_JIS → EUC-KR).

## 실행

DB 없이 기존 정적 모드로 실행할 수 있다 (ES 모듈이라 `file://` 은 안 됨).

```bash
npm run serve      # → http://localhost:8000
```

저장 채보까지 사용하려면 PostgreSQL 연결 문자열을 지정해 Node 서버를 실행한다.

```bash
export DATABASE_URL='postgresql://...'
npm start           # → http://localhost:10000
npm run import:chart -- ./song.bms
npm run import:chart -- ./song-pack  # 하위 폴더까지 일괄 등록
npm run import:chart -- ./packs --highest-7k  # 곡별 최고난도 7K SP 한 장
```

같은 파일명으로 다시 import하면 기존 채보를 갱신한다. DB 테이블은 서버나 import 명령이 처음 실행될 때 자동 생성된다.

## Render 배포

Render Dashboard에서 이 저장소를 Blueprint로 연결하면 `render.yaml`이 Web Service와 PostgreSQL을 만들고 `DATABASE_URL`을 자동 연결한다. 배포 후 Render의 External Database URL을 로컬 `DATABASE_URL`로 지정해 위 import 명령을 실행하면 목록에 표시된다.

무료 PostgreSQL은 30일 후 만료되므로 계속 보관할 채보에는 유료 DB를 사용한다.

## 개발

```bash
npm test                         # 순수 로직 + 배선 스모크
npm i && npm run build:vendor    # bms-js 버전 올릴 때만
```

브라우저 파싱은 [bms-js](https://github.com/bemusic/bms-js), 서버 DB 연결은 `pg`를 사용한다. 파서 번들 산출물(`js/vendor/bms.js`, 34.5KB)은 커밋되어 별도 프런트엔드 빌드가 없다.

`js/` 한 층이고 모듈 이름이 곧 역할이다. 각 파일 첫 주석이 자기 계약을 적어 두므로, 구현된 동작의 정답은 코드다 — 레인 배치는 `lanes.js`, bmspc 포팅분은 `features.js`/`segment.js`/`tagger.js`, 렌더러는 `charts.js`/`timeline.js`/`preview.js`, 배선은 `main.js`.

## 한계

- 지뢰(`D1–E9`)는 파싱·통계·렌더·재생 어디에도 없다. bmspc도 무시하므로 분석 결과와 일관된다.
- `#RANDOM`은 분기 선택·재추첨을 지원한다. `#SETRANDOM`/`#SWITCH`는 배지와 파서 경고만 표시한다.
- 패턴 태그 임계값은 7K 기준 튜닝 값. DP/PMS는 원본과 마찬가지로 best-effort.
- `.bmson`은 별개 JSON 포맷이라 제외.

## 사용한 프로젝트

- **[bms-js](https://github.com/bemusic/bms-js)** (MIT) — 유일한 브라우저 런타임 의존성. `#RANDOM`/`#SWITCH` 전개, BPM 변화·STOP·마디배율을 반영한 시간축 계산, LN 해석을 맡는다. 노드 전용 `Reader`를 피하려고 서브모듈만 직접 번들한다 ([build/entry.js](build/entry.js) 주석 참고).
- **[bmspc](https://github.com/khanwul/bmspc)** (MIT, Python) — 구간 분할과 패턴 태깅의 원본. 윈도우 피처 · PELT 구간화 · 태그 11종 임계값을 JS로 포팅했고, 원본의 `__main__` self-check를 `test/run.js`로 옮겨 대조 검증했다.
- **[ruptures](https://github.com/deepcharles/ruptures)** (BSD-2, Python) — bmspc가 쓰는 변화점 탐지 라이브러리. JS 대체품이 없어 PELT를 직접 구현했다(45줄). PELT는 정확 알고리즘이라 — 가지치기는 속도 최적화일 뿐 — 같은 목적함수의 DP를 풀면 경계가 동일하다. `ruptures`의 기본값 `jump=5`를 그대로 맞춰야 원본과 결과가 같다.
- **[esbuild](https://github.com/evanw/esbuild)** (MIT) — bms-js 번들링. 개발 의존성이라 저장소를 쓰는 쪽에는 필요 없다.

차트·재생기·UI에는 라이브러리를 쓰지 않는다. `<canvas>`, Web Audio API, `TextDecoder` 전부 네이티브.

## 라이선스

MIT — [LICENSE](LICENSE).

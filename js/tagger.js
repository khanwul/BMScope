// bmspc/tagger.py 포팅. 구간의 '원시 단위' 평균 피처 벡터에 **절대** 임계값을 적용해 태그 집합을 낸다.
//
// 절대(코퍼스 상대가 아닌) 기준선이어야 하는 이유: 상대 z-score 는 드물지만 평균 이상인 피처를
// 부풀린다 — 점프스트림(j2≈0.3)이 진짜 데님 기준(j2≥0.55)에 못 미치는데도 데님 쪽으로 끌려간다.
//
// 임계값은 원본이 손 라벨링한 7K 평가셋으로 튜닝한 값이다. DP/PMS 는 같은 검출기를
// best-effort 로 통과할 뿐 검증되지 않았다 (원본도 미해결).

export const THR = {
  rest_nps: 2.5,                          // 이 아래는 rest (읽을 구조가 없음)
  scratch_nps: 3.5,                       // 초당 스크래치. 느린 백비트 스크래치는 제외
  soflan_cov: 0.15, soflan_stop: 0.05,    // cov = 메인 BPM 에서 25% 이상 벗어난 윈도우 비율
  long_cov: 0.45, long_tap: 0.30,         // 탭 없는 긴 LN + 굵은 구간이 long 을 과검출하던 걸 올려 잡음
  jack: 0.25,                             // 잭 가드 (잭을 데님에서 밀어냄)
  chord_simul: 1.8,
  denim_j2: 0.55, denim_span: 0.50,       // 진짜 데님
  stair: 0.16, trill: 0.15,               // 단타 비율 검출기. stair 는 정밀도 우선으로 높게 둔다
  stream_nps: 6.0,                        // 밀집 흐름. 8.0 은 진짜 nps 6~8 스트림을 mix 로 흘렸다
}

// 구체적인 것 우선 — 멀티라벨 출력 순서이자 대표 태그 선택 순서
const TAGS = ['denim', 'stair', 'trill', 'jack', 'chord',
  'long', 'scratch', 'soflan', 'stream', 'rest', 'mix']

const order = tags => [...tags].sort((a, b) => TAGS.indexOf(a) - TAGS.indexOf(b))

/** feats: { 피처명: 원시값 } → 태그 배열 (구체적인 것 우선). */
export function classify(feats) {
  const g = k => feats[k] ?? 0
  const nps = g('nps'), simul = g('mean_simul')
  const tags = new Set()

  // 직교 채널은 밀도와 무관하므로 rest 게이트를 건너뛴다: 느린 소플란 인트로, 홀로 늘어진 LN,
  // 스크래치만 있는 구간은 건반 nps 가 낮아도 rest 가 아니다 (nps 는 건반만 센다).
  if (g('scratch_nps') >= THR.scratch_nps) tags.add('scratch')
  if (g('bpm_off_main') >= THR.soflan_cov || g('stop_time_frac') >= THR.soflan_stop) tags.add('soflan')
  if (g('ln_coverage') >= THR.long_cov || g('ln_active_tap_ratio') >= THR.long_tap) tags.add('long')

  // 건반 구조를 읽기엔 너무 성김: 직교 태그만 내보내고, 없으면 rest
  if (nps < THR.rest_nps) return tags.size ? order(tags) : ['rest']

  const isJack = g('jack_ratio') >= THR.jack
  const chordy = simul >= THR.chord_simul
  const periodic = g('j2_jaccard') >= THR.denim_j2

  if (isJack) tags.add('jack')
  // 진짜 데님 = 2주기 ∧ 손 폭 겹침 ∧ 코드 ∧ 잭 아님
  if (periodic && g('span_overlap') >= THR.denim_span && chordy && !isJack) {
    tags.add('denim'); tags.add('chord')
  }
  if (g('stair_ratio') >= THR.stair) tags.add('stair')
  if (g('trill_ratio') >= THR.trill && !isJack) tags.add('trill')
  // 데님이 아닌 코드 진동(스플릿 트릴)은 trill+chord 로 읽는다
  if (periodic && chordy && !tags.has('denim') && !isJack) { tags.add('trill'); tags.add('chord') }
  // 특별한 시퀀스 구조 없는 순수 코드
  if (chordy && !tags.has('denim')) tags.add('chord')
  // stream: 밀집했지만 지배적인 건반 구조가 없음. 패턴 배제는 유지한다 — 밀도 마커로만 쓰면
  // 과검출한다(정답 라벨이 밀집한 jack/chord 구간에 +stream 을 일관되게 붙이지 않기 때문).
  if (nps >= THR.stream_nps && !['jack', 'stair', 'trill', 'denim'].some(t => tags.has(t)))
    tags.add('stream')

  if (!tags.size) tags.add('mix')
  return order(tags)
}

/** 구간의 윈도우 평균 = 그 구간의 대표 벡터 (겹치는 윈도우는 상관되므로 구간이 분석 단위). */
function segmentMean(wf, a, b) {
  const out = {}
  wf.names.forEach((name, k) => {
    let s = 0
    for (let i = a; i < b; i++) s += wf.X[i][k]
    out[name] = s / (b - a)
  })
  return out
}

const toFeats = (row, names) => Object.fromEntries(names.map((n, i) => [n, row[i]]))
const tagKey = feats => classify(feats).join('|') // 태그 집합 비교용

// ── fine 세분화 (bmspc corpus.py `_refine_by_tags`) ─────────────────────────
// 텍스처 경계는 그대로 두고, 그 안에서 '태그가 2박 넘게 유지되며 바뀌는' 지점을 추가로 자른다.
// 밀도가 일정한 구간 안에서 패턴만 바뀌는 대목(예: 스트림 → 잭)을 잡아낸다.
const SMOOTH = 3     // 이동평균 창(윈도우). 태그가 한두 윈도우 튀는 걸 억제한다
const MIN_BEATS = 2  // 이보다 짧은 조각은 이웃에 흡수 (디바운스)

/** 3-윈도우 이동평균. 가장자리는 구간 안의 끝값으로 패딩한다(np.pad mode='edge'). */
function smoothRows(wf, a, b) {
  const pad = SMOOTH >> 1
  const at = i => wf.X[Math.min(Math.max(i, a), b - 1)]
  const out = []
  for (let j = a; j < b; j++) {
    const row = new Array(wf.names.length).fill(0)
    for (let k = -pad; k <= pad; k++) {
      const src = at(j + k)
      for (let c = 0; c < row.length; c++) row[c] += src[c] / SMOOTH
    }
    out.push(row)
  }
  return out
}

function refineOne(wf, [a, b]) {
  if (b - a < SMOOTH) return [[a, b]]

  // 후보 태그는 '평활된' 벡터에서 뽑고, 최종 태그는 나중에 원본 평균으로 다시 매긴다
  const states = smoothRows(wf, a, b).map(row => tagKey(toFeats(row, wf.names)))
  const runs = []
  let start = a, state = states[0]
  for (let i = 1; i < states.length; i++)
    if (states[i] !== state) { runs.push([start, a + i, state]); start = a + i; state = states[i] }
  runs.push([start, b, state])

  const n = wf.X.length
  const beatAt = i => (i < n ? wf.beat0[i] : wf.beat1[n - 1])
  const runBeats = r => beatAt(r[1]) - beatAt(r[0])

  // 짧은 조각 흡수. 양옆 태그가 같으면 셋을 하나로, 끝이면 안쪽으로, 아니면 긴 이웃으로.
  while (runs.length > 1) {
    const s = runs.findIndex(r => runBeats(r) <= MIN_BEATS)
    if (s < 0) break
    const last = runs.length - 1
    if (s > 0 && s < last && runs[s - 1][2] === runs[s + 1][2]) {
      runs[s - 1][1] = runs[s + 1][1]
      runs.splice(s, 2)
    } else if (s === 0) {
      runs[1][0] = runs[0][0]
      runs.splice(0, 1)
    } else if (s === last) {
      runs[last - 1][1] = runs[last][1]
      runs.pop()
    } else if (runBeats(runs[s - 1]) >= runBeats(runs[s + 1])) {
      runs[s - 1][1] = runs[s][1]
      runs.splice(s, 1)
    } else {
      runs[s + 1][0] = runs[s][0]
      runs.splice(s, 1)
    }
  }

  // 자식 태그를 원본(비평활) 평균으로 다시 매기고, 같아진 이웃은 도로 합친다
  const segs = runs.map(([x, y]) => [x, y])
  while (segs.length > 1) {
    const tags = segs.map(([x, y]) => tagKey(segmentMean(wf, x, y)))
    const same = tags.findIndex((t, i) => i < tags.length - 1 && t === tags[i + 1])
    if (same < 0) break
    segs.splice(same, 2, [segs[same][0], segs[same + 1][1]])
  }
  return segs
}

/** 텍스처 구간들을 태그 변화 지점에서 더 잘게 나눈다. 텍스처 경계는 항상 살아남는다. */
export const refine = (wf, segs) => segs.flatMap(s => refineOne(wf, s))

/**
 * `[a, b)` 윈도우 구간 목록 → 태그 붙은 구간.
 * 끝 시각은 **다음 구간의 시작 윈도우**다 — 이 구간 마지막 윈도우의 끝을 쓰면 윈도우 폭만큼
 * 넘쳐서 인접 구간이 겹친다.
 */
export function tagSegments(wf, segs) {
  const n = wf.t0.length
  return segs.map(([a, b]) => ({
    a, b,
    beat0: wf.beat0[a],
    beat1: b < n ? wf.beat0[b] : wf.beat1[n - 1],
    t0: wf.t0[a],
    t1: b < n ? wf.t0[b] : wf.t1[n - 1],
    tags: classify(segmentMean(wf, a, b)),
  }))
}

const num = (v, d = 0) => (v == null || v === '' || isNaN(+v) ? d : +v)

/** BPM 구간 목록. 각 구간의 길이는 (박 수 × 60 / BPM) 이므로 STOP 시간이 섞이지 않는다. */
function bpmSegments({ timing }, totalBeats) {
  const edges = [0, ...timing.getEventBeats().filter(b => b > 0 && b < totalBeats), totalBeats]
  const segs = []
  for (let i = 0; i < edges.length - 1; i++) {
    const [b0, b1] = [edges[i], edges[i + 1]]
    const bpm = timing.bpmAtBeat(b0)
    if (b1 > b0 && bpm > 0) segs.push({ b0, b1, bpm, seconds: ((b1 - b0) * 60) / bpm })
  }
  return segs
}

function bpmStats(parsed, lanes) {
  const { chart } = parsed
  const segs = bpmSegments(parsed, lanes.totalBeats)
  const objects = chart.objects.all()

  // 메인 BPM 은 등장 횟수가 아니라 '시간 가중' 최빈값. 소플란 채보에서 이걸 틀리면
  // 레이더의 SOFLAN 축과 bmspc 의 bpm_off_main 이 통째로 무의미해진다.
  const weight = new Map()
  for (const s of segs) {
    const k = s.bpm.toFixed(2)
    weight.set(k, (weight.get(k) || 0) + s.seconds)
  }
  const main = [...weight].sort((a, b) => b[1] - a[1])[0]

  const all = segs.map(s => s.bpm)
  return {
    initial: num(chart.headers.get('bpm'), 130),
    min: all.length ? Math.min(...all) : 0,
    max: all.length ? Math.max(...all) : 0,
    main: main ? +main[0] : 0,
    changes: objects.filter(o => o.channel === '03' || o.channel === '08').length,
    stops: lanes.stopEvents.length,
    stopSeconds: lanes.stopEvents.reduce((s, e) => s + e.seconds, 0),
  }
}

// 마디 뷰와 시간 뷰는 버킷 배열의 형태가 같아서 렌더러 하나를 공유한다.
// 막대는 종류별로 쌓고(높이 합 = 노트 수), 선은 '순간 최대 밀도'다.
//
// 왜 NPS 가 아닌가: NPS = 노트 수 / 버킷 길이라서 시간 뷰에서는 노트 수에 정확히 비례하고
// 마디 뷰에서도 BPM 만큼만 갈린다 — BPM 은 이미 따로 그린다. 순간 최대 밀도는 노트가
// 버킷 안에서 고르게 퍼졌는지 한 곳에 몰렸는지를 재므로 막대 높이와 독립이다.
// 스크래치 레인의 롱노트(백스핀)는 '스크래치'로 센다 — 길이보다 어느 레인이냐가 읽는 데 중요하다.
export const kindOf = (n, scratch) => (scratch.has(n.col) ? 'scratch' : n.isLN ? 'ln' : 'normal')

/**
 * 각 노트에서 시작하는 1초 창의 노트 수. 전체 최댓값이 곧 채보의 최대 NPS 이고,
 * 버킷별 최댓값이 그 구간의 순간 최대 밀도다 — 통계 패널과 같은 정의라 눈금이 통한다.
 */
function windowCounts(times) {
  const out = new Array(times.length)
  let hi = 0
  for (let lo = 0; lo < times.length; lo++) {
    while (hi < times.length && times[hi] - times[lo] < 1) hi++
    out[lo] = hi - lo
  }
  return out
}

/**
 * 버킷 집계. 마디 뷰와 시간 뷰는 경계만 다르고 나머지가 같다.
 * `edges` 는 `{ beat, time }` 경계 목록이고, 노트 배분은 항상 시간으로 가른다
 * (`beatToSeconds` 가 박에 대해 단조증가라 마디 경계에서도 박 비교와 같은 결과).
 */
function bucketize(timing, lanes, wc, edges) {
  const notes = lanes.notes
  const scratch = new Set(lanes.scratchCols)
  const bars = []
  let i = 0
  for (let k = 0; k + 1 < edges.length; k++) {
    const types = { normal: 0, ln: 0, scratch: 0 }
    let peak = 0
    while (i < notes.length && notes[i].time < edges[k + 1].time) {
      peak = Math.max(peak, wc[i])
      types[kindOf(notes[i++], scratch)]++
    }
    bars.push({
      index: k,
      types,
      notes: types.normal + types.ln + types.scratch,
      peak,
      seconds: edges[k + 1].time - edges[k].time,
      bpm: timing.bpmAtBeat(edges[k].beat),
      startBeat: edges[k].beat,
      startTime: edges[k].time,
    })
  }
  return bars
}

/**
 * 박 → `마디` 또는 `마디:박` 토큰 (0-indexed). bmspc 텍스트 출력과 같은 표기라
 * 구간 목록을 원본 CLI 결과와 눈으로 대조할 수 있다.
 */
export function measureToken(beat, starts) {
  let i = 0
  while (i + 1 < starts.length && starts[i + 1] <= beat + 1e-6) i++
  const b = beat - starts[i]
  return Math.abs(b) < 1e-6 ? `${i}` : `${i}:${+b.toFixed(4)}`
}

/**
 * 레이더 6축. IIDX 산식을 따르지 않고, bmspc 윈도우 피처를 차트 전체로 집계한다 —
 * 새 계산이 사실상 없고, 레이더와 구간 태그가 같은 피처를 보므로 둘이 어긋나지 않는다.
 *
 * `raw` 를 100점으로 환산하는 K 는 실측 보정값이다.
 * ponytail: 합성 채보 3장으로만 맞춘 눈대중. 실제 채보 100장 돌려보고 이 표만 고치면 된다.
 */
// 배열 순서가 곧 육각형 배치다 — 12시부터 시계 방향.
// `of(row, i)` — row 는 피처 벡터, i 는 이름 → 인덱스 표.
export const RADAR_AXES = [
  { key: 'DENSITY', label: '노트수',    K: 20,  of: (r, i) => r[i.nps] },
  { key: 'PEAK',    label: '순간 nps',  K: 25,  of: (r, i) => r[i.peak_nps] },
  { key: 'SCRATCH', label: '스크래치',  K: 3,   of: (r, i) => r[i.scratch_nps] },
  { key: 'SOFLAN',  label: '소프란',    K: 0.5, of: (r, i) => r[i.bpm_off_main] + 2 * r[i.stop_time_frac] },
  { key: 'LN',      label: '롱',        K: 0.5, of: (r, i) => r[i.ln_coverage] },
  { key: 'CHORD',   label: '동시치기',  K: 1.2, of: (r, i) => Math.max(r[i.mean_simul] - 1, 0) },
]

export function radar(wf) {
  const idx = Object.fromEntries(wf.names.map((n, i) => [n, i]))
  // 곡 앞뒤의 빈 윈도우를 평균에 넣으면 모든 축이 눌린다 — 노트가 있는 윈도우만 집계한다.
  const active = wf.X.filter(r => r[idx.nps] > 0 || r[idx.scratch_nps] > 0)

  return RADAR_AXES.map(({ key, label, K, of }) => {
    let raw = 0
    if (active.length) {
      const vals = active.map(r => of(r, idx))
      // PEAK 만 평균이 아니라 상위 5% 분위 — 평균을 쓰면 한 번의 폭발이 전체에 묻힌다.
      if (key === 'PEAK') raw = [...vals].sort((a, b) => a - b)[Math.floor(0.95 * (vals.length - 1))]
      else raw = vals.reduce((s, v) => s + v, 0) / vals.length
    }
    return { key, label, raw, value: Math.min(100, Math.max(0, (raw / K) * 100)) }
  })
}

export function analyze(parsed, lanes) {
  const { chart, info, timing } = parsed
  const { notes, scratchCols } = lanes
  const isScratch = n => scratchCols.includes(n.col)

  const times = notes.map(n => n.time)
  const first = times[0] ?? 0
  const end = notes.reduce((m, n) => Math.max(m, n.endTime ?? n.time), 0)
  const span = Math.max(end - first, 1e-6)

  const byCol = new Array(lanes.keyCols + scratchCols.length).fill(0)
  for (const n of notes) byCol[n.col]++
  const wc = windowCounts(times)

  // 마디 경계는 박으로, 시간 경계는 1초 간격으로 잡고 마지막은 곡 끝에 맞춘다.
  const measureEdges = lanes.measureStarts.map(beat => ({ beat, time: timing.beatToSeconds(beat) }))
  const timeEdges = [...Array(Math.ceil(end)).keys()]
    .map(time => ({ beat: timing.secondsToBeat(time), time }))
  if (timeEdges.length) timeEdges.push({ beat: timing.secondsToBeat(end), time: end })

  return {
    info: { ...info, subtitle: info.subtitles.join(' '),
      rank: num(chart.headers.get('rank'), 3),
      total: num(chart.headers.get('total')) },
    mode: lanes.mode,
    duration: end,
    counts: {
      total: notes.length,
      ln: notes.filter(n => n.isLN).length,
      scratch: notes.filter(isScratch).length,
      invisible: lanes.invisible,
      maxEx: notes.length * 2,
      byCol,
    },
    bpm: bpmStats(parsed, lanes),
    density: {
      nps: notes.length / span,
      peakNps: wc.reduce((m, c) => Math.max(m, c), 0),
      measures: bucketize(timing, lanes, wc, measureEdges),
      seconds: bucketize(timing, lanes, wc, timeEdges),
    },
  }
}

export const RANK_NAMES = ['VERY HARD', 'HARD', 'NORMAL', 'EASY', 'VERY EASY']

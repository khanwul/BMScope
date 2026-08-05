import { Notes, BMSChart } from './vendor/bms.js'

// bms-js 의 Notes 는 1P 채널에만 컬럼을 매긴다(2P 는 column: undefined).
// 그래서 2P 채널을 1P 로 옮긴 사본을 만들어 같은 Notes 에 한 번 더 통과시킨다.
// LN 짝맞춤(#LNOBJ / #LNTYPE)을 그대로 재사용하므로 중복 구현이 없다.
const SHIFT_2P_TO_1P = { 2: '1', 4: '3', 6: '5' } // 가시 / 비가시 / 롱노트. 지뢰(E)는 다루지 않는다

function as1P(src) {
  const c = new BMSChart()
  c.headers = src.headers
  c.timeSignatures = src.timeSignatures
  for (const o of src.objects.all()) {
    const to = SHIFT_2P_TO_1P[o.channel[0]]
    if (to) c.objects.add({ ...o, channel: to + o.channel[1] })
  }
  return c
}

const playable = chart => Notes.fromBMSChart(chart).all().filter(n => n.column)

// 컬럼 번호는 0…keyCols-1 이 건반, 그 뒤가 스크래치. bmspc features 의 입력 계약과 같다.
// 5K/10K 는 7K/14K 템플릿을 그대로 타고 6·7키 레인만 비워 둔다 — bmspc 와 같은 규칙이라
// 컬럼 폭이 달라지지 않는다(폭이 바뀌면 jack/stair 임계값의 우연 수준이 어긋난다).
const LAYOUTS = {
  SP:  { keyCols: 7,  scratchCols: [7],     p1: c => (c === 'SC' ? 7 : +c - 1) },
  DP:  { keyCols: 14, scratchCols: [14, 15],
         p1: c => (c === 'SC' ? 14 : +c - 1),
         p2: c => (c === 'SC' ? 15 : +c + 6) },
  // PMS: 1P 11–15 = 버튼 1–5, 2P 22–25 = 버튼 6–9. 스크래치 없음.
  PMS: { keyCols: 9,  scratchCols: [],
         p1: c => +c - 1,
         p2: c => +c + 3 },
}

// ── 화면 배치 ──────────────────────────────────────────────────────────────
// 재생기 · 전체 보기 · 레인별 분포가 모두 같은 배치를 쓴다. 여기가 단일 출처다.
// (그리기는 charts/preview 쪽 몫이라 여기엔 캔버스 코드를 두지 않는다 — 순환 import 방지)
const KEY_W = 7   // 건반 레인 폭(px)
const SCR_W = 11  // 스크래치는 넓게 — 실제 배치 감각

/** 화면에 놓이는 순서. 1P 스크래치가 왼쪽 끝, DP 는 2P 스크래치가 오른쪽 끝. */
export function laneOrder({ keyCols, scratchCols }) {
  const keys = [...Array(keyCols).keys()]
  if (scratchCols.length === 2) return [scratchCols[0], ...keys, scratchCols[1]]
  if (scratchCols.length === 1) return [scratchCols[0], ...keys]
  return keys // PMS: 스크래치 없음
}

/** 레인별 x 오프셋과 폭. 왼쪽 끝 기준의 상대 좌표. `scale` 로 통째로 키운다. */
export function laneGeom(lanes, scale = 1) {
  const scratch = new Set(lanes.scratchCols)
  const geom = new Map()
  let x = 0
  for (const col of laneOrder(lanes)) {
    const w = (scratch.has(col) ? SCR_W : KEY_W) * scale
    geom.set(col, { x, w })
    x += w
  }
  // DP 는 1P/2P 경계에 구분선을 긋는다. 스크래치가 둘이면 DP — 2P 건반은 keyCols 의 뒤 절반.
  const splitX = lanes.scratchCols.length === 2 ? geom.get(lanes.keyCols / 2)?.x ?? null : null
  return { geom, width: x, scratch, splitX }
}

export const laneVar = (col, scratch) =>
  scratch.has(col) ? '--scratch' : col % 2 === 0 ? '--lane-white' : '--lane-blue'

/** 레인 라벨. DP 는 양쪽 다 1…7 로 센다. */
export function laneLabel(col, { keyCols, scratchCols }) {
  if (scratchCols.includes(col)) return 'S'
  return (col % (scratchCols.length === 2 ? keyCols / 2 : keyCols)) + 1
}

function detect(ext, p1, p2) {
  const wide = p1.some(n => +n.column > 5) // 6·7키를 쓰는가
  if (ext === 'pms') return ['PMS', '9K']
  if (p2.length) {
    // PMS 채널 서명: 2P 는 22–25 만, 1P 는 11–15 만 쓴다 (스크래치·6/7키 없음)
    const pmsLike = !p2.some(n => n.column === 'SC' || n.column === '1' || +n.column > 5) && !wide
    if (pmsLike) return ['PMS', '9K']
    return ['DP', wide ? '14K' : '10K']
  }
  return ['SP', wide ? '7K' : '5K']
}

/** STOP 이벤트를 (박, 정지 초) 로. bmspc Chart.stop_events 와 같은 형태. */
function stopEvents(chart, timing) {
  return chart.objects
    .all()
    .filter(o => o.channel === '09')
    .map(o => {
      const beat = chart.measureToBeat(o.measure, o.fraction)
      const units = +chart.headers.get('stop' + o.value.toLowerCase()) || 0
      const bpm = timing.bpmAtBeat(beat)
      return { beat, seconds: bpm > 0 ? (units / 48) * (60 / bpm) : 0 } // #STOPxx 단위 = 1/192 온음표
    })
    .sort((a, b) => a.beat - b.beat)
}

/** chart → { mode, keyCols, scratchCols, notes, totalBeats, invisible } */
export function toLanes({ chart, ext, timing }) {
  const p1 = playable(chart)
  const p2 = playable(as1P(chart))
  const [template, mode] = detect(ext, p1, p2)
  const L = LAYOUTS[template]

  const build = (list, map) =>
    list.map(n => ({
      beat: n.beat,
      time: timing.beatToSeconds(n.beat),
      endBeat: n.endBeat,
      endTime: n.endBeat == null ? undefined : timing.beatToSeconds(n.endBeat),
      col: map(n.column),
      isLN: n.endBeat != null,
    }))

  const notes = [
    ...build(p1, L.p1),
    ...(L.p2 ? build(p2, L.p2) : []),
  ]
    .filter(n => n.col >= 0 && n.col < L.keyCols + L.scratchCols.length)
    .sort((a, b) => a.time - b.time || a.col - b.col)

  // 비가시 노트(채널 3x/4x)는 bms-js Notes 가 아예 내보내지 않으므로 개수만 직접 센다.
  const invisible = chart.objects.all().filter(o => /^[34][1-9]$/.test(o.channel)).length

  const lastBeat = notes.reduce((m, n) => Math.max(m, n.endBeat ?? n.beat), 0)
  const lastMeasure = chart.objects.all().reduce((m, o) => Math.max(m, o.measure), 0)
  // 마디 m 의 시작 박. 마지막 마디의 끝까지 담으므로 길이는 lastMeasure + 2.
  const measureStarts = Array.from({ length: lastMeasure + 2 }, (_, m) => chart.measureToBeat(m, 0))

  return {
    mode,
    keyCols: L.keyCols,
    scratchCols: L.scratchCols,
    notes,
    invisible,
    measureStarts,
    stopEvents: stopEvents(chart, timing),
    totalBeats: Math.max(lastBeat, measureStarts[measureStarts.length - 1]),
  }
}

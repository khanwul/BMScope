// bmspc/features.py 포팅. 2박 윈도우를 0.5박씩 밀며 윈도우당 피처 벡터 하나를 낸다.
// 스크래치는 건반 패턴 피처에서 빼고 자체 채널로 다룬다. LN 몸통은 밀도를 부풀리지 않는다
// (탭 피처는 노트 머리만, LN-잭은 LN 활성 구간 겹침으로).
//
// 파이썬/numpy 와 결과가 갈리는 지점은 세 곳뿐이고 전부 맞춰 놓았다:
//   · round 는 짝수 반올림(banker's rounding) — Math.round 는 올림
//   · np.std 는 모표준편차(ddof=0)
//   · np.unique 는 정렬된 값을 주고 argmax 는 첫 최대를 고름 → 동점이면 작은 값

const ROW_EPS = 0.005 // s. 이 간격 안의 노트는 한 행(동시치기)으로 본다
const SNAP_NS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 48]
const WIN_BEATS = 2.0
const HOP_BEATS = 0.5

export const FEATURE_NAMES = [
  // 밀도
  'nps', 'peak_nps', 'mean_simul',
  // 균일도 / 스냅
  'ioi_cv', 'snap_entropy',
  // 시퀀스 (단타 행)
  'jack_ratio', 'trill_ratio', 'stair_ratio',
  // 코드 형태
  'j2_jaccard', 'span_overlap',
  // 스크래치
  'scratch_nps',
  // LN
  'ln_coverage', 'ln_active_tap_ratio',
  // 소플란
  'eff_bpm', 'stop_time_frac', 'bpm_off_main',
]

// ── 수치 헬퍼 ────────────────────────────────────────────────────────────
const sum = a => a.reduce((s, v) => s + v, 0)
const mean = a => sum(a) / a.length
const stdev = a => { const m = mean(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / a.length) }

/** 파이썬 round()/np.round 의 짝수 반올림. Math.round 는 .5 를 올려서 경계에서 갈린다. */
function roundHalfEven(x) {
  const f = Math.floor(x)
  if (x - f !== 0.5) return Math.round(x)
  return f % 2 === 0 ? f : f + 1
}

/** np.searchsorted(a, v, 'left') */
function lowerBound(arr, v) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m }
  return lo
}

function entropy(counts) {
  const s = sum(counts)
  if (s <= 0) return 0
  let h = 0
  for (const c of counts) if (c > 0) { const p = c / s; h -= p * Math.log2(p) }
  return h
}

// ── 차트 단위 전처리 ──────────────────────────────────────────────────────

/** 정렬된 (time, beat, col) 을 ROW_EPS 시간 간격으로 묶어 행 배열로. */
function buildRows(onsets) {
  const rtime = [], rbeat = [], rcols = []
  let curT = null, curB = 0, cur = []
  for (const [t, b, c] of onsets) {
    if (curT === null || t - curT > ROW_EPS) {
      if (cur.length) { rtime.push(curT); rbeat.push(curB); rcols.push(cur.sort((x, y) => x - y)) }
      curT = t; curB = b; cur = [c]
    } else cur.push(c)
  }
  if (cur.length) { rtime.push(curT); rbeat.push(curB); rcols.push(cur.sort((x, y) => x - y)) }
  return { rtime, rbeat, rcols }
}

function snapClass(beat, tol = 0.012) {
  let r = beat - Math.floor(beat)
  if (r > 1 - tol) r = 0
  for (const n of SNAP_NS) if (Math.abs(r * n - roundHalfEven(r * n)) <= tol * n) return n
  return null // 격자 밖
}

function snapBin(n) {
  if (n === null) return 5      // 격자 밖
  if (n <= 1) return 0          // 4분 (정박)
  if (n === 2) return 1         // 8분
  if (n === 3 || n === 6) return 2 // 셋잇단
  if (n === 4) return 3         // 16분
  return 4                      // 32분 이상
}

/**
 * 지속되는 두 노트 교대(A-B-A-B) 안에 든 단타의 비율.
 * 단순 lag-2 일치율은 과검출한다 — 무작위 스트림도 우연히 1/키 확률로 맞고,
 * 지그재그 계단(1-2-3-2-1)은 고립된 일치를 만든다. 그래서 run 게이트를 건다.
 * run>=2 (일치 2회 = 4노트 교대) 부터 인정.
 */
export function trillRatio(cseq) {
  const n = cseq.length
  if (n < 3) return 0
  let covered = 0, run = 0
  for (let i = 2; i <= n; i++) {                        // i === n 은 마지막 run 을 흘려보내는 용도
    if (i < n && cseq[i] === cseq[i - 2] && cseq[i] !== cseq[i - 1]) run++
    else { if (run >= 2) covered += run + 2; run = 0 }  // run 은 간격으로 분리되므로 구간이 안 겹침
  }
  return covered / n
}

// ── 윈도우 하나의 피처 ────────────────────────────────────────────────────

function windowFeatures(ctx, b0, b1, t0, t1) {
  const { rtime, rbeat, rcols, scrBeats, lns, kbTimes, kbCols, stops } = ctx
  const wall = Math.max(t1 - t0, 1e-6)
  const f = Object.fromEntries(FEATURE_NAMES.map(n => [n, 0]))
  f.eff_bpm = ((b1 - b0) * 60) / wall

  const lo = lowerBound(rbeat, b0)
  const hi = lowerBound(rbeat, b1)
  const rt = rtime.slice(lo, hi)
  const rc = rcols.slice(lo, hi)
  const rb = rbeat.slice(lo, hi)
  const sizes = rc.map(c => c.length)
  const nNotes = sum(sizes)

  if (nNotes) {
    f.nps = nNotes / wall
    f.mean_simul = mean(sizes)
  }

  if (rt.length >= 2) {
    const ioi = []
    for (let i = 1; i < rt.length; i++) if (rt[i] - rt[i - 1] > 0) ioi.push(rt[i] - rt[i - 1])
    if (ioi.length) {
      f.peak_nps = 1 / Math.min(...ioi)
      const m = mean(ioi)
      f.ioi_cv = m > 0 ? stdev(ioi) / m : 0
    }
  }

  if (rc.length) {
    const bins = new Array(6).fill(0)
    rc.forEach((cols, i) => { for (let k = 0; k < cols.length; k++) bins[snapBin(snapClass(rb[i]))]++ })
    f.snap_entropy = entropy(bins)
  }

  // 잭: 인접 행이 공유하는 컬럼 수
  if (rc.length >= 2) {
    let jacks = 0
    for (let i = 0; i + 1 < rc.length; i++) {
      const next = new Set(rc[i + 1])
      for (const c of new Set(rc[i])) if (next.has(c)) jacks++
    }
    f.jack_ratio = jacks / nNotes
  }

  // 단타 행 시퀀스: 트릴 / 계단
  const cseq = rc.filter(c => c.length === 1).map(c => c[0])
  if (cseq.length >= 3) {
    f.trill_ratio = trillRatio(cseq)
    let up = 1, dn = 1, stairNotes = 0
    for (let i = 1; i < cseq.length; i++) {
      const s = cseq[i] - cseq[i - 1]
      if (s > 0) { up++; dn = 1 } else if (s < 0) { dn++; up = 1 } else { up = 1; dn = 1 }
      if (up >= 3 || dn >= 3) stairNotes++
    }
    f.stair_ratio = stairNotes / cseq.length
  }

  // 궤적 / 코드 형태 — j2 = lag-2 자기유사도(2주기 = 데님/트릴), span_overlap = 인접 행 폭 교차
  if (rc.length >= 3) {
    const sets = rc.map(c => new Set(c))
    const j2 = []
    for (let i = 0; i + 2 < sets.length; i++) {
      let inter = 0
      for (const c of sets[i]) if (sets[i + 2].has(c)) inter++
      j2.push(inter / new Set([...sets[i], ...sets[i + 2]]).size)
    }
    f.j2_jaccard = j2.length ? mean(j2) : 0
    const ov = []
    for (let i = 0; i + 1 < rc.length; i++) {
      const a = rc[i], b = rc[i + 1]
      ov.push(Math.max(a[0], b[0]) <= Math.min(a[a.length - 1], b[b.length - 1]) ? 1 : 0)
    }
    f.span_overlap = ov.length ? mean(ov) : 0
  }

  const nScr = lowerBound(scrBeats, b1) - lowerBound(scrBeats, b0)
  if (nScr) f.scratch_nps = nScr / wall

  // LN / LN-잭
  const winLns = lns
    .filter(l => l.start < t1 && l.end > t0)
    .map(l => ({ col: l.col, start: Math.max(l.start, t0), end: Math.min(l.end, t1) }))
  if (winLns.length) {
    const ivs = winLns.map(l => [l.start, l.end]).sort((x, y) => x[0] - y[0] || x[1] - y[1])
    let cov = 0, ce = ivs[0][0]
    for (let [a, z] of ivs) {
      a = Math.max(a, ce)
      if (z > a) { cov += z - a; ce = z } else ce = Math.max(ce, z)
    }
    f.ln_coverage = Math.min(cov / wall, 1)
    // 다른 컬럼의 LN 이 눌려 있는 동안 떨어지는 탭 = LN-잭 신호
    if (kbTimes.length && nNotes) {
      let activeTaps = 0
      for (let i = lowerBound(kbTimes, t0); i < kbTimes.length; i++) {
        const ot = kbTimes[i]
        if (ot >= t1) break
        if (winLns.some(l => l.col !== kbCols[i] && l.start <= ot && ot <= l.end)) activeTaps++
      }
      f.ln_active_tap_ratio = activeTaps / nNotes
    }
  }

  f.stop_time_frac = sum(stops.filter(s => s.beat >= b0 && s.beat < b1).map(s => s.seconds)) / wall

  return FEATURE_NAMES.map(n => f[n])
}

// ── 추출 ─────────────────────────────────────────────────────────────────

/**
 * lanes(js/lanes.js 산출) + timing → 윈도우 피처.
 * 반환: { beat0, beat1, t0, t1, X: number[][], names }
 */
export function extract(lanes, timing, { winBeats = WIN_BEATS, hopBeats = HOP_BEATS } = {}) {
  const scratch = new Set(lanes.scratchCols)
  const kb = lanes.notes
    .filter(n => !scratch.has(n.col))
    .map(n => [n.time, n.beat, n.col])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])

  const { rtime, rbeat, rcols } = buildRows(kb)
  const ctx = {
    rtime, rbeat, rcols,
    scrBeats: lanes.notes.filter(n => scratch.has(n.col)).map(n => n.beat).sort((a, b) => a - b),
    lns: lanes.notes.filter(n => n.isLN).map(n => ({ col: n.col, start: n.time, end: n.endTime })),
    kbTimes: kb.map(o => o[0]),
    kbCols: kb.map(o => o[2]),
    stops: lanes.stopEvents,
  }

  const total = lanes.totalBeats
  const stop = Math.max(total - winBeats * 0.5, hopBeats)
  const beat0 = [], beat1 = [], t0a = [], t1a = [], X = []
  for (let i = 0, n = Math.ceil(stop / hopBeats); i < n; i++) {
    const b0 = i * hopBeats
    const b1 = Math.min(b0 + winBeats, total)
    if (b1 - b0 < winBeats * 0.5) continue
    const t0 = timing.beatToSeconds(b0)
    const t1 = timing.beatToSeconds(b1)
    X.push(windowFeatures(ctx, b0, b1, t0, t1))
    beat0.push(b0); beat1.push(b1); t0a.push(t0); t1a.push(t1)
  }

  // bpm_off_main: 윈도우별 '메인 템포에서 벗어남' 플래그. 구간 평균이 곧 소플란 커버리지.
  if (X.length) {
    const iEb = FEATURE_NAMES.indexOf('eff_bpm')
    const iOff = FEATURE_NAMES.indexOf('bpm_off_main')
    const counts = new Map()
    for (const row of X) {
      const k = roundHalfEven(row[iEb])
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    // np.unique 는 정렬 순, argmax 는 첫 최대 → 동점이면 작은 값이 메인
    const main = [...counts.keys()].sort((a, b) => a - b)
      .reduce((best, k) => (counts.get(k) > counts.get(best) ? k : best))
    if (main > 0)
      for (const row of X) row[iOff] = Math.abs(row[iEb] - main) / main >= 0.25 ? 1 : 0
  }

  return { beat0, beat1, t0: t0a, t1: t1a, X, names: FEATURE_NAMES }
}

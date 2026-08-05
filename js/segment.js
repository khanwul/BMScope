// bmspc/segment.py 포팅. 윈도우 피처를 표준화한 뒤 PELT 변화점 탐지로 구간 경계를 잡는다.
//
// 경계는 '텍스처' 변화에만 놓는다 — 노트 밀도 + 반복 정도. 패턴 '형태'(jack/trill/stair/denim)로도
// 자르면 안 된다: 형태는 구간을 무엇으로 분류하느냐이지 구간이 어디서 시작·끝나느냐가 아니고,
// 형태로 자르면 손 모양이 흔들릴 때마다 멀쩡한 구간이 토막난다.

export const SEG_FEATURES = [
  // 밀도: 초당 노트, 순간 최고, 코드 두께
  'nps', 'peak_nps', 'mean_simul',
  // 반복 정도 (패턴 형태와 무관):
  //   j2_jaccard = lag-2 자기유사도 · ioi_cv = 박자 균일도 · snap_entropy = 분할 다양성
  'j2_jaccard', 'ioi_cv', 'snap_entropy',
]

const PEN_MULT = 3.0 // 낮을수록 잘게 쪼갠다. 3.0 이 10~16초 구간을 노린 값
const MIN_SIZE = 2
const MIN_WIN = 2
// ruptures.Pelt 의 기본 jump. bmspc 가 이를 지정하지 않으므로 경계는 윈도우 인덱스
// 5의 배수(= 2.5박 격자)에서만 잡힌다. 빼먹으면 원본과 경계가 미묘하게 달라진다.
const JUMP = 5

/** 열별 z-score. 표준편차가 0에 가까우면 1로 두어 상수 열이 폭발하지 않게 한다. */
function standardize(X) {
  const n = X.length, d = X[0].length
  const mu = new Float64Array(d), sd = new Float64Array(d)
  for (const row of X) for (let k = 0; k < d; k++) mu[k] += row[k] / n
  for (const row of X) for (let k = 0; k < d; k++) sd[k] += (row[k] - mu[k]) ** 2 / n
  for (let k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k]) < 1e-9 ? 1 : Math.sqrt(sd[k])
  return X.map(row => row.map((v, k) => (v - mu[k]) / sd[k]))
}

/**
 * PELT (l2). ruptures 는 파이썬 전용이라 직접 구현한다 — 가지치기는 속도용일 뿐
 * 정확 알고리즘이므로 같은 목적함수를 풀면 경계가 같다.
 *   cost(i,j) = Σ_dim Σ_{i≤t<j} (x - 평균)²   ← 누적합 두 개로 O(d) 조회
 */
function pelt(X, pen, { minSize = MIN_SIZE, jump = JUMP } = {}) {
  const n = X.length, d = X[0].length
  const S1 = new Float64Array((n + 1) * d)
  const S2 = new Float64Array((n + 1) * d)
  for (let i = 0; i < n; i++)
    for (let k = 0; k < d; k++) {
      S1[(i + 1) * d + k] = S1[i * d + k] + X[i][k]
      S2[(i + 1) * d + k] = S2[i * d + k] + X[i][k] ** 2
    }
  const cost = (i, j) => {
    const len = j - i
    let c = 0
    for (let k = 0; k < d; k++) {
      const s1 = S1[j * d + k] - S1[i * d + k]
      c += S2[j * d + k] - S2[i * d + k] - (s1 * s1) / len
    }
    return c
  }

  const ind = []
  for (let k = 0; k < n; k += jump) if (k >= minSize) ind.push(k)
  ind.push(n)

  const G = new Map([[0, 0]]) // G[t] = 0..t 최적 분할 비용(페널티 포함)
  const prev = new Map()
  let admissible = []
  for (const bkp of ind) {
    admissible.push(Math.floor((bkp - minSize) / jump) * jump)
    const vals = admissible.map(t => (G.has(t) ? G.get(t) + cost(t, bkp) + pen : Infinity))
    let best = Infinity, bestT = -1
    // 동점이면 첫 항 — 파이썬 min() 과 같은 규칙
    vals.forEach((v, i) => { if (v < best) { best = v; bestT = admissible[i] } })
    G.set(bkp, best)
    prev.set(bkp, bestT)
    admissible = admissible.filter((_, i) => vals[i] <= best + pen)
  }

  const bkps = []
  for (let cur = n; cur > 0; cur = prev.get(cur)) bkps.push(cur)
  return bkps.reverse().slice(0, -1) // 끝의 n 은 버린다
}

/** 윈도우 피처 → 경계 인덱스. 윈도우가 너무 적으면 경계 없음. */
export function boundaries(wf, penMult = PEN_MULT) {
  const idx = SEG_FEATURES.map(name => wf.names.indexOf(name))
  const n = wf.X.length
  if (n < 2 * MIN_SIZE + 1) return []
  const Xs = standardize(wf.X.map(row => idx.map(i => row[i])))
  return pelt(Xs, penMult * SEG_FEATURES.length * Math.log(n))
}

/**
 * 경계 → `[a, b)` 윈도우 인덱스 구간. `MIN_WIN` 미만인 조각은 이웃에 붙이지 않고 **버린다**
 * (bmspc 와 같은 동작이라 구간이 곡 전체를 덮지 않을 수 있다).
 */
export function segments(wf, penMult = PEN_MULT) {
  if (wf.X.length < 5) return []
  const edges = [0, ...boundaries(wf, penMult), wf.X.length]
  const segs = []
  for (let i = 0; i < edges.length - 1; i++)
    if (edges[i + 1] - edges[i] >= MIN_WIN) segs.push([edges[i], edges[i + 1]])
  return segs
}

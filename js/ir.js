const TACHI = 'https://boku.tachi.ac'

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

/** Web Crypto가 지원하지 않는 MD5는 IR 식별용으로만 최소 구현한다. */
export function md5(buffer) {
  const src = new Uint8Array(buffer)
  const size = Math.ceil((src.length + 9) / 64) * 64
  const bytes = new Uint8Array(size)
  bytes.set(src)
  bytes[src.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(size - 8, (src.length * 8) >>> 0, true)
  view.setUint32(size - 4, Math.floor(src.length / 0x20000000), true)

  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32))
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476

  for (let off = 0; off < size; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true))
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f, g
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const s = shifts[Math.floor(i / 16) * 4 + (i % 4)]
      const x = (a + f + K[i] + M[g]) | 0
      ;[a, d, c, b] = [d, c, b, (b + ((x << s) | (x >>> (32 - s)))) | 0]
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
  }

  const out = new Uint8Array(16), result = new DataView(out.buffer)
  ;[a0, b0, c0, d0].forEach((v, i) => result.setUint32(i * 4, v, true))
  return hex(out)
}

export async function hashes(buffer) {
  return { md5: md5(buffer), sha256: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))) }
}

export const irGame = mode => mode === '14K' || mode === '10K'
  ? 'bms-14k' : mode === '9K' ? 'pms-keyboard' : 'bms-7k'

async function api(path) {
  const res = await fetch(`${TACHI}/api/v1${path}`)
  const data = await res.json()
  if (!res.ok || !data.success) throw new Error(data.description || 'Bokutachi 조회 실패')
  return data.body
}

const level = chart => chart?.data?.aiLevel || chart?.song?.data?.tableString ||
  Object.entries(chart?.data?.tableFolders || {}).map(([k, v]) => k + v).join(', ')

export function summarizePBs(pbs = []) {
  const lamps = {}
  for (const pb of pbs) lamps[pb.scoreData.lamp] = (lamps[pb.scoreData.lamp] || 0) + 1
  const values = pbs.map(pb => pb.scoreData.percent).filter(Number.isFinite)
  const bp = pbs.map(pb => pb.scoreData.optional?.bp).filter(Number.isFinite)
  return {
    players: pbs[0]?.rankingData?.outOf || 0,
    sample: pbs.length,
    average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    top: pbs[0]?.scoreData?.score ?? null,
    minBp: bp.length ? Math.min(...bp) : null,
    lamps,
  }
}

export function progression(scores = []) {
  let best = -Infinity
  return [...(scores || [])]
    .filter(x => Number.isFinite(x?.scoreData?.percent))
    .sort((a, b) => new Date(a.timeAchieved || 0) - new Date(b.timeAchieved || 0))
    .reduce((out, x) => {
      if (x.scoreData.percent > best) {
        best = x.scoreData.percent
        out.push({ percent: x.scoreData.percent, score: x.scoreData.score, time: x.timeAchieved })
      }
      return out
    }, [])
}

function levelKey(chart) {
  const m = String(chart?.data?.aiLevel || '').match(/^([^\d-]*)(-?\d+(?:\.\d+)?)$/)
  return m && { prefix: m[1], value: +m[2] }
}

export function recommend(current, charts = [], recent = []) {
  const here = levelKey(current)
  const played = new Set(recent.map(s => s.chartID))
  return charts
    .filter(c => c.chartID !== current.chartID)
    .map(c => ({ chart: c, key: levelKey(c) }))
    .filter(({ key }) => !here || key && key.prefix === here.prefix && key.value <= here.value && key.value >= here.value - 2)
    .sort((a, b) => (played.has(a.chart.chartID) - played.has(b.chart.chartID)) ||
      (here && b.key ? Math.abs(here.value - a.key.value) - Math.abs(here.value - b.key.value) : 0))
    .slice(0, 5)
    .map(({ chart }) => ({
      title: chart.song.title,
      artist: chart.song.artist,
      level: level(chart) || '?',
      played: played.has(chart.chartID),
      url: `${TACHI}/games/${chart.game}/charts/${chart.chartID}`,
    }))
}

export async function loadTachi({ sha256, mode, username = '', rival = '' }) {
  const game = irGame(mode)
  const found = await api(`/search/chart-hash?search=${sha256}`)
  const chart = found.charts.find(c => c.game === game) || found.charts[0] || null
  if (!chart) return { chart: null, game, pbs: summarizePBs(), personal: null, recent: [], recommendations: [] }

  const [board, popular, personal, history, scoreHistory, rivalPb] = await Promise.all([
    api(`/games/${chart.game}/charts/${chart.chartID}/pbs`).catch(() => ({ pbs: [] })),
    api(`/games/${chart.game}/charts`).catch(() => ({ charts: [] })),
    username ? api(`/users/${encodeURIComponent(username)}/games/${chart.game}/best-score/${sha256}`).catch(() => null) : null,
    username ? api(`/users/${encodeURIComponent(username)}/games/${chart.game}/scores/recent`).catch(() => ({ charts: [], scores: [], songs: [] })) : {},
    username ? api(`/users/${encodeURIComponent(username)}/games/${chart.game}/scores/${chart.chartID}`).catch(() => []) : [],
    rival ? api(`/users/${encodeURIComponent(rival)}/games/${chart.game}/best-score/${sha256}`).catch(() => null) : null,
  ])
  const recent = (history.scores || []).slice(0, 5).map(score => {
    const c = history.charts.find(x => x.chartID === score.chartID)
    return { ...score, title: c?.song?.title || score.chartID, level: level(c) || '?',
      url: c ? `${TACHI}/games/${c.game}/charts/${c.chartID}` : null }
  })
  return {
    chart,
    game: chart.game,
    url: `${TACHI}/games/${chart.game}/charts/${chart.chartID}`,
    levels: chart.data.tableFolders || {},
    aiLevel: chart.data.aiLevel,
    pbs: summarizePBs(board.pbs),
    personal,
    rival: rivalPb,
    progression: progression(scoreHistory),
    recent,
    recommendations: recommend(chart, popular.charts, history.scores || []),
  }
}

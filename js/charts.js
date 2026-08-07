import { laneGeom, laneLabel, laneVar } from './lanes.js'

/**
 * 캔버스를 CSS 크기 × devicePixelRatio 로 맞추고 ctx 를 논리 좌표로 스케일한다.
 * 숨어 있으면(`hidden`) 크기가 0 이라 `null` — 그릴 것도 없고, 음수 크기는 컨텍스트를 못 받는다.
 */
export function fit(canvas) {
  const { width: w, height: h } = canvas.getBoundingClientRect()
  if (w <= 0 || h <= 0) return null
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return { ctx, w, h, dpr }
}

/** 굽는 레이어용 오프스크린. 같은 dpr 스케일을 건다. */
export function offscreen(w, h, dpr) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { canvas, ctx }
}

export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// 막대는 노트 종류별로 쌓는다. 아래부터 스크래치 → 롱 → 일반 —
// 적은 종류를 바닥에 붙여야 몇 개짜리 층도 눈에 띈다.
const STACK = [['scratch', '--scratch', '스크래치'], ['ln', '--ln', '롱'], ['normal', '--key', '일반']]

/**
 * `step`=true 면 계단, 아니면 버킷 중앙을 잇는 꺾은선.
 * BPM 은 구간 내내 상수라 계단이 맞고, 밀도처럼 연속으로 변하는 값은 계단으로 그리면
 * 막대를 한 겹 더 그린 것처럼 보인다.
 */
function line(ctx, bars, valueOf, toY, x0, bw, color, { dash = [], step = false } = {}) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  ctx.setLineDash(dash)
  ctx.beginPath()
  bars.forEach((b, i) => {
    const y = toY(valueOf(b))
    const x = x0 + (step ? i : i + 0.5) * bw
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
    if (step) ctx.lineTo(x + bw, y)
  })
  ctx.stroke()
  ctx.restore()
}

/**
 * 밀도 그래프. 마디 버킷과 시간 버킷이 같은 형태라 렌더러 하나로 둘 다 그린다.
 *   쌓은 막대 = 종류별 노트 수 · 실선 = 순간 최대 밀도(1초 창) · 파선 = BPM
 * `tick(i)` 이 x축 라벨을 만든다. `grow` 0–1 은 등장 애니메이션용 세로 배율.
 */
export function drawDensity(canvas, bars, { tick = i => i, grow = 1 } = {}) {
  const box = fit(canvas)
  if (!box || !bars.length) return
  const { ctx, w, h } = box

  const pad = { l: 34, r: 8, t: 24, b: 18 }
  const plotW = w - pad.l - pad.r
  const plotH = h - pad.t - pad.b
  const bottom = pad.t + plotH
  const bw = plotW / bars.length

  const maxNotes = Math.max(1, ...bars.map(b => b.notes))
  const maxPeak = Math.max(1, ...bars.map(b => b.peak))
  const bpms = bars.map(b => b.bpm)
  const bpmLo = Math.min(...bpms)
  const bpmHi = Math.max(...bpms)
  const bpmSpan = Math.max(bpmHi - bpmLo, 1)

  const dim = css('--dim')
  const cPeak = css('--peak')
  const cBpm = css('--bpm')

  // 가로 격자 + 노트 수 눈금 (좌축)
  ctx.strokeStyle = css('--grid')
  ctx.fillStyle = dim
  ctx.font = '10px ui-monospace, monospace'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const y = bottom - (plotH * i) / 4
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke()
    ctx.fillText(Math.round((maxNotes * i) / 4), pad.l - 5, y + 3)
  }

  // 막대와 두 선은 바닥 기준으로 눌러서 자라게 한다 — 격자·축·범례는 처음부터 제자리.
  ctx.save()
  ctx.translate(0, bottom)
  ctx.scale(1, grow)
  ctx.translate(0, -bottom)

  // 종류별 누적 막대
  const barW = Math.max(bw - 0.5, 0.8)
  for (const b of bars) {
    if (!b.notes) continue
    let y = bottom
    for (const [kind, varName] of STACK) {
      const bh = (b.types[kind] / maxNotes) * plotH
      if (!bh) continue
      ctx.fillStyle = css(varName)
      ctx.fillRect(pad.l + b.index * bw, y - bh, barW, bh)
      y -= bh
    }
  }

  // 두 선은 각자 스케일. 순간 최대 밀도는 0 기준 꺾은선, BPM 은 min–max 범위의 계단.
  line(ctx, bars, b => b.peak, v => bottom - (v / maxPeak) * plotH * 0.94, pad.l, bw, cPeak)
  line(ctx, bars, b => b.bpm,
    v => bottom - ((v - bpmLo) / bpmSpan) * plotH * 0.84 - plotH * 0.08,
    pad.l, bw, cBpm, { dash: [4, 3], step: true })
  ctx.restore()

  // 범례 겸 축 — 선마다 우측 축을 세우면 라벨이 겹친다
  ctx.textAlign = 'left'
  let x = pad.l
  const item = (color, label, line) => {
    ctx.fillStyle = color
    if (line) ctx.fillRect(x, pad.t - 14, 9, 2)
    else ctx.fillRect(x, pad.t - 18, 8, 8)
    ctx.fillText(label, x + 13, pad.t - 11)
    x += ctx.measureText(label).width + 26
  }
  for (const [, varName, label] of [...STACK].reverse()) item(css(varName), label)
  item(cPeak, `순간 최대 밀도 0–${maxPeak}/s`, true)
  item(cBpm, bpmLo === bpmHi ? `BPM ${Math.round(bpmLo)}` : `BPM ${Math.round(bpmLo)}–${Math.round(bpmHi)}`, true)

  // x축 라벨
  ctx.fillStyle = dim
  ctx.textAlign = 'center'
  const step = Math.max(1, Math.ceil(bars.length / (plotW / 45)))
  for (let i = 0; i < bars.length; i += step)
    ctx.fillText(tick(i), pad.l + i * bw + bw / 2, h - 5)
}

/** 6축 레이더. 축 순서가 곧 육각형의 꼭짓점 순서(12시부터 시계방향). */
export function drawRadar(canvas, axes, grow = 1) {
  const box = fit(canvas)
  if (!box) return
  const { ctx, w, h } = box
  const cx = w / 2, cy = h / 2 + 2
  const R = Math.min(w, h) / 2 - 30
  if (R <= 0) return
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
  }
  const ring = (r, path = ctx) => {
    path.beginPath()
    axes.forEach((_, i) => path[i ? 'lineTo' : 'moveTo'](...pt(i, r)))
    path.closePath()
  }

  // 격자 3겹 + 스포크
  ctx.strokeStyle = css('--grid')
  for (const f of [1 / 3, 2 / 3, 1]) { ring(R * f); ctx.stroke() }
  axes.forEach((_, i) => {
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...pt(i, R)); ctx.stroke()
  })

  // 값 다각형
  const accent = css('--accent')
  ctx.beginPath()
  axes.forEach((a, i) => ctx[i ? 'lineTo' : 'moveTo'](...pt(i, (R * a.value * grow) / 100)))
  ctx.closePath()
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.22
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.lineWidth = 1

  // 라벨 — 각도에 따라 정렬을 바꿔야 육각형에 안 겹친다
  ctx.font = '11px system-ui, sans-serif'
  axes.forEach((a, i) => {
    const [x, y] = pt(i, R + 13)
    const dx = x - cx, dy = y - cy
    ctx.textAlign = Math.abs(dx) < 2 ? 'center' : dx > 0 ? 'left' : 'right'
    ctx.textBaseline = Math.abs(dy) < 2 ? 'middle' : dy > 0 ? 'top' : 'bottom'
    ctx.fillStyle = css('--dim')
    ctx.fillText(a.label, x, y)
    ctx.fillStyle = accent
    ctx.fillText(Math.round(a.value), x, y + (dy > 2 ? 13 : dy < -2 ? -13 : 13))
  })
}

/** 레인별 노트 분포 막대. */
// 막대 순서·색·폭을 재생기와 맞춘다 — 두 그림을 눈으로 대조하려면 같은 배치여야 한다.
// 스크래치가 왼쪽 끝(DP 는 오른쪽에도), 흰/파란 건반이 번갈아, 스크래치 레인이 더 넓다.
export function drawLanes(canvas, stats, lanes, grow = 1) {
  const box = fit(canvas)
  if (!box) return
  const { ctx, w, h } = box
  const counts = stats.counts.byCol
  const max = Math.max(1, ...counts)
  const { geom, width, splitX } = laneGeom(lanes)
  const k = w / width
  const plotH = h - 16
  ctx.font = '10px ui-monospace, monospace'
  ctx.textAlign = 'center'

  for (const [col, g] of geom) {
    const bh = ((counts[col] || 0) / max) * plotH * grow
    ctx.fillStyle = css(laneVar(col, lanes))
    ctx.fillRect(g.x * k + 1, h - 14 - bh, g.w * k - 2, bh)
    ctx.fillStyle = css('--dim')
    ctx.fillText(laneLabel(col, lanes), (g.x + g.w / 2) * k, h - 3)
  }

  if (splitX != null) {
    ctx.globalAlpha = 0.45
    ctx.fillStyle = css('--dim')
    ctx.fillRect(splitX * k - 1, 0, 2, plotH)
    ctx.globalAlpha = 1
  }
}

// ── 저장용 카드 ──────────────────────────────────────────────────────────
// 화면에 이미 그려진 캔버스를 그대로 옮겨 붙인다 — 저장 전용 렌더러를 따로 두면 두 벌이
// 갈라진다. 대신 화면 밖이라 아직 안 그려진 차트는 부르는 쪽이 먼저 채워 두어야 한다.
const CARD_W = 1000
const CARD_PAD = 24
const GAP = 14
const INNER = CARD_W - CARD_PAD * 2

function badgeRow(ctx, items, x, y) {
  ctx.font = '12px system-ui, sans-serif'
  for (const [text, hot] of items) {
    const w = ctx.measureText(text).width + 18
    ctx.beginPath()
    ctx.roundRect(x, y, w, 22, 11)
    ctx.fillStyle = css('--panel')
    ctx.fill()
    ctx.strokeStyle = css(hot ? '--accent' : '--grid')
    ctx.stroke()
    ctx.fillStyle = css(hot ? '--accent' : '--fg')
    ctx.fillText(text, x + 9, y + 15)
    x += w + 6
  }
}

/**
 * 요약 카드 한 장. `rows` 는 한 줄에 나란히 놓을 캔버스들 — 열 너비에 맞춰 비율대로 줄인다.
 * 비어 있는(숨어서 0×0 인) 캔버스는 그 줄에서 빠지고, 줄이 통째로 비면 줄째로 빠진다.
 */
export function snapshot({ title, byline, badges, stats, rows, footer }) {
  const live = rows.map(r => r.filter(c => c.width > 0 && c.height > 0)).filter(r => r.length)
  const dims = live.map(r => {
    const w = (INNER - GAP * (r.length + 1)) / r.length
    return { w, h: Math.max(...r.map(c => (w * c.height) / c.width)) }
  })
  const statH = Math.ceil(stats.length / 2) * 20
  const H = CARD_PAD * 2 + 78 + dims.reduce((s, d) => s + d.h + GAP * 3, 0) + statH + GAP + 20

  const { canvas, ctx } = offscreen(CARD_W, H, 2)
  ctx.fillStyle = css('--bg')
  ctx.fillRect(0, 0, CARD_W, H)

  let y = CARD_PAD
  ctx.fillStyle = css('--fg')
  ctx.font = '600 22px system-ui, sans-serif'
  ctx.fillText(title, CARD_PAD, y + 22)
  y += 30
  ctx.fillStyle = css('--dim')
  ctx.font = '12px system-ui, sans-serif'
  ctx.fillText(byline, CARD_PAD, y + 12)
  y += 18
  badgeRow(ctx, badges, CARD_PAD, y)
  y += 30

  live.forEach((r, i) => {
    const { w, h } = dims[i]
    ctx.fillStyle = css('--panel')
    ctx.beginPath()
    ctx.roundRect(CARD_PAD, y, INNER, h + GAP * 2, 10)
    ctx.fill()
    r.forEach((c, j) =>
      ctx.drawImage(c, CARD_PAD + GAP + j * (w + GAP), y + GAP, w, (w * c.height) / c.width))
    y += h + GAP * 3
  })

  // 통계는 두 열. 화면의 <dl> 과 같은 순서라 눈으로 대조된다.
  ctx.font = '12px system-ui, sans-serif'
  stats.forEach(([k, v], i) => {
    const x = CARD_PAD + (i % 2) * (INNER / 2)
    const ty = y + Math.floor(i / 2) * 20 + 12
    ctx.fillStyle = css('--dim')
    ctx.fillText(k, x, ty)
    ctx.fillStyle = css('--fg')
    ctx.fillText(v, x + 78, ty)
  })

  ctx.fillStyle = css('--dim')
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillText(footer, CARD_PAD, y + statH + GAP + 12)
  return canvas
}

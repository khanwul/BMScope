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
 * `tick(i)` 이 x축 라벨을 만든다.
 */
export function drawDensity(canvas, bars, { tick = i => i } = {}) {
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
export function drawRadar(canvas, axes) {
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
  axes.forEach((a, i) => ctx[i ? 'lineTo' : 'moveTo'](...pt(i, (R * a.value) / 100)))
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
export function drawLanes(canvas, stats, lanes) {
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
    const bh = ((counts[col] || 0) / max) * plotH
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

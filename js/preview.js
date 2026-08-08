// 채보 프리뷰 — 전체 보기 모드. 마디를 세로 컬럼으로 쌓아 좌→우로 나열한다(악보식).
// 스크롤 없이 전곡 구조가 보이고, 구간 태그를 배경색으로 깐다.
//
// 좌표계는 `레인 → x`, `박 → y`(아래에서 위로). 재생 모드가 같은 좌표계를 쓰므로 LN 몸통은
// `drawBody` 하나로 공유한다(머리는 높이 규칙이 달라 각자 그린다).
// 레인 배치(`laneOrder`/`laneGeom`)는 `lanes.js` — 레인별 분포도 같이 쓴다.
// 타임라인(`timeline.js`)은 `시간 → x`, `레인 → y` 라 좌표계가 아예 다르다 — 공유하지 않는다.
import { css, fit, offscreen } from './charts.js'
import { laneGeom, laneVar } from './lanes.js'

const COL_GAP = 14
const PAD = { t: 6, b: 14 }
const MAX_SCALE = 7  // 재생 모드 레인 확대 상한
// 슬라이더 기본값. 재생 모드는 px/position, 전체 보기는 이걸 1배로 본 배율 — 표시도 배율로 한다
export const HISPEED_1X = 140
const MAX_CANVAS = 16384 // px. 넘기면 브라우저가 컨텍스트를 통째로 비운다

/** LN 몸통 — 머리(`y`)에서 끝(`yEnd`, 위쪽)까지 흐리게. 뒤집힌 구간이면 안 그린다. */
function drawBody(ctx, color, x, w, y, yEnd, alpha) {
  if (y <= yEnd) return
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.fillRect(x, yEnd, w, y - yEnd)
  ctx.globalAlpha = 1
}

/** 1P/2P 구분선. 레인 배경보다 진하게 — 여기가 손이 갈리는 지점이라 한눈에 보여야 한다. */
function drawSplit(ctx, x, y, h) {
  ctx.save()
  ctx.globalAlpha = 0.45
  ctx.fillStyle = css('--dim')
  ctx.fillRect(x - 1, y, 2, h)
  ctx.restore()
}

/**
 * 재생 모드 — 스크롤 렌더. 전체 보기와 좌표계(레인 → x, 박 → y)를 공유한다.
 *
 * y 는 박이 아니라 `Positioning.position()` 으로 잡는다 — bms-js 가 `#SCROLL`/`#SPEED`
 * 확장까지 처리해 주므로 그대로 쓰면 된다. 하이스피드는 그 위에 곱하는 배율이고,
 * **배속과는 별개 노브다**(하이스피드 = 보이는 간격, 배속 = 시간축 자체).
 */
export function createPlayView(canvas) {
  let data = null
  let time = 0
  let hispeed = HISPEED_1X // position 단위당 px
  let maxLnBeats = 0 // 화면 아래로 지나간 LN 의 몸통을 어디까지 거슬러 찾을지
  const JUDGE = 46   // 판정선의 바닥으로부터 거리

  const firstAtBeat = beat => {
    let lo = 0, hi = data.notes.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (data.notes[m].beat < beat) lo = m + 1; else hi = m }
    return lo
  }

  function draw() {
    if (!data) return
    const box = fit(canvas) // 재생 모드가 아니면 숨어 있다 — null
    if (!box) return
    const { ctx, w, h } = box

    // 판정 필드를 캔버스 폭의 72% 까지 키운다. 상한 MAX_SCALE 은 14K 가 화면을 다 먹지 않게.
    const scale = Math.min((w * 0.72) / laneGeom(data).width, MAX_SCALE)
    const { geom, width: noteW, splitX } = laneGeom(data, scale)
    const noteH = Math.max(4, Math.round(scale))
    const gap = Math.max(1, scale * 0.2)
    const x0 = (w - noteW) / 2
    const judgeY = h - JUDGE
    const nowBeat = data.timing.secondsToBeat(time)
    const origin = data.pos.position(nowBeat)
    const yOf = beat => judgeY - (data.pos.position(beat) - origin) * hispeed

    // 구간 태그 배경 — 전체 보기와 같은 색 규칙. 태그가 갈리는 지점이 판정선으로 내려온다.
    ctx.globalAlpha = 0.13
    for (const s of data.segs) {
      const yTop = yOf(s.beat1), yBot = yOf(s.beat0)
      if (yBot < 0 || yTop > h) continue
      ctx.fillStyle = css(`--tag-${s.tags[0]}`) || css('--dim')
      ctx.fillRect(x0, yTop, noteW, yBot - yTop)
    }
    ctx.globalAlpha = 1

    // 레인 배경 — 스크래치와 파란 건반만 살짝 어둡게 깔아 열이 구분되게
    for (const [col, g] of geom) {
      const v = laneVar(col, data)
      ctx.fillStyle = v === '--scratch' ? 'rgba(224,70,110,0.10)'
        : v === '--lane-blue' ? 'rgba(255,255,255,0.045)' : 'transparent'
      ctx.fillRect(x0 + g.x, 0, g.w, h)
    }
    // 필드 양 끝 선 — SP/PMS 는 오른쪽 끝이 스크래치가 아니라 배경 없이 끝나 경계가 안 보인다
    ctx.fillStyle = css('--grid')
    ctx.fillRect(x0 - 1, 0, 1, h)
    ctx.fillRect(x0 + noteW, 0, 1, h)
    if (splitX != null) drawSplit(ctx, x0 + splitX, 0, h)

    // 마디선
    ctx.strokeStyle = css('--grid')
    for (const beat of data.measureStarts) {
      const y = yOf(beat)
      if (y < -2 || y > judgeY) continue
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + noteW, y); ctx.stroke()
    }

    // 노트. LN 몸통이 판정선을 걸치고 있을 수 있어 최장 LN 만큼 거슬러 올라가 훑는다.
    for (let i = firstAtBeat(nowBeat - maxLnBeats); i < data.notes.length; i++) {
      const n = data.notes[i]
      const y = yOf(n.beat)
      if (y < -8) break
      const g = geom.get(n.col)
      if (!g) continue
      const color = css(laneVar(n.col, data))
      // 몸통은 판정선에서 자른다 — 머리가 지나가도 남은 몸통은 계속 보여야 한다
      if (n.isLN) drawBody(ctx, color, x0 + g.x, g.w - gap, Math.min(y, judgeY), Math.max(yOf(n.endBeat), -8), 0.4)
      if (y > judgeY) continue // 판정선을 지난 머리는 지운다
      ctx.fillStyle = color
      ctx.fillRect(x0 + g.x, y - noteH, g.w - gap, noteH)
    }

    // 판정선
    ctx.fillStyle = css('--cursor')
    ctx.fillRect(x0 - 4, judgeY - 1, noteW + 8, 2)
  }

  return {
    load(next) {
      data = next
      time = 0
      maxLnBeats = next.notes.reduce((m, n) => (n.isLN ? Math.max(m, n.endBeat - n.beat) : m), 0)
      draw()
    },
    setTime(t) { time = t; draw() },
    setHispeed(v) { hispeed = v; draw() },
    setSegs(segs) { if (data) { data.segs = segs; draw() } },
    draw,
  }
}

/**
 * 전체 보기. 재생 중에도 이 모드를 쓸 수 있으므로 태그 배경·마디선·노트는 오프스크린에
 * 한 번 굽고, 매 프레임은 drawImage + 구간 음영 + 커서만 그린다(타임라인과 같은 수법).
 *
 * 하이스피드는 여기서 **컬럼 밀도**다 — 재생 모드처럼 노트 간격을 벌리되, 컬럼 높이는
 * 화면에 고정해 두고 컬럼 수를 늘린다(악보식이라 세로로 늘리면 한 컬럼도 다 못 본다).
 * 1배면 캔버스가 폭에 딱 맞고, 올리면 넘친 만큼 감싼 래퍼가 가로 스크롤한다.
 */
export function createOverview(canvas, { onSelect, onSeek }) {
  let data = null
  let time = 0
  let range = null
  let layout = null
  let zoom = 1
  let baked = null
  let bakedFor = ''
  let stamp = 0 // 채보나 구간이 갈릴 때 올린다 — 다시 구울 신호

  /** `hostW` 는 캔버스가 아니라 래퍼(보이는 폭) — 캔버스 폭은 여기서 정하는 결과값이다. */
  function measure(hostW, h) {
    const { geom, width: noteW, splitX } = laneGeom(data)
    const fitCols = Math.max(1, Math.floor(hostW / (noteW + COL_GAP)))
    const unit = hostW / fitCols
    const maxCols = Math.floor(MAX_CANVAS / (window.devicePixelRatio || 1) / unit)
    const cols = Math.max(1, Math.min(Math.round(fitCols * zoom), maxCols))
    const w = Math.max(hostW, cols * unit) // 축소해도 빈 여백을 남기지 않는다
    return {
      w, h, cols, colW: w / cols, geom, noteW, splitX,
      beatsPerCol: data.totalBeats / cols,
      plotH: h - PAD.t - PAD.b,
    }
  }

  /** 박 → 화면 좌표. 컬럼 밖이면 null. */
  const place = (beat, L) => {
    const c = Math.min(Math.floor(beat / L.beatsPerCol), L.cols - 1)
    if (c < 0) return null
    const local = (beat - c * L.beatsPerCol) / L.beatsPerCol
    return { c, x0: c * L.colW + (L.colW - L.noteW) / 2, y: PAD.t + L.plotH * (1 - local) }
  }

  /** 정적 레이어 — 태그 배경 · 1P/2P 구분선 · 마디선 · 노트. */
  function bakeLayers(L, dpr) {
    const { canvas: off, ctx } = offscreen(L.w, L.h, dpr)

    // 구간 태그 배경 — 한 구간이 여러 컬럼에 걸치므로 컬럼마다 잘라 칠한다
    for (const s of data.segs) {
      ctx.fillStyle = css(`--tag-${s.tags[0]}`) || css('--dim')
      ctx.globalAlpha = 0.13
      const c0 = Math.floor(s.beat0 / L.beatsPerCol)
      const c1 = Math.min(Math.floor((s.beat1 - 1e-9) / L.beatsPerCol), L.cols - 1)
      for (let c = Math.max(c0, 0); c <= c1; c++) {
        const lo = Math.max(s.beat0, c * L.beatsPerCol)
        const hi = Math.min(s.beat1, (c + 1) * L.beatsPerCol)
        const yTop = PAD.t + L.plotH * (1 - (hi - c * L.beatsPerCol) / L.beatsPerCol)
        const yBot = PAD.t + L.plotH * (1 - (lo - c * L.beatsPerCol) / L.beatsPerCol)
        ctx.fillRect(c * L.colW, yTop, L.colW, yBot - yTop)
      }
      ctx.globalAlpha = 1
    }

    // 1P/2P 구분선 — 컬럼마다 하나씩
    if (L.splitX != null)
      for (let c = 0; c < L.cols; c++)
        drawSplit(ctx, c * L.colW + (L.colW - L.noteW) / 2 + L.splitX, PAD.t, L.plotH)

    // 마디선 + 마디 번호
    ctx.strokeStyle = css('--grid')
    ctx.fillStyle = css('--dim')
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'right'
    data.measureStarts.forEach((beat, m) => {
      const p = place(beat, L)
      if (!p || beat >= data.totalBeats) return
      ctx.beginPath()
      ctx.moveTo(p.x0, p.y)
      ctx.lineTo(p.x0 + L.noteW, p.y)
      ctx.stroke()
      if (m % 4 === 0) ctx.fillText(m, p.x0 - 3, p.y + 3)
    })

    // 노트 — LN 은 몸통을 흐리게 깔고 머리를 진하게
    for (const n of data.notes) {
      const g = L.geom.get(n.col)
      if (!g) continue
      const p = place(n.beat, L)
      if (!p) continue
      const color = css(laneVar(n.col, data))
      if (n.isLN) {
        // 컬럼 위쪽에서 자른다. 경계에 정확히 끝나면 다음 컬럼으로 넘어가므로 앱실론을 뺀다.
        const e = place(Math.min(n.endBeat, (p.c + 1) * L.beatsPerCol - 1e-9), L)
        if (e && e.c === p.c) drawBody(ctx, color, p.x0 + g.x, g.w - 1, p.y, e.y, 0.35)
      }
      ctx.fillStyle = color
      ctx.fillRect(p.x0 + g.x, p.y - 2, g.w - 1, 2)
    }
    return off
  }

  function draw() {
    if (!data) return
    // 폭을 먼저 정하고 캔버스에 박은 뒤에 fit — fit 은 실제 CSS 크기로 백버퍼를 잡는다.
    const host = canvas.parentElement
    const L = (layout = measure(host.clientWidth, canvas.getBoundingClientRect().height))
    if (L.plotH <= 0 || L.w <= 0) return
    canvas.style.width = `${L.w}px`
    const box = fit(canvas)
    if (!box) return
    const { ctx, dpr } = box

    const key = `${Math.round(L.w)}|${Math.round(L.h)}|${stamp}`
    if (key !== bakedFor) { baked = bakeLayers(L, dpr); bakedFor = key }
    ctx.drawImage(baked, 0, 0, L.w, L.h)

    // 선택 구간 밖은 어둡게
    if (range) {
      ctx.fillStyle = 'rgba(10,12,16,0.55)'
      for (let c = 0; c < L.cols; c++) {
        const b0 = c * L.beatsPerCol, b1 = (c + 1) * L.beatsPerCol
        const yOf = b => PAD.t + L.plotH * (1 - (Math.min(Math.max(b, b0), b1) - b0) / L.beatsPerCol)
        ctx.fillRect(c * L.colW, yOf(b1), L.colW, yOf(range.b1) - yOf(b1))
        ctx.fillRect(c * L.colW, yOf(range.b0), L.colW, yOf(b0) - yOf(range.b0))
      }
    }

    // 재생 커서
    const beat = data.timing.secondsToBeat(time)
    if (beat > 0) {
      const p = place(beat, L)
      if (p) {
        ctx.fillStyle = css('--cursor')
        ctx.fillRect(p.x0 - 2, p.y - 0.5, L.noteW + 4, 1.5)
        // 확대해 두면 커서가 스크롤 밖으로 나간다 — 나갔을 때만 그 컬럼을 왼쪽에 붙인다
        const cx = p.c * L.colW
        if (cx < host.scrollLeft || cx + L.colW > host.scrollLeft + host.clientWidth)
          host.scrollLeft = cx
      }
    }
  }

  // ── 입력 ───────────────────────────────────────────────────────────────
  // 끌면 재생 위치가 따라온다(스크럽). Shift+클릭은 그 구간을 재생 구간으로 —
  // 커서 이동이 훨씬 잦은 조작이라 그쪽을 기본 제스처로 준다.
  let scrub = false

  const beatAt = e => {
    const r = canvas.getBoundingClientRect()
    const L = layout
    const c = Math.min(Math.max(Math.floor((e.clientX - r.left) / L.colW), 0), L.cols - 1)
    const local = 1 - (e.clientY - r.top - PAD.t) / L.plotH
    return (c + Math.min(Math.max(local, 0), 1)) * L.beatsPerCol
  }

  const seekTo = beat => onSeek?.(data.timing.beatToSeconds(Math.max(beat, 0)))

  canvas.addEventListener('pointerdown', e => {
    if (!data || !layout) return
    const beat = beatAt(e)
    if (e.shiftKey) {
      const hit = data.segs.find(s => beat >= s.beat0 && beat < s.beat1)
      if (hit) onSelect?.(hit)
      return
    }
    scrub = true
    canvas.setPointerCapture(e.pointerId)
    seekTo(beat)
  })
  canvas.addEventListener('pointermove', e => { if (scrub && data) seekTo(beatAt(e)) })
  canvas.addEventListener('pointerup', () => { scrub = false })

  return {
    load(next) { data = next; time = 0; range = null; stamp++; draw() },
    setTime(t) { time = t; draw() },
    // 컬럼 수가 갈리면 L.w 가 갈리고 굽기 키도 같이 갈린다 — 따로 무를 게 없다.
    setHispeed(v) { zoom = v / HISPEED_1X; draw() },
    setSegs(segs) { if (data) { data.segs = segs; stamp++; draw() } },
    setRange(r) { range = r; draw() },
    draw,
  }
}

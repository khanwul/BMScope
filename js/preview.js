// 채보 프리뷰 — 전체 보기 모드. 마디를 세로 컬럼으로 쌓아 좌→우로 나열한다(악보식).
// 스크롤 없이 전곡 구조가 보이고, 구간 태그를 배경색으로 깐다.
//
// 좌표계는 `레인 → x`, `박 → y`(아래에서 위로). 재생 모드가 같은 좌표계를 쓰므로 노트
// 그리기를 공유한다. 레인 배치(`laneOrder`/`laneGeom`)는 `lanes.js` — 레인별 분포도 같이 쓴다.
// 타임라인(`timeline.js`)은 `시간 → x`, `레인 → y` 라 좌표계가 아예 다르다 — 공유하지 않는다.
import { css, fit, offscreen } from './charts.js'
import { laneGeom, laneVar } from './lanes.js'

const COL_GAP = 14
const PAD = { t: 6, b: 14 }
const MAX_SCALE = 7  // 재생 모드 레인 확대 상한

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
  let hispeed = 140  // position 단위당 px
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
      if (n.isLN) {
        const yEnd = Math.max(yOf(n.endBeat), -8)
        const yStart = Math.min(y, judgeY)
        if (yStart > yEnd) {
          ctx.globalAlpha = 0.4
          ctx.fillStyle = color
          ctx.fillRect(x0 + g.x, yEnd, g.w - gap, yStart - yEnd)
          ctx.globalAlpha = 1
        }
      }
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
    draw,
  }
}

/**
 * 전체 보기. 재생 중에도 이 모드를 쓸 수 있으므로 태그 배경·마디선·노트는 오프스크린에
 * 한 번 굽고, 매 프레임은 drawImage + 구간 음영 + 커서만 그린다(타임라인과 같은 수법).
 */
export function createOverview(canvas, { onSelect, onSeek } = {}) {
  let data = null
  let time = 0
  let range = null
  let layout = null
  let baked = null
  let bakedFor = ''
  let stamp = 0 // 채보나 구간이 갈릴 때 올린다 — 다시 구울 신호

  function measure(w, h) {
    const { geom, width: noteW, splitX } = laneGeom(data)
    const cols = Math.max(1, Math.floor(w / (noteW + COL_GAP)))
    const colW = w / cols
    return {
      w, h, cols, colW, geom, noteW, splitX,
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
        if (e && e.c === p.c) {
          ctx.globalAlpha = 0.35
          ctx.fillStyle = color
          ctx.fillRect(p.x0 + g.x, e.y, g.w - 1, p.y - e.y)
          ctx.globalAlpha = 1
        }
      }
      ctx.fillStyle = color
      ctx.fillRect(p.x0 + g.x, p.y - 2, g.w - 1, 2)
    }
    return off
  }

  function draw() {
    if (!data) return
    const box = fit(canvas)
    if (!box) return
    const { ctx, dpr } = box
    const L = (layout = measure(box.w, box.h))
    if (L.plotH <= 0) return

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
    setSegs(segs) { if (data) { data.segs = segs; stamp++; draw() } },
    setRange(r) { range = r; draw() },
    draw,
  }
}

// 조정바. 캔버스 하나가 네 역할을 겸한다 — 별도 미니맵을 만들지 않는다.
//   ① 채보 미리보기(노트 = 1px 점)  ② 구간 태그 밴드  ③ A–B 재생 구간  ④ 재생 커서
//
// 미리보기는 로드 시 오프스크린 캔버스에 한 번 굽고 매 프레임 drawImage 로 복사만 한다.
// 재생 중 60fps 로 다시 그려야 하므로 노트 수천 개를 매번 순회하면 안 된다.
import { css, fit, offscreen } from './charts.js'

const BAND_H = 9 // 태그 밴드 높이
const GRAB = 8 // 구간 경계 스냅 / 핸들 잡기 허용 오차(px)

const KIND_VAR = { scratch: '--scratch', ln: '--ln', normal: '--key' }

/**
 * @param canvas  <canvas>
 * @param onSeek  (초) => void          커서를 옮길 때
 * @param onRange ({a, b}) => void      재생 구간이 바뀔 때
 */
export function createTimeline(canvas, { onSeek, onRange } = {}) {
  let data = null // { notes, scratchCols, keyCols, segs, duration }
  let baked = null // 미리보기 오프스크린
  let bakedFor = '' // 다시 구울지 판단하는 키 (폭 × 로드한 채보)
  let time = 0
  let range = null // { a, b } — null 이면 전곡
  let drag = null // { from, moved } 또는 { handle: 'a'|'b' }

  const previewOf = h => h - BAND_H - 2
  const geom = () => {
    const { width: w, height: h } = canvas.getBoundingClientRect()
    return { w, h, previewH: previewOf(h) }
  }
  const xOf = t => (data.duration > 0 ? (t / data.duration) * geom().w : 0)
  const tOf = x => Math.max(0, Math.min(data.duration, (x / geom().w) * data.duration))

  /** 구간 경계에 붙인다 — "이 잭 구간만" 같은 지정이 정확해진다. */
  function snap(t) {
    let best = t, dist = GRAB
    for (const s of data.segs)
      for (const edge of [s.t0, s.t1]) {
        const d = Math.abs(xOf(edge) - xOf(t))
        if (d < dist) { dist = d; best = edge }
      }
    return best
  }

  function bake(w, h, dpr) {
    const { canvas: c, ctx: g } = offscreen(w, h, dpr)
    const lanes = data.keyCols + data.scratchCols.length
    const laneH = h / lanes
    const scratch = new Set(data.scratchCols)
    // 스크래치를 맨 위에 두어 건반 레인이 연속으로 붙는다 (실제 플레이 배치와 같은 감각)
    const rowOf = col => (scratch.has(col) ? data.scratchCols.indexOf(col) : data.scratchCols.length + col)

    // 레인 높이를 꽉 채우면 동시치기가 세로 줄기로 뭉쳐 구간 구분이 안 된다. 가운데 점으로 찍는다.
    const dotH = Math.max(1.5, Math.min(laneH - 2, 3))
    const dotPad = (laneH - dotH) / 2

    for (const n of data.notes) {
      const kind = scratch.has(n.col) ? 'scratch' : n.isLN ? 'ln' : 'normal'
      g.fillStyle = css(KIND_VAR[kind])
      const x = xOf(n.time)
      const y = rowOf(n.col) * laneH + dotPad
      const wpx = n.isLN ? Math.max(xOf(n.endTime) - x, 1) : 1
      g.fillRect(x, y, wpx, dotH)
    }
    return c
  }

  function draw() {
    if (!data) return
    const box = fit(canvas)
    if (!box) return
    const { ctx, w, h, dpr } = box
    const previewH = previewOf(h)
    if (previewH <= 0) return // 밴드 높이도 안 되는 캔버스 — 음수 크기로 굽다 죽는다

    const key = `${Math.round(w)}|${data.id}|${Math.round(previewH)}`
    if (key !== bakedFor) { baked = bake(w, previewH, dpr); bakedFor = key }
    ctx.drawImage(baked, 0, 0, w, previewH)

    // 태그 밴드 — 대표색은 첫 태그(가장 구체적인 것)
    const bandY = previewH + 2
    for (const s of data.segs) {
      ctx.fillStyle = css(`--tag-${s.tags[0]}`) || css('--dim')
      ctx.fillRect(xOf(s.t0), bandY, Math.max(xOf(s.t1) - xOf(s.t0) - 0.5, 1), BAND_H)
    }

    // 구간 밖은 어둡게 + 경계 핸들
    if (range) {
      ctx.fillStyle = 'rgba(10,12,16,0.62)'
      ctx.fillRect(0, 0, xOf(range.a), h)
      ctx.fillRect(xOf(range.b), 0, w - xOf(range.b), h)
      ctx.fillStyle = css('--accent')
      for (const t of [range.a, range.b]) ctx.fillRect(xOf(t) - 1, 0, 2, h)
    }

    // 재생 커서
    const cx = xOf(time)
    ctx.fillStyle = css('--cursor')
    ctx.fillRect(cx - 0.5, 0, 1.5, previewH)
    ctx.beginPath()
    ctx.moveTo(cx - 4, 0); ctx.lineTo(cx + 4, 0); ctx.lineTo(cx, 5)
    ctx.closePath(); ctx.fill()
  }

  // ── 입력 ───────────────────────────────────────────────────────────────
  const localX = e => e.clientX - canvas.getBoundingClientRect().left

  canvas.addEventListener('pointerdown', e => {
    if (!data) return
    canvas.setPointerCapture(e.pointerId)
    const x = localX(e)
    // 이미 구간이 있으면 경계를 잡아 미세 조정, 아니면 새로 끌어 만든다
    const handle = range && ['a', 'b'].find(k => Math.abs(xOf(range[k]) - x) <= GRAB)
    drag = handle ? { handle } : { from: tOf(x), moved: false }
  })

  canvas.addEventListener('pointermove', e => {
    if (!drag || !data) return
    const t = snap(tOf(localX(e)))
    if (drag.handle) {
      range = { ...range, [drag.handle]: t }
    } else {
      if (Math.abs(xOf(t) - xOf(drag.from)) < 3) return // 클릭과 구분
      drag.moved = true
      range = { a: Math.min(drag.from, t), b: Math.max(drag.from, t) }
    }
    if (range.a > range.b) range = { a: range.b, b: range.a }
    onRange?.(range)
    draw()
  })

  canvas.addEventListener('pointerup', e => {
    if (!drag || !data) return
    const wasDrag = drag.handle || drag.moved
    drag = null
    if (wasDrag) return
    const x = localX(e)
    // 태그 밴드를 클릭하면 그 구간을 통째로 선택 — 제일 잦은 조작이라 한 번에 되게 한다
    const inBand = e.clientY - canvas.getBoundingClientRect().top > geom().previewH
    const hit = data.segs.find(s => tOf(x) >= s.t0 && tOf(x) < s.t1)
    if (inBand && hit) {
      range = { a: hit.t0, b: hit.t1 }
      onRange?.(range)
      time = hit.t0
    } else {
      time = tOf(x)
    }
    onSeek?.(time)
    draw()
  })

  return {
    /** 채보를 갈아끼운다. `id` 가 바뀌면 미리보기를 다시 굽는다. */
    load(next) { data = next; range = null; time = 0; bakedFor = ''; onRange?.(null); draw() },
    setNotes(notes) { data.notes = notes; bakedFor = ''; draw() },
    setTime(t) { time = t; draw() },
    setSegs(segs) { if (data) { data.segs = segs; draw() } },
    setRange(r) { range = r; time = r ? r.a : time; onRange?.(range); onSeek?.(time); draw() },
    clearRange() { range = null; onRange?.(null); draw() },
    getRange: () => range,
    draw,
  }
}

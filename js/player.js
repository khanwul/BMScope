// 히트음 재생기. **`AudioContext.currentTime` 을 단독 소유하는 유일한 모듈**이고
// 나머지는 `now()` 로 읽기만 한다. 렌더러가 rAF 로 시간을 세면 오디오와 서서히 갈린다.
//
// 실제 곡 재생이 아니라 노트가 기준선을 넘을 때 고정된 히트음을 낸다 — 그래서 키음 파일도,
// 폴더 입력도, 디코딩도 필요 없다. 원곡 오디오가 없으니 배속을 바꿔도 피치가 안 깨진다.

const LOOKAHEAD = 0.3 // s. 이만큼 앞의 노트까지 미리 스케줄한다
const TICK = 100 // ms

/** 짧은 감쇠 사인파. 에셋 0 — 파일도 fetch 도 decode 도 없다. */
function clickBuffer(ctx) {
  const n = Math.floor(ctx.sampleRate * 0.028)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++)
    d[i] = Math.sin((2 * Math.PI * 900 * i) / ctx.sampleRate) * (1 - i / n) ** 3
  return buf
}

/** 레인별 음정. 스크래치는 낮게, 1건반 → 마지막 건반으로 완만히 상승. */
function pitchOf(col, { keyCols, scratchCols }) {
  if (scratchCols.includes(col)) return 0.6
  return 1 + (col / Math.max(keyCols - 1, 1)) * 0.5
}

export function createPlayer({ onEnd } = {}) {
  let ctx = null, click = null, master = null
  let hits = []          // { time, pitch } — 노트 시작만. LN 끝·마디선은 소리내지 않는다
  let duration = 0
  let i = 0, t0 = 0, pos = 0, rate = 1
  let timer = null
  let range = null       // { a, b } — null 이면 전곡
  let loop = true

  const playing = () => timer !== null
  const bounds = () => (range ? [range.a, range.b] : [0, duration])
  const now = () => (playing() ? (ctx.currentTime - t0) * rate : pos)

  function ensureAudio() {
    if (ctx) return
    ctx = new AudioContext()
    click = clickBuffer(ctx)
    master = new DynamicsCompressorNode(ctx) // 동시치기가 겹칠 때의 클리핑 방지. 네이티브 한 줄
    master.connect(ctx.destination)
  }

  function tick() {
    const [a, b] = bounds()
    const t = now()
    if (t >= b) {
      if (loop) { seek(a); return }
      stop()
      onEnd?.()
      return
    }
    const until = Math.min(t + LOOKAHEAD, b)
    while (i < hits.length && hits[i].time < until) {
      const h = hits[i++]
      const src = new AudioBufferSourceNode(ctx, { buffer: click })
      src.playbackRate.value = h.pitch
      src.connect(master)
      src.start(t0 + h.time / rate)
    }
  }

  function play(from = now()) {
    if (!hits.length) return
    ensureAudio()
    ctx.resume()
    const [a, b] = bounds()
    pos = from >= b - 1e-3 ? a : Math.max(from, a)
    t0 = ctx.currentTime - pos / rate
    i = hits.findIndex(h => h.time >= pos)
    if (i < 0) i = hits.length
    clearInterval(timer)
    timer = setInterval(tick, TICK)
    tick()
  }

  function stop() {
    if (!playing()) return
    pos = now()
    clearInterval(timer)
    timer = null
  }

  /** 재생 중이면 그 자리에서 다시 스케줄한다 — 시크·배속·구간 변경이 전부 이 경로. */
  function seek(t) {
    const was = playing()
    stop()
    pos = t
    if (was) play(t)
  }

  return {
    load({ notes, keyCols, scratchCols, duration: d }) {
      stop()
      duration = d
      pos = 0
      range = null
      hits = notes
        .map(n => ({ time: n.time, pitch: pitchOf(n.col, { keyCols, scratchCols }) }))
        .sort((x, y) => x.time - y.time)
    },
    play, stop, seek, now, playing,
    toggle() { playing() ? stop() : play() },
    setRange(r) { range = r; if (r && (now() < r.a || now() > r.b)) seek(r.a) },
    setLoop(v) { loop = v },
    setRate(v) { const t = now(); rate = v; seek(t) },
  }
}

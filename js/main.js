import { loadFile } from './load.js'
import { toLanes } from './lanes.js'
import { analyze, measureToken, radar, RANK_NAMES } from './analyze.js'
import { drawDensity, drawLanes, drawRadar } from './charts.js'
import { extract } from './features.js'
import { segments } from './segment.js'
import { refine, tagSegments } from './tagger.js'
import { createTimeline } from './timeline.js'
import { createOverview, createPlayView } from './preview.js'
import { createPlayer } from './player.js'

const $ = id => document.getElementById(id)
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const r1 = n => n.toFixed(1)

let current = null
let cursor = 0

// 구간 나누기 방식. 'texture' = bmspc 기본(밀도·반복 변화만), 'fine' = 그 안에서 태그가
// 2박 넘게 바뀌는 지점까지 추가로 자름. 세분화가 기본 — 구간 선택이 주 기능이라서.
let segMode = 'fine'

function cutSegments(wf) {
  const raw = segments(wf)
  return tagSegments(wf, segMode === 'fine' ? refine(wf, raw) : raw)
}

// 재생 구간의 단일 출처는 타임라인(초 단위)이다. 전체 보기는 박으로 환산해 받고,
// 재생기는 초 그대로 받는다. 시간의 단일 출처는 player(`AudioContext.currentTime`).
const toBeats = r =>
  r && current ? { b0: current.parsed.timing.secondsToBeat(r.a), b1: current.parsed.timing.secondsToBeat(r.b) } : null

// 커서를 옮기는 유일한 통로. 재생 구간 밖으로 나가면 구간을 버리고 그 자리에서 이어 재생한다 —
// 안 그러면 player 가 구간 경계로 도로 끌어당겨서 사용자가 찍은 위치가 무시된다.
function seekTo(t) {
  const r = timeline.getRange()
  if (r && (t < r.a || t > r.b)) timeline.clearRange()
  player.seek(t)
  setCursor(t)
}

const timeline = createTimeline($('timeline'), {
  onSeek: seekTo,
  onRange: r => { player.setRange(r); overview.setRange(toBeats(r)); showRange() },
})

const overview = createOverview($('overview'), {
  onSelect: seg => timeline.setRange({ a: seg.t0, b: seg.t1 }),
  onSeek: seekTo,
})

const playView = createPlayView($('play'))
const player = createPlayer({ onEnd: () => syncTransport() })

// ── 재생 ────────────────────────────────────────────────────────────────
let mode = 'overview'

/** 커서 한 번에 갱신. 보이지 않는 캔버스는 건드리지 않는다 — 전체 보기는 노트를 전부 훑는다. */
function setCursor(t) {
  cursor = t
  timeline.setTime(t)
  ;(mode === 'play' ? playView : overview).setTime(t)
  showRange()
  const seg = current?.segs.find(s => t >= s.t0 && t < s.t1)
  $('seg-now').textContent = seg ? seg.tags.join('+') : ''
}

// rAF 루프는 하나만 돈다. 모드를 바꿔도 재생이 안 끊기므로 syncTransport 가 여러 번
// 불리는데, 그때마다 새 루프를 띄우면 프레임마다 중복해서 그린다.
let raf = 0
function frame() {
  if (!player.playing()) { raf = 0; return }
  setCursor(player.now())
  raf = requestAnimationFrame(frame)
}

function syncTransport() {
  const on = player.playing()
  $('playpause').textContent = on ? '⏸ 일시정지' : '▶ 재생'
  if (on) { if (!raf) raf = requestAnimationFrame(frame) }
  else setCursor(player.now())
}

$('playpause').addEventListener('click', () => { player.toggle(); syncTransport() })
$('loop').addEventListener('change', e => player.setLoop(e.target.checked))
$('hispeed').addEventListener('input', e => playView.setHispeed(+e.target.value))
$('rate').addEventListener('input', e => {
  const v = +e.target.value / 100
  player.setRate(v)
  $('rate-v').textContent = v.toFixed(2) + '×'
})

// 스페이스로 재생/일시정지. 입력 위젯에 포커스가 있으면 넘긴다.
addEventListener('keydown', e => {
  if (e.code !== 'Space' || !current || /^(INPUT|BUTTON|TEXTAREA)$/.test(e.target.tagName)) return
  e.preventDefault()
  player.toggle()
  syncTransport()
})

document.querySelectorAll('input[name=mode]').forEach(r =>
  r.addEventListener('change', e => {
    mode = e.target.value
    const play = mode === 'play'
    $('overview').hidden = play
    $('play').hidden = !play
    $('hispeed-l').hidden = !play // 하이스피드는 스크롤 렌더에만 의미가 있다
    $('view-hint').textContent = play
      ? '스페이스 = 재생/일시정지 · 하이스피드와 배속은 별개 노브'
      : '끌면 재생 위치 이동 · Shift+클릭 = 그 구간 선택 · 배경색 = 구간 태그'
    // 재생은 모드와 무관하다 — 전체 보기로 넘어와도 그대로 흐른다.
    syncTransport()
    setCursor(cursor)
  }))

async function show(file) {
  cursor = 0
  const parsed = await loadFile(file)
  const lanes = toLanes(parsed)
  const stats = analyze(parsed, lanes)
  // ponytail: 메인 스레드 동기 실행. 로드 시 1회뿐이라 허용 — 체감 렉이 생기면 Web Worker 로.
  const wf = extract(lanes, parsed.timing)
  current = { parsed, lanes, stats, wf, segs: cutSegments(wf), radar: radar(wf) }

  // 렌더러보다 먼저 패널을 띄운다 — 숨어 있는 동안은 캔버스가 0×0 이라 레이아웃 계산이 깨진다.
  $('result').hidden = false

  const { segs } = current
  const view = { notes: lanes.notes, keyCols: lanes.keyCols, scratchCols: lanes.scratchCols, segs }
  timeline.load({ ...view, id: file.name + file.size, duration: stats.duration })
  overview.load({ ...view, totalBeats: lanes.totalBeats, measureStarts: lanes.measureStarts, timing: parsed.timing })
  playView.load({ ...view, measureStarts: lanes.measureStarts, timing: parsed.timing, pos: parsed.pos })
  player.load({ ...view, duration: stats.duration })
  syncTransport()

  const { info, bpm, counts, density } = stats
  $('title').textContent = info.title || file.name
  $('byline').textContent = [info.artist, info.genre, info.subtitle].filter(Boolean).join(' · ')

  const badges = [
    [stats.mode, true],
    [`Lv.${info.level || '?'}`, true],
    [mmss(stats.duration), false],
    [`${counts.total.toLocaleString()} notes`, false],
    [bpm.min === bpm.max ? `BPM ${r1(bpm.main)}` : `BPM ${r1(bpm.main)} (${r1(bpm.min)}–${r1(bpm.max)})`, bpm.min !== bpm.max],
    [parsed.hasRandom ? '#RANDOM' : null, true],
    [parsed.encoding !== 'utf-8' ? parsed.encoding : null, false],
  ]
  $('badges').innerHTML = badges
    .filter(([t]) => t)
    .map(([t, hot]) => `<span class="badge${hot ? ' hot' : ''}">${t}</span>`)
    .join('')

  const rows = [
    ['노트', `${counts.total.toLocaleString()} <small>(LN ${counts.ln} · 스크래치 ${counts.scratch}${counts.invisible ? ` · 비가시 ${counts.invisible}` : ''})</small>`],
    ['최대 EX', counts.maxEx.toLocaleString()],
    ['평균 NPS', `${r1(density.nps)} <small>/ 최대 ${density.peakNps}</small>`],
    ['BPM', `${r1(bpm.main)} <small>메인 · 초기 ${r1(bpm.initial)} · 변경 ${bpm.changes}회</small>`],
    ['STOP', bpm.stops ? `${bpm.stops}회 <small>총 ${r1(bpm.stopSeconds)}s</small>` : '없음'],
    ['#TOTAL', info.total || '<small>미지정</small>'],
    ['#RANK', `${RANK_NAMES[info.rank] ?? info.rank}`],
    ['마디', density.measures.length],
  ]
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')

  $('warn').textContent = parsed.warnings.length
    ? `경고 ${parsed.warnings.length}건: ${parsed.warnings.slice(0, 3).map(w => `${w.lineNumber}행 ${w.message}`).join(' / ')}`
    : ''

  redraw()
}

function showRange() {
  const r = timeline.getRange()
  $('clear-range').hidden = !r
  $('range').textContent = `커서 ${mmss(cursor)} · ` +
    (r ? `재생 구간 ${mmss(r.a)}–${mmss(r.b)} (${(r.b - r.a).toFixed(1)}s)` : '재생 구간: 전체')
}

$('clear-range').addEventListener('click', () => timeline.clearRange())

// 마디별 / 시간별. 밀도 그래프의 x축과 구간 목록의 범위 표기에 함께 적용된다.
let axis = 'measures'

function redraw() {
  if (!current) return
  const { stats, lanes, segs } = current
  const byMeasure = axis === 'measures'

  const bars = stats.density[axis]
  drawDensity($('density'), bars, { tick: byMeasure ? i => i : i => mmss(bars[i].startTime) })
  drawRadar($('radar'), current.radar)
  drawLanes($('lanes'), stats, lanes)
  timeline.draw()
  ;(mode === 'play' ? playView : overview).draw()

  const range = byMeasure
    ? s => `${measureToken(s.beat0, lanes.measureStarts)}–${measureToken(s.beat1, lanes.measureStarts)}`
    : s => `${mmss(s.t0)}–${mmss(s.t1)}`
  $('seg-count').textContent = segs.length ? `${segs.length}개` : ''
  $('segments').innerHTML = segs.length
    ? segs.map(s => `<li><span class="t">${range(s)}</span>` +
        s.tags.map(t => `<span class="tag tag-${t}">${t}</span>`).join('') + '</li>').join('')
    : '<li class="dim">구간 없음 (노트가 없거나 너무 짧음)</li>'
}

document.querySelectorAll('input[name=axis]').forEach(r =>
  r.addEventListener('change', e => { axis = e.target.value; redraw() }))

// 구간 방식을 바꾸면 태그 밴드·오버레이·목록이 전부 갈리므로 다시 계산해 셋 다 갱신한다.
// 선택해 둔 재생 구간은 건드리지 않는다 — 경계가 조금 달라져도 사용자가 고른 범위는 유지.
document.querySelectorAll('input[name=segmode]').forEach(r =>
  r.addEventListener('change', e => {
    segMode = e.target.value
    if (!current) return
    current.segs = cutSegments(current.wf)
    timeline.setSegs(current.segs)
    overview.setSegs(current.segs)
    redraw()
  }))

addEventListener('resize', redraw)

$('file').addEventListener('change', e => e.target.files[0] && show(e.target.files[0]))

const drop = $('drop')
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', e => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = e.dataTransfer.files[0]
  if (f) show(f)
})

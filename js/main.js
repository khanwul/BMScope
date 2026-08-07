import { loadFile } from './load.js'
import { laneSpec, randomLaneSpec, remapLanes, toLanes } from './lanes.js'
import { analyze, measureToken, radar, RANK_NAMES } from './analyze.js'
import { drawDensity, drawLanes, drawRadar, snapshot } from './charts.js'
import { extract } from './features.js'
import { segments } from './segment.js'
import { refine, tagSegments } from './tagger.js'
import { createTimeline } from './timeline.js'
import { createOverview, createPlayView, HISPEED_1X } from './preview.js'
import { createPlayer } from './player.js'

const $ = id => document.getElementById(id)
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const r1 = n => n.toFixed(1)

let current = null
let currentFile = null
let cursor = 0
const savedCharts = new Map()

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

const overview = createOverview($('overview'), { onSelect: selectSegment, onSeek: seekTo })

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
  $('seg-now').innerHTML = seg ? seg.tags.map(t => `<span class="tag tag-${t}">${t}</span>`).join('') : ''
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
// 한 노브가 두 모드에 걸린다 — 재생은 px/position, 전체 보기는 컬럼 밀도. 뜻은 같다(노트 간격).
// 수치는 배율로 보여준다: 두 모드의 원단위가 다르고, 어느 쪽도 사용자에게 뜻이 없는 숫자다.
$('hispeed').addEventListener('input', e => {
  const v = +e.target.value
  playView.setHispeed(v)
  overview.setHispeed(v)
  $('hispeed-v').textContent = (v / HISPEED_1X).toFixed(2) + '×'
})
$('rate').addEventListener('input', e => {
  const v = +e.target.value / 100
  player.setRate(v)
  $('rate-v').textContent = v.toFixed(2) + '×'
})

function loadPlayerViews(notes) {
  const { parsed, lanes, stats, segs } = current
  const view = { notes, keyCols: lanes.keyCols, scratchCols: lanes.scratchCols, segs }
  overview.load({ ...view, totalBeats: lanes.totalBeats, measureStarts: lanes.measureStarts, timing: parsed.timing })
  playView.load({ ...view, measureStarts: lanes.measureStarts, timing: parsed.timing, pos: parsed.pos })
  player.load({ ...view, duration: stats.duration })
}

function applyLaneOrder(spec) {
  const input = $('lane-order')
  try {
    const notes = remapLanes(current.lanes.notes, current.lanes, spec)
    input.setCustomValidity('')
    input.value = spec.replace(/\s/g, '')
    const time = player.now(), wasPlaying = player.playing(), range = timeline.getRange()
    loadPlayerViews(notes)
    timeline.setNotes(notes)
    player.setRange(range)
    player.seek(time)
    overview.setRange(toBeats(range))
    setCursor(time)
    if (wasPlaying) player.play(time)
    syncTransport()
  } catch (error) {
    input.setCustomValidity(error.message)
    input.reportValidity()
  }
}

$('lane-order').addEventListener('input', e => e.currentTarget.setCustomValidity(''))
$('lane-order').addEventListener('change', e => applyLaneOrder(e.currentTarget.value))
$('lane-order').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
})
$('lane-random').addEventListener('click', () => applyLaneOrder(randomLaneSpec(current.lanes)))

function selectSegment(seg) {
  if (seg) timeline.setRange({ a: seg.t0, b: seg.t1 })
}

// 스페이스 재생, 좌우 5초 이동, Shift+좌우 구간 이동. 입력 위젯에 포커스가 있으면 넘긴다.
addEventListener('keydown', e => {
  if (!current || /^(INPUT|BUTTON|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return
  if (e.code === 'Space') {
    e.preventDefault()
    player.toggle()
    syncTransport()
    return
  }
  if (!['ArrowLeft', 'ArrowRight'].includes(e.code)) return
  e.preventDefault()
  const dir = e.code === 'ArrowRight' ? 1 : -1
  if (!e.shiftKey) return seekTo(Math.max(0, Math.min(current.stats.duration, cursor + dir * 5)))
  const ordered = dir > 0 ? current.segs : [...current.segs].reverse()
  selectSegment(ordered.find(s => dir > 0 ? s.t0 > cursor + 1e-3 : s.t0 < cursor - 1e-3))
})

document.querySelectorAll('input[name=mode]').forEach(r =>
  r.addEventListener('change', e => {
    mode = e.target.value
    const play = mode === 'play'
    $('overview').hidden = play
    $('play').hidden = !play
    $('view-hint').textContent = play
      ? '스페이스 = 재생/일시정지 · 배경색 = 구간 태그 · 하이스피드와 배속은 별개 노브'
      : '끌면 재생 위치 이동 · Shift+클릭 = 그 구간 선택 · 배경색 = 구간 태그 · 하이스피드 = 가로 확대'
    // 재생은 모드와 무관하다 — 전체 보기로 넘어와도 그대로 흐른다.
    syncTransport()
    setCursor(cursor)
  }))

async function show(file, random = 1) {
  cursor = 0
  const parsed = await loadFile(file, { random })
  const lanes = toLanes(parsed)
  // 확장자·#명령 검사를 통과해도 채보가 없으면 볼 게 없다 — 빈 패널 대신 오류로 끝낸다.
  if (!lanes.notes.length) throw new Error('연주 노트가 없습니다 — 채보가 아니거나 손상된 파일입니다')
  const stats = analyze(parsed, lanes)
  // ponytail: 메인 스레드 동기 실행. 로드 시 1회뿐이라 허용 — 체감 렉이 생기면 Web Worker 로.
  const wf = extract(lanes, parsed.timing)
  current = { parsed, lanes, stats, wf, segs: cutSegments(wf), radar: radar(wf) }

  // 렌더러보다 먼저 패널을 띄운다 — 숨어 있는 동안은 캔버스가 0×0 이라 레이아웃 계산이 깨진다.
  $('result').hidden = false

  const { segs } = current
  const view = { notes: lanes.notes, keyCols: lanes.keyCols, scratchCols: lanes.scratchCols, segs }
  timeline.load({ ...view, id: `${file.name}${file.size}:${parsed.randomChoice}`, duration: stats.duration })
  loadPlayerViews(lanes.notes)
  $('lane-order').value = laneSpec(lanes)
  $('lane-order').title = lanes.scratchCols.length === 2 ? '1P/2P 순서 (예: 54321/12345)' : '레인 순서 (예: 54321)'
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

  $('random-control').hidden = parsed.randomMax < 2
  $('random-branch').max = parsed.randomMax
  $('random-branch').value = parsed.randomChoice

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

  // 이미지 저장이 쓸 텍스트. 화면에 넣은 것과 같은 배열에서 뽑아 두 벌이 어긋나지 않게 한다.
  current.card = {
    badges: badges.filter(([t]) => t),
    stats: rows.map(([k, v]) => [k, String(v).replace(/<[^>]+>/g, '')]),
  }

  $('warn').textContent = parsed.warnings.length
    ? `경고 ${parsed.warnings.length}건: ${parsed.warnings.slice(0, 3).map(w => `${w.lineNumber}행 ${w.message}`).join(' / ')}`
    : ''

  redraw(true)
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

// 차트 셋은 따로 뗀다 — 캔버스는 CSS 로 못 물리니 등장 애니메이션을 직접 돌려야 하고,
// 화면에 들어온 것만 자라야 하므로 하나씩 부를 수 있어야 한다.
// (타임라인·전체 보기는 노트를 전부 훑으므로 여기 끼면 프레임이 무너진다.)
const chartDraw = {
  density: g => {
    const bars = current.stats.density[axis]
    const tick = axis === 'measures' ? i => i : i => mmss(bars[i].startTime)
    drawDensity($('density'), bars, { tick, grow: g })
  },
  radar: g => drawRadar($('radar'), current.radar, g),
  lanes: g => drawLanes($('lanes'), current.stats, current.lanes, g),
}
const drawCharts = () => { for (const id in chartDraw) chartDraw[id](1) }

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const chartRaf = {}

function growChart(id) {
  cancelAnimationFrame(chartRaf[id])
  if (reduceMotion.matches) return chartDraw[id](1)
  const t0 = performance.now()
  const step = now => {
    const p = Math.min(1, (now - t0) / 450)
    chartDraw[id](1 - (1 - p) ** 3) // easeOutCubic
    if (p < 1) chartRaf[id] = requestAnimationFrame(step)
  }
  chartRaf[id] = requestAnimationFrame(step)
}

// 페이지가 길다 — 로드 때 셋 다 돌리면 접힌 화면 아래 차트는 다 놓친다. 화면에 들어올 때 시작.
const reveal = new IntersectionObserver((entries, obs) => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue
    obs.unobserve(target) // 등장은 한 번뿐. 스크롤 오갈 때마다 다시 자라면 산만하다.
    growChart(target.id)
  }
}, { threshold: 0.25 })

function armCharts() {
  reveal.disconnect()
  for (const id in chartDraw) reveal.observe($(id))
}

// `animate` 는 새 채보를 띄울 때만. 리사이즈·축 전환은 즉시 그린다 — 조작할 때마다
// 차트가 다시 자라면 값을 비교할 수가 없다.
function redraw(animate = false) {
  if (!current) return
  const { lanes, segs } = current
  const byMeasure = axis === 'measures'

  animate ? armCharts() : drawCharts()
  timeline.draw()
  ;(mode === 'play' ? playView : overview).draw()

  const range = byMeasure
    ? s => `${measureToken(s.beat0, lanes.measureStarts)}–${measureToken(s.beat1, lanes.measureStarts)}`
    : s => `${mmss(s.t0)}–${mmss(s.t1)}`
  $('seg-count').textContent = segs.length ? `${segs.length}개` : ''
  $('segments').innerHTML = segs.length
    ? segs.map((s, i) => `<li data-seg="${i}" title="클릭해서 이 구간 선택"><span class="t">${range(s)}</span>` +
        s.tags.map(t => `<span class="tag tag-${t}">${t}</span>`).join('') + '</li>').join('')
    : '<li class="dim">구간 없음 (노트가 없거나 너무 짧음)</li>'
}

$('segments').addEventListener('click', e => {
  const li = e.target.closest('[data-seg]')
  if (li) selectSegment(current?.segs[+li.dataset.seg])
})

$('random-branch').addEventListener('change', e => open(currentFile, +e.target.value))
$('reroll').addEventListener('click', () => {
  const max = current?.parsed.randomMax || 1
  let choice = 1 + Math.floor(Math.random() * max)
  if (max > 1 && choice === current.parsed.randomChoice) choice = choice % max + 1
  open(currentFile, choice)
})

// 이미지 저장 — 화면에 그려진 캔버스를 그대로 카드 한 장으로 굽는다.
$('save-image').addEventListener('click', async () => {
  if (!current) return
  drawCharts() // 스크롤이 안 닿아 아직 안 그려진 차트가 있으면 여기서 채운다
  const canvas = snapshot({
    title: $('title').textContent,
    byline: $('byline').textContent,
    ...current.card,
    rows: [[$('overview')], [$('timeline')], [$('density')], [$('radar'), $('lanes')]],
    footer: `${currentFile.name} · BMScope`,
  })
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = currentFile.name.replace(/\.[^.]*$/, '') + '.png'
  a.click()
  // 즉시 revoke 하면 브라우저가 저장을 시작하기 전에 URL 이 죽는 경우가 있다.
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

$('copy-analysis').addEventListener('click', async e => {
  const { parsed, stats, radar: axes, segs } = current
  const report = {
    file: currentFile.name,
    title: stats.info.title,
    artist: stats.info.artist,
    mode: stats.mode,
    level: stats.info.level,
    duration: stats.duration,
    bpm: stats.bpm,
    counts: stats.counts,
    radar: Object.fromEntries(axes.map(a => [a.key, +a.value.toFixed(1)])),
    segments: segs.map(s => ({ start: s.t0, end: s.t1, tags: s.tags })),
    ...(parsed.randomMax > 1 && { randomBranch: parsed.randomChoice }),
  }
  const label = e.currentTarget.textContent
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    e.currentTarget.textContent = '복사됨'
  } catch {
    e.currentTarget.textContent = '복사 실패'
  }
  setTimeout(() => { e.currentTarget.textContent = label }, 1200)
})

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
    playView.setSegs(current.segs)
    redraw()
  }))

// 이벤트 객체가 `animate` 로 새면 리사이즈마다 차트가 다시 자란다.
addEventListener('resize', () => redraw())

// 파일 진입점. 두 경로(선택·드롭)가 여기로 모이므로 파싱 실패도 여기서만 잡는다.
function open(file, random = 1) {
  if (!file) return
  currentFile = file
  $('error').hidden = true
  // display 를 껐다 켜야 등장 애니메이션이 다시 돈다 — 다시 뽑기·브랜치 변경도 새 결과다.
  $('result').hidden = true
  return show(file, random).catch(e => {
    current = null
    player.stop()
    syncTransport()
    $('result').hidden = true
    $('error').textContent = `${file.name} — ${e.message}`
    $('error').hidden = false
  })
}

// value 를 비워야 같은 파일을 다시 골랐을 때도 change 가 뜬다 — 오류 뒤 재시도가 먹통이 된다.
$('file').addEventListener('change', e => {
  const f = e.target.files[0]
  e.target.value = ''
  if (f) return open(f)
})

const drop = $('drop')
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', e => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = e.dataTransfer.files[0]
  if (f) open(f)
})

const chartLabel = chart => [chart.title || chart.filename, chart.artist, chart.title && chart.filename].filter(Boolean).join(' — ')
let savedRequest = 0
let searchTimer

async function loadSavedCharts(query = '') {
  const request = ++savedRequest
  try {
    const res = await fetch(`/api/charts?q=${encodeURIComponent(query)}`)
    if (!res.ok) throw new Error()
    const charts = await res.json()
    if (request !== savedRequest || !Array.isArray(charts)) return
    const list = $('saved-charts')
    savedCharts.clear()
    list.replaceChildren()
    for (const chart of charts) {
      savedCharts.set(String(chart.id), chart)
      const option = document.createElement('option')
      option.value = chart.id
      option.textContent = chartLabel(chart)
      list.append(option)
    }
    $('saved').hidden = false
  } catch {
    if (request === savedRequest) $('saved').hidden = true
  }
}

$('saved-chart').addEventListener('input', e => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadSavedCharts(e.currentTarget.value), 200)
})

$('load-saved').addEventListener('click', async () => {
  const chart = savedCharts.get($('saved-charts').value)
  if (!chart) return
  try {
    const res = await fetch(`/api/charts/${encodeURIComponent(chart.id)}`)
    if (!res.ok) throw new Error('저장된 채보를 가져오지 못했습니다')
    await open(new File([await res.blob()], chart.filename.split('/').pop()))
  } catch (error) {
    $('error').textContent = `${chart.filename} — ${error.message}`
    $('error').hidden = false
  }
})

loadSavedCharts()

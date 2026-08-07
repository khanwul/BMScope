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
// 두 탭에 같은 노브가 하나씩 있다. 값은 하나이므로 클래스로 한꺼번에 잡는다.
const $$ = selector => document.querySelectorAll(selector)
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
function setHispeed(v) {
  playView.setHispeed(v)
  overview.setHispeed(v)
  const label = (v / HISPEED_1X).toFixed(2) + '×'
  for (const el of $$('.hispeed')) el.value = v
  for (const el of $$('.hispeed-v')) el.textContent = label
}
for (const el of $$('.hispeed')) el.addEventListener('input', e => setHispeed(+e.target.value))
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

function applyLaneOrder(spec, input = $$('.lane-order')[0]) {
  try {
    const notes = remapLanes(current.lanes.notes, current.lanes, spec)
    for (const el of $$('.lane-order')) {
      el.setCustomValidity('')
      el.value = spec.replace(/\s/g, '')
    }
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

for (const el of $$('.lane-order')) {
  el.addEventListener('input', e => e.currentTarget.setCustomValidity(''))
  el.addEventListener('change', e => applyLaneOrder(e.currentTarget.value, e.currentTarget))
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
  })
}
for (const el of $$('.lane-random'))
  el.addEventListener('click', () => applyLaneOrder(randomLaneSpec(current.lanes)))

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

$$('input[name=mode]').forEach(r =>
  r.addEventListener('change', e => {
    mode = e.target.value
    const play = mode === 'play'
    $('overview-view').hidden = play
    $('play-view').hidden = !play
    // 켜지는 쪽 캔버스는 방금까지 0×0 이라 안 그려졌다 — 여기서 채운다.
    // 재생은 모드와 무관하다 — 전체 보기로 넘어와도 그대로 흐른다.
    redraw()
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
  const spec = laneSpec(lanes)
  const laneTitle = lanes.scratchCols.length === 2 ? '1P/2P 순서 (예: 54321/12345)' : '레인 순서 (예: 54321)'
  for (const el of $$('.lane-order')) {
    el.value = spec
    el.title = laneTitle
  }
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

// 숨은 탭의 캔버스는 0×0 이라 그려지지 않는다 — 탭을 켤 때 redraw 가 다시 돈다.
function drawCharts() {
  const bars = current.stats.density[axis]
  const tick = axis === 'measures' ? i => i : i => mmss(bars[i].startTime)
  drawDensity($('density'), bars, { tick })
  drawRadar($('radar'), current.radar)
  drawLanes($('lanes'), current.stats, current.lanes)
}

function redraw() {
  if (!current) return
  const { lanes, segs } = current
  const byMeasure = axis === 'measures'

  drawCharts()
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

$$('.axis-control').forEach(r =>
  r.addEventListener('change', e => {
    axis = e.target.value
    $$('.axis-control').forEach(x => { x.checked = x.value === axis })
    redraw()
  }))

// 구간 방식을 바꾸면 태그 밴드·오버레이·목록이 전부 갈리므로 다시 계산해 셋 다 갱신한다.
// 선택해 둔 재생 구간은 건드리지 않는다 — 경계가 조금 달라져도 사용자가 고른 범위는 유지.
$$('input[name=segmode]').forEach(r =>
  r.addEventListener('change', e => {
    segMode = e.target.value
    if (!current) return
    current.segs = cutSegments(current.wf)
    timeline.setSegs(current.segs)
    overview.setSegs(current.segs)
    playView.setSegs(current.segs)
    redraw()
  }))

addEventListener('resize', redraw)

// 파일 진입점. 두 경로(선택·드롭)가 여기로 모이므로 파싱 실패도 여기서만 잡는다.
function open(file, random = 1) {
  if (!file) return
  currentFile = file
  $('error').hidden = true
  // 파싱이 실패하면 앞 채보의 결과가 남아 있으면 안 된다 — 먼저 감추고 성공할 때만 켠다.
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

const chartLabel = chart => {
  const filename = chart.filename.replace(/^[^/]+\//, '')
  return [chart.title || filename, chart.artist, chart.title && filename].filter(Boolean).join(' — ')
}
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
  const { value } = e.currentTarget
  searchTimer = setTimeout(() => loadSavedCharts(value), 200)
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

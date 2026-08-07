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
import { irComparison, loadTachi, practiceSegments } from './ir.js'

const $ = id => document.getElementById(id)
const $$ = selector => document.querySelectorAll(selector)
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const r1 = n => n.toFixed(1)
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

let current = null
let currentFile = null
let cursor = 0
const savedCharts = new Map()
let irRequest = 0

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
  if (mode === 'play') playView.setTime(t)
  else if (mode === 'overview') overview.setTime(t)
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
  $('hispeed-v').textContent = (v / HISPEED_1X).toFixed(2) + '×'
}
$('hispeed').addEventListener('input', e => setHispeed(+e.target.value))
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
    renderIrRandom()
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

function setMode(next) {
  mode = next
  for (const radio of $$('input[name=mode]')) radio.checked = radio.value === mode
  $('overview-view').hidden = mode !== 'overview'
  $('play-view').hidden = mode !== 'play'
  $('ir-view').hidden = mode !== 'ir'
  $('view-controls').hidden = mode === 'ir' // IR 탭에는 그릴 캔버스가 없다
  if (mode === 'ir') {
    if (current && !current.ir && !current.irLoading) loadIrData()
    return
  }
  // 켜지는 쪽 캔버스는 방금까지 0×0 이라 안 그려졌다 — 여기서 채운다.
  // 재생은 모드와 무관하다 — 전체 보기로 넘어와도 그대로 흐른다.
  redraw()
  syncTransport()
  setCursor(cursor)
}

$$('input[name=mode]').forEach(r => r.addEventListener('change', e => setMode(e.target.value)))

async function show(file, random = 1) {
  cursor = 0
  const parsed = await loadFile(file, { random })
  const lanes = toLanes(parsed)
  // 확장자·#명령 검사를 통과해도 채보가 없으면 볼 게 없다 — 빈 패널 대신 오류로 끝낸다.
  if (!lanes.notes.length) throw new Error('연주 노트가 없습니다 — 채보가 아니거나 손상된 파일입니다')
  const stats = analyze(parsed, lanes)
  // ponytail: 메인 스레드 동기 실행. 로드 시 1회뿐이라 허용 — 체감 렉이 생기면 Web Worker 로.
  const wf = extract(lanes, parsed.timing)
  current = { parsed, lanes, stats, wf, segs: cutSegments(wf), radar: radar(wf), ir: null }

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

  $('ir-content').hidden = true
  $('ir-status').textContent = 'IR 탭을 열면 조회합니다.'
  $('bokutachi-link').hidden = true
  redraw()
  if (mode === 'ir') loadIrData()
}

// ── 외부 IR ─────────────────────────────────────────────────────────────
const IR_CLIENTS = { lr2: 'LR2', openlr2: 'OpenLR2', lr2oraja: 'LR2oraja', lr2oraja_ed: 'LR2oraja ED', beatoraja: 'beatoraja' }
const irClient = () => IR_CLIENTS[$('ir-client').value] ? $('ir-client').value : 'lr2'
const bmsIrUrl = (md5, client = irClient()) => `https://bms-ir.org/new/song?songmd5=${md5}&client_view=${client}`
const mochaUrl = info => `https://mocha-repository.info/songs2.php?title=${encodeURIComponent(info.title || '')}&artist=${encodeURIComponent(info.artist || '')}`

function renderIrRandom() {
  if (!current) return
  const option = current.ir?.bmsir?.song?.topOption
  const lane = $('lane-order').value
  const recorded = option?.match(/\b([1-7]{7})\b/)?.[1]
  $('ir-random').textContent = option
    ? `현재 레인 ${lane} · BMS-IR 선두 OP ${option}${recorded ? ` · ${lane === recorded ? '같은 배치' : '다른 배치'}` : ' · seed는 구동기별 해석'}`
    : `현재 레인 ${lane} · IR에 비교 가능한 RANDOM 배치 없음`
}

function renderIr() {
  const data = current.ir
  if (!data) return
  const tachi = data.tachi
  const bms = data.bmsir
  const levels = [...new Set([
    ...Object.entries(tachi?.levels || {}).map(([k, v]) => k + v),
    ...(bms?.song?.levels || []),
  ])]
  const stats = []
  if (levels.length) stats.push(['난이도표', levels.join(' · ')])
  if (tachi?.aiLevel) stats.push(['추정 난이도', tachi.aiLevel])
  const s = bms?.song?.found ? bms.song.stats : null
  if (s) {
    stats.push(['BMS-IR', IR_CLIENTS[bms.client] || bms.client])
    stats.push(['플레이', `${s.players || 0}명 · ${s.plays || 0}회`])
    stats.push(['평균 EX', s.averageScore || '-'])
    stats.push(['최고 EX / 최소 BP', `${s.topEx || '-'} / ${s.minBp || '-'}`])
    if (+s.players && Number.isFinite(+s.clears)) stats.push(['클리어율', `${((+s.clears / +s.players) * 100).toFixed(1)}%`])
  } else if (tachi?.pbs?.players) {
    stats.push(['Bokutachi', `${tachi.pbs.players}명`])
    stats.push(['상위 표본', `${tachi.pbs.sample}명 · 평균 ${tachi.pbs.average?.toFixed(2) || '-'}%`])
    stats.push(['최고 EX / 최소 BP', `${tachi.pbs.top ?? '-'} / ${tachi.pbs.minBp ?? '-'}`])
  }
  $('ir-stats').innerHTML = stats.length
    ? stats.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
    : '<dt>통계</dt><dd class="dim">등록 기록 없음</dd>'

  const lamps = (bms?.song?.found && bms.song.lamps.length
    ? bms.song.lamps.map(x => ({ name: x.lamp, count: x.count, percent: x.percent })) : null) ||
    Object.entries(tachi?.pbs?.lamps || {}).map(([name, count]) => ({ name, count, percent: count / Math.max(1, tachi.pbs.sample) * 100 }))
  $('ir-lamps').innerHTML = lamps.length
    ? `<div class="lamp-line" title="${esc(lamps.map(x => `${x.name} ${x.count}`).join(' · '))}">` +
      lamps.map((x, i) => `<span style="width:${Math.max(0, Math.min(100, x.percent))}%;--lamp-i:${i}"></span>`).join('') + '</div>'
    : ''

  const minir = bms?.minir
  const archive = bms?.archive
  const timing = minir?.timing
  const comparison = irComparison({
    localMaxEx: current.stats.counts.maxEx, bms, minir, tachi, archive,
    randomized: current.parsed.randomMax > 1,
  })
  $('ir-other').innerHTML = `<table class="ir-compare"><thead><tr><th>IR</th><th>인원</th><th>평균</th><th>최고 EX</th><th>최대 EX</th></tr></thead><tbody>${comparison.map(row => {
    const source = row.source.startsWith('BMS-IR') ? `BMS-IR (${IR_CLIENTS[bms?.client] || bms?.client || '-'})` : row.source
    const status = !row.available ? '미등록' : row.basis === 'hash' ? `${row.maxEx?.toLocaleString() ?? '?'} (해시)` :
      row.comparable ? `${row.maxEx?.toLocaleString() ?? '?'} (일치)` : `${row.maxEx?.toLocaleString() ?? '?'} (제외)`
    return `<tr class="${row.comparable === false ? 'excluded' : ''}"><th>${esc(source)}</th>` +
      `<td>${row.players?.toLocaleString() ?? '—'}</td><td>${row.average == null ? '—' : `${row.average.toFixed(2)}%`}</td>` +
      `<td>${row.topEx?.toLocaleString() ?? '—'}</td><td title="${row.comparable === false ? `현재 파일 최대 EX ${current.stats.counts.maxEx}` : ''}">${status}</td></tr>`
  }).join('')}</tbody></table>` + [
    timing && `MinIR 판정: EARLY ${timing.earlyPercent.toFixed(1)}% · LATE ${(100 - timing.earlyPercent).toFixed(1)}%`,
    archive && `구 LR2IR: ${archive.plays.toLocaleString()}회 · 클리어 ${archive.players ? (archive.clearPlayers / archive.players * 100).toFixed(1) : '0.0'}%`,
  ].filter(Boolean).map(note => `<p class="dim ir-note">${note}</p>`).join('')

  const pb = tachi?.personal
  $('ir-personal').innerHTML = pb
    ? `<strong>${esc(pb.scoreData.lamp)}</strong> · ${pb.scoreData.percent.toFixed(2)}% · EX ${pb.scoreData.score.toLocaleString()} · ` +
      `#${pb.rankingData.rank}/${pb.rankingData.outOf}${Number.isFinite(pb.scoreData.optional?.bp) ? ` · BP ${pb.scoreData.optional.bp}` : ''}`
    : $('ir-user').value.trim() ? '이 채보의 기록이 없습니다.' : '사용자명을 입력하면 표시합니다.'
  const growth = tachi?.progression || []
  const values = growth.map(x => x.percent)
  const min = Math.min(...values), max = Math.max(...values)
  const points = growth.map((x, i) => `${growth.length === 1 ? 50 : i / (growth.length - 1) * 100},${max === min ? 17 : 31 - (x.percent - min) / (max - min) * 28}`).join(' ')
  $('ir-growth').innerHTML = growth.length
    ? `<span class="dim">PB 변화 ${growth.map(x => x.percent.toFixed(2)).join(' → ')}%</span>` +
      (growth.length > 1 ? `<svg viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="PB 성장 그래프"><polyline points="${points}"></polyline></svg>` : '')
    : ''
  const rival = tachi?.rival
  const rivalName = $('ir-rival').value.trim()
  $('ir-rival-result').innerHTML = rival
    ? `<strong>${esc(rivalName)}</strong> · ${esc(rival.scoreData.lamp)} · ${rival.scoreData.percent.toFixed(2)}% · EX ${rival.scoreData.score.toLocaleString()}` +
      (pb ? ` · 내 PB 대비 ${(rival.scoreData.score - pb.scoreData.score) >= 0 ? '+' : ''}${(rival.scoreData.score - pb.scoreData.score).toLocaleString()}` : '')
    : rivalName ? '라이벌의 이 채보 기록이 없습니다.' : ''
  $('ir-recent').innerHTML = tachi?.recent?.length
    ? tachi.recent.map(x => `<li>${x.url ? `<a href="${x.url}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)} ` +
      `<span class="dim">${esc(x.level)} · ${esc(x.scoreData.lamp)} ${x.scoreData.percent.toFixed(2)}%</span></li>`).join('')
    : ''

  const peakIndex = current.wf.names.indexOf('peak_nps')
  const candidates = current.segs.map(segment => ({
    ...segment,
    peakNps: peakIndex < 0 ? 0 : current.wf.X.slice(segment.a, segment.b)
      .reduce((max, row) => Math.max(max, Number.isFinite(row[peakIndex]) ? row[peakIndex] : 0), 0),
  }))
  const baseline = comparison.find(row => row.available && row.comparable && row.average != null)?.average ?? null
  const practice = practiceSegments(candidates, pb?.scoreData?.percent, baseline)
  const focusTags = [...new Set(practice.flatMap(x => x.tags))].slice(0, 3)
  const gap = practice[0]?.gap
  const gapLabel = !pb ? '내 기록 없음' : gap == null ? '비교 평균 없음' :
    `평균 대비 ${gap > 0 ? '-' : '+'}${Math.abs(gap).toFixed(2)}%p`
  $('ir-focus').textContent = [gapLabel, focusTags.length && `초점 ${focusTags.join(' · ')}`].filter(Boolean).join(' · ')
  $('ir-practice').innerHTML = practice.length
    ? practice.map(x => `<li><button type="button" class="ir-practice" data-ir-seg="${x.index}">` +
      `<strong>${mmss(x.t0)}–${mmss(x.t1)}</strong> ${x.tags.map(tag => `<span class="tag tag-${tag}">${tag}</span>`).join('')}` +
      `<span class="dim">최대 ${x.peakNps.toFixed(1)} nps · 클릭해 반복 재생</span></button></li>`).join('')
    : '<li class="dim">집중 연습할 패턴 구간 없음</li>'
  $('ir-recommend').innerHTML = tachi?.recommendations?.length
    ? tachi.recommendations.map((x, i) => `<li><button type="button" class="ir-load" data-ir-rec="${i}">${esc(x.title)}</button> ` +
      `<span class="dim">${esc(x.level)}${x.played ? ' · 최근 플레이' : ''} · <a href="${x.url}" target="_blank" rel="noopener">IR</a></span></li>`).join('')
    : '<li class="dim">난이도가 가까운 인기 채보 없음</li>'
  $('ir-recommend-status').textContent = ''
  $('ir-popular').innerHTML = bms?.popular?.slice(0, 5).map(x =>
    `<li><a href="${bmsIrUrl(x.md5)}" target="_blank" rel="noopener">${esc(x.title)}</a> ` +
    `<span class="dim">${x.players}명 · ${x.plays}회</span></li>`).join('') || '<li class="dim">조회 불가</li>'

  $('ir-content').hidden = false
  $('ir-status').innerHTML = [
    ['Bokutachi', !!tachi?.chart],
    [`BMS-IR (${IR_CLIENTS[bms?.client] || IR_CLIENTS[irClient()]})`, !!bms?.song?.found],
    ['MinIR', !!minir],
    ['LR2IR Archive', !!archive],
  ].map(([name, ok]) => `<span class="badge${ok ? ' hot' : ''}" title="${ok ? '연결됨' : '미등록/조회 불가'}">${esc(name)}</span>`)
    .join('') + '<span class="badge" title="조회 API 없음">STELLAVERSE IR 링크만</span>'
  if (tachi?.url) { $('bokutachi-link').href = tachi.url; $('bokutachi-link').hidden = false }
  renderIrRandom()

  // 이미지 저장용 IR 행. 화면에 쓴 값 그대로 담고 분석 통계와는 따로 둔다 —
  // 한 배열에 섞으면 다시 조회할 때마다 라벨 이름으로 걸러내야 한다.
  const weekly = bms?.popular?.find(x => x.md5 === current.parsed.hashes.md5)
  current.card.irStats = [
    levels.length && ['IR 난이도', levels.join(' · ')],
    +s?.players && [`BMS-IR (${IR_CLIENTS[bms.client]})`, `${s.players}명 · 평균 ${s.averageScore || '-'}`],
    minir && ['MinIR', `${minir.players}명 · 평균 ${minir.average.toFixed(2)}%`],
    archive && ['구 LR2IR', `${archive.players.toLocaleString()}명 · ${archive.plays.toLocaleString()}회`],
    pb && ['내 PB', `${pb.scoreData.lamp} · ${pb.scoreData.percent.toFixed(2)}%`],
    weekly && ['주간 인기', `#${weekly.rank} · ${weekly.players}명`],
  ].filter(Boolean)
  if (levels.length && !current.irBadge) {
    current.irBadge = levels[0]
    $('badges').innerHTML += `<span class="badge hot">${esc(levels[0])}</span>`
    current.card.badges.push([levels[0], true])
  }
}

$('ir-practice').addEventListener('click', e => {
  const button = e.target.closest('[data-ir-seg]')
  const segment = button && current?.segs[+button.dataset.irSeg]
  if (!segment) return
  selectSegment(segment)
  setMode('play')
  seekTo(segment.t0)
})

$('ir-recommend').addEventListener('click', async e => {
  const button = e.target.closest('[data-ir-rec]')
  const recommendation = button && current?.ir?.tachi?.recommendations?.[+button.dataset.irRec]
  if (!recommendation?.sha256) return
  const status = $('ir-recommend-status')
  button.disabled = true
  status.textContent = '저장된 채보 확인 중…'
  try {
    const response = await fetch(`/api/charts?sha256=${recommendation.sha256}`)
    const [chart] = response.ok ? await response.json() : []
    if (!chart) throw new Error('서버에 저장된 원본이 없습니다. 채보 폴더를 다시 가져오면 연결됩니다.')
    if (await openSavedChart(chart)) setMode('overview')
  } catch (error) {
    status.textContent = error.message || '채보를 불러오지 못했습니다.'
  } finally {
    button.disabled = false
  }
})

async function loadIrData() {
  if (!current) return
  current.irLoading = true
  const request = ++irRequest
  const { hashes } = current.parsed
  const client = irClient()
  $('bmsir-link').href = bmsIrUrl(hashes.md5, client)
  $('bmsir-link').textContent = `BMS-IR (${IR_CLIENTS[client]})`
  $('lr2archive-link').href = `https://lr2ir.com/charts/${hashes.md5}`
  $('mocha-link').href = mochaUrl(current.stats.info)
  $('bokutachi-link').hidden = true
  $('ir-content').hidden = true
  $('ir-status').textContent = '조회 중…'
  const username = $('ir-user').value.trim()
  const rival = $('ir-rival').value.trim()
  const [tachi, bmsir] = await Promise.allSettled([
    loadTachi({ sha256: hashes.sha256, mode: current.stats.mode, username, rival }),
    fetch(`/api/ir/${hashes.md5}?sha256=${hashes.sha256}&client=${client}`).then(r => r.ok ? r.json() : Promise.reject(new Error())),
  ])
  if (request !== irRequest || current?.parsed.hashes.md5 !== hashes.md5) return
  current.irLoading = false
  current.ir = {
    tachi: tachi.status === 'fulfilled' ? tachi.value : null,
    bmsir: bmsir.status === 'fulfilled' ? bmsir.value : null,
  }
  renderIr()
}

try {
  $('ir-user').value = window.localStorage?.getItem('bmscope-bokutachi-user') || ''
  $('ir-rival').value = window.localStorage?.getItem('bmscope-bokutachi-rival') || ''
  const client = window.localStorage?.getItem('bmscope-bmsir-client')
  if (IR_CLIENTS[client]) $('ir-client').value = client
} catch {}
const saveIrSettings = () => {
  try {
    window.localStorage?.setItem('bmscope-bokutachi-user', $('ir-user').value.trim())
    window.localStorage?.setItem('bmscope-bokutachi-rival', $('ir-rival').value.trim())
    window.localStorage?.setItem('bmscope-bmsir-client', irClient())
  } catch {}
}
$('load-ir-user').addEventListener('click', () => {
  saveIrSettings()
  loadIrData()
})
$('ir-client').addEventListener('change', () => { saveIrSettings(); loadIrData() })

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
  if (!current || mode === 'ir') return
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
    stats: [...current.card.stats, ...(current.card.irStats || [])],
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
    hashes: parsed.hashes,
    title: stats.info.title,
    artist: stats.info.artist,
    mode: stats.mode,
    level: stats.info.level,
    duration: stats.duration,
    bpm: stats.bpm,
    counts: stats.counts,
    radar: Object.fromEntries(axes.map(a => [a.key, +a.value.toFixed(1)])),
    segments: segs.map(s => ({ start: s.t0, end: s.t1, tags: s.tags })),
    ...(current.ir && { ir: {
      levels: current.ir.tachi?.levels || {},
      aiLevel: current.ir.tachi?.aiLevel || null,
      bmsIrClient: current.ir.bmsir?.client || null,
      community: current.ir.bmsir?.song?.found ? current.ir.bmsir.song : current.ir.tachi?.pbs || null,
      minir: current.ir.bmsir?.minir || null,
      lr2Archive: current.ir.bmsir?.archive || null,
      personal: current.ir.tachi?.personal || null,
      rival: current.ir.tachi?.rival || null,
      progression: current.ir.tachi?.progression || [],
      weeklyRank: current.ir.bmsir?.popular?.find(x => x.md5 === parsed.hashes.md5)?.rank || null,
    } }),
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

$$('input[name=axis]').forEach(r =>
  r.addEventListener('change', e => { axis = e.target.value; redraw() }))

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

async function openSavedChart(chart) {
  try {
    const res = await fetch(`/api/charts/${encodeURIComponent(chart.id)}`)
    if (!res.ok) throw new Error('저장된 채보를 가져오지 못했습니다')
    await open(new File([await res.blob()], chart.filename.split('/').pop()))
    return true
  } catch (error) {
    $('error').textContent = `${chart.filename} — ${error.message}`
    $('error').hidden = false
    return false
  }
}

$('load-saved').addEventListener('click', () => {
  const chart = savedCharts.get($('saved-charts').value)
  if (chart) return openSavedChart(chart)
})

loadSavedCharts()

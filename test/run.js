// 자체검증: node test/run.js  (또는 npm test)
// 시간축·레인 매핑·마디 집계처럼 조용히 틀리는 것만 본다. 프레임워크 없음.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, decode } from '../js/load.js'
import { toLanes, laneGeom, laneLabel, laneOrder, laneSpec, randomLaneSpec, remapLanes } from '../js/lanes.js'
import { analyze, measureToken, radar, RADAR_AXES } from '../js/analyze.js'
import { extract, trillRatio, FEATURE_NAMES } from '../js/features.js'
import { boundaries, segments, SEG_FEATURES } from '../js/segment.js'
import { classify, refine, tagSegments } from '../js/tagger.js'
import { createPlayer } from '../js/player.js'
import { hashes, irComparison, md5, practiceSegments, progression, recommend, summarizePBs } from '../js/ir.js'

const run = (text, name = 'x.bms') => {
  const parsed = parse(text, { name })
  const lanes = toLanes(parsed)
  return { parsed, lanes, stats: analyze(parsed, lanes) }
}

// ── IR 식별·요약 ───────────────────────────────────────────────────────────
{
  const bytes = s => new TextEncoder().encode(s).buffer
  assert.equal(md5(bytes('')), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5(bytes('abc')), '900150983cd24fb0d6963f7d28e17f72')
  assert.deepEqual(await hashes(bytes('abc')), {
    md5: '900150983cd24fb0d6963f7d28e17f72',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  })
  const pbs = [
    { rankingData: { outOf: 9 }, scoreData: { lamp: 'HARD CLEAR', percent: 90, score: 1800, optional: { bp: 2 } } },
    { rankingData: { outOf: 9 }, scoreData: { lamp: 'EASY CLEAR', percent: 70, score: 1400, optional: { bp: 8 } } },
  ]
  assert.deepEqual(summarizePBs(pbs), {
    players: 9, sample: 2, average: 80, top: 1800, minBp: 2,
    lamps: { 'HARD CLEAR': 1, 'EASY CLEAR': 1 },
  })
  const chart = (id, n) => ({ chartID: id, game: 'bms-7k', song: { title: id, artist: 'a' }, data: { aiLevel: `★${n}`, hashSHA256: 'a'.repeat(64) } })
  const recommendations = recommend(chart('now', 10), [chart('hard', 11), chart('same', 10), chart('easy', 8)], [])
  assert.deepEqual(recommendations.map(x => x.title),
    ['same', 'easy'], '현재보다 같거나 두 단계 낮은 인기 채보만 추천')
  assert.equal(recommendations[0].sha256, 'a'.repeat(64), '추천 채보를 저장 원본과 연결할 SHA-256을 보존')
  assert.deepEqual(progression([
    { timeAchieved: '2026-01-03', scoreData: { percent: 80, score: 1600 } },
    { timeAchieved: '2026-01-01', scoreData: { percent: 60, score: 1200 } },
    { timeAchieved: '2026-01-02', scoreData: { percent: 55, score: 1100 } },
  ]).map(x => x.percent), [60, 80], 'PB 성장선은 시간순 최고기록만 남긴다')

  const comparison = irComparison({
    localMaxEx: 200,
    bms: { client: 'lr2', song: { found: true, stats: { players: '20', averageScore: '87.50%', topEx: '190' } } },
    minir: { players: 10, average: 80, topEx: 170, maxEx: 198 },
    tachi: { chart: {}, pbs: { players: 8, average: 85, top: 188 } },
    archive: { players: 30, topEx: 195, maxEx: 200 },
  })
  assert.equal(comparison[0].average, 87.5)
  assert.equal(comparison[0].basis, 'hash')
  assert.equal(comparison[1].comparable, false)
  assert.equal(comparison[1].topEx, null, '최대 EX가 다른 MinIR 점수는 비교에서 제외')
  assert.equal(comparison[3].topEx, 195)
  assert.equal(irComparison({
    localMaxEx: 200, randomized: true,
    bms: { song: { found: true, stats: { averageScore: '90%', topEx: 190 } } },
    tachi: { chart: {}, pbs: { average: 90, top: 190 } },
  })[0].comparable, false, '#RANDOM 채보는 같은 파일 해시만으로 최대 EX 일치를 단정하지 않는다')

  assert.deepEqual(practiceSegments([
    { t0: 0, t1: 5, tags: ['rest'], peakNps: 1 },
    { t0: 5, t1: 10, tags: ['trill'], peakNps: 8 },
    { t0: 10, t1: 16, tags: ['jack', 'chord'], peakNps: 10 },
  ], 75, 82).map(x => [x.index, x.tags, x.gap]), [
    [2, ['jack', 'chord'], 7], [1, ['trill'], 7],
  ], '패턴 구간은 밀도순이며 개인 PB와 커뮤니티 격차를 함께 보존')
}

// ── 7K: 노트 · LN · 스크래치 · BPM 변화 · STOP · 마디 집계 ────────────────────
const SEVEN = [
  '#TITLE Sample', '#ARTIST Me', '#GENRE Test',
  '#BPM 120', '#PLAYLEVEL 10', '#RANK 2', '#TOTAL 300',
  '#LNOBJ ZZ', '#WAV01 a.wav', '#BPM01 240', '#STOP01 48',
  '#00111:01010101', // 4박~7박, 1키
  '#00116:0101',     // 4박·6박, 스크래치
  '#00118:01',       // 4박, 6키 → 7K 판정
  '#00208:01',       // 8박에서 BPM 240
  '#00209:01',       // 8박에서 STOP 1박
  '#00211:01ZZ',     // 8박~10박 LN
  '#00331:01',       // 비가시
].join('\n')

{
  const { lanes, stats } = run(SEVEN)
  const { counts, bpm, density } = stats

  assert.equal(lanes.mode, '7K')
  assert.deepEqual(lanes.scratchCols, [7])
  assert.equal(counts.total, 8, '노트 8개 (지뢰·비가시·BGM 제외)')
  assert.equal(counts.ln, 1, '#LNOBJ 롱노트 1개')
  assert.equal(counts.scratch, 2)
  assert.equal(counts.invisible, 1, '비가시는 개수만')
  assert.equal(counts.byCol[0], 5, '1키 = 일반 4 + LN 1')
  assert.equal(counts.byCol[5], 1, 'ch18 → 6키 = col 5')
  assert.equal(counts.byCol[7], 2, '스크래치 = 마지막 컬럼')

  // 시간 가중 최빈값: 120BPM 이 8박(4초), 240BPM 이 8박(2초) → 120 이 메인
  assert.equal(bpm.main, 120, '메인 BPM 은 등장 횟수가 아니라 시간 가중')
  assert.equal(bpm.min, 120)
  assert.equal(bpm.max, 240)
  assert.equal(bpm.changes, 1)
  assert.equal(bpm.stops, 1)
  assert.ok(Math.abs(bpm.stopSeconds - 0.25) < 1e-9, `STOP 48/48박 @240BPM = 0.25s (${bpm.stopSeconds})`)

  // LN 끝 = 10박: 0~8박@120 = 4s, STOP 0.25s, 8~10박@240 = 0.5s
  assert.ok(Math.abs(stats.duration - 4.75) < 1e-9, `총 길이 4.75s (${stats.duration})`)

  assert.equal(density.measures.length, 4, '마디 0~3')
  assert.deepEqual(density.measures.map(b => b.notes), [0, 7, 1, 0])
  assert.equal(density.measures[1].bpm, 120)
  assert.equal(density.measures[2].bpm, 240)
  assert.equal(density.peakNps, 4, '1초 창 최대 = 4박 지점의 동시 3 + 4.5박 1')

  // 시간 뷰는 1초 버킷. 첫 노트가 2.0s, 마지막(LN 끝)이 4.75s → 버킷 5개
  assert.equal(density.seconds.length, 5, '0~4.75s → 1초 버킷 5개')
  assert.deepEqual(density.seconds.map(b => b.notes), [0, 0, 4, 3, 1],
    '2.0s에 3+1개(4박·4.5박), 3.0s에 3개(5·5.5·6박은 3.0/3.5s), 4.0s에 LN 시작')
  assert.equal(density.seconds.reduce((s, b) => s + b.notes, 0), counts.total, '두 뷰의 합이 같아야 한다')
  assert.equal(density.measures.reduce((s, b) => s + b.notes, 0), counts.total)
  assert.ok(Math.abs(density.seconds[4].seconds - 0.75) < 1e-9, '마지막 버킷은 남은 길이만')

  // 종류별 누적: 막대 높이 합 = 노트 수여야 하고, 종류별 총합은 통계와 맞아야 한다
  for (const view of ['measures', 'seconds'])
    for (const b of density[view])
      assert.equal(b.types.normal + b.types.ln + b.types.scratch, b.notes, `${view} 버킷 ${b.index} 종류 합`)
  const total = k => density.measures.reduce((s, b) => s + b.types[k], 0)
  assert.equal(total('ln'), counts.ln, '롱노트 합')
  assert.equal(total('scratch'), counts.scratch, '스크래치 합')
  assert.equal(total('normal'), counts.total - counts.ln - counts.scratch, '일반 노트 합')
  assert.deepEqual(density.measures[1].types, { normal: 5, ln: 0, scratch: 2 }, '마디1 = 일반 5 + 스크래치 2')
  assert.deepEqual(density.measures[2].types, { normal: 0, ln: 1, scratch: 0 }, '마디2 = LN 1')
  assert.deepEqual(density.seconds[2].types, { normal: 3, ln: 0, scratch: 1 }, '2.0~3.0s')

  // 순간 최대 밀도 = 버킷 안의 노트에서 시작하는 1초 창의 최대 노트 수.
  // 노트 시각은 2.0×3 · 2.5 · 3.0×2 · 3.5 · 4.0 → [2.0,3.0) 창이 4개로 최대.
  assert.equal(density.measures[1].peak, 4, '마디1 순간 최대')
  assert.equal(density.measures[2].peak, 1, '마디2 는 LN 1개뿐')
  assert.equal(density.measures[0].peak, 0, '빈 마디는 0')
  assert.deepEqual(density.seconds.map(b => b.peak), [0, 0, 4, 3, 1], '시간 버킷별 순간 최대')
  // 전체 최댓값은 통계 패널의 최대 NPS 와 같은 정의여야 눈금이 통한다
  assert.equal(Math.max(...density.measures.map(b => b.peak)), density.peakNps, '전체 최댓값 일치')
}

// ── 키 모드 판정 ──────────────────────────────────────────────────────────
{
  const dp = run('#BPM 120\n#00111:01\n#00118:01\n#00121:01\n#00126:01').lanes
  assert.equal(dp.mode, '14K')
  assert.deepEqual(dp.scratchCols, [14, 15])
  assert.deepEqual(dp.notes.map(n => n.col).sort((a, b) => a - b), [0, 5, 7, 15],
    '1P 6키=5, 2P 1키=7, 2P 스크래치=15')

  const pms = run('#BPM 120\n#00111:01\n#00122:01', 'x.pms').lanes
  assert.equal(pms.mode, '9K')
  assert.deepEqual(pms.scratchCols, [])
  assert.deepEqual(pms.notes.map(n => n.col).sort((a, b) => a - b), [0, 5], 'PMS 2P 22번 = 버튼 6 = col 5')

  // 확장자가 .bms 라도 채널 서명으로 PMS 를 잡아낸다
  assert.equal(run('#BPM 120\n#00111:01\n#00122:01').lanes.mode, '9K')

  // 5K/10K 는 7K/14K 템플릿을 타고 6·7키 레인만 비운다 (bmspc 와 같은 규칙)
  const five = run('#BPM 120\n#00111:01\n#00115:01\n#00116:01').lanes
  assert.equal(five.mode, '5K')
  assert.equal(five.keyCols, 7)
  assert.deepEqual(five.scratchCols, [7])

  const ten = run('#BPM 120\n#00111:01\n#00115:01\n#00116:01\n#00121:01\n#00126:01').lanes
  assert.equal(ten.mode, '10K')
  assert.equal(ten.keyCols, 14)

  // 화면 배치 — 재생기 · 전체 보기 · 레인별 분포가 공유한다.
  assert.deepEqual(laneOrder(five), [7, 0, 1, 2, 3, 4, 5, 6], 'SP 는 스크래치가 왼쪽 끝')
  assert.deepEqual(laneOrder(dp).at(-1), 15, 'DP 는 2P 스크래치가 오른쪽 끝')
  assert.deepEqual(laneOrder(pms), [0, 1, 2, 3, 4, 5, 6, 7, 8])

  // 1P/2P 구분선 위치. DP 는 2P 건반이 col 7 부터 — 레인 배치가 바뀌면 선이 엉뚱한 데 그어진다.
  const gd = laneGeom(dp)
  assert.equal(gd.splitX, gd.geom.get(7).x)
  assert.equal(gd.splitX, gd.geom.get(0).x + 7 * 7, '스크래치 하나 + 1P 건반 7개 뒤')
  assert.equal(laneGeom(five).splitX, null, 'SP 는 구분선 없음')
  assert.equal(laneGeom(pms).splitX, null, 'PMS 는 구분선 없음')

  // 라벨은 DP 양쪽 다 1…7, PMS 는 1…9
  assert.deepEqual(laneOrder(dp).map(c => laneLabel(c, dp)),
    ['S', 1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7, 'S'])
  assert.deepEqual(laneOrder(pms).map(c => laneLabel(c, pms)), [1, 2, 3, 4, 5, 6, 7, 8, 9])

  // 재생 레인 지정 — 스크래치·5K의 빈 6/7키는 그대로, DP 양쪽은 독립 지정.
  assert.equal(laneSpec(five), '12345')
  const sample = [0, 1, 4, 5, 7].map(col => ({ time: 0, col }))
  assert.deepEqual(remapLanes(sample, five, '54321').map(n => n.col), [0, 3, 4, 5, 7])
  assert.equal(laneSpec(dp), '1234567/1234567')
  assert.deepEqual(remapLanes([{ time: 0, col: 0 }, { time: 0, col: 7 }], dp, '2345671/7654321').map(n => n.col), [6, 13])
  assert.throws(() => remapLanes(sample, five, '11234'), /각각 한 번/)
  const random = Math.random
  Math.random = () => 0
  assert.equal(randomLaneSpec(five), '23451', 'Fisher–Yates 레인 랜덤')
  Math.random = random
}

// ── 마디 길이 배율이 박·시간에 반영되는가 ───────────────────────────────────
{
  const { stats } = run('#BPM 120\n#00102:0.5\n#00211:01')
  // 마디1 이 0.5배(2박) → 마디2 는 6박에서 시작 → 3초
  assert.ok(Math.abs(stats.density.measures[2].startTime - 3) < 1e-9,
    `마디 배율 0.5 → 마디2 시작 3s (${stats.density.measures[2].startTime})`)
}

// ── features: trillRatio (bmspc features.py 의 self-check 이식) ────────────
{
  assert.equal(trillRatio([0, 6, 0, 6, 0, 6, 0, 6]), 1.0, '순수 A-B-A-B 트릴')
  assert.equal(trillRatio([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1]), 0, '지그재그 계단은 트릴이 아니다')
  assert.equal(trillRatio([0, 1, 2, 3, 4, 5, 6]), 0, '상행 계단')
  assert.equal(trillRatio([0, 6, 0, 1, 2, 3, 4, 5]), 0, '고립된 일치(run 1)는 거부')
  assert.equal(trillRatio([0, 6, 0, 6, 1, 2, 3, 4]), 0.5, '4노트 ABAB(run 2) → 4/8')
  assert.equal(trillRatio([0, 6, 0, 6, 0, 6, 1, 2, 3]), 6 / 9, '6노트 트릴 후 중단 → 6/9')
}

// ── features: 손으로 검산 가능한 윈도우 두 개 ───────────────────────────────
// 파이썬 원본과는 별도로 대조 검증했다(7K/DP/PMS 합성 채보, 16개 피처 전부 오차 1e-11 이내).
// 여기서는 그 구현이 조용히 어긋나는 걸 잡는 회귀 고정만 한다.
{
  const FEAT = [
    '#BPM 120',
    '#00111:0100010001000100', // 마디1: 8분 트릴 (0↔1 컬럼)
    '#00112:0001000100010001',
    '#00211:01010101',         // 마디2: 4분 3동시치기
    '#00212:01010101',
    '#00213:01010101',
  ].join('\n')
  const { parsed, lanes } = run(FEAT)
  const wf = extract(lanes, parsed.timing)
  assert.deepEqual(wf.names, FEATURE_NAMES)
  assert.equal(wf.X.length, 22, '2박 윈도우 · 0.5박 홉 · 총 12박')

  const at = b => wf.X[wf.beat0.indexOf(b)]
  const get = (row, name) => row[FEATURE_NAMES.indexOf(name)]
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} ≠ ${b}`)

  // 4~6박 = 8분 트릴 4노트, 120BPM 이므로 창 길이 1.0초
  const trill = at(4)
  near(get(trill, 'nps'), 4, 'nps')
  near(get(trill, 'mean_simul'), 1, 'mean_simul')
  near(get(trill, 'peak_nps'), 4, 'peak_nps')
  near(get(trill, 'ioi_cv'), 0, '등간격이므로 ioi_cv 0')
  near(get(trill, 'trill_ratio'), 1, 'trill_ratio')
  near(get(trill, 'jack_ratio'), 0, '교대는 잭이 아니다')
  near(get(trill, 'stair_ratio'), 0, '2컬럼 왕복은 계단이 아니다')
  near(get(trill, 'j2_jaccard'), 1, 'lag-2 완전 일치 = 2주기')
  near(get(trill, 'span_overlap'), 0, '단타끼리는 폭이 안 겹친다')
  near(get(trill, 'snap_entropy'), 1, '4분·8분 절반씩 → 1비트')
  near(get(trill, 'eff_bpm'), 120, 'eff_bpm')

  // 8~10박 = 4분 3동시치기 2행
  const chord = at(8)
  near(get(chord, 'nps'), 6, 'nps')
  near(get(chord, 'mean_simul'), 3, 'mean_simul')
  near(get(chord, 'jack_ratio'), 0.5, '같은 3컬럼 반복 → 공유 3 / 노트 6')
  near(get(chord, 'trill_ratio'), 0, '단타 행이 없다')
}

// ── tagger (bmspc tagger.py 의 self-check 이식) ─────────────────────────────
{
  const base = { nps: 10.0 } // rest 게이트를 통과하는 밀도
  const has = (t, f) => classify({ ...base, ...f }).includes(t)

  assert.ok(has('soflan', { bpm_off_main: 0.20 }), '커버리지 0.20 이면 발동')
  assert.ok(!has('soflan', { bpm_off_main: 0.10 }), '커버리지 0.10(순간 변동)은 발동하면 안 됨')
  assert.ok(has('soflan', { stop_time_frac: 0.10 }), 'STOP 채널로도 발동')
  assert.ok(!has('soflan', {}), 'BPM 일정하면 깨끗해야 함')
  // 성긴 구간의 템포 기믹은 soflan 이지 rest 로 삼켜지면 안 된다
  assert.deepEqual(classify({ nps: 1.0, bpm_off_main: 0.20 }), ['soflan'])
  assert.deepEqual(classify({ nps: 1.0 }), ['rest'])
  assert.ok(has('scratch', { scratch_nps: 6.0 }), '초당 6회 스크래치는 발동')
  assert.ok(!has('scratch', { scratch_nps: 2.0 }), '느린 백비트(2회)는 발동하면 안 됨')
  assert.ok(has('trill', { trill_ratio: 0.2 }), '희석됐어도 진짜 트릴은 발동')
  assert.ok(!has('trill', { trill_ratio: 0.05 }), '거의 0(스트림/계단 바닥)은 발동하면 안 됨')
}

// ── segment: 밀도로는 자르고, 패턴 형태로는 자르지 않는다 ────────────────────
{
  const names = [...SEG_FEATURES, 'jack_ratio', 'trill_ratio', 'stair_ratio']
  const n = 40
  const step = (col, lo, hi) => ({
    names,
    beat0: [...Array(n).keys()], beat1: [], t0: [], t1: [],
    X: [...Array(n).keys()].map(i =>
      names.map(name => (name === col ? (i < n / 2 ? lo : hi) : 0))),
  })
  // pen_mult 는 고정값을 쓴다: 구간 수 튜닝이 아니라 분할 로직을 보는 테스트라서
  const dense = boundaries(step('nps', 2.0, 20.0), 1.0)
  assert.ok(dense.some(b => Math.abs(b - n / 2) <= 2), `밀도 스텝을 놓쳤다: ${dense}`)
  assert.deepEqual(boundaries(step('jack_ratio', 0.0, 1.0), 1.0), [],
    '패턴 형태만 바뀐 건 텍스처 경계가 아니다')
}

// ── 전 파이프라인 회귀 고정 (bmspc 와 대조 검증한 결과) ─────────────────────
// 경계 · 구간 · 시각 · 태그 전부 파이썬 원본과 일치하는 것을 확인한 뒤 그 값을 박아 둔다.
{
  // 텍스처 세그멘테이션만 (세분화 이전)
  const texture = {
    'sp7k.bms': ['soflan', 'stair+soflan', 'jack+chord', 'jack+chord+soflan',
      'stream', 'jack+chord+soflan', 'jack+chord'],
    'dp14k.bms': ['soflan', 'chord+soflan+stream', 'chord+stream', 'chord+stream', 'chord+stream'],
    'pms9k.pms': ['rest', 'stair', 'stair+trill+soflan', 'stair+soflan'],
  }
  // 기본 동작 = bmspc --fine. 텍스처 경계는 전부 살아남고 태그 변화 지점이 더해진다.
  const fine = {
    'sp7k.bms': ['soflan', 'stair+soflan', 'jack+chord', 'jack+chord+long', 'jack+chord',
      'jack+chord+long', 'jack+chord', 'jack+chord+long', 'jack+chord', 'jack+chord+long+soflan',
      'jack+chord+soflan', 'soflan', 'stream', 'jack+chord+soflan', 'jack+chord'],
    'pms9k.pms': ['rest', 'stair', 'stair+long', 'stair', 'stair', 'stair+trill', 'stair',
      'stair+long', 'stair+trill+soflan', 'stair+soflan', 'stair+long+soflan', 'stair+soflan',
      'stair+long+soflan'],
  }
  // bmspc CLI 텍스트 출력과 같은 마디 토큰 (`마디` 또는 `마디:박`)
  const pmsRanges = ['0-0:2.5', '0:2.5-8:3', '8:3-16:3.5', '16:3.5-25']

  for (const [file, tags] of Object.entries(texture)) {
    const parsed = parse(readFileSync(new URL(`fixtures/${file}`, import.meta.url), 'utf8'), { name: file })
    const lanes = toLanes(parsed)
    const wf = extract(lanes, parsed.timing)
    const raw = segments(wf)
    const segs = tagSegments(wf, raw)
    assert.deepEqual(segs.map(s => s.tags.join('+')), tags, `${file} 텍스처 구간 태그`)

    if (fine[file]) {
      const refined = refine(wf, raw)
      assert.deepEqual(tagSegments(wf, refined).map(s => s.tags.join('+')), fine[file], `${file} fine 구간 태그`)
      // 텍스처 경계는 세분화 후에도 전부 살아남아야 한다
      const edges = new Set(refined.flat())
      for (const [a, b] of raw)
        assert.ok(edges.has(a) && edges.has(b), `${file} 텍스처 경계 ${a}-${b} 가 사라졌다`)
    }

    if (file === 'pms9k.pms')
      assert.deepEqual(
        segs.map(s => `${measureToken(s.beat0, lanes.measureStarts)}-${measureToken(s.beat1, lanes.measureStarts)}`),
        pmsRanges, '마디 토큰')
    // 구간은 시간순으로 이어지고, 끝 시각이 다음 시작을 넘지 않아야 한다
    segs.forEach((s, i) => {
      assert.ok(s.t1 > s.t0, `${file} 구간 ${i} 길이`)
      if (i) assert.ok(s.t0 >= segs[i - 1].t1 - 1e-9, `${file} 구간 ${i} 겹침`)
    })
  }
}

// ── 레이더 6축 ────────────────────────────────────────────────────────────
{
  // 각 축이 '그 성질만 있는' 채보에서 켜지고 다른 축에서는 꺼지는지 본다.
  const axesOf = text => {
    const { parsed, lanes } = run(text)
    return Object.fromEntries(radar(extract(lanes, parsed.timing)).map(a => [a.key, a.value]))
  }
  const measures = (n, ch, data) =>
    Array.from({ length: n }, (_, i) => `#${String(i + 1).padStart(3, '0')}${ch}:${data}`).join('\n')

  const singles = axesOf('#BPM 150\n' + measures(16, '11', '01'.repeat(8)))
  assert.ok(singles.DENSITY > 0, '단타만 있어도 밀도는 잡힌다')
  assert.equal(singles.CHORD, 0, '단타만 = 동시치기 0')
  assert.equal(singles.SCRATCH, 0)
  assert.equal(singles.LN, 0)
  assert.equal(singles.SOFLAN, 0, 'BPM 일정하면 소플란 0')

  // 같은 노트 수를 3동시로 치면 동시치기 축만 오른다
  const chords = axesOf('#BPM 150\n' + [11, 12, 13].map(c => measures(16, c, '01'.repeat(8))).join('\n'))
  assert.ok(chords.CHORD > 0, '3동시 → 동시치기 축')
  assert.ok(chords.CHORD > singles.CHORD)
  assert.equal(chords.SCRATCH, 0, '동시치기가 스크래치 축을 오염시키지 않는다')

  const scratch = axesOf('#BPM 150\n' + measures(16, '16', '01'.repeat(8)))
  assert.ok(scratch.SCRATCH > 0, '스크래치 축')
  assert.equal(scratch.CHORD, 0, '스크래치는 건반 동시치기에 안 들어간다')

  // 빈 윈도우가 평균을 누르지 않아야 한다 — 앞뒤에 빈 마디를 붙여도 밀도가 유지된다
  const padded = axesOf('#BPM 150\n#00011:00\n' +
    Array.from({ length: 16 }, (_, i) => `#${String(i + 9).padStart(3, '0')}11:${'01'.repeat(8)}`).join('\n'))
  assert.ok(Math.abs(padded.DENSITY - singles.DENSITY) < 1, '빈 구간은 평균에서 제외')

  assert.deepEqual(radar(extract(run('#BPM 150').lanes, run('#BPM 150').parsed.timing)).map(a => a.value),
    RADAR_AXES.map(() => 0), '노트 없는 채보는 전 축 0')
}

// ── player: 룩어헤드 스케줄 · A–B 반복 · 배속 ──────────────────────────────
// Web Audio 를 최소한으로 흉내내고 setInterval 을 가로채 시간을 직접 굴린다.
// 스케줄러는 타이밍이 조용히 어긋나는 종류라 눈으로는 못 잡는다.
{
  const realInterval = globalThis.setInterval
  const realClear = globalThis.clearInterval
  let clock = 0, fired = [], tick = null

  globalThis.AudioContext = class {
    get currentTime() { return clock }
    sampleRate = 48000
    destination = {}
    createBuffer(_c, n) { return { getChannelData: () => new Float32Array(n) } }
    resume() {}
  }
  globalThis.DynamicsCompressorNode = class { connect() {} }
  globalThis.AudioBufferSourceNode = class {
    playbackRate = {}
    connect() {}
    start(t) { fired.push(+t.toFixed(6)) }
  }
  globalThis.setInterval = fn => { tick = fn; return 1 }
  globalThis.clearInterval = () => { tick = null }

  const advance = to => { clock = to; tick?.() }
  const player = createPlayer()
  const notes = [0, 0.5, 1, 1.5, 2, 2.5].map((time, i) => ({ time, col: i % 7 }))
  player.load({ notes, keyCols: 7, scratchCols: [7], duration: 3 })

  // 룩어헤드는 0.3초. 한 번에 전부 스케줄하면 안 된다 (시크·배속이 노드 수천 개 stop 이 된다)
  player.play(0)
  assert.deepEqual(fired, [0], '처음엔 0.3초 안의 노트만')
  advance(0.5)
  assert.deepEqual(fired, [0, 0.5], '창이 밀리며 다음 노트가 붙는다')
  assert.equal(player.now(), 0.5)

  // 스크래치는 낮은 음, 건반은 올라가는 음 — 눈 안 보고도 레인이 들린다
  player.stop()
  fired = []
  const scr = createPlayer()
  scr.load({ notes: [{ time: 0, col: 7 }], keyCols: 7, scratchCols: [7], duration: 1 })
  clock = 0; scr.play(0)
  assert.ok(scr.playing(), '스크래치만 있어도 재생된다')

  // A–B 반복: b 를 넘으면 a 로 되감고 거기서부터 다시 스케줄
  fired = []
  clock = 0
  player.setRange({ a: 1, b: 2 })
  assert.equal(player.now(), 1, '구간을 지정하면 그 앞으로 당겨진다')
  player.play()
  assert.deepEqual(fired, [0], '1.0초 노트를 0초 시점에 스케줄 (t0 = 0 - 1)')
  fired = []
  advance(1.2) // 채보 시각 2.2 → b(2.0) 초과
  assert.ok(player.now() >= 1 && player.now() < 2, `되감겨 구간 안: ${player.now()}`)
  assert.ok(fired.length, '되감은 뒤 다시 스케줄한다')

  // 반복을 끄면 구간 끝에서 멈춘다
  player.setLoop(false)
  player.play(1)
  advance(clock + 1.5)
  assert.ok(!player.playing(), '반복 off 면 구간 끝에서 정지')

  // 배속: 채보 시각이 그만큼 빨리 흐르고, 바꿔도 현재 위치는 유지
  player.setLoop(true)
  player.setRange(null)
  player.seek(0)
  clock = 10
  player.play(0)
  advance(10.5)
  assert.equal(player.now(), 0.5, '1배속')
  player.setRate(2)
  assert.equal(player.now(), 0.5, '배속을 바꿔도 그 자리')
  advance(clock + 0.5)
  assert.equal(player.now(), 1.5, '2배속이면 실시간 0.5초에 채보 1.0초')

  player.stop()
  globalThis.setInterval = realInterval
  globalThis.clearInterval = realClear
}

// ── 인코딩 ────────────────────────────────────────────────────────────────
{
  assert.equal(decode(new TextEncoder().encode('#TITLE 한글')).encoding, 'utf-8')
  // Shift_JIS 로 인코딩된 '#TITLE テスト' → UTF-8 로는 깨지므로 재시도해야 한다
  const sjis = Uint8Array.from([0x23, 0x54, 0x49, 0x54, 0x4c, 0x45, 0x20, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67])
  const d = decode(sjis)
  assert.equal(d.encoding, 'shift-jis')
  assert.equal(d.text, '#TITLE テスト')
}

// ── 형식 거부 ────────────────────────────────────────────────────────────────
{
  assert.throws(() => parse('#BPM 120\n#00111:01', { name: 'song.mp3' }), /지원하지 않습니다/)
  assert.throws(() => parse('\x00\xff\xd8just binary junk', { name: 'x.bms' }), /BMS 형식이 아닙니다/)
  assert.doesNotThrow(() => parse('#BPM 150', { name: 'x.pms' }), '헤더만 있어도 BMS 는 BMS')
}

// ── #RANDOM 분기 ─────────────────────────────────────────────────────────────
{
  const text = '#BPM 120\n#RANDOM 2\n#IF 1\n#00111:01\n#ENDIF\n#IF 2\n#00112:01\n#ENDIF'
  const one = toLanes(parse(text, { name: 'x.bms', random: 1 }))
  const two = toLanes(parse(text, { name: 'x.bms', random: 2 }))
  assert.deepEqual(one.notes.map(n => n.col), [0], '1번 분기')
  assert.deepEqual(two.notes.map(n => n.col), [1], '2번 분기')
  assert.equal(parse(text, { random: 99 }).randomChoice, 2, '범위 밖 선택은 마지막 분기로 제한')
}

console.log('ok — 레인 매핑 · 시간축 · 마디 집계 · 윈도우 피처 · PELT 구간 · 태거 · 레이더 · 재생기 · 인코딩')

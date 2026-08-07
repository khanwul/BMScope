import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHandler, parseBmsIrPopular, parseBmsIrSong, summarizeLr2Archive, summarizeMinIr } from '../server.js'
import { collectCharts, highest7KGroups } from '../scripts/import-chart.js'
import { createPool } from '../db.js'

const chart = Buffer.from('#TITLE DB Demo\n#BPM 120\n#00111:01')
let searchParams
const pool = {
  async query(sql, params) {
    if (sql.includes('id::text')) {
      searchParams = params
      return { rows: [{ id: '1', filename: 'db.bms', title: 'DB Demo', artist: '' }] }
    }
    assert.deepEqual(params, ['1'])
    return { rows: [{ content: chart }] }
  },
}
const handler = createHandler(pool)
const requestWith = (activeHandler, url, method = 'GET') => new Promise(resolve => {
  const response = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
      this.headersSent = true
    },
    end(body) {
      if (body) response.body = Buffer.from(body)
      resolve(response)
    },
  }
  activeHandler({ url, method }, res)
})
const request = (url, method) => requestWith(handler, url, method)

const list = await request('/api/charts')
assert.deepEqual(JSON.parse(list.body), [{ id: '1', filename: 'db.bms', title: 'DB Demo', artist: '' }])
await request('/api/charts?q=demo')
assert.deepEqual(searchParams, ['%demo%'])

const file = await request('/api/charts/1')
assert.deepEqual(file.body, chart)

assert.equal((await request('/api/charts/0')).status, 404)
assert.equal((await request('/server.js')).status, 404, '서버 소스가 정적 공개되면 안 된다')

const fixtures = await collectCharts(fileURLToPath(new URL('fixtures', import.meta.url)))
assert.deepEqual(fixtures.map(file => file.name), ['dp14k.bms', 'pms9k.pms', 'sp7k.bms'])
const highest = await highest7KGroups(fixtures)
assert.deepEqual(highest.flat().map(file => file.name), ['sp7k.bms'])
const renderPool = createPool('postgresql://user:pass@example.render.com/db')
assert.match(renderPool.options.connectionString, /sslmode=verify-full/)
await renderPool.end()

const songHtml = `
  <p>ranking_key: abc</p><p><a class="tag" title="Stella" href="#">st4</a></p>
  <div class="panel song-section-tags"></div>
  <div class="stat"><span>プレイ人数</span><b>20</b></div>
  <div class="stat"><span>平均スコア率</span><b>87.50%</b></div>
  <span class="lamp-ratio-item"><b>HARD</b> 60.0% <span>12/20</span></span>
  <span class="score-option">乱/難1P 1234567<span>seed 42</span></span>`
assert.deepEqual(parseBmsIrSong(songHtml), {
  found: true,
  stats: { players: '20', averageScore: '87.50%' },
  lamps: [{ lamp: 'HARD', percent: 60, count: 12, total: 20 }],
  levels: ['st4'],
  topOption: '乱/難1P 1234567 seed 42',
})

const popularHtml = `週間人気ランキング<table>
  <tr><td>1</td><td><a href="/new/song?songmd5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&view=new">A &amp; B</a><div>x</div></td><td>Artist</td><td class="score-main">12</td><td>34</td></tr>
</table>`
assert.deepEqual(parseBmsIrPopular(popularHtml), [{
  rank: 1, md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'A & B', artist: 'Artist', players: 12, plays: 34,
}])

const minirRows = [
  { userid: 'a', score: 180, notes: 100, combo: 90, clear: 6, epg: 10, egr: 5, lpg: 4, lgr: 1 },
  { userid: 'b', score: 120, notes: 100, combo: 70, clear: 4, epg: 5, egr: 0, lpg: 10, lgr: 0 },
  { userid: 'variant', score: 190, notes: 99, combo: 99, clear: 8 },
]
const minirSummary = summarizeMinIr(minirRows)
assert.equal(minirSummary.players, 2)
assert.equal(minirSummary.maxEx, 200)
assert.equal(minirSummary.average, 75)
assert.equal(minirSummary.topEx, 180)
assert.deepEqual(minirSummary.lamps, { HARD: 1, EASY: 1 })

const archiveData = {
  chart: { title: 'Old', level: '★1', play_people: 20, play_count: 30, clear_people: 15 },
  leaderboard: [
    { is_cheated: 1, score: 200, score_max: 200, player_name: 'bad' },
    { is_cheated: 0, score: 190, score_max: 200, player_name: 'good' },
  ],
}
assert.deepEqual(summarizeLr2Archive(archiveData), {
  title: 'Old', level: '★1', players: 20, plays: 30, clearPlayers: 15,
  topEx: 190, maxEx: 200, topPlayer: 'good',
})

const irCalls = []
const irHandler = createHandler(null, undefined, async (url, options) => {
  irCalls.push({ url, options })
  if (url.includes('getSongScores')) return { ok: true, json: async () => minirRows }
  if (url.includes('lr2ir.com/api')) return { ok: true, json: async () => archiveData }
  return { ok: true, text: async () => url.includes('/new/song?') ? songHtml : popularHtml }
})
const sha256 = 'c'.repeat(64)
const irResponse = await requestWith(irHandler, `/api/ir/${'b'.repeat(32)}?sha256=${sha256}&client=lr2oraja`)
assert.equal(irResponse.status, 200, 'DB 없이도 IR 해시 조회는 동작해야 한다')
assert.equal(JSON.parse(irResponse.body).song.stats.players, '20')
assert.equal(JSON.parse(irResponse.body).client, 'lr2oraja')
assert.equal(JSON.parse(irResponse.body).minir.topEx, 180)
assert.equal(JSON.parse(irResponse.body).archive.topPlayer, 'good')
assert.ok(irCalls.some(x => x.url.includes('client_view=lr2oraja')))
assert.ok(irCalls.some(x => x.options.headers.songhash === sha256))
assert.equal((await requestWith(irHandler, `/api/ir/${'b'.repeat(32)}?client=nope`)).status, 400)
assert.equal((await requestWith(irHandler, `/api/ir/${'b'.repeat(32)}?sha256=nope`)).status, 400)

console.log('ok — 저장 채보 API (목록 · 원문 · 경로 제한 · 최고난도 7K 선별)')

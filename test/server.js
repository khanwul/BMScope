import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHandler, parseBmsIrPopular, parseBmsIrSong } from '../server.js'
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

const irHandler = createHandler(null, undefined, async url => ({
  ok: true,
  text: async () => url.includes('/new/song?') ? songHtml : popularHtml,
}))
const irResponse = await requestWith(irHandler, '/api/ir/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
assert.equal(irResponse.status, 200, 'DB 없이도 IR 해시 조회는 동작해야 한다')
assert.equal(JSON.parse(irResponse.body).song.stats.players, '20')

console.log('ok — 저장 채보 API (목록 · 원문 · 경로 제한 · 최고난도 7K 선별)')

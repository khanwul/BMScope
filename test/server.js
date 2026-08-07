import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../server.js'
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
const request = (url, method = 'GET') => new Promise(resolve => {
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
  handler({ url, method }, res)
})

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

console.log('ok — 저장 채보 API (목록 · 원문 · 경로 제한 · 최고난도 7K 선별)')

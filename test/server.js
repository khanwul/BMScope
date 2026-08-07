import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../server.js'
import { collectCharts } from '../scripts/import-chart.js'

const chart = Buffer.from('#TITLE DB Demo\n#BPM 120\n#00111:01')
const pool = {
  async query(sql, params) {
    if (sql.includes('id::text')) return { rows: [{ id: '1', filename: 'db.bms', title: 'DB Demo', artist: '' }] }
    assert.deepEqual(params, ['1'])
    return { rows: [{ filename: 'db.bms', content: chart }] }
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

const file = await request('/api/charts/1')
assert.deepEqual(file.body, chart)

assert.equal((await request('/api/charts/0')).status, 404)
assert.equal((await request('/server.js')).status, 404, '서버 소스가 정적 공개되면 안 된다')

const fixtures = await collectCharts(fileURLToPath(new URL('fixtures', import.meta.url)))
assert.deepEqual(fixtures.map(file => file.name), ['dp14k.bms', 'pms9k.pms', 'sp7k.bms'])

console.log('ok — 저장 채보 API (목록 · 원문 · 경로 제한 · 폴더 수집)')

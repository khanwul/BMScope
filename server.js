import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPool, initDb } from './db.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length })
  res.end(data)
}
const json = (res, status, value) => send(res, status, JSON.stringify(value))

function publicFile(root, pathname) {
  if (pathname === '/') return join(root, 'index.html')
  let file
  try { file = resolve(root, '.' + decodeURIComponent(pathname)) } catch { return null }
  const publicRoots = [join(root, 'css'), join(root, 'js')]
  return publicRoots.some(dir => file.startsWith(dir + sep)) ? file : null
}

async function handle(req, res, pool, root) {
  const { pathname } = new URL(req.url, 'http://localhost')

  if (req.method === 'GET' && pathname === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8')

  if (pathname.startsWith('/api/') && !pool)
    return json(res, 503, { error: 'DATABASE_URL이 설정되지 않았습니다' })

  if (req.method === 'GET' && pathname === '/api/charts') {
    const { rows } = await pool.query(
      `SELECT id::text, filename, title, artist
       FROM charts ORDER BY COALESCE(NULLIF(title, ''), filename), filename`,
    )
    return json(res, 200, rows)
  }

  const match = req.method === 'GET' && pathname.match(/^\/api\/charts\/([1-9]\d*)$/)
  if (match) {
    const { rows } = await pool.query('SELECT filename, content FROM charts WHERE id = $1', [match[1]])
    if (!rows.length) return json(res, 404, { error: '채보를 찾을 수 없습니다' })
    return send(res, 200, rows[0].content, 'application/octet-stream')
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' })
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')

  const file = publicFile(root, pathname)
  if (!file) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8')
  try {
    const data = await readFile(file)
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': data.length })
      return res.end()
    }
    return send(res, 200, data, TYPES[extname(file)] || 'application/octet-stream')
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not Found', 'text/plain; charset=utf-8')
    throw error
  }
}

export function createHandler(pool, root = ROOT) {
  return (req, res) => handle(req, res, pool, root).catch(error => {
    console.error(error)
    if (!res.headersSent) json(res, 500, { error: '서버 오류가 발생했습니다' })
    else res.end()
  })
}

export async function start() {
  const pool = createPool()
  if (pool) await initDb(pool)
  const port = Number(process.env.PORT) || 10000
  createServer(createHandler(pool)).listen(port, '0.0.0.0', () =>
    console.log(`BMScope listening on 0.0.0.0:${port}${pool ? '' : ' (DB disabled)'}`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  start().catch(error => { console.error(error); process.exitCode = 1 })

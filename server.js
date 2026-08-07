import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPool, SCHEMA } from './db.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length })
  res.end(data)
}
const json = (res, status, value) => send(res, status, JSON.stringify(value))

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
const textOnly = html => html
  .replace(/<[^>]*>/g, '')
  .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (_, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? `&${key};`
    const hex = key[1]?.toLowerCase() === 'x'
    const code = parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : `&${key};`
  })
  .trim()

/** BMS-IR은 점수 read API가 없어 공개 곡 페이지의 요약 블록만 읽는다. */
export function parseBmsIrSong(html) {
  const labels = {
    'プレイ人数': 'players', '総プレイ回数': 'plays', '平均プレイ回数': 'averagePlays',
    'クリア人数': 'clears', '平均スコア率': 'averageScore', 'トップEX': 'topEx', '最小BP': 'minBp',
  }
  const stats = {}
  for (const m of html.matchAll(/<div class="stat"><span>([^<]+)<\/span><b>([^<]*)<\/b><\/div>/g)) {
    const key = labels[textOnly(m[1])]
    if (key) stats[key] = textOnly(m[2])
  }
  const lamps = [...html.matchAll(/class="lamp-ratio-item"[^>]*>.*?<b>([^<]+)<\/b>\s*([\d.]+)%.*?([\d,]+)\/([\d,]+)/gs)]
    .map(m => ({ lamp: textOnly(m[1]), percent: +m[2], count: +m[3].replace(/,/g, ''), total: +m[4].replace(/,/g, '') }))
  const tagsHtml = html.split('<div class="panel song-section-tags">')[0]
  const levels = [...tagsHtml.matchAll(/<a class="tag"[^>]*title="[^"]*"[^>]*>(.*?)<\/a>/gs)].map(m => textOnly(m[1]))
  const option = html.match(/class="score-option">(.*?)<span>(.*?)<\/span>/s)
  return {
    found: /ranking_key:/.test(html) && !/曲が見つかりません|譜面が見つかりません/.test(html), stats, lamps, levels,
    topOption: option ? `${textOnly(option[1])} ${textOnly(option[2])}`.trim() : null,
  }
}

export function parseBmsIrPopular(html) {
  const block = html.split('週間人気ランキング')[1]?.split('</table>')[0] || ''
  return [...block.matchAll(/<tr><td>(\d+)<\/td><td><a href="\/new\/song\?songmd5=([\da-f]{32})[^\"]*">(.*?)<\/a>.*?<\/td><td>(.*?)<\/td><td class="score-main">([\d,]+)<\/td><td>([\d,]+)<\/td>/gs)]
    .map(m => ({ rank: +m[1], md5: m[2], title: textOnly(m[3]), artist: textOnly(m[4]), players: +m[5].replace(/,/g, ''), plays: +m[6].replace(/,/g, '') }))
}

const irCache = new Map()
async function cached(key, load) {
  const hit = irCache.get(key)
  if (hit && Date.now() - hit.time < 10 * 60_000) return hit.value
  const value = await load()
  if (irCache.size >= 200) irCache.delete(irCache.keys().next().value)
  irCache.set(key, { time: Date.now(), value })
  return value
}

async function fetchText(fetcher, url) {
  const response = await fetcher(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'BMScope/1.0 (+https://github.com/khanwul/BMScope)' },
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) throw new Error(`BMS-IR HTTP ${response.status}`)
  return response.text()
}

function publicFile(root, pathname) {
  if (pathname === '/') return join(root, 'index.html')
  let file
  try { file = resolve(root, '.' + decodeURIComponent(pathname)) } catch { return null }
  const publicRoots = [join(root, 'css'), join(root, 'js')]
  return publicRoots.some(dir => file.startsWith(dir + sep)) ? file : null
}

async function handle(req, res, pool, root, fetcher) {
  const url = new URL(req.url, 'http://localhost')
  const { pathname } = url

  if (req.method === 'GET' && pathname === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8')

  const ir = req.method === 'GET' && pathname.match(/^\/api\/ir\/([\da-f]{32})$/i)
  if (ir) {
    const md5 = ir[1].toLowerCase()
    const [song, popular] = await Promise.allSettled([
      cached(`song:${md5}`, async () => parseBmsIrSong(await fetchText(fetcher, `https://bms-ir.org/new/song?songmd5=${md5}&client_view=lr2`))),
      cached('popular', async () => parseBmsIrPopular(await fetchText(fetcher, 'https://bms-ir.org/'))),
    ])
    if (song.status === 'rejected' && popular.status === 'rejected')
      return json(res, 502, { error: 'BMS-IR을 불러오지 못했습니다' })
    return json(res, 200, {
      song: song.status === 'fulfilled' ? song.value : null,
      popular: popular.status === 'fulfilled' ? popular.value : [],
    })
  }

  if (pathname.startsWith('/api/') && !pool)
    return json(res, 503, { error: 'DATABASE_URL이 설정되지 않았습니다' })

  if (req.method === 'GET' && pathname === '/api/charts') {
    const search = url.searchParams.get('q')
    const { rows } = await pool.query(
      `SELECT id::text, filename, title, artist
       FROM charts
       ${search === null ? '' : "WHERE concat_ws(' ', filename, title, artist) ILIKE $1"}
       ORDER BY COALESCE(NULLIF(title, ''), filename), filename
       ${search === null ? '' : 'LIMIT 20'}`,
      search === null ? [] : [`%${search}%`],
    )
    return json(res, 200, rows)
  }

  const match = req.method === 'GET' && pathname.match(/^\/api\/charts\/([1-9]\d*)$/)
  if (match) {
    const { rows } = await pool.query('SELECT content FROM charts WHERE id = $1', [match[1]])
    if (!rows.length) return json(res, 404, { error: '채보를 찾을 수 없습니다' })
    return send(res, 200, rows[0].content, 'application/octet-stream')
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' })
  if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')

  const file = publicFile(root, pathname)
  if (!file) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8')
  try {
    const data = await readFile(file)
    return send(res, 200, data, TYPES[extname(file)] || 'application/octet-stream')
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not Found', 'text/plain; charset=utf-8')
    throw error
  }
}

export function createHandler(pool, root = ROOT, fetcher = fetch) {
  return (req, res) => handle(req, res, pool, root, fetcher).catch(error => {
    console.error(error)
    if (!res.headersSent) json(res, 500, { error: '서버 오류가 발생했습니다' })
    else res.end()
  })
}

async function start() {
  const pool = createPool()
  if (pool) await pool.query(SCHEMA)
  const port = Number(process.env.PORT) || 10000
  createServer(createHandler(pool)).listen(port, '0.0.0.0', () =>
    console.log(`BMScope listening on 0.0.0.0:${port}${pool ? '' : ' (DB disabled)'}`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  start().catch(error => { console.error(error); process.exitCode = 1 })

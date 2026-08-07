import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createPool, SCHEMA } from '../db.js'
import { loadFile } from '../js/load.js'

const EXT = /\.(bms|bme|bml|pms)$/i
const MAX_BYTES = 5 * 1024 * 1024

async function walk(dir, root, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, root, out)
    else if (entry.isFile() && EXT.test(entry.name))
      out.push({ path, name: relative(root, path).split(sep).join('/') })
  }
}

export async function collectCharts(input) {
  const path = resolve(input)
  const info = await stat(path)
  if (info.isFile()) {
    if (!EXT.test(path)) throw new Error('지원 확장자: .bms .bme .bml .pms')
    return [{ path, name: basename(path) }]
  }
  if (!info.isDirectory()) throw new Error('파일 또는 폴더가 아닙니다')
  const out = []
  await walk(path, path, out)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function importCharts(input) {
  if (!input) throw new Error('사용법: npm run import:chart -- <file-or-directory>')
  const pool = createPool()
  if (!pool) throw new Error('DATABASE_URL이 필요합니다')
  const charts = await collectCharts(input)
  let saved = 0
  let skipped = 0

  try {
    await pool.query(SCHEMA)
    // ponytail: 순차 import. 1회성 관리 작업이라 충분함 — 수천 건에서 느리면 동시성만 제한해 추가.
    for (const [i, chart] of charts.entries()) {
      try {
        const content = await readFile(chart.path)
        if (content.length > MAX_BYTES) throw new Error('5MB 초과')
        const parsed = await loadFile({
          name: chart.name,
          arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
        })
        await pool.query(
          `INSERT INTO charts (filename, title, artist, sha256, content) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (filename) DO UPDATE
           SET title = EXCLUDED.title, artist = EXCLUDED.artist, sha256 = EXCLUDED.sha256, content = EXCLUDED.content`,
          [chart.name, parsed.info.title || '', parsed.info.artist || '', parsed.hashes.sha256, content],
        )
        saved++
      } catch (error) {
        skipped++
        console.error(`${chart.name} — ${error.message || '저장 실패'}`)
      }
      if ((i + 1) % 50 === 0 || i + 1 === charts.length) console.log(`${i + 1}/${charts.length}`)
    }
  } finally {
    await pool.end()
  }
  console.log(`저장 ${saved}개 · 건너뜀 ${skipped}개`)
  return { saved, skipped }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  importCharts(process.argv[2])
    .then(({ skipped }) => { if (skipped) process.exitCode = 1 })
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}

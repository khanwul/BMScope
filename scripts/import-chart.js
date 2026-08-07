import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createPool, initDb } from '../db.js'
import { loadFile } from '../js/load.js'

const path = process.argv[2]
if (!path) throw new Error('사용법: npm run import:chart -- <file.bms>')

const content = await readFile(path)
if (content.length > 5 * 1024 * 1024) throw new Error('채보 파일은 5MB 이하여야 합니다')
const filename = basename(path)
const parsed = await loadFile({
  name: filename,
  arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
})
const pool = createPool()
if (!pool) throw new Error('DATABASE_URL이 필요합니다')

try {
  await initDb(pool)
  await pool.query(
    `INSERT INTO charts (filename, title, artist, content) VALUES ($1, $2, $3, $4)
     ON CONFLICT (filename) DO UPDATE
     SET title = EXCLUDED.title, artist = EXCLUDED.artist, content = EXCLUDED.content`,
    [filename, parsed.info.title || '', parsed.info.artist || '', content],
  )
  console.log(`${filename} 저장 완료`)
} finally {
  await pool.end()
}

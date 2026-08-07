import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createPool, initDb } from '../db.js'
import { loadFile } from '../js/load.js'
import { toLanes } from '../js/lanes.js'

const EXT = /\.(bms|bme|bml|pms)$/i

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

export async function highest7KGroups(charts) {
  const groups = new Map()
  let next = 0
  async function scan() {
    while (next < charts.length) {
      const i = next++
      const chart = charts[i]
      if ((i + 1) % 5000 === 0) console.log(`선별 ${i + 1}/${charts.length}`)
      if (/\.pms$/i.test(chart.path)) continue
      const content = await readFile(chart.path)
      if (content.length > 5 * 1024 * 1024) continue
      const text = content.toString('latin1')
      let wide = false
      let p2 = false
      for (const match of text.matchAll(/^\s*#\d{3}([1256][1-9]):([0-9a-z]+)/gim)) {
        if (!/[1-9a-z]/i.test(match[2])) continue
        if ('26'.includes(match[1][0])) p2 = true
        else if ('89'.includes(match[1][1])) wide = true
        if (p2) break
      }
      if (!wide || p2) continue
      const raw = text.match(/^\s*#PLAYLEVEL\s+([^\r\n]+)/im)?.[1] || ''
      const level = +(raw.match(/\d+(?:\.\d+)?/)?.[0] || 0)
      const dir = dirname(chart.path)
      if (!groups.has(dir)) groups.set(dir, [])
      groups.get(dir).push({ ...chart, level, size: content.length })
    }
  }
  await Promise.all(Array.from({ length: 16 }, scan))
  return [...groups.values()].map(group => group.sort((a, b) => b.level - a.level || b.size - a.size))
}

async function importCharts(input, { highest7K = false } = {}) {
  if (!input) throw new Error('사용법: npm run import:chart -- <file-or-directory> [--highest-7k]')
  const pool = createPool()
  if (!pool) throw new Error('DATABASE_URL이 필요합니다')
  const charts = await collectCharts(input)
  const groups = highest7K ? await highest7KGroups(charts) : charts.map(chart => [chart])
  if (highest7K) console.log(`최고난도 7K SP ${groups.length}곡 선별`)
  let saved = 0
  let skipped = 0

  try {
    await initDb(pool)
    // ponytail: 순차 import. 1회성 관리 작업이라 충분함 — 수천 건에서 느리면 동시성만 제한해 추가.
    for (const [i, group] of groups.entries()) {
      let stored = false
      let lastError
      for (const chart of group) try {
        const content = await readFile(chart.path)
        if (content.length > 5 * 1024 * 1024) throw new Error('5MB 초과')
        const parsed = await loadFile({
          name: chart.name,
          arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
        })
        if (highest7K) {
          const lanes = toLanes(parsed)
          if (lanes.mode !== '7K' || !lanes.notes.length) throw new Error('정상 7K SP가 아님')
        }
        await pool.query(
          `INSERT INTO charts (filename, title, artist, content) VALUES ($1, $2, $3, $4)
           ON CONFLICT (filename) DO UPDATE
           SET title = EXCLUDED.title, artist = EXCLUDED.artist, content = EXCLUDED.content`,
          [chart.name, parsed.info.title || '', parsed.info.artist || '', content],
        )
        saved++
        stored = true
        break
      } catch (error) {
        lastError = error
      }
      if (!stored) {
        skipped++
        console.error(`${group[0]?.name || '채보'} — ${lastError?.message || '저장 실패'}`)
      }
      if ((i + 1) % 50 === 0 || i + 1 === groups.length) console.log(`${i + 1}/${groups.length}`)
    }
  } finally {
    await pool.end()
  }
  console.log(`저장 ${saved}개 · 건너뜀 ${skipped}개`)
  return { saved, skipped }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  importCharts(args.find(arg => !arg.startsWith('--')), { highest7K: args.includes('--highest-7k') })
    .then(({ skipped }) => { if (skipped) process.exitCode = 1 })
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}

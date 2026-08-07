// main.js 를 실제로 import 해서 파일 한 장을 흘려보내는 스모크. DOM 은 최소 스텁.
//
// run.js 는 모듈을 하나씩 부르므로 배선(DOM id, 그리는 순서)은 못 잡는다. 여기서 잡는다.
// 스텁이 지키는 두 가지 — 브라우저와 어긋나면 버그를 놓친다:
//   ① getElementById 는 index.html 에 실제로 있는 id 만 돌려준다 (오타 검출)
//   ② hidden 인 조상 안의 캔버스는 0×0 이다 (숨은 채로 그리다 죽는 것 검출)
import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const root = new URL('..', import.meta.url)
const html = readFileSync(new URL('index.html', root), 'utf8')
const IDS = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
const HIDDEN = new Set(
  [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].filter(m => /\shidden[\s>]/.test(m[0])).map(m => m[1]))

const noop = () => {}
const ctx2d = () => new Proxy({}, {
  get: (t, k) => {
    if (k in t) return t[k]
    if (k === 'measureText') return () => ({ width: 10 })
    return (t[k] = noop)
  },
  set: (t, k, v) => ((t[k] = v), true),
})

const listeners = new Map()
const cache = new Map()
const missing = []

function el(id) {
  const c = ctx2d()
  return {
    id, textContent: '', innerHTML: '', hidden: HIDDEN.has(id), value: '100', checked: false,
    style: {}, children: [], classList: { add: noop, remove: noop },
    width: 0, height: 0,
    // 전체 보기는 캔버스가 아니라 래퍼의 폭으로 컬럼을 나눈다(캔버스는 넘칠 수 있다)
    parentElement: { clientWidth: 900, scrollLeft: 0 },
    // 크기가 음수면 브라우저는 컨텍스트를 안 준다. 숨은 채로 그리면 여기서 터진다.
    getContext() { return this.width < 0 || this.height < 0 ? null : c },
    getBoundingClientRect: () => (cache.get('result').hidden
      ? { width: 0, height: 0, left: 0, top: 0 }
      : { width: 900, height: 200, left: 0, top: 0 }),
    setPointerCapture: noop,
    click: noop,
    toBlob: cb => cb({}),
    replaceChildren(...children) { this.children = children },
    append(child) { this.children.push(child) },
    addEventListener(type, fn) { listeners.set(`${id}:${type}`, fn) },
  }
}

for (const id of IDS) cache.set(id, el(id))

let lastCreated = null
globalThis.document = {
  documentElement: {},
  getElementById: id => (IDS.has(id) ? cache.get(id) : (missing.push(id), null)),
  querySelectorAll: () => [],
  createElement: () => (lastCreated = el('offscreen')),
}
globalThis.URL.createObjectURL = () => 'blob:x'
globalThis.URL.revokeObjectURL = noop
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#fff' })
globalThis.window = { devicePixelRatio: 1 }
globalThis.devicePixelRatio = 1
const windowListeners = new Map()
globalThis.addEventListener = (type, fn) => windowListeners.set(type, fn)
globalThis.requestAnimationFrame = noop
globalThis.cancelAnimationFrame = noop
// 헤드리스에는 모션이 없다. reduce 로 답하면 차트가 rAF 없이 최종 상태로 한 번에 그려진다.
globalThis.matchMedia = () => ({ matches: true })
// 스텁 뷰포트에는 스크롤이 없다 — 관찰하는 즉시 보이는 것으로 친다. 이게 있어야
// 등장 애니메이션 경로를 타고도 차트가 실제로 그려지는지 검사된다.
globalThis.IntersectionObserver = class {
  constructor(cb) { this.cb = cb }
  observe(target) { this.cb([{ target, isIntersecting: true }], this) }
  unobserve() {}
  disconnect() {}
}
globalThis.AudioContext = class {
  currentTime = 0; sampleRate = 44100; destination = {}
  createBuffer(_ch, n) { return { getChannelData: () => new Float32Array(n) } }
  resume() {}
}
globalThis.DynamicsCompressorNode = class { connect() {} }
globalThis.AudioBufferSourceNode = class { playbackRate = {}; connect() {} start() {} }
globalThis.File = class {
  constructor(parts, name) { this.blob = new Blob(parts); this.name = name; this.size = this.blob.size }
  arrayBuffer() { return this.blob.arrayBuffer() }
}

const dbChart = readFileSync(new URL('test/fixtures/sp7k.bms', root))
const fetched = []
globalThis.fetch = async url => (fetched.push(url), url.startsWith('/api/charts?q='))
  ? { ok: true, json: async () => [{ id: '1', filename: 'db.bms', title: 'DB Demo', artist: 'DB Artist' }] }
  : { ok: url === '/api/charts/1', blob: async () => new Blob([dbChart]) }

await import(new URL('js/main.js', root))
await new Promise(setImmediate)
assert.deepStrictEqual(missing, [], `index.html 에 없는 id 를 찾는다: ${missing}`)
assert.equal(cache.get('saved').hidden, false, 'DB 채보 목록이 안 떴다')
listeners.get('saved-chart:input')({ currentTarget: { value: 'DB Artist' } })
await new Promise(resolve => setTimeout(resolve, 210))
assert.ok(fetched.includes('/api/charts?q=DB%20Artist'), '입력한 검색어로 자동완성을 갱신하지 않는다')
const suggestion = cache.get('saved-charts').children[0]
assert.match(suggestion.textContent, /DB Demo.*DB Artist.*db\.bms/, '검색 결과에 제목·작곡가·파일명이 없다')
cache.get('saved-charts').value = suggestion.value
await listeners.get('load-saved:click')()
assert.equal(cache.get('title').textContent, 'BMScope Demo', 'DB 채보를 열지 못했다')

const buf = readFileSync(new URL('test/fixtures/sp7k.bms', root))
await listeners.get('file:change')({
  target: { files: [{ name: 'sp7k.bms', size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }] },
})

assert.equal(cache.get('result').hidden, false, '패널이 안 떴다')
assert.equal(cache.get('title').textContent, 'BMScope Demo')
assert.match(cache.get('stats').innerHTML, /<dt>노트<\/dt>/)
assert.match(cache.get('segments').innerHTML, /class="tag tag-/)
assert.match(cache.get('badges').innerHTML, /7K/)

// 구간 목록도 타임라인 밴드처럼 한 번 클릭으로 재생 구간을 잡는다.
listeners.get('segments:click')({ target: { closest: () => ({ dataset: { seg: '0' } }) } })
assert.equal(cache.get('clear-range').hidden, false, '구간 목록 클릭이 구간을 안 잡는다')
listeners.get('clear-range:click')()

// 전체 보기 조작: 끌면 커서가 따라오고, Shift+클릭은 그 구간을 재생 구간으로.
// 스텁 캔버스는 900×200, 컬럼 12개(75px) 기준이라 x=200 은 3번째, x=700 은 10번째 컬럼.
const down = listeners.get('overview:pointerdown')
const up = listeners.get('overview:pointerup')
const cursorSec = () => {
  const m = cache.get('range').textContent.match(/커서 (\d+):(\d+)/)
  return +m[1] * 60 + +m[2]
}

// 키보드 좌우는 5초 이동. 폼 컨트롤에 포커스가 있으면 건드리지 않는다.
const keydown = windowListeners.get('keydown')
keydown({ code: 'ArrowRight', shiftKey: false, target: { tagName: 'BODY' }, preventDefault: noop })
assert.ok(cursorSec() >= 5, '오른쪽 키로 5초 이동하지 않는다')
const beforeInputKey = cursorSec()
keydown({ code: 'ArrowLeft', shiftKey: false, target: { tagName: 'INPUT' }, preventDefault: noop })
assert.equal(cursorSec(), beforeInputKey, '입력 위젯의 방향키를 가로챈다')

keydown({ code: 'ArrowLeft', shiftKey: false, target: { tagName: 'BODY' }, preventDefault: noop })
assert.equal(cursorSec(), 0)
down({ clientX: 200, clientY: 100, shiftKey: false, pointerId: 1 }); up({})
const early = cursorSec()
down({ clientX: 700, clientY: 100, shiftKey: false, pointerId: 1 }); up({})
assert.ok(early > 0, '끌어도 커서가 안 움직인다')
assert.ok(cursorSec() > early, '오른쪽 컬럼일수록 뒤 시간이어야 한다')

assert.equal(cache.get('clear-range').hidden, true)
down({ clientX: 700, clientY: 100, shiftKey: true, pointerId: 1 }); up({})
assert.equal(cache.get('clear-range').hidden, false, 'Shift+클릭이 구간을 안 잡는다')
assert.match(cache.get('range').textContent, /재생 구간 \d+:\d+–(?!0:00)\d+:\d+/)

// 구간 안을 찍으면 구간이 남고, 밖으로 나가면 구간을 버리고 그 자리에서 이어 재생한다
down({ clientX: 700, clientY: 100, shiftKey: false, pointerId: 1 }); up({})
assert.equal(cache.get('clear-range').hidden, false, '구간 안을 찍었는데 구간이 사라졌다')

down({ clientX: 5, clientY: 195, shiftKey: false, pointerId: 1 }); up({}) // 맨 앞 = 구간 밖
assert.equal(cache.get('clear-range').hidden, true, '구간 밖으로 나갔는데 구간이 남았다')
assert.match(cache.get('range').textContent, /커서 0:00 · 재생 구간: 전체/)

// 하이스피드 = 전체 보기의 컬럼 밀도. 올리면 캔버스가 래퍼(900)보다 넓어져 가로 스크롤이 되고,
// 기본값(140)이면 딱 맞아 스크롤이 안 생긴다.
const hispeed = listeners.get('hispeed:input')
const overview = cache.get('overview')
hispeed({ target: { value: '280' } })
assert.equal(overview.style.width, '1800px', '하이스피드를 올려도 컬럼이 안 늘어난다')
assert.equal(cache.get('hispeed-v').textContent, '2.00×', '하이스피드 수치가 배율로 안 나온다')
hispeed({ target: { value: '140' } })
assert.equal(overview.style.width, '900px', '기본값인데 캔버스가 래퍼 폭과 다르다')

// 잘못된 파일: 패널은 감춘 채로 두고 오류만 띄운다 (앞 파일 결과가 남아 있으면 안 된다).
const feed = (name, bytes) => listeners.get('file:change')({
  target: { files: [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer }] },
})
const enc = new TextEncoder()

for (const [name, bytes, why] of [
  ['song.mp3', new Uint8Array([0xff, 0xfb, 0x90]), '확장자'],
  ['x.bms', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), '이름만 바꾼 바이너리'],
  ['empty.bms', enc.encode('#TITLE 헤더만 있음\n#BPM 150'), '노트 0개'],
]) {
  await feed(name, bytes)
  assert.equal(cache.get('result').hidden, true, `${why}: 오류인데 패널이 떠 있다`)
  assert.equal(cache.get('error').hidden, false, `${why}: 오류 메시지가 안 나온다`)
  assert.ok(cache.get('error').textContent.startsWith(name), `${why}: 어느 파일인지 안 알려준다`)
}

const randomChart = enc.encode('#BPM 120\n#RANDOM 2\n#IF 1\n#00111:01\n#ENDIF\n#IF 2\n#00112:01\n#ENDIF')
await feed('random.bms', randomChart)
assert.equal(cache.get('random-control').hidden, false, '#RANDOM 선택기가 안 보인다')
assert.equal(cache.get('random-branch').max, 2)
await listeners.get('random-branch:change')({ target: { value: '2' } })
assert.equal(cache.get('random-branch').value, 2, '#RANDOM 2번 분기로 다시 읽지 않는다')

// JSON 복사에는 화면 요약과 구간 분석이 함께 들어간다.
await feed('sp7k.bms', new Uint8Array(buf))
let copied = ''
globalThis.navigator.clipboard = { writeText: async text => { copied = text } }
const copyButton = cache.get('copy-analysis')
await listeners.get('copy-analysis:click')({ currentTarget: copyButton })
const report = JSON.parse(copied)
assert.equal(report.title, 'BMScope Demo')
assert.ok(report.segments.length, '복사한 JSON에 구간이 없다')

// 이미지 저장: 카드를 굽고 채보 이름으로 내려받는다.
await listeners.get('save-image:click')()
assert.equal(lastCreated.download, 'sp7k.png', '이미지 저장이 파일 이름을 안 따라간다')
assert.ok(lastCreated.href, '내려받을 URL 이 없다')

console.log('ok — 배선 스모크 (DOM id · 로드 → 렌더 순서 · 전체 보기 스크럽 · 하이스피드 · 잘못된 파일 거부)')

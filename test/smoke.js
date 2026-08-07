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

const control = (key, value, checked = false) => ({
  value, checked,
  addEventListener(type, fn) { listeners.set(`${key}:${type}`, fn) },
})
const controls = {
  'input[name=mode]': [
    control('mode:overview', 'overview', true), control('mode:play', 'play'), control('mode:ir', 'ir'),
  ],
  'input[name=axis]': [control('axis:measures', 'measures', true), control('axis:seconds', 'seconds')],
  'input[name=segmode]': [control('segmode:texture', 'texture'), control('segmode:fine', 'fine', true)],
}

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
    setCustomValidity: noop,
    reportValidity: noop,
    blur: noop,
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
  // id 없는 라디오만 표로 흉내낸다 — 나머지는 전부 getElementById 라 오타 검출을 받는다.
  querySelectorAll: selector => controls[selector] || [],
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
  ? { ok: true, json: async () => [{ id: '1', filename: 'Stellaverse/song/db.bms', title: 'DB Demo', artist: 'DB Artist' }] }
  : { ok: url === '/api/charts/1', blob: async () => new Blob([dbChart]) }

await import(new URL('js/main.js', root))
await new Promise(setImmediate)
assert.deepStrictEqual(missing, [], `index.html 에 없는 id 를 찾는다: ${missing}`)
assert.equal(cache.get('saved').hidden, false, 'DB 채보 목록이 안 떴다')
const searchEvent = { currentTarget: { value: 'DB Artist' } }
listeners.get('saved-chart:input')(searchEvent)
searchEvent.currentTarget = null
await new Promise(resolve => setTimeout(resolve, 210))
assert.ok(fetched.includes('/api/charts?q=DB%20Artist'), '입력한 검색어로 자동완성을 갱신하지 않는다')
const suggestion = cache.get('saved-charts').children[0]
assert.match(suggestion.textContent, /DB Demo.*DB Artist.*song\/db\.bms/, '검색 결과에 제목·작곡가·파일명이 없다')
assert.doesNotMatch(suggestion.textContent, /Stellaverse/, '검색 결과에 최상위 폴더가 남아 있다')
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
assert.equal(fetched.some(x => String(x).startsWith('/api/ir/')), false, 'IR 탭을 열기 전에 조회한다')

// IR은 별도 탭이며 처음 열 때만 지연 조회한다.
listeners.get('mode:ir:change')({ target: controls['input[name=mode]'][2] })
assert.equal(cache.get('overview-view').hidden, true)
assert.equal(cache.get('play-view').hidden, true)
assert.equal(cache.get('ir-view').hidden, false)
assert.equal(cache.get('view-controls').hidden, true, 'IR 탭에 캔버스 노브가 남아 있다')
assert.match(cache.get('bmsir-link').href, /songmd5=0d98fe8171ebfb82310d89ffc0320dfa/, '원본 MD5로 IR 링크를 만들지 않는다')
assert.match(cache.get('lr2archive-link').href, /lr2ir\.com\/charts\/0d98fe8171ebfb82310d89ffc0320dfa/)
assert.match(cache.get('mocha-link').href, /title=BMScope%20Demo/)
assert.ok(fetched.some(x => /\/api\/ir\/[\da-f]{32}\?sha256=[\da-f]{64}&client=lr2/.test(x)), 'MD5·SHA-256·클라이언트로 IR을 조회하지 않는다')
await new Promise(setImmediate)
assert.match(cache.get('ir-other').innerHTML, /class="ir-compare"/, 'IR 비교표가 렌더링되지 않는다')
assert.equal(cache.get('ir-status').innerHTML.match(/class="badge/g).length, 5, 'IR 연결 상태 배지가 5개가 아니다')
assert.match(cache.get('ir-status').innerHTML, /badge" title="미등록[^>]*>MinIR/, '미등록 IR이 꺼진 배지로 표시되지 않는다')
const practice = cache.get('ir-practice').innerHTML.match(/data-ir-seg="(\d+)"/)
assert.ok(practice, '분석 태그 기반 연습 구간이 나오지 않는다')
listeners.get('ir-practice:click')({ target: { closest: () => ({ dataset: { irSeg: practice[1] } }) } })
assert.equal(cache.get('play-view').hidden, false, '연습 구간 클릭이 재생 탭으로 이동하지 않는다')
assert.equal(cache.get('clear-range').hidden, false, '연습 구간 클릭이 반복 범위를 잡지 않는다')

// 상단 탭은 세 화면 묶음 전체를 바꾸고, 돌아와도 같은 커서를 유지한다.
listeners.get('mode:play:change')({ target: controls['input[name=mode]'][1] })
assert.equal(cache.get('overview-view').hidden, true)
assert.equal(cache.get('play-view').hidden, false)
assert.equal(cache.get('ir-view').hidden, true)
listeners.get('mode:overview:change')({ target: controls['input[name=mode]'][0] })
assert.equal(cache.get('overview-view').hidden, false)
assert.equal(cache.get('play-view').hidden, true)
assert.equal(cache.get('ir-view').hidden, true)
assert.equal(cache.get('view-controls').hidden, false, '캔버스 탭인데 노브가 사라졌다')

// 축 노브는 하나뿐이고 두 화면에 함께 걸린다 — 구간 목록의 범위 표기가 마디↔시간으로 갈린다.
assert.match(cache.get('segments').innerHTML, /class="t">0–/, '기본은 마디 토큰')
listeners.get('axis:seconds:change')({ target: controls['input[name=axis]'][1] })
assert.match(cache.get('segments').innerHTML, /class="t">0:00–/, '시간별로 안 바뀐다')
listeners.get('axis:measures:change')({ target: controls['input[name=axis]'][0] })

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

const laneBefore = cache.get('lane-order').value
listeners.get('lane-random:click')()
assert.notEqual(cache.get('lane-order').value, '', '랜덤 배치가 레인 입력에 안 들어간다')
assert.equal(cache.get('lane-order').value.length, laneBefore.length, '랜덤 배치가 레인 수를 바꿨다')

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

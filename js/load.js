import { compile, Timing, Positioning, SongInfo } from './vendor/bms.js'

// UTF-8 로 먼저 엄격 디코드하고, 대체문자(U+FFFD)가 섞이면 Shift_JIS → EUC-KR 순으로 재시도.
// 순서가 중요하다: Shift_JIS 로 UTF-8 바이트를 읽으면 U+FFFD 없이 조용히 깨진다.
const ENCODINGS = ['utf-8', 'shift-jis', 'euc-kr']

export function decode(buf) {
  for (const enc of ENCODINGS) {
    const text = new TextDecoder(enc).decode(buf)
    if (!text.includes('�')) return { text, encoding: enc }
  }
  return { text: new TextDecoder('shift-jis').decode(buf), encoding: 'shift-jis' }
}

const EXTS = ['bms', 'bme', 'bml', 'pms']

// 형식 검사는 여기 한 곳. 확장자만 보면 이름만 바꾼 mp3 를 통과시키고, 내용만 보면
// 오탈자 확장자를 조용히 먹는다 — 둘 다 본다. BMS 는 최소 한 줄이 `#명령` 이다.
export function parse(text, { name = '', random = 1 } = {}) {
  const ext = (name.split('.').pop() || 'bms').toLowerCase()
  if (name && !EXTS.includes(ext)) throw new Error(`.${ext} 는 지원하지 않습니다 — ${EXTS.map(e => '.' + e).join(' ')} 만 읽습니다`)
  if (!/^\s*#[A-Za-z0-9]/m.test(text)) throw new Error('BMS 형식이 아닙니다 (#명령이 하나도 없음)')

  const randomMax = Math.max(0, ...[...text.matchAll(/^\s*#RANDOM\s+(\d+)/gim)].map(m => +m[1]))
  // ponytail: 여러 #RANDOM 에 같은 번호를 적용한다. 독립 분기 선택이 필요해지면 지시문별 선택 UI 로.
  const randomChoice = Math.min(randomMax || 1, Math.max(1, Math.floor(random)))
  const { chart, warnings } = compile(text, { rng: max => Math.min(randomChoice, max) })
  return {
    name,
    ext,
    chart,
    warnings,
    hasRandom: /^\s*#(RANDOM|SETRANDOM|SWITCH)\b/im.test(text),
    randomMax,
    randomChoice,
    info: SongInfo.fromBMSChart(chart),
    timing: Timing.fromBMSChart(chart),
    pos: Positioning.fromBMSChart(chart),
  }
}

export async function loadFile(file, options) {
  const { text, encoding } = decode(await file.arrayBuffer())
  return { ...parse(text, { name: file.name, ...options }), encoding }
}

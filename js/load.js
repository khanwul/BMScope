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

export function parse(text, { name = '' } = {}) {
  // #RANDOM 은 항상 첫 번째 분기로 고정 전개한다. 배지로 표시만 하고 분기 선택 UI 는 두지 않는다.
  const { chart, warnings } = compile(text, { rng: () => 1 })
  return {
    name,
    ext: (name.split('.').pop() || 'bms').toLowerCase(),
    chart,
    warnings,
    hasRandom: /^\s*#(RANDOM|SETRANDOM|SWITCH)\b/im.test(text),
    info: SongInfo.fromBMSChart(chart),
    timing: Timing.fromBMSChart(chart),
    pos: Positioning.fromBMSChart(chart),
  }
}

export async function loadFile(file) {
  const { text, encoding } = decode(await file.arrayBuffer())
  return { ...parse(text, { name: file.name }), encoding }
}

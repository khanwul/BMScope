// bms-js 번들 진입점. 패키지 루트가 아닌 서브모듈을 직접 임포트하는 이유:
// lib/index.js 가 노드 전용 Reader(iconv-lite + chardet + buffer 폴리필)를 무조건
// 끌고 오는데, v51 의 package.json `browser` 필드 경로가 틀려서(./reader/... vs
// ./lib/reader/...) 브라우저 대체본으로 안 바뀐다. 인코딩은 TextDecoder 로 직접 한다.
export { compile } from 'bms/lib/compiler'
export { Notes } from 'bms/lib/notes'
export { Timing } from 'bms/lib/timing'
export { SongInfo } from 'bms/lib/song-info'
export { Positioning } from 'bms/lib/positioning'
export { BMSChart } from 'bms/lib/bms/chart'

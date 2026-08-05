"""개발용 정적 서버.

`python -m http.server` 는 Cache-Control 을 안 보낸다. 그러면 브라우저가 Last-Modified
기반 휴리스틱 캐시(수명 = 파일 나이의 10%)를 쓰기 때문에, CSS/JS 를 고쳐도 일반
새로고침에는 안 잡힌다. no-store 를 붙여 그 구간을 없앤다.
"""
import http.server


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


http.server.test(NoCache, port=8000)

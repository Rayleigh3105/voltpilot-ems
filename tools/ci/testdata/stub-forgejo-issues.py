"""Stub der Forgejo-Issue-API fuer tools/ci/test-report-failure.sh.

Spielt genau die drei Aufrufe, auf die report-failure.sh sich verlaesst:

  * GET  issues?state=open&type=issues&q=<titel> - [] solange keine Issue mit
    diesem Titel existiert, sonst [{"number": n, "title": ...}]
  * POST issues                                  - legt sie an (idempotent:
    ein zweiter Aufruf mit demselben Titel waere ein Fehler im Skript, der
    Stub verweigert ihn LAUT statt eine zweite Issue zu erfinden)
  * POST issues/<n>/comments                      - haengt den Bericht an;
    der Body wird gemerkt, damit der Test die letzten 200 Zeilen darin findet

Druckt seinen Port auf stdout und laeuft, bis er getoetet wird.
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

ISSUES = {}  # number -> title
COMMENTS = []  # [(issue number, body)]
NEXT_ID = [1]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # kein Rauschen im Testprotokoll
        pass

    def _send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self):
        return self.headers.get("Authorization", "").startswith("Basic ")

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"message": "Unauthorized"})
        parsed = urlparse(self.path)
        if re.match(r"^/api/v1/repos/[^/]+/[^/]+/issues$", parsed.path):
            q = parse_qs(parsed.query).get("q", [""])[0]
            treffer = [{"number": n, "title": t} for n, t in ISSUES.items() if t == q]
            return self._send(200, treffer)

        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/issues/(\d+)/comments$", parsed.path)
        if m:
            nummer = int(m.group(1))
            return self._send(200, [b for n, b in COMMENTS if n == nummer])
        self._send(404, {"message": "unbekannter Pfad"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"message": "Unauthorized"})
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b"{}"
        payload = json.loads(raw or b"{}")
        parsed = urlparse(self.path)

        if re.match(r"^/api/v1/repos/[^/]+/[^/]+/issues$", parsed.path):
            titel = payload.get("title", "")
            if any(t == titel for t in ISSUES.values()):
                return self._send(409, {"message": "Issue mit diesem Titel existiert schon"})
            nummer = NEXT_ID[0]
            NEXT_ID[0] += 1
            ISSUES[nummer] = titel
            return self._send(201, {"number": nummer, "title": titel})

        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/issues/(\d+)/comments$", parsed.path)
        if m:
            nummer = int(m.group(1))
            if nummer not in ISSUES:
                return self._send(404, {"message": "unbekannte Issue"})
            COMMENTS.append((nummer, payload.get("body", "")))
            return self._send(201, {"id": len(COMMENTS)})

        self._send(404, {"message": "unbekannter Pfad"})


def main():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    print(srv.server_port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())

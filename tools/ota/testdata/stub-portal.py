"""Stub des Portals + Keycloak + Forgejo fuer die OTA-Release-Selbsttests.

Er spielt genau die Antworten, deren Behandlung im Skript tragend ist:

  * Token: 200 nur mit dem richtigen client_secret, sonst 401 (invalid_client)
  * next-seq: 200 mit nextSeq/currentSeq, 401 ohne gueltiges Token
  * POST edge-releases: 201 neu · 200 BYTEGLEICHE Wiederholung · 409 abweichend
  * Forgejo: Release anlegen (201) bzw. schon vorhanden (409) + per Tag finden,
    Assets auflisten/loeschen/hochladen

Das 200-vs-409-Verhalten ist bewusst DIESELBE Regel wie in
AdminEdgeReleaseController.isIdenticalRepeat - ein Stub, der jede Wiederholung
durchwinkt, wuerde die Eigenschaft testen, die es gerade NICHT geben soll.
Ebenso das Forgejo-409: nur so ist der Wiederholungslauf wirklich geprueft.

Druckt seinen Port auf stdout und laeuft, bis er getoetet wird.
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STORE = {}  # version -> (manifest, signature, notes)
RELEASES = {}  # tag -> id
ASSETS = {}  # release id -> {name: {"id": n, "size": n}}
NEXT_ASSET_ID = [1]  # monoton wie bei Forgejo - eine wiederverwendete id
# wuerde beim Ersetzen eines Assets ein FREMDES Asset mittreffen.
TOKEN = "stub-token"
SECRET = "richtig"


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
        return self.headers.get("Authorization") == "Bearer " + TOKEN

    def _forgejo_authed(self):
        # Beide Formen muessen ankommen: Repo-Token und Basic-Auth.
        a = self.headers.get("Authorization", "")
        return a.startswith("token ") or a.startswith("Basic ")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        # Ein Asset-Upload ist multipart - die Bytes interessieren nur der
        # Groesse nach, gelesen werden muessen sie trotzdem.
        raw = self.rfile.read(n)

        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/releases$", self.path)
        if m:
            if not self._forgejo_authed():
                return self._send(401, {"message": "keine Zugangsdaten"})
            tag = json.loads(raw.decode())["tag_name"]
            if tag in RELEASES:
                return self._send(409, {"message": "release already exists"})
            rid = len(RELEASES) + 1
            RELEASES[tag] = rid
            ASSETS[rid] = {}
            return self._send(201, {"id": rid, "tag_name": tag})

        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/releases/(\d+)/assets\?name=(.+)$", self.path)
        if m:
            if not self._forgejo_authed():
                return self._send(401, {"message": "keine Zugangsdaten"})
            rid, name = int(m.group(1)), m.group(2)
            if rid not in ASSETS:
                return self._send(404, {"message": "unbekannte Release"})
            if name in ASSETS[rid]:
                # Genau wie Forgejo: ein gleichnamiges Asset wird NICHT still
                # ersetzt - das Skript muss es vorher loeschen.
                return self._send(400, {"message": "asset already exists"})
            ASSETS[rid][name] = {"id": NEXT_ASSET_ID[0], "size": len(raw)}
            NEXT_ASSET_ID[0] += 1
            return self._send(201, {"id": ASSETS[rid][name]["id"], "name": name})

        body = raw.decode()
        if self.path.endswith("/openid-connect/token"):
            if ("client_secret=" + SECRET) not in body:
                return self._send(401, {"error": "invalid_client"})
            return self._send(200, {"access_token": TOKEN, "expires_in": 60})
        if self.path.endswith("/api/v1/admin/edge-releases"):
            if not self._authed():
                return self._send(401, {"message": "kein Token"})
            d = json.loads(body)
            key = d["version"]
            entry = (d.get("manifest"), d.get("signature"), d.get("notes"))
            if key in STORE:
                if STORE[key] == entry and entry[0] is not None:
                    return self._send(200, {"version": key, "wiederholung": True})
                return self._send(
                    409, {"message": "Release '%s' ist bereits registriert." % key}
                )
            STORE[key] = entry
            return self._send(201, {"version": key})
        self._send(404, {"message": "unbekannter Pfad"})

    def do_GET(self):
        if self.path.endswith("/edge-releases/next-seq"):
            if not self._authed():
                return self._send(401, {"message": "kein Token"})
            return self._send(
                200,
                {"nextSeq": 13, "currentSeq": 12, "currentVersion": "edge-2026.08.0"},
            )
        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/releases/tags/(.+)$", self.path)
        if m:
            tag = m.group(1)
            if tag not in RELEASES:
                return self._send(404, {"message": "kein Release fuer diesen Tag"})
            return self._send(200, {"id": RELEASES[tag], "tag_name": tag})
        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/releases/(\d+)/assets$", self.path)
        if m:
            rid = int(m.group(1))
            return self._send(
                200,
                [{"id": v["id"], "name": k, "size": v["size"]}
                 for k, v in sorted(ASSETS.get(rid, {}).items())],
            )
        self._send(404, {"message": "unbekannter Pfad"})

    def do_DELETE(self):
        m = re.match(r"^/api/v1/repos/[^/]+/[^/]+/releases/(\d+)/assets/(\d+)$", self.path)
        if m:
            rid, aid = int(m.group(1)), int(m.group(2))
            for name, v in list(ASSETS.get(rid, {}).items()):
                if v["id"] == aid:
                    del ASSETS[rid][name]
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(404, {"message": "unbekannter Pfad"})


def main():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    print(srv.server_port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())

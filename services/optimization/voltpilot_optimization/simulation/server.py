"""The simulation service's HTTP surface (stdlib, internal network only).

Three routes, JSON in/out (design report §2 - deliberately no web framework,
matching the repo's dependency-lean Python services):

    POST /simulations          -> 202 {"simulationId"} | 400 | 429
    GET  /simulations/{id}     -> 200 {status, progress, result?, error?} | 404
    GET  /health               -> 200 {"status": "ok"}

The service knows neither tenants nor tokens: it only ever runs on the
internal compose network, and ALL auth/tenancy lives in the Java api (the
ingest JdbcDeviceDirectory trust pattern).
"""

from __future__ import annotations

import json
import logging
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from voltpilot_optimization.simulation.jobs import JobStore, TooBusyError
from voltpilot_optimization.simulation.request import InvalidRequest, parse_request

logger = logging.getLogger("voltpilot.simulation.server")

MAX_BODY_BYTES = 64 * 1024

_JOB_PATH = re.compile(r"^/simulations/([0-9a-f]{32})$")


def make_handler(store: JobStore):
    """Bind the request handler class to a job store."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "voltpilot-simulation"

        def log_message(self, fmt, *args):  # route through logging, not stderr
            logger.debug("http " + fmt % args)

        def _send(self, status: int, doc: dict) -> None:
            body = json.dumps(doc).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib API
            if self.path == "/health":
                self._send(200, {"status": "ok"})
                return
            match = _JOB_PATH.match(self.path)
            if match:
                snapshot = store.get(match.group(1))
                if snapshot is None:
                    self._send(404, {"message": "Simulation nicht gefunden."})
                    return
                self._send(200, snapshot)
                return
            self._send(404, {"message": "Unbekannter Pfad."})

        def do_POST(self) -> None:  # noqa: N802 - stdlib API
            if self.path != "/simulations":
                self._send(404, {"message": "Unbekannter Pfad."})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(400, {"message": "Ungültige Anfrage (Body fehlt oder zu groß)."})
                return
            try:
                doc = json.loads(self.rfile.read(length).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send(400, {"message": "Ungültige Anfrage: kein gültiges JSON."})
                return
            try:
                request = parse_request(doc)
            except InvalidRequest as exc:
                self._send(400, {"message": str(exc)})
                return
            try:
                job_id = store.submit(request)
            except TooBusyError as exc:
                self._send(429, {"message": str(exc)})
                return
            self._send(202, {"simulationId": job_id})

    return Handler


def serve(store: JobStore, port: int, bind: str = "0.0.0.0") -> ThreadingHTTPServer:
    """Build (not start) the HTTP server - the CLI calls serve_forever()."""
    return ThreadingHTTPServer((bind, port), make_handler(store))

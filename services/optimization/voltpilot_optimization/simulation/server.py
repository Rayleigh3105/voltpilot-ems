"""The optimization service's ON-DEMAND SOLVE surface (stdlib, internal only).

Four routes, JSON in/out (design report §2 - deliberately no web framework,
matching the repo's dependency-lean Python services):

    POST /simulations          -> 202 {"simulationId"} | 400 | 429
    GET  /simulations/{id}     -> 200 {status, progress, result?, error?} | 404
    POST /what-if              -> 200 {baseline, variant, delta} | 400 | 429 | 503
    GET  /health               -> 200 {"status": "ok"}

The two POST routes are the two shapes of "solve something the tick loop did
not ask for": the Ersparnis-Simulation is a long ASYNC year chain behind a job
store, the admin what-if re-optimize (vp-admin-optimizer-ui-design §4.3) is a
single 24 h horizon that solves in well under a second and is therefore served
SYNCHRONOUSLY - two solves in the request thread, no job id to poll. Both are
ephemeral: neither writes ``schedule`` nor publishes MQTT, and both run in this
process, never in the 15-minute tick loop's.

The service knows neither tenants nor tokens: it only ever runs on the
internal compose network, and ALL auth/tenancy lives in the Java api (the
ingest JdbcDeviceDirectory trust pattern) - the api resolves the site through
its RLS-scoped datasource BEFORE forwarding a site id here.
"""

from __future__ import annotations

import json
import logging
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from voltpilot_optimization.simulation.jobs import JobStore, TooBusyError
from voltpilot_optimization.simulation.request import InvalidRequest, parse_request
from voltpilot_optimization.whatif import (
    InvalidWhatIfRequest,
    WhatIfUnavailable,
)

logger = logging.getLogger("voltpilot.simulation.server")

MAX_BODY_BYTES = 64 * 1024

_JOB_PATH = re.compile(r"^/simulations/([0-9a-f]{32})$")

WHAT_IF_BUSY_MESSAGE = (
    "Gerade laufen zu viele Neuberechnungen. Bitte in wenigen Sekunden erneut versuchen."
)
WHAT_IF_FAILED_MESSAGE = (
    "Die Neuberechnung ist fehlgeschlagen. Der gespeicherte Fahrplan gilt unverändert."
)


def make_handler(store: JobStore, what_if=None):
    """Bind the request handler class to a job store.

    ``what_if`` is the optional synchronous re-optimize callable
    (``dict -> dict``); when it is None the route answers 503 rather than
    pretending the feature exists.
    """

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

        def _body(self) -> dict | None:
            """Read + parse the JSON body, answering 400 itself on failure."""
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(400, {"message": "Ungültige Anfrage (Body fehlt oder zu groß)."})
                return None
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send(400, {"message": "Ungültige Anfrage: kein gültiges JSON."})
                return None

        def do_POST(self) -> None:  # noqa: N802 - stdlib API
            if self.path == "/what-if":
                self._what_if()
                return
            if self.path != "/simulations":
                self._send(404, {"message": "Unbekannter Pfad."})
                return
            doc = self._body()
            if doc is None:
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

        def _what_if(self) -> None:
            if what_if is None:
                self._send(503, {"message": WHAT_IF_FAILED_MESSAGE})
                return
            doc = self._body()
            if doc is None:
                return
            try:
                self._send(200, what_if(doc))
            except InvalidWhatIfRequest as exc:
                self._send(400, {"message": str(exc)})
            except TooBusyError:
                self._send(429, {"message": WHAT_IF_BUSY_MESSAGE})
            except WhatIfUnavailable as exc:
                # A real, nameable reason the site cannot be planned - relayed
                # as a 400 so the operator reads it instead of "Dienst kaputt".
                self._send(400, {"message": str(exc)})
            except Exception:  # a failed preview must never claim a result
                logger.exception("whatif.failed")
                self._send(500, {"message": WHAT_IF_FAILED_MESSAGE})

    return Handler


def serve(store: JobStore, port: int, bind: str = "0.0.0.0",
          what_if=None) -> ThreadingHTTPServer:
    """Build (not start) the HTTP server - the CLI calls serve_forever()."""
    return ThreadingHTTPServer((bind, port), make_handler(store, what_if))

'use strict';
/**
 * serve.js - the flowc HTTP sidecar (E2 → E3a bridge): the CLOUD activation
 * path (services/api) has no Node runtime, so the flow-graph → flow-artifact
 * compiler runs as a tiny internal HTTP service the api calls, mirroring the
 * `simulate-serve` pattern (services/optimization/.../simulation/server.py):
 * stdlib only, JSON in/out, internal compose network, a /health endpoint. It
 * knows neither tenants nor tokens - ALL auth/tenancy lives in the Java api
 * (the ingest JdbcDeviceDirectory trust pattern).
 *
 *   POST /compile   {document, compiled_at?} -> 200 <artifact>
 *                                            |  422 {message, findings}  (flow rejected)
 *                                            |  400 {message}            (bad request)
 *                                            |  500 {message}            (internal)
 *   GET  /health                             -> 200 {status, compiler_version}
 *
 * The content_hash on the returned artifact comes from compile()/canonicalize.js
 * (the RFC-8785 JCS hash) - the api NEVER recomputes it, it only verifies the
 * manifest shape and propagates it into the D-11 deployment set. compiled_at
 * defaults to the request time (compile.js itself defaults to the epoch so its
 * output is deterministic for the pinned-hash test; the hash excludes
 * compiled_at, so stamping the real time here never changes it).
 */

const http = require('http');
const { compile, ValidationError, COMPILER_VERSION } = require('./compile');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB: a 256 KiB artifact + slack.
const DEFAULT_PORT = 8099;

function sendJson(res, status, doc) {
  const body = Buffer.from(JSON.stringify(doc), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handleCompile(res, raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { message: 'Ungültige Anfrage: kein gültiges JSON.' });
    return;
  }
  // Accept either the wrapper {document, compiled_at?} or a bare graph.
  const graph = doc && typeof doc === 'object' && doc.document !== undefined
    ? doc.document : doc;
  const compiledAt = doc && typeof doc === 'object' && typeof doc.compiled_at === 'string'
    ? doc.compiled_at : new Date().toISOString();
  if (!graph || typeof graph !== 'object') {
    sendJson(res, 400, { message: 'Ungültige Anfrage: Flow-Dokument fehlt.' });
    return;
  }
  try {
    const artifact = compile(graph, { compiledAt });
    sendJson(res, 200, artifact);
  } catch (e) {
    if (e instanceof ValidationError) {
      sendJson(res, 422, {
        message: 'Der Flow konnte nicht kompiliert werden: ' + e.message,
        findings: e.findings || [],
      });
      return;
    }
    sendJson(res, 500, { message: 'Interner Compiler-Fehler: ' + (e && e.message) });
  }
}

/** Build (not start) the HTTP server - the CLI / test calls listen(). */
function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok', compiler_version: COMPILER_VERSION });
      return;
    }
    if (req.method === 'POST' && req.url === '/compile') {
      readBody(req, MAX_BODY_BYTES)
        .then((raw) => handleCompile(res, raw))
        .catch(() => sendJson(res, 400,
          { message: 'Ungültige Anfrage (Body fehlt oder zu groß).' }));
      return;
    }
    sendJson(res, 404, { message: 'Unbekannter Pfad.' });
  });
}

/**
 * Stop accepting connections, let in-flight compiles finish, then leave.
 *
 * Container contract (docs/k8s-readiness.md): Node installs NO default
 * SIGTERM handler, and the Linux kernel delivers a signal to PID 1 only when
 * that process registered a handler - so without this the sidecar IGNORES
 * SIGTERM and every `docker stop` / rolling deploy ends in SIGKILL after the
 * full grace period. A compile is milliseconds, so the drain is instant; the
 * timer is only the backstop for a wedged socket.
 */
function installShutdownHandlers(server, { timeoutMs = 10000, exit = process.exit } = {}) {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(`flowc-serve stopping (${signal})`);
    const hard = setTimeout(() => exit(0), timeoutMs);
    if (typeof hard.unref === 'function') hard.unref();
    server.close(() => {
      clearTimeout(hard);
      exit(0);
    });
    // Idle keep-alive sockets would otherwise hold close() open until they expire.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal));
  return stop;
}

module.exports = { createServer, installShutdownHandlers };

if (require.main === module) {
  const port = Number(process.env.FLOWC_PORT || process.env.PORT || DEFAULT_PORT);
  const bind = process.env.FLOWC_BIND || '0.0.0.0';
  const server = createServer();
  installShutdownHandlers(server);
  server.listen(port, bind, () => {
    // The BOUND port, not the configured one - with FLOWC_PORT=0 (ephemeral,
    // what the shutdown test uses) the configured value says nothing.
    const bound = server.address();
    // eslint-disable-next-line no-console
    console.log(
      `flowc-serve listening on ${bound.address}:${bound.port} (compiler ${COMPILER_VERSION})`
    );
  });
}

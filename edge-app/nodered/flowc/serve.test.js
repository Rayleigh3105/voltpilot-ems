'use strict';
// node --test serve.test.js - the sidecar contract proof (offline): a
// flow-graph fixture POSTed to the running server compiles to an artifact
// whose content_hash matches flowc's OWN pinned test vector (pinned-hash.txt),
// the invalid-graph class is refused with 422 + findings, and /health answers.
// This is the E2→E3a bridge's end (the api integration test uses the fixture
// ARTIFACT since a JVM test has no Node runtime; together they cover
// graph→artifact→published set).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./serve');

const EXAMPLES = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2', 'examples');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));
}

function pinnedHash() {
  return fs.readFileSync(path.join(__dirname, 'pinned-hash.txt'), 'utf8').trim();
}

function pinnedPeakshavingHash() {
  return fs.readFileSync(path.join(__dirname, 'pinned-peakshaving-hash.txt'), 'utf8').trim();
}

function pinnedNotifyHash() {
  return fs.readFileSync(path.join(__dirname, 'pinned-notify-hash.txt'), 'utf8').trim();
}

/** Start the server on an ephemeral port; resolve {port, close}. */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function request(port, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { /* leave raw */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('POST /compile compiles a graph fixture to the pinned artifact', async () => {
  const { port, close } = await startServer();
  try {
    const graph = fixture('flow-graph.valid.pv-surplus-heatrod.json');
    // Both request shapes work: the {document} wrapper the api sends...
    const res = await request(port, 'POST', '/compile', { document: graph });
    assert.strictEqual(res.status, 200, res.text);
    const artifact = res.json;
    assert.strictEqual(artifact.kind, 'artifact');
    assert.strictEqual(artifact.flow_id, graph.flow_id);
    assert.strictEqual(artifact.flow_version, graph.flow_version);
    // The hash is flowc's own, byte-stable against the committed vector.
    assert.strictEqual(artifact.content_hash, pinnedHash());
    assert.strictEqual(artifact.bundle.format, 'nodered-tabs');
    assert.ok(Array.isArray(artifact.bundle.tab_ids) && artifact.bundle.tab_ids.length >= 1);

    // ...and a bare graph body compiles identically (hash unchanged).
    const bare = await request(port, 'POST', '/compile', graph);
    assert.strictEqual(bare.status, 200);
    assert.strictEqual(bare.json.content_hash, pinnedHash());
  } finally {
    await close();
  }
});

test('POST /compile compiles a peakshaving graph to its pinned artifact', async () => {
  const { port, close } = await startServer();
  try {
    const graph = fixture('flow-graph.valid.peakshaving-battery.json');
    const res = await request(port, 'POST', '/compile', { document: graph });
    assert.strictEqual(res.status, 200, res.text);
    const artifact = res.json;
    assert.strictEqual(artifact.kind, 'artifact');
    assert.strictEqual(artifact.flow_id, graph.flow_id);
    // The delegated peak-shaving strategy compiles to a no-op (no vp-desired);
    // the hash is flowc's own, byte-stable against the committed vector.
    assert.strictEqual(artifact.content_hash, pinnedPeakshavingHash());
    assert.strictEqual(
      artifact.bundle.nodered_flows.find((n) => n.type === 'vp-desired'), undefined);
  } finally {
    await close();
  }
});

test('POST /compile compiles the notification automation the api used to reject', async () => {
  // #518: a Schwellwert -> Wenn/Dann-gate -> Benachrichtigung flow validates +
  // simulates in the editor. Before the gate compile entry existed, activation
  // (which POSTs the document here) died with compiler_rejected. It must now
  // compile to the artifact whose content_hash is flowc's own pinned vector.
  const { port, close } = await startServer();
  try {
    const graph = fixture('flow-graph.valid.notify-threshold.json');
    const res = await request(port, 'POST', '/compile', { document: graph });
    assert.strictEqual(res.status, 200, res.text);
    const artifact = res.json;
    assert.strictEqual(artifact.kind, 'artifact');
    assert.strictEqual(artifact.flow_id, graph.flow_id);
    assert.strictEqual(artifact.content_hash, pinnedNotifyHash());
    assert.ok(artifact.bundle.nodered_flows.find((n) => n.type === 'vp-notify'),
      'the compiled bundle carries the notification publisher');
  } finally {
    await close();
  }
});

test('POST /compile honors a caller-supplied compiled_at without changing the hash', async () => {
  const { port, close } = await startServer();
  try {
    const graph = fixture('flow-graph.valid.pv-surplus-heatrod.json');
    const res = await request(port, 'POST', '/compile',
      { document: graph, compiled_at: '2026-07-19T09:30:00Z' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.compiled_at, '2026-07-19T09:30:00Z');
    assert.strictEqual(res.json.content_hash, pinnedHash());
  } finally {
    await close();
  }
});

test('POST /compile rejects an invalid graph with 422 + findings', async () => {
  const { port, close } = await startServer();
  try {
    const res = await request(port, 'POST', '/compile',
      { document: fixture('flow-graph.invalid.unknown-trigger.json') });
    assert.strictEqual(res.status, 422, res.text);
    assert.ok(Array.isArray(res.json.findings) && res.json.findings.length >= 1);
    assert.match(res.json.message, /kompiliert werden/);
  } finally {
    await close();
  }
});

test('POST /compile rejects a non-JSON body with 400', async () => {
  const { port, close } = await startServer();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/compile',
        headers: { 'Content-Type': 'application/json' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.end('not json');
    });
    assert.strictEqual(res.status, 400);
  } finally {
    await close();
  }
});

test('GET /health answers with the compiler version', async () => {
  const { port, close } = await startServer();
  try {
    const res = await request(port, 'GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'ok');
    assert.match(res.json.compiler_version, /^\d+\.\d+\.\d+$/);
  } finally {
    await close();
  }
});

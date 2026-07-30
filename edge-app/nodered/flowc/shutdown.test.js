'use strict';
// node --test shutdown.test.js - the flowc sidecar's container contract
// (docs/k8s-readiness.md).
//
// The fact this guards: Node installs NO default SIGTERM handler, and the
// Linux kernel delivers a signal to PID 1 only when that process registered
// one - so a `node serve.js` container without an explicit handler IGNORES
// SIGTERM and is SIGKILLed after the full terminationGracePeriodSeconds on
// every rolling deploy. The test spawns the REAL entrypoint (that is where PID
// 1 lives in the image), waits for it to listen, sends SIGTERM and requires a
// clean, prompt exit.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer, installShutdownHandlers } = require('./serve');

const SERVE = path.join(__dirname, 'serve.js');
// Generous vs. the ~30 s grace period a manifest grants, tight enough that a
// missing handler (which never exits at all) fails instead of hanging the run.
const EXIT_BUDGET_MS = 10000;

function startServe() {
  return new Promise((resolve, reject) => {
    // Port 0 = let the OS pick, so a parallel run never clashes.
    const child = spawn(process.execPath, [SERVE], {
      env: { ...process.env, FLOWC_PORT: '0', FLOWC_BIND: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('serve.js never listened')), 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(chunk);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on('error', reject);
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

test('SIGTERM stops the sidecar cleanly instead of waiting for SIGKILL', async () => {
  const { child, port } = await startServe();
  assert.strictEqual(await get(port, '/health'), 200);

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    resolve({ code, signal });
  }));
  const guard = setTimeout(() => child.kill('SIGKILL'), EXIT_BUDGET_MS);
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  clearTimeout(guard);

  // signal !== null would mean it had to be SIGKILLed - exactly the failure
  // mode a missing handler produces.
  assert.strictEqual(signal, null, 'sidecar had to be killed, it ignored SIGTERM');
  assert.strictEqual(code, 0);
});

test('a second signal while already stopping is ignored', async () => {
  // Kubernetes may repeat the signal; the drain must not restart or double-exit.
  const server = createServer();
  const exits = [];
  const stop = installShutdownHandlers(server, {
    timeoutMs: 50,
    exit: (code) => exits.push(code),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stop('SIGTERM');
  stop('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepStrictEqual(exits, [0]);
});

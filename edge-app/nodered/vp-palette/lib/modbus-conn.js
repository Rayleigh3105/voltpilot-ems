/**
 * modbus-conn - the shared per-target Modbus-TCP connection manager for the
 * vp-modbus-* palette nodes (MB-M1). It bakes the 2026-07-13 poll law
 * (edge-app/CLAUDE.md "Node-RED SunSpec polls: never overlap, never silent")
 * into a reusable library:
 *
 *   - ONE in-flight operation per (host, port) across ALL vp-modbus nodes in
 *     the runtime - module scope spans every tab, which is the decisive
 *     advantage of palette nodes over per-flow function-node code. Excess
 *     requests queue FIFO, bounded (drop-OLDEST with a rejection the caller
 *     surfaces - never a silent drop).
 *   - a FRESH socket per operation (single-session gateways displace held
 *     connections), 8 s connect timeout, 8 s read timeout, and a 30 s overall
 *     Promise.race cap so the per-target busy flag ALWAYS clears.
 *   - every failure resolves to a rejected promise with a German message the
 *     node turns into status + a rate-limited warn - this module never logs
 *     itself and never swallows an error.
 */
'use strict';

const net = require('net');
const codec = require('./modbus-tcp.js');

const CONNECT_TIMEOUT_MS = 8000;
const READ_TIMEOUT_MS = 8000;
const OVERALL_TIMEOUT_MS = 30000;
const MAX_QUEUE = 8;

/** 'host:port' -> { busy: boolean, queue: [{opts, resolve, reject}] } */
const targets = new Map();
let txCounter = 0;

/**
 * readRegisters({host, port, unitId, fc, addr, count, connectTimeoutMs?,
 * readTimeoutMs?, overallTimeoutMs?, maxQueue?}) -> Promise<number[]>.
 * `fc` is codec.FN_READ_HOLDING (default) or codec.FN_READ_INPUT.
 */
function readRegisters(opts) {
  return new Promise((resolve, reject) => {
    const key = opts.host + ':' + opts.port;
    let t = targets.get(key);
    if (!t) {
      t = { busy: false, queue: [] };
      targets.set(key, t);
    }
    t.queue.push({ opts, resolve, reject });
    const maxQueue = opts.maxQueue > 0 ? opts.maxQueue : MAX_QUEUE;
    if (t.queue.length > maxQueue) {
      const dropped = t.queue.shift();
      dropped.reject(new Error('Warteschlange für ' + key + ' voll - älteste Anfrage verworfen'));
    }
    pump(t);
  });
}

function pump(t) {
  if (t.busy || t.queue.length === 0) return;
  const job = t.queue.shift();
  t.busy = true;
  const overallMs = job.opts.overallTimeoutMs > 0 ? job.opts.overallTimeoutMs : OVERALL_TIMEOUT_MS;
  let overallTimer;
  const overall = new Promise((_, rej) => {
    overallTimer = setTimeout(
      () => rej(new Error('Gesamt-Timeout nach ' + overallMs + ' ms')), overallMs);
    if (overallTimer.unref) overallTimer.unref();
  });
  Promise.race([doRead(job.opts), overall])
    .then(
      (regs) => {
        clearTimeout(overallTimer);
        job.resolve(regs);
      },
      (err) => {
        clearTimeout(overallTimer);
        job.reject(err);
      },
    )
    .then(() => {
      t.busy = false;
      pump(t);
    });
}

/** One read on a FRESH socket; always destroys the socket when settled. */
function doRead(opts) {
  return new Promise((resolve, reject) => {
    txCounter = (txCounter + 1) & 0xffff;
    const txid = txCounter;
    const fc = opts.fc === codec.FN_READ_INPUT ? codec.FN_READ_INPUT : codec.FN_READ_HOLDING;
    const connectMs = opts.connectTimeoutMs > 0 ? opts.connectTimeoutMs : CONNECT_TIMEOUT_MS;
    const readMs = opts.readTimeoutMs > 0 ? opts.readTimeoutMs : READ_TIMEOUT_MS;
    const sock = new net.Socket();
    sock.setNoDelay(true);
    let settled = false;
    let buf = Buffer.alloc(0);
    let connectTimer = null;
    let readTimer = null;
    const finish = (err, regs) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      sock.destroy();
      if (err) reject(err);
      else resolve(regs);
    };
    connectTimer = setTimeout(
      () => finish(new Error('Verbindungsaufbau-Timeout (' + connectMs + ' ms)')), connectMs);
    sock.on('error', (e) => finish(new Error('Verbindung fehlgeschlagen: ' + e.message)));
    sock.on('close', () => finish(new Error('Verbindung geschlossen ohne Antwort')));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const want = codec.expectedFrameLength(buf);
      if (want === null || buf.length < want) return;
      try {
        finish(null, codec.parseReadResponse(buf.slice(0, want), {
          expectTxid: txid,
          expectUnit: opts.unitId,
          expectFn: fc,
        }));
      } catch (e) {
        finish(e);
      }
    });
    sock.connect(opts.port, opts.host, () => {
      clearTimeout(connectTimer);
      readTimer = setTimeout(
        () => finish(new Error('Antwort-Timeout (' + readMs + ' ms)')), readMs);
      sock.write(codec.buildReadRequest({
        txid,
        unitId: opts.unitId,
        addr: opts.addr,
        count: opts.count,
        fc,
      }));
    });
  });
}

/** Test hook: whether the target currently has an operation in flight. */
function busy(host, port) {
  const t = targets.get(host + ':' + port);
  return !!(t && t.busy);
}

module.exports = { readRegisters, busy,
  CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS, OVERALL_TIMEOUT_MS, MAX_QUEUE };

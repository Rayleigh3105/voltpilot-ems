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
 *
 * WRITING GOES THROUGH THE SAME QUEUE (Einheitsmodell Stufe 4). `writeValue`
 * shares `targets`/`pump` with `readRegisters` byte for byte, so a switch and a
 * running poll on one device SERIALIZE instead of displacing each other - the
 * one-socket law this module exists for does not get a second, weaker copy for
 * writes. The only difference is which frame `doOp` puts on the wire.
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
  return enqueue(Object.assign({}, opts, { _kind: 'read' }));
}

/**
 * writeValue({host, port, unitId, fc, addr, value, ...}) -> Promise&lt;void&gt;.
 * `fc` is 5 (coil), 6 (single register) or 16 (multiple registers, the DEFAULT
 * for a holding register - a single-register write is accepted but not adopted
 * by several real devices). A coil takes value 0/1; the 0xFF00 wire form is the
 * codec's business, never the caller's.
 */
function writeValue(opts) {
  return enqueue(Object.assign({}, opts, { _kind: 'write' }));
}

/**
 * readCoils({host, port, unitId, addr, count}) -> Promise&lt;number[]&gt; of 0/1.
 * A coil cannot be read with fn 0x03, so a relay readback needs its own read.
 */
function readCoils(opts) {
  return enqueue(Object.assign({}, opts, { _kind: 'coils' }));
}

function enqueue(opts) {
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
      () => rej(Object.assign(new Error('Gesamt-Timeout nach ' + overallMs + ' ms'), {code:'timeout'})), overallMs);
    if (overallTimer.unref) overallTimer.unref();
  });
  Promise.race([doOp(job.opts), overall])
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

/** One operation on a FRESH socket; always destroys the socket when settled. */
function doOp(opts) {
  return new Promise((resolve, reject) => {
    txCounter = (txCounter + 1) & 0xffff;
    const txid = txCounter;
    const kind = opts._kind === 'write' ? 'write' : (opts._kind === 'coils' ? 'coils' : 'read');
    const fc = kind === 'write'
      ? writeFn(opts.fc)
      : (kind === 'coils'
        ? codec.FN_READ_COILS
        : (opts.fc === codec.FN_READ_INPUT ? codec.FN_READ_INPUT : codec.FN_READ_HOLDING));
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
      () => finish(Object.assign(new Error('Verbindungsaufbau-Timeout (' + connectMs + ' ms)'), {code:'unreachable'})), connectMs);
    sock.on('error', (e) => finish(Object.assign(new Error('Verbindung fehlgeschlagen: ' + e.message), {code:'unreachable'})));
    sock.on('close', () => finish(Object.assign(new Error('Verbindung geschlossen ohne Antwort'), {code:'no_answer'})));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const want = codec.expectedFrameLength(buf);
      if (want === null || buf.length < want) return;
      const frame = buf.slice(0, want);
      const check = { expectTxid: txid, expectUnit: opts.unitId, expectFn: fc };
      try {
        if (kind === 'coils') {
          finish(null, codec.parseReadCoilsResponse(frame, check));
        } else if (fc === codec.FN_WRITE_COIL) {
          codec.parseWriteCoilResponse(frame, check);
          finish(null, null);
        } else if (fc === codec.FN_WRITE_MULTIPLE) {
          codec.parseWriteMultipleResponse(frame, check);
          finish(null, null);
        } else if (fc === codec.FN_WRITE_SINGLE) {
          codec.parseWriteSingleResponse(frame, check);
          finish(null, null);
        } else {
          finish(null, codec.parseReadResponse(frame, check));
        }
      } catch (e) {
        finish(Object.assign(e, {code:'invalid_response'}));
      }
    });
    sock.connect(opts.port, opts.host, () => {
      clearTimeout(connectTimer);
      readTimer = setTimeout(
        () => finish(Object.assign(new Error('Antwort-Timeout (' + readMs + ' ms)'), {code:'no_answer'})), readMs);
      sock.write(requestFrame(txid, fc, kind, opts));
    });
  });
}

/**
 * writeFn maps a requested function code onto one this module can build. An
 * UNKNOWN code falls back to FC16, not to FC6: the safe default is the one that
 * provably lands on the devices that silently ignore a single-register write.
 */
function writeFn(fc) {
  const n = Math.floor(Number(fc));
  if (n === codec.FN_WRITE_COIL || n === codec.FN_WRITE_SINGLE) return n;
  return codec.FN_WRITE_MULTIPLE;
}

function requestFrame(txid, fc, kind, opts) {
  if (kind === 'coils') {
    return codec.buildReadCoilsRequest({
      txid, unitId: opts.unitId, addr: opts.addr, count: opts.count > 0 ? opts.count : 1,
    });
  }
  if (kind === 'write') {
    const v = Math.floor(Number(opts.value)) & 0xffff;
    if (fc === codec.FN_WRITE_COIL) {
      return codec.buildWriteCoilRequest({ txid, unitId: opts.unitId, addr: opts.addr, on: v !== 0 });
    }
    if (fc === codec.FN_WRITE_SINGLE) {
      return codec.buildWriteSingleRequest({ txid, unitId: opts.unitId, addr: opts.addr, value: v });
    }
    return codec.buildWriteMultipleRequest({ txid, unitId: opts.unitId, addr: opts.addr, values: [v] });
  }
  return codec.buildReadRequest({
    txid, unitId: opts.unitId, addr: opts.addr, count: opts.count, fc,
  });
}

/** Test hook: whether the target currently has an operation in flight. */
function busy(host, port) {
  const t = targets.get(host + ':' + port);
  return !!(t && t.busy);
}

module.exports = { readRegisters, writeValue, readCoils, busy,
  CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS, OVERALL_TIMEOUT_MS, MAX_QUEUE };

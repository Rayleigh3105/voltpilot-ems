/**
 * register-write - the ONE-SHOT write of the plain Modbus-TCP lane (Konzept
 * `vp-reg-schreib-konzept-p8` §2.8 Stufe 2 „Freie Register"): read the register,
 * optionally compare `expected_before`, write EXACTLY ONCE, let the device
 * settle, read it back.
 *
 * ⚠ IT IS THE EINHEITSMODELL-STUFE-4 WRITE MECHANICS **WITHOUT THE AUTO-OFF**,
 * and that difference is the whole reason it is its own module rather than an
 * option on `switch-write.js`. There a write is a TEST and the point is that it
 * reverts; here the point is that it STAYS - a durable configuration change with
 * a mandatory journal. An auto-off flag on one function would be one keystroke
 * away from silently reverting a customer's installer setting.
 *
 * What it SHARES with its sibling, deliberately:
 *   - `lib/modbus-conn.js` - ONE in-flight operation per (host, port) across
 *     every vp-modbus node, so a write never displaces the running poll of the
 *     very device the customer is watching.
 *   - `switch-write.classify` - the CLOSED failure set of the two modules we own
 *     (modbus-conn + the codec's parse functions), keyed by message PREFIX, never
 *     a loose regex over errno text.
 *
 * IT DECIDES NOTHING about policy: which register, which value, which lane, and
 * whether a write is allowed at all was settled before the message reached the
 * bus (core `internal/registerwrite` + `internal/installerwrite`). It re-checks
 * only what it must to open a socket at all - the shape of the op and the
 * PRIVATE target - because whoever opens a connection checks its target
 * themselves (the OTA-sidecar discipline).
 */
'use strict';

const conn = require('./modbus-conn.js');
const codec = require('./modbus-tcp.js');
const sw = require('./switch-write.js');
const privateHost = require('./private-host.js');

const KIND_HOLDING = 'holding';
const KIND_COIL = 'coil';

const MODE_DRY = 'dry_run';
const MODE_APPLY = 'apply';

/**
 * SETTLE_MS is the pause between the write and the read-back. An EEPROM register
 * needs a moment to adopt a value, and reading too early would report the old
 * word as „nicht übernommen" - a lie about a write that landed.
 */
const SETTLE_MS = 2000;

const ERR_INVALID_REQUEST = 'invalid_request';
const ERR_PRECONDITION = 'precondition';
const ERR_UNREACHABLE = 'unreachable';

/**
 * plan() turns one bus request into the arguments the shared connection manager
 * takes, or null when it is unusable. Every bound is re-checked here even though
 * the core checked it: „this node writes only what it was handed" must be a
 * property of THIS code.
 */
function plan(req) {
  if (req == null || typeof req !== 'object') return null;
  const host = typeof req.host === 'string' ? req.host.trim() : '';
  if (!host || !privateHost.isPrivateHost(host)) return null;
  const kind = req.kind === KIND_COIL ? KIND_COIL : KIND_HOLDING;
  const addr = int(req.addr);
  if (addr === null || addr < 0 || addr > 65535) return null;
  const apply = req.mode === MODE_APPLY;
  const value = int(req.value);
  if (apply) {
    if (value === null || value < 0 || value > 65535) return null;
    if (kind === KIND_COIL && value !== 0 && value !== 1) return null;
  }
  const fc = writeFc(kind, req.write_fc);
  if (fc === null) return null;
  const expected = req.expected_before === undefined || req.expected_before === null
    ? null : int(req.expected_before);
  if (expected !== null && (expected < 0 || expected > 65535)) return null;
  return {
    host: host,
    port: bounded(req.port, 1, 65535, 502),
    unitId: bounded(req.unit_id, 0, 255, 1),
    kind: kind,
    addr: addr,
    apply: apply,
    value: apply ? value : null,
    fc: fc,
    expectedBefore: expected,
  };
}

/**
 * writeFc resolves the write function code. Absent = the DEFAULT of the object
 * class: FC5 for a coil (there is no other), FC16 for a holding register - never
 * FC6, because many firmwares ACCEPT an FC6 frame and never apply it (the
 * measured Deye/Fronius lesson the control path already carries).
 */
function writeFc(kind, raw) {
  if (kind === KIND_COIL) {
    if (raw === undefined || raw === null || raw === codec.FN_WRITE_COIL) {
      return codec.FN_WRITE_COIL;
    }
    return null;
  }
  if (raw === undefined || raw === null) return codec.FN_WRITE_MULTIPLE;
  const fc = int(raw);
  if (fc === codec.FN_WRITE_SINGLE || fc === codec.FN_WRITE_MULTIPLE) return fc;
  return null;
}

function int(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.floor(Number(v));
  return isFinite(n) ? n : null;
}

function bounded(v, min, max, fallback) {
  const n = int(v);
  if (n === null || n < min || n > max) return fallback;
  return n;
}

/** readOne() reads the addressed object, or null when it could not be read. */
function readOne(p, deps) {
  const args = { host: p.host, port: p.port, unitId: p.unitId, addr: p.addr, count: 1 };
  const read = p.kind === KIND_COIL
    ? deps.readCoils(args)
    : deps.readRegisters(Object.assign({ fc: codec.FN_READ_HOLDING }, args));
  return read.then((vals) => {
    if (!Array.isArray(vals) || vals.length === 0) return null;
    const v = vals[0];
    if (v === null || v === undefined) return null;
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
}

/**
 * runOnce() performs ONE request end to end.
 *
 * The order is the honesty:
 *   1. READ - it IS the preview, and on a real write it is the „before" every
 *      later investigation needs.
 *   2. COMPARE - `expected_before` is judged HERE, not in the core: comparing it
 *      there would mean a read, a hand-back and a second claim on the socket -
 *      exactly the window another writer could slip into.
 *   3. WRITE - EXACTLY ONCE. `wrote` is set BEFORE the frame goes out, because
 *      from that moment the write may have landed even if the answer is lost.
 *   4. READ BACK - and a failed read-back never turns a landed write into a
 *      failure: the register is honestly ABSENT, never a fabricated mismatch.
 *
 * `deps` = {readRegisters, readCoils, writeValue, sleep} so the whole sequence is
 * provable without a socket.
 */
function runOnce(req, deps) {
  const p = plan(req);
  if (!p) {
    return Promise.resolve({
      ok: false, wrote: false, error_code: ERR_INVALID_REQUEST,
      message: 'Der Schreibauftrag ist unvollständig oder unzulässig.',
    });
  }
  let before = null;
  let wrote = false;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  return readOne(p, deps)
    .then((v) => {
      before = v;
      if (!p.apply) return { ok: true, wrote: false, before: before };
      if (p.expectedBefore !== null && before !== p.expectedBefore) {
        return {
          ok: false, wrote: false, before: before, error_code: ERR_PRECONDITION,
          message: 'Das Register steht inzwischen auf '
            + (before === null ? 'einem nicht lesbaren Wert' : before)
            + ', erwartet wurde ' + p.expectedBefore + '. Es wurde NICHTS geschrieben.',
        };
      }
      wrote = true;
      return deps.writeValue({
        host: p.host, port: p.port, unitId: p.unitId,
        fc: p.fc, addr: p.addr, value: p.value,
      })
        .then(() => sleep(SETTLE_MS))
        .then(() => readOne(p, deps).catch(() => null))
        .then((after) => ({ ok: true, wrote: true, before: before, after: after }));
    })
    .catch((err) => {
      const c = sw.classify(err && err.message);
      return {
        ok: false,
        wrote: wrote,
        before: before,
        // ⚠ before/after travel EVEN on a failure, and `wrote` stays true once
        // the frame left: a write whose answer got lost is exactly the case the
        // audit entry has to record honestly.
        error_code: wrote && c.code === sw.ERR_NO_ANSWER ? 'write_unconfirmed' : c.code,
        message: wrote
          ? 'Der Schreibbefehl ging hinaus, das Ergebnis ist aber unbestätigt: ' + c.message
          : c.message,
      };
    });
}

/** The real dependencies - the SHARED connection manager, never a new socket. */
const liveDeps = {
  readRegisters: (p) => conn.readRegisters(p),
  readCoils: (p) => conn.readCoils(p),
  writeValue: (p) => conn.writeValue(p),
};

module.exports = {
  plan, runOnce, writeFc, liveDeps, SETTLE_MS,
  KIND_HOLDING, KIND_COIL, MODE_DRY, MODE_APPLY,
  ERR_INVALID_REQUEST, ERR_PRECONDITION, ERR_UNREACHABLE,
};

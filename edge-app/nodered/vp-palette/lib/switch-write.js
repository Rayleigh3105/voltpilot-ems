/**
 * switch-write - the shared write half of the two vp-modbus switch nodes
 * (Einheitsmodell Stufe 4): the guided switch test (`vp-modbus-switch-test`,
 * driven by the probe channel) and the released executor (`vp-modbus-switch`,
 * driven by the arbiter's entity command).
 *
 * It exists so the two nodes cannot drift in the ONE place where drift would be
 * dangerous - how a value reaches a register and how a failure is named. Both
 * go through `lib/modbus-conn.js`, so a switch and a running poll on the same
 * device serialize instead of displacing each other.
 *
 * The error classes are the CLOSED failure set of the two modules we own
 * (modbus-conn + the codec's parse functions), keyed by the message PREFIX each
 * of them starts with - never a loose regex over errno text. Same table as
 * vp-modbus-probe, with one addition a write has and a read does not: a device
 * that ACCEPTS the frame and then does not adopt it. That one is not an error
 * class at all - it shows up as a readback that does not match, which is why
 * the readback exists.
 */
'use strict';

const conn = require('./modbus-conn.js');
const codec = require('./modbus-tcp.js');
const sharedBus = require('../../measurements/shared-bus-arbiter.js');

const ERR_INVALID_REQUEST = 'invalid_request';
const ERR_UNREACHABLE = 'unreachable';
const ERR_NO_ANSWER = 'no_answer';
const ERR_INVALID_RESPONSE = 'invalid_response';
const ERR_TIMEOUT = 'timeout';

const CLASSES = [
  ['Verbindungsaufbau-Timeout',
    ERR_UNREACHABLE, 'Das Gerät ist unter dieser Adresse nicht erreichbar.'],
  ['Verbindung fehlgeschlagen',
    ERR_UNREACHABLE, 'Das Gerät ist unter dieser Adresse nicht erreichbar.'],
  ['Antwort-Timeout',
    ERR_NO_ANSWER, 'Das Gerät antwortet nicht auf den Schaltbefehl (Unit-ID und Register prüfen).'],
  ['Gesamt-Timeout',
    ERR_NO_ANSWER, 'Das Gerät antwortet nicht auf den Schaltbefehl (Unit-ID und Register prüfen).'],
  ['Verbindung geschlossen ohne Antwort',
    ERR_NO_ANSWER, 'Das Gerät hat die Verbindung ohne Antwort beendet.'],
  ['Modbus-Ausnahme',
    ERR_NO_ANSWER, 'Das Gerät weist den Schaltbefehl ab - dieses Register lässt sich dort '
      + 'vermutlich nicht beschreiben.'],
  ['Warteschlange',
    ERR_TIMEOUT, 'Das Gerät wird gerade von einer anderen Abfrage belegt. Bitte erneut versuchen.'],
];

function classify(message) {
  const m = String(message || '');
  for (let i = 0; i < CLASSES.length; i++) {
    if (m.indexOf(CLASSES[i][0]) === 0) {
      return { code: CLASSES[i][1], message: CLASSES[i][2] + ' (' + m + ')' };
    }
  }
  return { code: ERR_INVALID_RESPONSE, message: 'Die Antwort des Geräts war nicht lesbar (' + m + ').' };
}

/**
 * writePlan() turns one bus op into the arguments the shared connection manager
 * takes, or null when the op is unusable. It re-checks the value bounds the
 * core already checked - a deployed instruction from outside is verified by
 * whoever opens the connection (the OTA-sidecar discipline), and a coil that
 * receives a 300 is a request bug, never a device problem.
 */
function writePlan(op) {
  if (op == null || typeof op !== 'object') return null;
  const host = typeof op.host === 'string' ? op.host.trim() : '';
  if (!host) return null;
  const addr = Math.floor(Number(op.address));
  if (!isFinite(addr) || addr < 0 || addr > 65535) return null;
  const value = Math.floor(Number(op.value));
  if (!isFinite(value) || value < 0 || value > 65535) return null;
  const fc = Math.floor(Number(op.fc));
  if (fc !== codec.FN_WRITE_COIL && fc !== codec.FN_WRITE_SINGLE
    && fc !== codec.FN_WRITE_MULTIPLE) return null;
  if (fc === codec.FN_WRITE_COIL && value !== 0 && value !== 1) return null;
  return {
    host: host,
    port: boundedInt(op.port, 1, 65535, 502),
    unitId: boundedInt(op.unit_id, 0, 255, 1),
    fc: fc,
    addr: addr,
    value: value,
  };
}

function boundedInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * runWrite() performs ONE write and, when a readback address is named, reads it
 * back. A failed READBACK never turns a landed write into a failure: the write
 * is what happened, and an unread register is honestly ABSENT (never a
 * fabricated "does not match").
 *
 * deps = {writeValue, readRegisters, readCoils} so the whole sequencing is
 * provable without a socket.
 */
function runWrite(op, deps) {
  const plan = writePlan(op);
  if (!plan) {
    return Promise.resolve({
      id: opId(op), ok: false, error_code: ERR_INVALID_REQUEST,
      message: 'Der Schaltbefehl ist unvollständig oder unzulässig.',
    });
  }
  const isCoil = plan.fc === codec.FN_WRITE_COIL;
  const execute = () => deps.writeValue(plan)
    .then(() => {
      const rb = op.readback_address;
      if (rb === undefined || rb === null) return { id: opId(op), ok: true };
      const rbPlan = {
        host: plan.host, port: plan.port, unitId: plan.unitId,
        addr: boundedInt(rb, 0, 65535, plan.addr), count: 1,
      };
      const read = isCoil
        ? deps.readCoils(rbPlan)
        : deps.readRegisters(Object.assign({ fc: codec.FN_READ_HOLDING }, rbPlan));
      return read
        .then((vals) => {
          const v = Array.isArray(vals) && vals.length > 0 ? vals[0] : null;
          if (v === null || v === undefined) return { id: opId(op), ok: true };
          return { id: opId(op), ok: true, readback: v };
        })
        // A readback that fails says nothing about the write that succeeded.
        .catch(() => ({ id: opId(op), ok: true }));
    })
    .catch((err) => {
      const c = classify(err && err.message);
      return { id: opId(op), ok: false, error_code: c.code, message: c.message };
    });
  const arbiter = deps.arbiter || sharedBus;
  return arbiter.runControl(sharedBus.targetKey(plan, 502), execute);
}

function opId(op) {
  return op && typeof op.id === 'string' ? op.id : 'schalten';
}

/** The real dependencies - the SHARED connection manager, never a new socket. */
const liveDeps = {
  writeValue: (p) => conn.writeValue(p),
  readRegisters: (p) => conn.readRegisters(p),
  readCoils: (p) => conn.readCoils(p),
};

module.exports = {
  classify, writePlan, runWrite, liveDeps,
  ERR_INVALID_REQUEST, ERR_UNREACHABLE, ERR_NO_ANSWER, ERR_INVALID_RESPONSE, ERR_TIMEOUT,
};

'use strict';

/**
 * readback-verify.js - the SEMANTICS of the control hold check.
 *
 * A control write is only proven when the inverter reports back what we
 * commanded. Until this module existed, that proof was ONE line in the Deye
 * executor:
 *
 *     const actual = (regs[0] || 0) & 0xffff;
 *     match: Math.abs(actual - (rb.expect & 0xffff)) <= tol
 *
 * which makes two silent claims that are both wrong on a real Solarman logger:
 *
 *  1. "every commanded register is a STATIC value that must read back
 *     bit-identically". The remote-mode watchdog (1101) is not: it is a
 *     dead-man's TIMER the inverter consumes ("If watch dog out of this setting
 *     value, inv will exit remote mode" - Deye MODBUS RTU V105.1; the openEMS
 *     field report calls it "a configurable watchdog that resets the value to 0
 *     if no external updates are received"). A timer that is counting our armed
 *     value down is the register WORKING, not a refused write.
 *  2. "a register we could not read holds 0". A Solarman/LSW3 logger that
 *     cannot reach the inverter still answers with a well-framed, CRC-valid
 *     ALL-ZERO register block - the exact stub this repo already treats as
 *     TRANSIENT everywhere it reads values (deye/deye-decode.js socPlausible,
 *     guards.SocPlausible, and classifyDeyeCapability's own all-zero rule).
 *     Reading that zero as "the inverter reports 0" turns a missing ANSWER into
 *     "der Wechselrichter hat den Sollwert nicht uebernommen" - a false alarm on
 *     a plant that is demonstrably following the setpoint (live Pilsting,
 *     2026-07-30: warning every ~10 s naming remote_watchdog,
 *     power_control_mode, battery_strategy, remote_mode - i.e. every register
 *     whose commanded value is non-zero - while battery_power, commanded ~0 at
 *     the time, "matched" the zero).
 *
 * So this module answers TWO questions per readback cycle, separately:
 *
 *   - per register: does the ACTUAL value satisfy THIS register's rule?
 *     -> 'held' | 'mismatch' | 'unread'
 *   - per cycle:    is this cycle evidence at all?
 *     -> 'held' (all registers held) | 'mismatch' (a real deviation) |
 *        'unconfirmed' (no usable answer - NOT evidence of a refused write)
 *
 * A cycle verdict is an OBSERVATION about ONE cycle; it deliberately does NOT
 * decide whether the operator sees a warning. Turning a run of cycles into a
 * warning is the CORE's job (agent.onControlReadback debounces N consecutive
 * mismatch cycles), because a single flickering cycle must never raise an alarm
 * and a real refusal must still raise one.
 *
 * Pure + self-contained (no requires), so build-flows.js can embed it VERBATIM
 * into the executor function node - there is no synced copy that could drift.
 */

/** The documented "watchdog off" sentinel of Deye register 1101. */
const WATCHDOG_OFF = 0xffff;

const VERDICT = { HELD: 'held', MISMATCH: 'mismatch', UNREAD: 'unread' };
const CYCLE = { HELD: 'held', MISMATCH: 'mismatch', UNCONFIRMED: 'unconfirmed' };

const NO_ANSWER_REASON =
  'Der Wechselrichter hat auf die Ruecklese-Anfrage nicht geantwortet '
  + '(Null-Antwort des Loggers) - der geschriebene Sollwert ist damit weder '
  + 'bestaetigt noch widerlegt.';

/**
 * ruleForRole - which comparison SEMANTICS a control register follows.
 *
 *   'countdown' - a dead-man's timer we ARM: the inverter owns it afterwards, so
 *                 any value from 1 up to the armed value proves it took the arm.
 *                 0 (expired) and 0xFFFF (watchdog off) are real refusals.
 *   'exact'     - a static value that must read back within its tolerance.
 *
 * Deliberately conservative: ONLY the register whose dynamic behaviour is
 * DOCUMENTED gets a dynamic rule. remote_mode (1100) keeps the exact rule even
 * though the protocol defines 1..3 as "remote mode 1/2/3" - we command mode 1
 * and have no evidence any firmware answers with a different sub-mode, and
 * inventing that tolerance would hide a real deviation. If a live device ever
 * reports 2/3, the register table shows it and the rule can follow the evidence.
 */
function ruleForRole(role) {
  return role === 'remote_watchdog' ? 'countdown' : 'exact';
}

function u16(v) {
  return Number(v) & 0xffff;
}

/**
 * verifyRegister - the per-register verdict.
 *
 * entry: { role, expect, actual, tolerance?, rule?, error? }
 *   actual: the register word the inverter answered, or null/undefined when the
 *           read produced NO value (empty payload, read error, stale frame).
 * Returns { role, verdict, note } - `note` is a plain-German detail for the
 * technician's register table (empty on a plain hold).
 */
function verifyRegister(entry) {
  const e = entry || {};
  const role = e.role || '';
  const expect = u16(e.expect);
  if (e.actual === null || e.actual === undefined) {
    return { role: role, verdict: VERDICT.UNREAD, note: e.error ? String(e.error) : 'nicht gelesen' };
  }
  const actual = u16(e.actual);
  const rule = e.rule || ruleForRole(role);
  if (rule === 'countdown') {
    if (actual === expect) return { role: role, verdict: VERDICT.HELD, note: '' };
    if (actual === WATCHDOG_OFF) {
      return {
        role: role, verdict: VERDICT.MISMATCH,
        note: 'Totmannschalter steht auf AUS - die Scharfstellung wurde nicht uebernommen',
      };
    }
    if (actual === 0) {
      return {
        role: role, verdict: VERDICT.MISMATCH,
        note: 'Totmannschalter ist abgelaufen - der Wechselrichter hat die Fernsteuerung verlassen',
      };
    }
    if (actual < expect) {
      return {
        role: role, verdict: VERDICT.HELD,
        note: 'laeuft ab (' + actual + ' s von ' + expect + ' s)',
      };
    }
    return {
      role: role, verdict: VERDICT.MISMATCH,
      note: 'Wert hoeher als scharfgestellt (' + actual + ' s > ' + expect + ' s)',
    };
  }
  const tol = Number(e.tolerance) > 0 ? Number(e.tolerance) : 0;
  if (Math.abs(actual - expect) <= tol) return { role: role, verdict: VERDICT.HELD, note: '' };
  return { role: role, verdict: VERDICT.MISMATCH, note: '' };
}

/**
 * isZeroAnswer - the Solarman "inverter did not answer" STUB: every register we
 * managed to read came back 0 while we commanded at least one non-zero value.
 *
 * On the Deye remote block a genuine revert is NOT all-zero (the idle state is
 * 1101 = 0xFFFF watchdog-off, 1105 = 2 power strategy - the live probe of the
 * pilot's SUN-30K read exactly that), so an all-zero block cannot be an honest
 * inverter state for these registers. A release cycle (everything commanded 0)
 * is excluded by the non-zero requirement, so a confirmed release still reads
 * as confirmed.
 */
function isZeroAnswer(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let read = 0;
  let commandedNonZero = false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    if (u16(e.expect) !== 0) commandedNonZero = true;
    if (e.actual === null || e.actual === undefined) continue;
    if (u16(e.actual) !== 0) return false;
    read++;
  }
  return read > 0 && commandedNonZero;
}

/**
 * verifyCycle - the whole-cycle verdict over one readback pass.
 *
 * entries: [{ role, addr?, fc?, expect, actual, tolerance?, error? }]
 * Returns:
 *   {
 *     cycle: 'held' | 'mismatch' | 'unconfirmed',
 *     allMatch: true | false | null,   // null = unconfirmed (no verdict)
 *     registers: [{ role, verdict, note }],
 *     mismatchRoles: [...], unreadRoles: [...],
 *     reason: ''                       // plain German, only when not 'held'
 *   }
 *
 * Precedence: a REAL mismatch is decisive evidence and wins over unread
 * registers in the same cycle (we saw the inverter hold a different value).
 * Anything else that leaves a register unproven makes the cycle unconfirmed -
 * never a mismatch.
 */
function verifyCycle(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = {
    cycle: CYCLE.UNCONFIRMED, allMatch: null,
    registers: [], mismatchRoles: [], unreadRoles: [], reason: '',
  };
  if (list.length === 0) {
    out.reason = 'Keine Register zurueckgelesen.';
    return out;
  }

  const zeroAnswer = isZeroAnswer(list);
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    // A zero-answer cycle carries no readable value for ANY register - mark them
    // unread instead of comparing a value the inverter never sent.
    const r = zeroAnswer
      ? { role: e.role || '', verdict: VERDICT.UNREAD, note: 'keine Antwort (Null-Wert)' }
      : verifyRegister(e);
    out.registers.push(r);
    if (r.verdict === VERDICT.MISMATCH) out.mismatchRoles.push(r.role);
    else if (r.verdict === VERDICT.UNREAD) out.unreadRoles.push(r.role);
  }

  if (out.mismatchRoles.length > 0) {
    out.cycle = CYCLE.MISMATCH;
    out.allMatch = false;
    out.reason = 'Der Wechselrichter haelt den geschriebenen Wert nicht ('
      + out.mismatchRoles.join(', ') + ').';
    return out;
  }
  if (out.unreadRoles.length > 0) {
    out.cycle = CYCLE.UNCONFIRMED;
    out.allMatch = null;
    out.reason = zeroAnswer
      ? NO_ANSWER_REASON
      : 'Rueckmeldung unvollstaendig - nicht gelesen: ' + out.unreadRoles.join(', ') + '.';
    return out;
  }
  out.cycle = CYCLE.HELD;
  out.allMatch = true;
  return out;
}

module.exports = {
  WATCHDOG_OFF,
  VERDICT,
  CYCLE,
  NO_ANSWER_REASON,
  ruleForRole,
  verifyRegister,
  isZeroAnswer,
  verifyCycle,
};

/**
 * vp-control-readback - reports the per-register commanded-vs-actual result of
 * an inverter control write back to the core agent (edge/control/readback, NOT
 * retained), so the core folds it into the device Snapshot + the status
 * heartbeat and the :8484 "Steuerung & Bestätigung" card can render register-
 * level proof that the inverter accepted the schedule setpoint (report §5).
 *
 * It is the write-side twin of vp-status: the control adapter builds the
 * readback message (after writing + reading each control register back), this
 * node publishes it. Read-only reporting - it controls nothing.
 *
 * Input msg.payload: the readback object
 *   {
 *     ts, family, source, slot_start?, control_enabled, certified,
 *     registers: [ { role, fc, addr, commanded_kw?, commanded_raw,
 *                    actual_raw, actual_kw?, match, verdict? } ],
 *     verify?: 'held' | 'mismatch' | 'unconfirmed'
 *   }
 *
 * `verdict`/`verify` (readback-verify.js) carry the THREE-state truth of a cycle:
 * a register the inverter never answered is 'unread', and a cycle without a
 * usable answer is 'unconfirmed' - neither is evidence of a refused write. This
 * node therefore publishes `all_match: true | false | null` (null = no verdict,
 * the same convention the entity + curtailment readbacks already use). An older
 * adapter that sends only `match` booleans is unchanged: its verdicts are derived
 * from them and a cycle is then only ever held or mismatch.
 */
'use strict';

const TOPIC = 'edge/control/readback';

// dualControllerAwareness - the GENERIC "only-controller" signal (evcc's rule; the
// canonical, unit-tested source is inverter-control-routing.js dualControllerSignal,
// cross-checked in nodes_spec.js). While actively controlling a certified device, a
// commanded register that does not hold its value (readback mismatch) means a second
// controller (the inverter's own smart-control or another EMS) may be steering it -
// surfaced here on edge/control/readback, never silently fought. Vendor-specific
// detectors (Fronius ChaGriSet AND-link / SolarEdge storage mode) are extension
// points in dualControllerSignal (Phase D/E); this covers every adapter with readback
// (Deye Tier-3 included).
//
// It keys on a REAL mismatch (allMatch === false), never on an UNCONFIRMED cycle
// (allMatch === null): blaming a second controller for a read the inverter never
// answered is exactly the false accusation the flap fix removes.
function dualControllerAwareness(certified, controlEnabled, registerCount, allMatch, mismatchRoles) {
  const controlling = certified === true && controlEnabled === true && registerCount > 0;
  if (!controlling) return { only_controller_required: false, possible_conflict: false, detector: 'none', reason: '' };
  const out = { only_controller_required: true, possible_conflict: false, detector: 'readback_mismatch', reason: '' };
  if (allMatch === false) {
    out.possible_conflict = true;
    out.reason = 'Der Wechselrichter hält den geschriebenen Sollwert nicht ('
      + (mismatchRoles.join(', ') || 'Register weicht ab')
      + '). Möglicher Konflikt: die eigene Smart-Steuerung des Wechselrichters oder ein '
      + 'zweites EMS könnte gegensteuern - VoltPilot muss der einzige Controller sein.';
  }
  return out;
}

// shape() is exported for unit tests: validate + normalize the readback payload,
// or null when it is not a usable readback (never published - stays quiet).
function shape(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.registers)) return null;
  const registers = [];
  for (const r of payload.registers) {
    if (r == null || typeof r !== 'object') return null;
    if (typeof r.role !== 'string' || typeof r.match !== 'boolean') return null;
    registers.push(r);
  }
  const control_enabled = payload.control_enabled === true;
  const certified = payload.certified === true;
  // ONE derivation from the per-register verdicts (readback-verify.js): 'unread'
  // is neither a hold nor a mismatch. `verdict` absent -> derived from `match`,
  // so an older adapter keeps its exact two-state behaviour.
  const verdictOf = (r) => {
    if (r.verdict === 'held' || r.verdict === 'mismatch' || r.verdict === 'unread') return r.verdict;
    return r.match === true ? 'held' : 'mismatch';
  };
  const mismatch_roles = registers.filter((r) => verdictOf(r) === 'mismatch').map((r) => r.role);
  const unread_roles = registers.filter((r) => verdictOf(r) === 'unread').map((r) => r.role);
  // all_match: true = every commanded register held, false = a REAL deviation,
  // null = no verdict (nothing usable was read). null is the established shape of
  // the entity/curtailment readbacks, and the core treats it as "no evidence".
  let all_match = null;
  let verify = 'unconfirmed';
  if (mismatch_roles.length > 0) {
    all_match = false;
    verify = 'mismatch';
  } else if (registers.length > 0 && unread_roles.length === 0) {
    all_match = true;
    verify = 'held';
  }
  return {
    ts: typeof payload.ts === 'string' ? payload.ts : new Date().toISOString(),
    family: typeof payload.family === 'string' ? payload.family : '',
    source: typeof payload.source === 'string' ? payload.source : '',
    slot_start: typeof payload.slot_start === 'string' ? payload.slot_start : undefined,
    control_enabled,
    certified,
    mode: payload.mode === 'release' ? 'release' : 'normal',
    // WHICH Deye control path drove this write - 'remote' (the Tier-2 register
    // block 1100-1121) or 'tou' (the legacy Time-of-Use synthesis). Additive, so an
    // adapter that does not set it stays byte-compatible. The operator must always
    // be able to see which surface is steering their inverter.
    control_path: typeof payload.control_path === 'string' ? payload.control_path : '',
    // The Deye remote-control STATUS register (1121) - a read-only OBSERVATION, so
    // it deliberately never enters `registers` (it is not a commanded value and
    // must not be able to fabricate or break all_match).
    remote_status_raw: (typeof payload.remote_status_raw === 'number' && isFinite(payload.remote_status_raw))
      ? payload.remote_status_raw : null,
    registers,
    all_match,
    // The CYCLE verdict + what could not be read. The core debounces a run of
    // 'mismatch' cycles into the operator-facing warning; a single flickering
    // cycle must never raise one, and 'unconfirmed' never counts as evidence.
    verify,
    mismatch_roles,
    unread_roles,
    verify_reason: typeof payload.verify_reason === 'string' ? payload.verify_reason : '',
    // A control plan that was EMPTY because something is WRONG (an unknown nameplate
    // / power scale) - carried through so the core can show the CAUSE on the :8484
    // card instead of an eternal "warte auf Rueckmeldung" (Defect 2). A blocked
    // readback legitimately has registers: [] (there was nothing to write/read).
    // Additive: a normal readback leaves blocked false / reason '' and is unchanged.
    blocked: payload.blocked === true,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    // Additive "only-controller" awareness surfaced on the readback path.
    dual_controller: dualControllerAwareness(certified, control_enabled, registers.length, all_match, mismatch_roles),
  };
}

module.exports = function (RED) {
  function VpControlReadbackNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;
    client.on('connect', () => node.status({ fill: 'green', shape: 'dot', text: 'verbunden' }));
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    node.on('input', function (msg, send, done) {
      const shaped = shape(msg.payload);
      if (!shaped) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültige Rückmeldung verworfen' });
        done();
        return;
      }
      // NOT retained: a control readback is a live event, not a latched state.
      client.publish(TOPIC, JSON.stringify(shaped), { qos: 1, retain: false }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          let st;
          if (shaped.blocked) {
            st = { fill: 'yellow', shape: 'ring', text: 'angehalten: ' + (shaped.reason || 'Steuerung blockiert') };
          } else if (shaped.all_match === true) {
            st = { fill: 'green', shape: 'dot', text: 'bestätigt (' + shaped.registers.length + ' Register)' };
          } else if (shaped.all_match === false) {
            st = { fill: 'red', shape: 'dot', text: 'Abweichung: ' + shaped.mismatch_roles.join(', ') };
          } else {
            // No verdict: the inverter did not answer the readback. Honest and
            // calm - not an "Abweichung" (that would be the false alarm again).
            st = { fill: 'yellow', shape: 'ring', text: 'keine Rückmeldung: ' + shaped.unread_roles.join(', ') };
          }
          node.status(st);
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-control-readback', VpControlReadbackNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;

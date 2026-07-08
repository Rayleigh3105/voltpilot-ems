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
 *                    actual_raw, actual_kw?, match } ],
 *     all_match: boolean
 *   }
 */
'use strict';

const TOPIC = 'edge/control/readback';

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
  return {
    ts: typeof payload.ts === 'string' ? payload.ts : new Date().toISOString(),
    family: typeof payload.family === 'string' ? payload.family : '',
    source: typeof payload.source === 'string' ? payload.source : '',
    slot_start: typeof payload.slot_start === 'string' ? payload.slot_start : undefined,
    control_enabled: payload.control_enabled === true,
    certified: payload.certified === true,
    registers,
    all_match: registers.length > 0 && registers.every((r) => r.match === true),
    mismatch_roles: registers.filter((r) => r.match !== true).map((r) => r.role),
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
          node.status({
            fill: shaped.all_match ? 'green' : 'red',
            shape: 'dot',
            text: shaped.all_match
              ? 'bestätigt (' + shaped.registers.length + ' Register)'
              : 'Abweichung: ' + shaped.mismatch_roles.join(', '),
          });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-control-readback', VpControlReadbackNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;

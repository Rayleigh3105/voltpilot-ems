/**
 * vp-register-raw - publishes the inverter poll's RAW register blocks
 * RETAINED on the core agent's local bus (edge/registers/raw), feeding the
 * Modbus-Datenspiegel: the core's read-only Modbus-TCP mirror answers the
 * customer's building automation (Loxone) exclusively from this cache, so a
 * consumer never touches the single-client Solarman logger socket.
 *
 * Input:
 *   msg.payload = { ts: RFC3339, unit: <mb_slave_id>, blocks: [{ start,
 *                   regs: [u16...], learned?: true, count?, error? }] }
 *
 * Pure pass-through of data the poll already read - this node performs NO
 * device I/O and has NO write counterpart (the mirror is read-only by
 * construction). Retained + timestamped: a core restart re-serves instantly,
 * and its staleness guard keys on the payload ts, never the delivery time.
 */
'use strict';

const TOPIC = 'edge/registers/raw';

// shape() is exported for unit tests: validate/normalize the poll's block
// message, or null when there is nothing servable in it.
function shape(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.blocks) || payload.blocks.length === 0) return null;
  const blocks = [];
  for (const b of payload.blocks) {
    if (b == null || typeof b !== 'object') continue;
    const start = Number(b.start);
    if (!Number.isInteger(start) || start < 0 || start > 0xffff) continue;
    const out = { start };
    if (Array.isArray(b.regs) && b.regs.every((r) => Number.isInteger(r) && r >= 0 && r <= 0xffff)) {
      out.regs = b.regs;
    } else {
      out.regs = [];
    }
    if (b.learned) out.learned = true;
    if (Number.isInteger(b.count) && b.count > 0) out.count = b.count;
    if (typeof b.error === 'string' && b.error) out.error = b.error;
    if (out.regs.length === 0 && !out.error) continue; // nothing servable, nothing to report
    blocks.push(out);
  }
  if (blocks.length === 0) return null;
  const unit = Number(payload.unit);
  return {
    ts: typeof payload.ts === 'string' && !isNaN(Date.parse(payload.ts)) ? payload.ts : new Date().toISOString(),
    unit: Number.isInteger(unit) && unit >= 1 && unit <= 247 ? unit : 1,
    blocks,
  };
}

module.exports = function (RED) {
  function VpRegisterRawNode(config) {
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
        node.status({ fill: 'yellow', shape: 'ring', text: 'keine Registerbloecke im payload' });
        done();
        return;
      }
      client.publish(TOPIC, JSON.stringify(shaped), { qos: 1, retain: true }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({ fill: 'green', shape: 'dot', text: shaped.blocks.length + ' Bloecke' });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-register-raw', VpRegisterRawNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;

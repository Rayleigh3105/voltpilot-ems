/**
 * vp-sollwert - subscribes the core agent's setpoint command on the local
 * bus (edge/setpoint, retained) and emits it for a driver node (e.g. a
 * Modbus write) to apply to the inverter. The setpoint is ALREADY
 * guard-clamped by the core (power band, SoC bounds, §14a envelope) - the
 * flow only translates it to the device protocol.
 *
 * Output msg:
 *   msg.payload  = battery setpoint in kW (number, + = laden / - = entladen)
 *   msg.setpoint = the full command { battery_setpoint_kw, source, slot_start?, ts }
 */
'use strict';

const TOPIC = 'edge/setpoint';

// parse() is exported for unit tests: turns the local-bus JSON into the
// output message parts, or null for malformed payloads.
function parse(buf) {
  let cmd;
  try {
    cmd = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (cmd == null || typeof cmd.battery_setpoint_kw !== 'number' || !isFinite(cmd.battery_setpoint_kw)) {
    return null;
  }
  return { payload: cmd.battery_setpoint_kw, setpoint: cmd };
}

module.exports = function (RED) {
  function VpSollwertNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;

    const subscribe = () => {
      client.subscribe(TOPIC, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'green', shape: 'dot', text: 'wartet auf Sollwert' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== TOPIC) return;
      const parsed = parse(buf);
      if (!parsed) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültiger Sollwert verworfen' });
        return;
      }
      node.status({
        fill: 'blue',
        shape: 'dot',
        text: (parsed.setpoint.source || '?') + ' → ' + parsed.payload.toFixed(1) + ' kW',
      });
      node.send({ payload: parsed.payload, setpoint: parsed.setpoint, topic: topic });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-sollwert', VpSollwertNode);
};

module.exports.parse = parse;
module.exports.TOPIC = TOPIC;

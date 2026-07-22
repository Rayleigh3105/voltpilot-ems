/**
 * vp-node-status - the per-node live state tap of a deployed flow
 * (Portal v3 M5 Part C). flowc wires it from the compiled nodes; it publishes
 * {flow_id, node_id, state, text?, since?} on the local bus, the core folds
 * the set into its status heartbeat (feature-flagged), and the portal editor
 * renders it as "erfüllt" / "EIN seit 14:02" on the right node.
 *
 * Strictly REPORTING: it commands nothing and it is not on any control path.
 * A malformed input is dropped with a node status, never guessed at - an
 * invented node state would read to the customer as proof their rule fired.
 *
 * Input msg.payload:
 *   boolean                      true -> "active", false -> "idle"
 *   number                       -> "active" with the value as text
 *   { state, text?, since? }     the full shape
 */
'use strict';

const TOPIC = 'edge/flow/node-status';
const STATES = ['active', 'idle', 'error'];

/**
 * shape() is exported for unit tests: normalize an input into the local-bus
 * message, or null when it carries no usable state.
 */
function shape(payload, config, now) {
  const flowId = config && config.flowId;
  const nodeId = config && config.nodeId;
  if (!flowId || !nodeId) return null;

  let state = null;
  let text;
  if (typeof payload === 'boolean') {
    state = payload ? 'active' : 'idle';
  } else if (typeof payload === 'number' && isFinite(payload)) {
    state = 'active';
    text = String(payload);
  } else if (typeof payload === 'string' && STATES.indexOf(payload) >= 0) {
    state = payload;
  } else if (payload && typeof payload === 'object' && STATES.indexOf(payload.state) >= 0) {
    state = payload.state;
    if (typeof payload.text === 'string' && payload.text) text = payload.text.slice(0, 60);
  } else {
    return null;
  }

  const msg = {
    flow_id: String(flowId),
    node_id: String(nodeId),
    state: state,
    since: (now || new Date()).toISOString(),
  };
  if (text) msg.text = text;
  return msg;
}

module.exports = function (RED) {
  function VpNodeStatusNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;

    node.on('input', function (msg, send, done) {
      const shaped = shape(msg.payload, config);
      if (!shaped) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ohne Zustand verworfen' });
        done();
        return;
      }
      // NOT retained: a node state is live information; a retained stale state
      // would outlive the flow that produced it.
      client.publish(TOPIC, JSON.stringify(shaped), { qos: 0, retain: false }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
          return;
        }
        node.status({
          fill: shaped.state === 'error' ? 'red' : shaped.state === 'active' ? 'green' : 'grey',
          shape: 'dot',
          text: shaped.text || shaped.state,
        });
        // Pass through so the tap can sit inline without breaking a chain.
        send(msg);
        done();
      });
    });
  }

  RED.nodes.registerType('vp-node-status', VpNodeStatusNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;
module.exports.STATES = STATES;

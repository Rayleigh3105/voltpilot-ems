/**
 * vp-desired - the ONLY actuation-capable palette node of the v2 flow
 * runtime: publishes a DESIRED value ("Wunsch") on the core agent's
 * arbitration topic edge/entities/<entity>/desired (contract:
 * docs/contracts/v2/edge-desired-arbitration.md + edge-desired.schema.json).
 *
 * Flows never write registers and never publish actuation topics - the core
 * arbitrates (priority classes, TTL, conflicts), clamps the winner through
 * the per-entity guard chain and alone publishes the retained command the
 * driver layer executes. This node also subscribes the entity's arbitration
 * events and exposes the decisions concerning ITS desires on its output port
 * ("the flow SEES the clamp but cannot circumvent it").
 *
 * Config (stamped by the flowc compiler, never customer-edited):
 *   entity      - target entity id (topic-safe)
 *   command     - setpoint_kw | on_off | limit_pct | limit_kw | mode
 *   ttl_s       - REQUIRED desired TTL (1..86400; desires are never retained,
 *                 the flow re-emits on its triggers)
 *   override    - true = the D-5 boost escape hatch (elevates above market)
 *   flowId/flowVersion/nodeId - the compiler-stamped source identity
 *
 * Input:  msg.payload = the wished value (number/boolean/string per command).
 * Output: msg.payload = the arbitration event about this node's desired
 *         (accepted / clamped / rejected / superseded / expired).
 */
'use strict';

const PREFIX = 'edge/entities/';
const SCHEMA_VERSION = '1.0';
const COMMANDS = ['setpoint_kw', 'on_off', 'limit_pct', 'limit_kw', 'mode'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// shape() is exported for unit tests: build the desired payload for one
// wished value, or null when the value does not fit the command type. The
// request_id is stable per (node, value) so a re-emission of the SAME
// standing wish refreshes the holder's TTL (contract §5) while a changed
// value reads as a new request.
function shape(cfg, value, nowIso) {
  if (!cfg || !ID_RE.test(cfg.entity || '') || COMMANDS.indexOf(cfg.command) < 0) return null;
  const ttl = Math.floor(Number(cfg.ttl_s));
  if (!(ttl >= 1 && ttl <= 86400)) return null;
  if (!cfg.flowId || !(Number(cfg.flowVersion) >= 1) || !cfg.nodeId) return null;

  let v = value;
  switch (cfg.command) {
    case 'setpoint_kw':
      v = typeof v === 'string' ? Number(v) : v;
      if (typeof v !== 'number' || !isFinite(v)) return null;
      break;
    case 'limit_kw':
      v = typeof v === 'string' ? Number(v) : v;
      if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
      break;
    case 'limit_pct':
      v = typeof v === 'string' ? Number(v) : v;
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) return null;
      break;
    case 'on_off':
      if (typeof v === 'number') v = v !== 0;
      if (typeof v !== 'boolean') return null;
      break;
    case 'mode':
      if (typeof v !== 'string' || v.length < 1 || v.length > 64) return null;
      break;
  }

  const fingerprint = typeof v === 'number' ? v.toString() : String(v);
  const payload = {
    schema_version: SCHEMA_VERSION,
    entity_id: cfg.entity,
    request_id: cfg.nodeId + ':' + fingerprint,
    source: {
      kind: 'flow',
      flow_id: cfg.flowId,
      flow_version: Number(cfg.flowVersion),
      node_id: cfg.nodeId,
    },
    priority: 'flow', // always class flow - the core enforces it anyway
    command: { type: cfg.command, value: v },
    ttl_s: ttl,
    issued_at: nowIso || new Date().toISOString(),
  };
  if (cfg.override === true || cfg.override === 'true') payload.override = true;
  return payload;
}

function desiredTopic(entity) {
  return PREFIX + entity + '/desired';
}

function arbitrationTopic(entity) {
  return PREFIX + entity + '/arbitration';
}

// mine() is exported for unit tests: does an arbitration event concern this
// node's desires (subject.source.node_id match)?
function mine(cfg, event) {
  if (!event || typeof event !== 'object') return false;
  const src = event.subject && event.subject.source;
  return !!src && src.kind === 'flow' && src.node_id === cfg.nodeId && src.flow_id === cfg.flowId;
}

module.exports = function (RED) {
  function VpDesiredNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;
    const cfg = {
      entity: config.entity,
      command: config.command,
      ttl_s: config.ttl_s,
      override: config.override,
      flowId: config.flowId,
      flowVersion: config.flowVersion,
      nodeId: config.nodeId || config.id,
    };

    // Arbitration feedback: status + output port.
    const arbTopic = arbitrationTopic(cfg.entity);
    const subscribe = () => {
      client.subscribe(arbTopic, { qos: 1 }, () => {});
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    const onMessage = (topic, buf) => {
      if (topic !== arbTopic) return;
      let event;
      try {
        event = JSON.parse(buf.toString());
      } catch (e) {
        return;
      }
      if (!mine(cfg, event)) return;
      const fill = event.outcome === 'accepted' ? 'green' : event.outcome === 'clamped' ? 'yellow' : 'red';
      node.status({ fill, shape: 'dot', text: event.outcome });
      node.send({ payload: event, topic: arbTopic });
    };
    client.on('message', onMessage);
    node.on('close', () => client.removeListener('message', onMessage));

    node.on('input', function (msg, send, done) {
      const payload = shape(cfg, msg.payload);
      if (!payload) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'unbrauchbarer Wunschwert' });
        done();
        return;
      }
      client.publish(desiredTopic(cfg.entity), JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({ fill: 'blue', shape: 'dot', text: 'Wunsch ' + String(msg.payload) });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-desired', VpDesiredNode);
};

module.exports.shape = shape;
module.exports.mine = mine;
module.exports.desiredTopic = desiredTopic;
module.exports.arbitrationTopic = arbitrationTopic;

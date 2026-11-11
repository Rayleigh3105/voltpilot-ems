/**
 * vp-consumer-policy - the GENERATED reactive consumer-policy runtime node
 * (Verbrauchssteuerung Inkrement 4 §13.2, contract decision D-19). The flowc
 * compiler is its only author; its config is the cloud-compiled reactive spec
 * of ONE consumer policy.
 *
 * It evaluates the spec locally via lib/reactive-eval.js (three-state logic,
 * per-signal max_age_s freshness, hysteresis, precompiled UTC price windows,
 * off-delay debounce) and, while the merged condition holds, publishes a
 * DESIRED on edge/entities/<entity>/desired - the SAME payload shape as
 * vp-desired (its exported shape() is reused, one truth), with `override`
 * stamped exactly when an ACTIVE requirement carries must_run (the D-5 boost;
 * the core's 4-h override cap and the whole guard chain stay authoritative).
 *
 * Withdrawal is the desired contract's TTL: when the condition ends (after
 * the off-delay), this node simply STOPS renewing and the core lets the wish
 * expire - desires are never retained, there is no release message.
 *
 * Signal sources:
 *   - site signals (storage SoC, PV surplus, grid flow) from the local
 *     composite edge/telemetry;
 *   - consumer signals (vehicle_connected, available, ...) from the entity's
 *     own edge/entities/<entity>/telemetry channels.
 */
'use strict';

// The I/O-free half (signal mapping, evaluation, publish decision) lives in
// lib/consumer-policy-runtime.js so Edge Light's Go twin is held to the same
// vectors (docs/contracts/v2/verbraucherregel-vectors.json).
const { Runtime, siteSignals, entitySignals } = require('../lib/consumer-policy-runtime');

const SITE_TOPIC = 'edge/telemetry';
const PREFIX = 'edge/entities/';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

module.exports = function (RED) {
  function VpConsumerPolicyNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const entity = String(config.entity || '');
    if (!ID_RE.test(entity)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Entität ungültig' });
      return;
    }
    const client = core.client;
    const runtime = new Runtime(config);
    const entityTopic = PREFIX + entity + '/telemetry';

    const subscribe = () => {
      client.subscribe(SITE_TOPIC, { qos: 1 }, () => {});
      client.subscribe(entityTopic, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Signale' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);

    // Send what the runtime decided and show the verdict.
    const apply = ({ result, publish, unusable }) => {
      if (unusable) node.status({ fill: 'yellow', shape: 'ring', text: 'unbrauchbarer Zielwert' });
      if (publish) {
        client.publish(PREFIX + entity + '/desired', JSON.stringify(publish), { qos: 1 }, (err) => {
          if (err) node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
        });
      }
      if (result.active) {
        node.status({
          fill: 'green',
          shape: 'dot',
          text: (result.held ? 'endet gleich · ' : 'aktiv · ') + result.requirementIds.join(','),
        });
      } else {
        node.status({
          fill: 'grey',
          shape: result.anyUnknown ? 'ring' : 'dot',
          text: result.anyUnknown ? 'Signal unbekannt/veraltet' : 'Bedingung nicht erfüllt',
        });
      }
    };

    const onMessage = (msgTopic, buf) => {
      if (msgTopic !== SITE_TOPIC && msgTopic !== entityTopic) return;
      let obj;
      try {
        obj = JSON.parse(buf.toString());
      } catch (e) {
        return;
      }
      const now = Date.now();
      // react immediately (Fahrzeug anstecken -> sofort)
      apply(msgTopic === SITE_TOPIC ? runtime.onSite(obj, now) : runtime.onEntity(obj, now));
    };
    client.on('message', onMessage);
    node.on('close', () => client.removeListener('message', onMessage));

    // The compiled interval trigger drives renewal + staleness re-checks.
    node.on('input', function (msg, send, done) {
      apply(runtime.onTrigger(Date.now()));
      done();
    });
  }

  RED.nodes.registerType('vp-consumer-policy', VpConsumerPolicyNode);
};

module.exports.siteSignals = siteSignals;
module.exports.entitySignals = entitySignals;

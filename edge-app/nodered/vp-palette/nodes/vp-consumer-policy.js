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

const { Engine } = require('../lib/reactive-eval');
const { shape } = require('./vp-desired');

const SITE_TOPIC = 'edge/telemetry';
const PREFIX = 'edge/entities/';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * siteSignals() is exported for unit tests: map one composite edge/telemetry
 * payload onto the site signal channels. Absent inputs stay absent - the
 * surplus is only computable when BOTH pv and load were measured (never a
 * fabricated 0, §3.3).
 */
function siteSignals(obj) {
  if (obj == null || typeof obj !== 'object') return {};
  const out = {};
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const soc = num(obj.soc_pct);
  if (soc !== null) out.soc_pct = soc;
  const grid = num(obj.power_kw);
  if (grid !== null) out.grid_power_kw = grid;
  const pv = num(obj.pv_power_kw);
  const load = num(obj.load_kw);
  if (pv !== null && load !== null) out.pv_surplus_kw = pv - load;
  return out;
}

/** entitySignals(): numeric channels of one entity telemetry payload. */
function entitySignals(entity, obj) {
  if (obj == null || typeof obj !== 'object') return {};
  if (obj.schema_version !== '1.0' || obj.entity_id !== entity) return {};
  const channels = obj.channels;
  if (channels == null || typeof channels !== 'object') return {};
  const out = {};
  for (const key of Object.keys(channels)) {
    const v = channels[key];
    if (typeof v === 'number' && isFinite(v)) out[key] = v;
  }
  return out;
}

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
    const spec = {
      command: config.command,
      off_delay_s: Number(config.off_delay_s) || 0,
      requirements: Array.isArray(config.requirements) ? config.requirements : [],
    };
    const engine = new Engine(spec);
    const entityTopic = PREFIX + entity + '/telemetry';
    const baseCfg = {
      entity,
      command: config.command,
      ttl_s: config.ttl_s,
      flowId: config.flowId,
      flowVersion: config.flowVersion,
      nodeId: config.nodeId || config.id,
    };
    let lastFingerprint = null; // of the last published desired

    const subscribe = () => {
      client.subscribe(SITE_TOPIC, { qos: 1 }, () => {});
      client.subscribe(entityTopic, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Signale' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);

    const publish = (result) => {
      const payload = shape({ ...baseCfg, override: result.mustRun === true }, result.value);
      if (!payload) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'unbrauchbarer Zielwert' });
        return;
      }
      client.publish(PREFIX + entity + '/desired', JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
      });
      lastFingerprint = payload.request_id + '|' + (result.mustRun === true);
    };

    // fromTrigger = a compiled interval tick (the TTL renewal cadence): while
    // active, ALWAYS re-publish. A telemetry-driven evaluation publishes only
    // when the desired CHANGED (transition / new value) so a 5-s telemetry
    // loop cannot multiply the renewal rate.
    const evaluate = (fromTrigger) => {
      const result = engine.evaluate(Date.now());
      if (result.active) {
        const payload = shape({ ...baseCfg, override: result.mustRun === true }, result.value);
        const fingerprint = payload ? payload.request_id + '|' + (result.mustRun === true) : null;
        if (fromTrigger || fingerprint !== lastFingerprint) publish(result);
        node.status({
          fill: 'green',
          shape: 'dot',
          text: (result.held ? 'endet gleich · ' : 'aktiv · ') + result.requirementIds.join(','),
        });
      } else {
        lastFingerprint = null;
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
      if (msgTopic === SITE_TOPIC) {
        const signals = siteSignals(obj);
        for (const key of Object.keys(signals)) engine.updateSignal('site', key, signals[key], now);
      } else {
        const signals = entitySignals(entity, obj);
        for (const key of Object.keys(signals)) engine.updateSignal('entity', key, signals[key], now);
      }
      evaluate(false); // react immediately (Fahrzeug anstecken -> sofort)
    };
    client.on('message', onMessage);
    node.on('close', () => client.removeListener('message', onMessage));

    // The compiled interval trigger drives renewal + staleness re-checks.
    node.on('input', function (msg, send, done) {
      evaluate(true);
      done();
    });
  }

  RED.nodes.registerType('vp-consumer-policy', VpConsumerPolicyNode);
};

module.exports.siteSignals = siteSignals;
module.exports.entitySignals = entitySignals;

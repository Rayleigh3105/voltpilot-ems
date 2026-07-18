/**
 * vp-feed - the v2 flow runtime's platform data feeds (Strompreis /
 * PV-Prognose): subscribes ONE of the core's RESERVED retained feed topics
 * and emits the parsed payload. The feed set is a fixed WHITELIST - a
 * compiled flow can never subscribe an arbitrary topic through this node.
 *
 *   feed "prices"      -> edge/prices        (day-ahead price series; the E4
 *                         price down-channel mirrored locally by the core -
 *                         reserved, the core does not feed it yet)
 *   feed "pv_forecast" -> edge/forecast/pv   (site PV forecast - reserved)
 *
 * Until the core feeds a topic the node simply stays "keine Daten" - a flow
 * built on it is idle-safe, exactly like the self-wiring tabs without a
 * selection. An INPUT message re-emits the last payload (trigger semantics,
 * the vp-entity-read convention).
 */
'use strict';

const FEEDS = {
  prices: 'edge/prices',
  pv_forecast: 'edge/forecast/pv',
};

// topicFor is exported for unit tests: whitelist only, null otherwise.
function topicFor(feed) {
  return Object.prototype.hasOwnProperty.call(FEEDS, feed) ? FEEDS[feed] : null;
}

module.exports = function (RED) {
  function VpFeedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const topic = topicFor(config.feed);
    if (!topic) {
      node.status({ fill: 'red', shape: 'ring', text: 'unbekannter Feed' });
      return;
    }
    const client = core.client;
    let last = null;

    const subscribe = () => {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'keine Daten' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);

    const onMessage = (msgTopic, buf) => {
      if (msgTopic !== topic) return;
      let payload;
      try {
        payload = JSON.parse(buf.toString());
      } catch (e) {
        return; // malformed feed data: stay idle-safe, never emit garbage
      }
      last = payload;
      node.status({ fill: 'green', shape: 'dot', text: 'Daten empfangen' });
      node.send({ payload, topic });
    };
    client.on('message', onMessage);
    node.on('close', () => client.removeListener('message', onMessage));

    node.on('input', function (msg, send, done) {
      if (last !== null) node.send({ payload: last, topic });
      done();
    });
  }

  RED.nodes.registerType('vp-feed', VpFeedNode);
};

module.exports.topicFor = topicFor;
module.exports.FEEDS = FEEDS;

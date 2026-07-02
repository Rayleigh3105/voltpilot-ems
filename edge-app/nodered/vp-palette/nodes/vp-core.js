/**
 * vp-core - shared config node: the connection to the VoltPilot core agent's
 * embedded local MQTT bus. All vp-* nodes reference one vp-core node, so a
 * per-customer flow never hardcodes broker details. Defaults match the
 * edge-app docker-compose (service name "core", bus port 1883).
 */
'use strict';

const mqtt = require('mqtt');

module.exports = function (RED) {
  function VpCoreNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.host = config.host || process.env.VP_CORE_HOST || 'core';
    node.port = parseInt(config.port || process.env.VP_CORE_PORT || '1883', 10);

    node.client = mqtt.connect(`mqtt://${node.host}:${node.port}`, {
      clientId: `vp-nodered-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
    });
    node.client.setMaxListeners(0);

    node.on('close', function (done) {
      node.client.end(true, {}, done);
    });
  }

  RED.nodes.registerType('vp-core', VpCoreNode);
};

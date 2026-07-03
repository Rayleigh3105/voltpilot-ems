/**
 * vp-core - shared config node: the connection to the VoltPilot core agent's
 * embedded local MQTT bus. All vp-* nodes reference one vp-core node, so a
 * per-customer flow never hardcodes broker details. Defaults match the
 * edge-app docker-compose (service name "core", bus port 1883).
 *
 * VP_CORE_HOST / VP_CORE_PORT take PRECEDENCE over the flow's stored config so
 * a deployment mode can redirect the bus without editing the seeded flow. This
 * is what host-networking mode uses (docker-compose.hostnet.yml): on the host
 * network the "core" service name no longer resolves, so those env vars point
 * the bus at the core's host-loopback mapping (127.0.0.1:${VP_BUS_PORT}).
 */
'use strict';

const mqtt = require('mqtt');

module.exports = function (RED) {
  function VpCoreNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.host = process.env.VP_CORE_HOST || config.host || 'core';
    node.port = parseInt(process.env.VP_CORE_PORT || config.port || '1883', 10);

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

'use strict';
const status = require('../../measurements/data-source-status');
module.exports = function (RED) {
  function DataSourceStatus(config) {
    RED.nodes.createNode(this, config);
    const core = RED.nodes.getNode(config.core);
    this.on('input', (msg, send, done) => {
      const value = status.event(msg.payload);
      if (value && core) core.client.publish(status.TOPIC, JSON.stringify(value), { qos:1, retain:false });
      if (done) done();
    });
  }
  RED.nodes.registerType('vp-data-source-status', DataSourceStatus);
};

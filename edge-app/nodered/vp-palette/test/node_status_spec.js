'use strict';
// vp-node-status (Portal v3 M5 Part C): the per-node live state tap. The
// shaping rules carry the honesty - an input without a usable state is DROPPED
// (an invented node state would read to the customer as proof their rule
// fired), and the message always names the flow + node it belongs to.
const assert = require('assert');
const { shape, TOPIC } = require('../nodes/vp-node-status');

const CFG = { flowId: 'flow-1', nodeId: 'schwelle1' };
const NOW = new Date('2026-07-22T14:02:00.000Z');

describe('vp-node-status shape()', function () {
  it('publishes on the local-bus flow-node-status topic', function () {
    assert.strictEqual(TOPIC, 'edge/flow/node-status');
  });

  it('maps a boolean condition onto active/idle', function () {
    assert.deepStrictEqual(shape(true, CFG, NOW), {
      flow_id: 'flow-1', node_id: 'schwelle1', state: 'active',
      since: '2026-07-22T14:02:00.000Z',
    });
    assert.strictEqual(shape(false, CFG, NOW).state, 'idle');
  });

  it('carries a number as the node text', function () {
    const msg = shape(2.9, CFG, NOW);
    assert.strictEqual(msg.state, 'active');
    assert.strictEqual(msg.text, '2.9');
  });

  it('accepts the full shape and caps the text', function () {
    const msg = shape({ state: 'error', text: 'x'.repeat(200) }, CFG, NOW);
    assert.strictEqual(msg.state, 'error');
    assert.strictEqual(msg.text.length, 60);
  });

  it('drops anything without a usable state - never a guessed one', function () {
    assert.strictEqual(shape(null, CFG, NOW), null);
    assert.strictEqual(shape('bunt', CFG, NOW), null);
    assert.strictEqual(shape({ state: 'vielleicht' }, CFG, NOW), null);
    assert.strictEqual(shape(true, { flowId: '', nodeId: 'x' }, NOW), null);
    assert.strictEqual(shape(true, {}, NOW), null);
  });
});

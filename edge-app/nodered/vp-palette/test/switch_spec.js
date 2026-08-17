/**
 * The two SWITCH nodes (Einheitsmodell Stufe 4).
 *
 * The safety properties under test are the ones a customer's own device depends
 * on: only released values reach a register, the shared per-target queue is the
 * ONE Modbus path (a switch never displaces a running read), the failsafe
 * writes actively, and the plant-wide gate is fail-closed.
 */
'use strict';

const assert = require('assert');
const net = require('net');

const sw = require('../lib/switch-write.js');
const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');
const switchTest = require('../nodes/vp-modbus-switch-test.js');
const switchNode = require('../nodes/vp-modbus-switch.js');

/**
 * A SINGLE-SESSION Modbus gateway: it serves one client at a time and answers
 * slowly, which is exactly the device class the one-socket law exists for.
 */
function gateway(opts) {
  const o = opts || {};
  const state = {
    holding: new Map(), coils: new Map(), inFlight: 0, maxInFlight: 0, writes: [],
  };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', (buf) => {
      // ⚠ Gezaehlt werden ANFRAGEN, nicht Sockets: ein Client, der seinen
      // Socket zerstoert hat, taucht serverseitig erst beim naechsten
      // Event-Loop-Durchlauf als geschlossen auf - unter Last zaehlte das
      // einen laengst beendeten Vorgang als zweiten mit. Die Regel lautet
      // „ein Vorgang je Ziel", und genau das misst dieser Zaehler.
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const txid = buf.readUInt16BE(0);
      const unit = buf[6];
      const fn = buf[7];
      const addr = buf.readUInt16BE(8);
      const reply = (body) => {
        const head = Buffer.alloc(6);
        head.writeUInt16BE(txid, 0);
        head.writeUInt16BE(0, 2);
        head.writeUInt16BE(body.length, 4);
        setTimeout(() => {
          state.inFlight--;
          try { sock.write(Buffer.concat([head, body])); } catch (e) {}
        }, o.delayMs || 5);
      };
      if (fn === 0x05) {
        const on = buf.readUInt16BE(10) === 0xff00;
        state.writes.push({ fn, addr, value: on ? 1 : 0 });
        if (!o.swallow) state.coils.set(addr, on ? 1 : 0);
        reply(Buffer.from([unit, 0x05, buf[8], buf[9], buf[10], buf[11]]));
        return;
      }
      if (fn === 0x10) {
        const v = buf.readUInt16BE(13);
        state.writes.push({ fn, addr, value: v });
        if (!o.swallow) state.holding.set(addr, v);
        reply(Buffer.from([unit, 0x10, buf[8], buf[9], buf[10], buf[11]]));
        return;
      }
      if (fn === 0x01) {
        reply(Buffer.from([unit, 0x01, 1, state.coils.get(addr) || 0]));
        return;
      }
      if (fn === 0x03) {
        const v = state.holding.get(addr) || 0;
        reply(Buffer.from([unit, 0x03, 2, (v >> 8) & 0xff, v & 0xff]));
        return;
      }
      reply(Buffer.from([unit, fn | 0x80, 0x02]));
    });
  });
  state.server = server;
  return state;
}

function listen(state) {
  return new Promise((res) => state.server.listen(0, '127.0.0.1', () => res(state.server.address().port)));
}

describe('vp-modbus switch nodes', function () {
  it('writes a coil through the SHARED queue and reads it back', async function () {
    const gw = gateway();
    const port = await listen(gw);
    const res = await sw.runWrite({
      id: 'relais', host: '127.0.0.1', port, unit_id: 1,
      fc: codec.FN_WRITE_COIL, address: 3, value: 1, readback_address: 3,
    }, sw.liveDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.readback, 1);
    assert.deepStrictEqual(gw.writes, [{ fn: 0x05, addr: 3, value: 1 }]);
    gw.server.close();
  });

  it('writes a holding register with FC16 by default and never with FC6', async function () {
    const gw = gateway();
    const port = await listen(gw);
    const res = await sw.runWrite({
      id: 'sollwert', host: '127.0.0.1', port, unit_id: 1,
      fc: codec.FN_WRITE_MULTIPLE, address: 100, value: 3000, readback_address: 100,
    }, sw.liveDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.readback, 3000);
    assert.strictEqual(gw.writes[0].fn, 0x10);
    gw.server.close();
  });

  it('shares the ONE per-target queue with a read - never a second socket', async function () {
    // The device serves one client at a time; if a write opened its own
    // connection while a read was in flight, maxConcurrent would exceed 1.
    const gw = gateway({ delayMs: 40 });
    const port = await listen(gw);
    const plan = { host: '127.0.0.1', port, unitId: 1, fc: codec.FN_READ_HOLDING, addr: 100, count: 1 };
    await Promise.all([
      conn.readRegisters(plan),
      sw.runWrite({ id: 'a', host: '127.0.0.1', port, unit_id: 1, fc: codec.FN_WRITE_MULTIPLE, address: 100, value: 7 }, sw.liveDeps),
      conn.readRegisters(plan),
      sw.runWrite({ id: 'b', host: '127.0.0.1', port, unit_id: 1, fc: codec.FN_WRITE_MULTIPLE, address: 100, value: 9 }, sw.liveDeps),
    ]);
    assert.strictEqual(gw.maxInFlight, 1, 'a switch must never run a second operation in parallel');
    gw.server.close();
  });

  it('a device that swallows the write is caught by the readback, not by the echo', async function () {
    // The Fronius/Deye lesson: the frame is ACCEPTED and the register does not
    // change. The write "succeeds", and only the readback tells the truth.
    const gw = gateway({ swallow: true });
    const port = await listen(gw);
    const res = await sw.runWrite({
      id: 'relais', host: '127.0.0.1', port, unit_id: 1,
      fc: codec.FN_WRITE_COIL, address: 3, value: 1, readback_address: 3,
    }, sw.liveDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.readback, 0, 'the readback must show what really stands there');
    gw.server.close();
  });

  it('names an unreachable device instead of failing silently', async function () {
    const res = await sw.runWrite({
      id: 'relais', host: '127.0.0.1', port: 1, unit_id: 1,
      fc: codec.FN_WRITE_COIL, address: 0, value: 1,
    }, sw.liveDeps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, sw.ERR_UNREACHABLE);
    assert.ok(res.message.length > 0);
  });

  it('refuses a value the release never covered', function () {
    // A coil takes 0/1 and nothing else; an unknown function code is refused
    // outright rather than guessed into a register write.
    assert.strictEqual(sw.writePlan({ host: 'x', address: 0, value: 300, fc: 5 }), null);
    assert.strictEqual(sw.writePlan({ host: 'x', address: 0, value: 1, fc: 3 }), null);
    assert.strictEqual(sw.writePlan({ host: 'x', address: 70000, value: 1, fc: 5 }), null);
    assert.strictEqual(sw.writePlan({ host: '  ', address: 0, value: 1, fc: 5 }), null);
    assert.ok(sw.writePlan({ host: 'x', address: 0, value: 1, fc: 5 }));
  });

  it('runs the ops of one request SEQUENTIALLY', async function () {
    const order = [];
    const deps = {
      writeValue: (p) => new Promise((r) => {
        order.push('start' + p.value);
        setTimeout(() => { order.push('end' + p.value); r(); }, 10);
      }),
      readRegisters: () => Promise.resolve([0]),
      readCoils: () => Promise.resolve([0]),
    };
    await switchTest.runOps([
      { id: 'a', host: 'x', address: 0, value: 1, fc: 5 },
      { id: 'b', host: 'x', address: 0, value: 0, fc: 5 },
    ], deps);
    assert.deepStrictEqual(order, ['start1', 'end1', 'start0', 'end0']);
  });

  it('drops a malformed bus request without answering', function () {
    assert.strictEqual(switchTest.parse(Buffer.from('nicht json')), null);
    assert.strictEqual(switchTest.parse(Buffer.from(JSON.stringify({ ops: [] }))), null);
    assert.strictEqual(switchTest.parse(Buffer.from(JSON.stringify({ request_id: 'a', ops: [] }))), null);
    assert.ok(switchTest.parse(Buffer.from(JSON.stringify({ request_id: 'a', ops: [{ id: 'x' }] }))));
  });

  describe('the released executor', function () {
    it('writes only the two released constants for an on/off device', function () {
      const cfg = { kind: 'on_off', on_value: 1, off_value: 0 };
      assert.strictEqual(switchNode.plan(cfg, { on_off: true }), 1);
      assert.strictEqual(switchNode.plan(cfg, { on_off: false }), 0);
      // A setpoint wish on an on/off device becomes on/off, never a third value.
      assert.strictEqual(switchNode.plan(cfg, { setpoint_kw: 7 }), 1);
      assert.strictEqual(switchNode.plan(cfg, { setpoint_kw: 0 }), 0);
      // Nothing actionable -> nothing written (the caller then uses the safe value).
      assert.strictEqual(switchNode.plan(cfg, {}), null);
    });

    it('never writes outside the released clamp, in either scale direction', function () {
      const up = { kind: 'setpoint', min_value: 1, max_value: 10, safe_value: 0, scale: 0.001, offset: 0 };
      assert.strictEqual(switchNode.plan(up, { setpoint_kw: 5 }), 5000);
      assert.strictEqual(switchNode.plan(up, { setpoint_kw: 99 }), 10000, 'clamped to max');
      assert.strictEqual(switchNode.plan(up, { setpoint_kw: -99 }), 1000, 'clamped to min');
      // A NEGATIVE scale flips the raw order; the raw clamp is what keeps the
      // promise regardless of what the conversion does.
      const down = { kind: 'setpoint', min_value: 1, max_value: 10, safe_value: 1, scale: -100, offset: 2000 };
      const lo = switchNode.plan(down, { setpoint_kw: -99 });
      const hi = switchNode.plan(down, { setpoint_kw: 99 });
      const bounds = [switchNode.plan(down, { setpoint_kw: 1 }), switchNode.plan(down, { setpoint_kw: 10 })];
      assert.ok(lo >= Math.min.apply(null, bounds) && lo <= Math.max.apply(null, bounds));
      assert.ok(hi >= Math.min.apply(null, bounds) && hi <= Math.max.apply(null, bounds));
      // And never outside a 16-bit register whatever the arithmetic says.
      [lo, hi].forEach((v) => assert.ok(v >= 0 && v <= 65535));
    });

    it('an explicit off writes the SAFE value, even below the operating band', function () {
      // The safe value is its own released constant and normally sits BELOW the
      // operating minimum - clamping it into the band would turn "off" into
      // "keep running slowly".
      const cfg = { kind: 'setpoint', min_value: 2, max_value: 10, safe_value: 0, scale: 0.001, offset: 0 };
      assert.strictEqual(switchNode.plan(cfg, { on_off: false }), 0);
      assert.strictEqual(switchNode.safeValue(cfg), 0);
      // ...while an ordinary wish is still clamped INTO the band.
      assert.strictEqual(switchNode.plan(cfg, { setpoint_kw: 0 }), 2000);
    });

    it('a failed write carries its class and NO all_match', function () {
      const bad = switchNode.readbackPayload('e1', 't', 1, undefined,
        { error_code: 'unreachable', message: 'weg' });
      assert.strictEqual(bad.all_match, undefined, 'no evidence must stay no evidence');
      assert.strictEqual(bad.error_code, 'unreachable');
      const noRb = switchNode.readbackPayload('e1', 't', 1, undefined);
      assert.strictEqual(noRb.all_match, undefined);
      const ok = switchNode.readbackPayload('e1', 't', 1, 1);
      assert.strictEqual(ok.all_match, true);
      const miss = switchNode.readbackPayload('e1', 't', 1, 0);
      assert.strictEqual(miss.all_match, false);
    });

    it('the re-assert is shorter than the staleness window', function () {
      // Otherwise a healthy command would time itself out between two writes.
      assert.ok(switchNode.REASSERT_MS < switchNode.STALE_MS);
    });
  });
});

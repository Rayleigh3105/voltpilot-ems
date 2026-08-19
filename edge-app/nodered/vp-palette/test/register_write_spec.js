/**
 * The ONE-SHOT register write of the plain Modbus-TCP lane (Register schreiben
 * über das Portal, Stufe 2 „Freie Register").
 *
 * The properties under test are the ones a customer's own device depends on:
 * exactly ONE write attempt, the read-before/read-back that turns a claim into
 * evidence, the `expected_before` guard, the LAN whitelist as a property of the
 * code that opens the socket, and the SHARED per-target queue - a register write
 * must never displace the running poll of the very device the customer watches.
 */
'use strict';

const assert = require('assert');
const net = require('net');

const rw = require('../lib/register-write.js');
const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');

/** A SINGLE-SESSION Modbus gateway - the device class the one-socket law exists for. */
function gateway(opts) {
  const o = opts || {};
  const state = {
    holding: new Map(), coils: new Map(), inFlight: 0, maxInFlight: 0, writes: [], reads: [],
  };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', (buf) => {
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
          try { sock.write(Buffer.concat([head, body])); } catch (e) { /* closed */ }
        }, o.delayMs || 5);
      };
      if (fn === 0x05) {
        const on = buf.readUInt16BE(10) === 0xff00;
        state.writes.push({ fn, addr, value: on ? 1 : 0 });
        if (!o.swallow) state.coils.set(addr, on ? 1 : 0);
        reply(Buffer.from([unit, 0x05, buf[8], buf[9], buf[10], buf[11]]));
        return;
      }
      if (fn === 0x06 || fn === 0x10) {
        const v = fn === 0x06 ? buf.readUInt16BE(10) : buf.readUInt16BE(13);
        state.writes.push({ fn, addr, value: v });
        if (!o.swallow) state.holding.set(addr, v);
        reply(Buffer.from([unit, fn, buf[8], buf[9], buf[10], buf[11]]));
        return;
      }
      if (fn === 0x01) {
        state.reads.push({ fn, addr });
        reply(Buffer.from([unit, 0x01, 1, state.coils.get(addr) || 0]));
        return;
      }
      if (fn === 0x03) {
        state.reads.push({ fn, addr });
        const v = state.holding.has(addr) ? state.holding.get(addr) : 0;
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

// A settle of 2 s is right on a device and pointless in a test.
const fastDeps = Object.assign({}, rw.liveDeps, { sleep: () => Promise.resolve() });

describe('vp-register-write (die schlichte Modbus-TCP-Lane)', function () {
  it('liest, schreibt GENAU EINMAL und liest zurück', async function () {
    const gw = gateway();
    const port = await listen(gw);
    gw.holding.set(0x00e7, 3300);
    const res = await rw.runOnce({
      request_id: 'a1', mode: 'apply', kind: 'holding', addr: 0x00e7, value: 7000,
      host: '127.0.0.1', port, unit_id: 1,
    }, fastDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(res.before, 3300, 'der Ist-Wert VOR dem Schreiben');
    assert.strictEqual(res.after, 7000);
    assert.strictEqual(gw.writes.length, 1, 'GENAU ein Schreibversuch - EEPROM');
    assert.strictEqual(gw.writes[0].fn, 0x10, 'FC16 ist die Vorauswahl fürs Holding-Register');
    assert.strictEqual(gw.reads.length, 2, 'davor und danach gelesen');
    gw.server.close();
  });

  it('ein Probelauf liest und schreibt NICHTS', async function () {
    const gw = gateway();
    const port = await listen(gw);
    gw.holding.set(50, 1234);
    const res = await rw.runOnce({
      request_id: 'a2', mode: 'dry_run', kind: 'holding', addr: 50,
      host: '127.0.0.1', port, unit_id: 1,
    }, fastDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, false);
    assert.strictEqual(res.before, 1234);
    assert.strictEqual(gw.writes.length, 0, 'eine Vorschau fasst das Gerät nicht an');
    gw.server.close();
  });

  it('eine Spule wird mit FC5 geschrieben und mit FC1 zurückgelesen', async function () {
    const gw = gateway();
    const port = await listen(gw);
    const res = await rw.runOnce({
      request_id: 'a3', mode: 'apply', kind: 'coil', addr: 3, value: 1,
      host: '127.0.0.1', port, unit_id: 1,
    }, fastDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.after, 1);
    assert.deepStrictEqual(gw.writes, [{ fn: 0x05, addr: 3, value: 1 }]);
    assert.ok(gw.reads.every((r) => r.fn === 0x01), 'eine Spule wird als Spule gelesen');
    gw.server.close();
  });

  it('⚠ expected_before verhindert den Schreibvorgang, statt blind zu überschreiben', async function () {
    const gw = gateway();
    const port = await listen(gw);
    gw.holding.set(0x00e7, 5000); // jemand anderes war schneller
    const res = await rw.runOnce({
      request_id: 'a4', mode: 'apply', kind: 'holding', addr: 0x00e7, value: 7000,
      expected_before: 3300, host: '127.0.0.1', port, unit_id: 1,
    }, fastDeps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'precondition');
    assert.strictEqual(res.wrote, false);
    assert.strictEqual(res.before, 5000, 'der WIRKLICHE Ist-Wert reist mit');
    assert.ok(res.message.includes('NICHTS geschrieben'));
    assert.strictEqual(gw.writes.length, 0);
    gw.server.close();
  });

  it('⚠ ein Ziel, das nicht nachweisbar privat ist, wird nie angeklopft', async function () {
    // Der zweite Riegel: der Core hat es schon geprüft, aber wer die Verbindung
    // öffnet, prüft sein Ziel selbst (die OTA-Sidecar-Disziplin).
    let dialed = false;
    const deps = {
      readRegisters: () => { dialed = true; return Promise.resolve([0]); },
      readCoils: () => { dialed = true; return Promise.resolve([0]); },
      writeValue: () => { dialed = true; return Promise.resolve(); },
      sleep: () => Promise.resolve(),
    };
    for (const host of ['8.8.8.8', 'example.com', 'wechselrichter', '']) {
      const res = await rw.runOnce({
        request_id: 'a5', mode: 'apply', kind: 'holding', addr: 1, value: 1, host,
      }, deps);
      assert.strictEqual(res.ok, false, host);
      assert.strictEqual(res.error_code, 'invalid_request', host);
    }
    assert.strictEqual(dialed, false, 'kein einziger Socket');
  });

  it('⚠ ein unzulässiger Auftrag erreicht das Gerät nie', async function () {
    let dialed = false;
    const deps = {
      readRegisters: () => { dialed = true; return Promise.resolve([0]); },
      readCoils: () => { dialed = true; return Promise.resolve([0]); },
      writeValue: () => { dialed = true; return Promise.resolve(); },
      sleep: () => Promise.resolve(),
    };
    const bad = [
      { kind: 'coil', addr: 3, value: 300 },            // eine Spule kennt 0 und 1
      { kind: 'holding', addr: 3, value: 65536 },       // kein Registerwort
      { kind: 'holding', addr: 65536, value: 1 },       // keine Adresse
      { kind: 'holding', addr: 3, value: 1, write_fc: 5 },  // FC5 ist die Spulen-Funktion
      { kind: 'coil', addr: 3, value: 1, write_fc: 16 },    // und umgekehrt
    ];
    for (const b of bad) {
      const res = await rw.runOnce(Object.assign(
        { request_id: 'a6', mode: 'apply', host: '192.168.0.44' }, b,
      ), deps);
      assert.strictEqual(res.ok, false, JSON.stringify(b));
      assert.strictEqual(res.error_code, 'invalid_request', JSON.stringify(b));
    }
    assert.strictEqual(dialed, false);
  });

  it('teilt sich die EINE Warteschlange je Ziel mit dem laufenden Poll', async function () {
    const gw = gateway({ delayMs: 40 });
    const port = await listen(gw);
    const plan = { host: '127.0.0.1', port, unitId: 1, fc: codec.FN_READ_HOLDING, addr: 100, count: 1 };
    await Promise.all([
      conn.readRegisters(plan),
      rw.runOnce({ request_id: 'q1', mode: 'apply', kind: 'holding', addr: 100, value: 7, host: '127.0.0.1', port, unit_id: 1 }, fastDeps),
      conn.readRegisters(plan),
      rw.runOnce({ request_id: 'q2', mode: 'apply', kind: 'holding', addr: 100, value: 9, host: '127.0.0.1', port, unit_id: 1 }, fastDeps),
    ]);
    assert.strictEqual(gw.maxInFlight, 1, 'nie ein zweiter Vorgang je Ziel');
    gw.server.close();
  });

  it('ein Gerät, das den Schreibvorgang schluckt, fällt am Rücklesen auf', async function () {
    const gw = gateway({ swallow: true });
    const port = await listen(gw);
    gw.holding.set(0x00e7, 3300);
    const res = await rw.runOnce({
      request_id: 'a7', mode: 'apply', kind: 'holding', addr: 0x00e7, value: 7000,
      host: '127.0.0.1', port, unit_id: 1,
    }, fastDeps);
    // Der Austausch lief sauber - dass der Wert NICHT übernommen wurde, sagt
    // allein das Rücklesen (der Core macht daraus „nicht übernommen").
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(res.after, 3300, 'zurückgelesen wird, was wirklich dort steht');
    gw.server.close();
  });

  it('⚠ ein unerreichbares Gerät meldet einen benannten Fehler und NIE einen Wert', async function () {
    const res = await rw.runOnce({
      request_id: 'a8', mode: 'apply', kind: 'holding', addr: 1, value: 1,
      host: '127.0.0.1', port: 1, unit_id: 1,
    }, fastDeps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'unreachable');
    assert.strictEqual(res.wrote, false);
    assert.ok(res.before === null || res.before === undefined, 'kein erfundener Ist-Wert');
  });

  it('der Knoten nimmt nur wohlgeformte Aufträge an', function () {
    assert.strictEqual(require('../nodes/vp-register-write.js').parse(Buffer.from('kaputt')), null);
    assert.strictEqual(require('../nodes/vp-register-write.js').parse(Buffer.from('{}')), null);
    const ok = require('../nodes/vp-register-write.js').parse(Buffer.from(JSON.stringify({
      request_id: 'x', mode: 'dry_run', addr: 1, host: '192.168.0.44',
    })));
    assert.strictEqual(ok.request_id, 'x');
  });
});

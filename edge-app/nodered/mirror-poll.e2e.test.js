'use strict';

/**
 * mirror-poll.e2e.test.js - drives the ACTUAL Deye read poll (auto-router +
 * auto-solarman from flows.json) against a real in-process Solarman-V5 logger
 * to prove the Modbus-Datenspiegel's learned-block extension end to end:
 *
 *   - a learned block rides the SAME poll cycle/socket, AFTER the primary
 *     blocks (at most one per cycle, round-robin across cycles);
 *   - a learned block the inverter REFUSES (Modbus exception) is reported as
 *     an error block and NEVER aborts the primary poll - telemetry survives
 *     any consumer asking for garbage registers;
 *   - a fresh control-write intent (sv5_write_want) skips the WHOLE cycle,
 *     learned block included - consumer demand can never displace a write;
 *   - the raw-shaper node turns the cycle's blocks into the retained
 *     edge/registers/raw payload byte-faithfully.
 *
 * The sv5 lock/yield discipline itself is pinned by deye-control.e2e.test.js;
 * this file only proves the mirror rides INSIDE it without changing it.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const sharedBus = require('./measurements/shared-bus-arbiter');
const fs = require('node:fs');
const path = require('node:path');

const SV5 = require('./deye/solarman-v5');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));
const ROUTER = byId['auto-router'].func;
const READ_POLL = byId['auto-solarman'].func;
const MIRROR_RAW = byId['auto-mirror-raw'].func;

const SERIAL = 2985159064;

const SEL = {
  schema_version: '1.0', brand: 'deye', label: 'Deye', family: 'hybrid_3p',
  communication: 'solarman_v5',
  connection: { ip: '127.0.0.1', serial: String(SERIAL), mb_slave_id: 1 },
};

// Die TAEGLICHE Lesung der geraete-eigenen Einspeisegrenze („Grenzen & Waechter"
// Stufe 0) haengt sich ebenfalls an den Leseplan und ist auf einem frischen
// Flow-Kontext faellig. Die Spiegel-Tests stempeln sie deshalb als soeben
// versucht, damit ihr Gegenstand (die gelernten Bloecke) isoliert bleibt; ihr
// eigenes Verhalten steht im letzten Test dieser Datei.
const exportLimitStamped = (extra = {}) => ({
  ['export_limit_at:' + SEL.connection.ip + ':8899']: Date.now(),
  ...extra,
});

// --- a minimal in-process Solarman-V5 logger (FC3 reads only) ----------------
const V5_RESP_PREAMBLE = 14;

function buildV5Response(serial, sequence, modbusFrame) {
  const length = V5_RESP_PREAMBLE + modbusFrame.length;
  const header = Buffer.alloc(11);
  header[0] = 0xa5;
  header.writeUInt16LE(length, 1);
  header.writeUInt16LE(0x1510, 3);
  header.writeUInt16LE(sequence & 0xffff, 5);
  header.writeUInt32LE(SV5.normLoggerSerial(serial), 7);
  const preamble = Buffer.alloc(V5_RESP_PREAMBLE);
  preamble[0] = 0x02;
  preamble[1] = 0x01;
  const frame = Buffer.concat([header, preamble, modbusFrame, Buffer.from([0x00, 0x15])]);
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum = (sum + frame[i]) & 0xff;
  frame[frame.length - 2] = sum & 0xff;
  return frame;
}

const V5_REQ_MODBUS_OFFSET = 26;

// startLogger serves FC3 from a register store (value = address by default);
// addresses in opts.exceptionFrom answer Modbus exception 0x02.
function startLogger(opts = {}) {
  const reads = []; // audit: every {addr, count} the logger served, in order
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        let need;
        try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        while (need !== null && acc.length >= need) {
          const frame = acc.slice(0, need);
          acc = acc.slice(need);
          const seq = frame.readUInt16LE(5);
          const mb = frame.slice(V5_REQ_MODBUS_OFFSET, frame.length - 2);
          const slave = mb[0];
          if (mb[1] !== 0x03) { sock.destroy(); return; }
          const addr = mb.readUInt16BE(2);
          const count = mb.readUInt16BE(4);
          reads.push({ addr, count });
          let respMb;
          if (Array.isArray(opts.exceptionFrom) && opts.exceptionFrom.indexOf(addr) !== -1) {
            const eb = Buffer.from([slave, 0x83, 0x02]);
            const ecrc = SV5.modbusCrc16(eb);
            respMb = Buffer.concat([eb, Buffer.from([ecrc & 0xff, (ecrc >> 8) & 0xff])]);
          } else {
            const body = Buffer.alloc(3 + count * 2);
            body[0] = slave; body[1] = 0x03; body[2] = count * 2;
            for (let i = 0; i < count; i++) body.writeUInt16BE((addr + i) & 0xffff, 3 + i * 2);
            const crc = SV5.modbusCrc16(body);
            respMb = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
          }
          sock.write(buildV5Response(SERIAL, seq, respMb));
          try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, reads }));
  });
}

// vm-realm gotcha (see flows-sync.test.js): arrays built inside the function
// node carry the vm context's own prototypes, so deepStrictEqual against
// outer-realm literals fails - normalize via a JSON round-trip first.
const J = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

async function runNode(func, msg, flowStore = {}, ctxStore = {}) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

// pollOnce runs router -> solarman on a SHARED flow context (like the tab).
async function pollOnce(flowStore, port) {
  const routed = await runNode(ROUTER, {}, flowStore);
  const msg = routed[0];
  if (!msg) return null;
  msg.deye.cfg.port = port;
  return runNode(READ_POLL, msg, flowStore);
}

test('learned blocks ride the poll AFTER the primary blocks, one per cycle round-robin', async () => {
  const { server, port, reads } = await startLogger();
  try {
    const flowStore = exportLimitStamped({
      inverter_config: SEL,
      mirror_want: [{ start: 0x0060, count: 4 }, { start: 0x0100, count: 2 }],
    });
    // Cycle 1: identity + measurement block, THEN learned block A.
    let out = await pollOnce(flowStore, port);
    assert.ok(out, 'poll cycle 1 completed');
    assert.deepStrictEqual(reads.map((r) => r.addr), [0x0000, 0x024b, 0x0060],
      'learned block read LAST, after the primary blocks');
    const learned = out.deye.blocks[2];
    assert.strictEqual(learned.learned, true);
    assert.deepStrictEqual(J(learned.regs), [0x0060, 0x0061, 0x0062, 0x0063], 'logger bytes served verbatim');

    // Cycle 2: the OTHER learned block (round-robin), still exactly one.
    reads.length = 0;
    out = await pollOnce(flowStore, port);
    assert.deepStrictEqual(reads.map((r) => r.addr), [0x0000, 0x024b, 0x0100]);
    assert.strictEqual(out.deye.blocks.length, 3);
  } finally {
    server.close();
  }
});

test('a refused learned block becomes an error block and never aborts the primary poll', async () => {
  const { server, port, reads } = await startLogger({ exceptionFrom: [0x0f00] });
  try {
    const flowStore = exportLimitStamped({ inverter_config: SEL, mirror_want: [{ start: 0x0f00, count: 4 }] });
    const out = await pollOnce(flowStore, port);
    assert.ok(out, 'poll survived the refused learned block');
    assert.strictEqual(out.deye.blocks.length, 3, 'primary blocks + the error block');
    assert.strictEqual(out.deye.blocks[0].regs.length, 1, 'identity block intact');
    assert.strictEqual(out.deye.blocks[1].regs.length, 0x7a, 'measurement block intact');
    const failed = out.deye.blocks[2];
    assert.strictEqual(failed.learned, true);
    assert.deepStrictEqual(J(failed.regs), []);
    assert.match(failed.error, /Modbus-Ausnahme/, 'the refusal is NAMED so the core can reject the want');
    assert.deepStrictEqual(reads.map((r) => r.addr), [0x0000, 0x024b, 0x0f00]);

    // The raw shaper forwards the error block for the core's learner.
    const shaped = await runNode(MIRROR_RAW, out, flowStore);
    assert.strictEqual(shaped.payload.blocks[2].error.indexOf('Modbus-Ausnahme'), 0);
    assert.strictEqual(shaped.payload.blocks[2].count, 4, 'count carried so the core can drop the exact want');
    assert.strictEqual(shaped.payload.unit, 1);
  } finally {
    server.close();
  }
});

test('a fresh control-write intent skips the WHOLE cycle - learned block included', async () => {
  const { server, port, reads } = await startLogger();
  try {
    const flowStore = {
      inverter_config: SEL,
      mirror_want: [{ start: 0x0060, count: 4 }],
      ['sv5_write_want:127.0.0.1:' + port]: Date.now(),
    };
    const out = await pollOnce(flowStore, port);
    assert.strictEqual(out, null, 'read yielded to the announced write');
    assert.strictEqual(reads.length, 0, 'NOT ONE socket operation - consumer demand cannot displace a write');
  } finally {
    server.close();
  }
});

// „Grenzen & Wächter" Stufe 0: die geraete-eigene Einspeisegrenze reitet EINMAL
// AM TAG auf demselben Leseplan mit - ein zusaetzlicher FC3-Umlauf, kein
// zweiter Socket. Was hier zaehlt: dass der Umlauf wirklich stattfindet, dass
// der gelesene Registerwert BYTE-getreu in der retained Rohnachricht ankommt
// (aus der der Core ihn dekodiert - `agent/device_export_limit_test.go`), und
// dass die Lastgarantie haelt: die folgenden Polls tragen ihn NICHT.
test('die Einspeisegrenze des Geraets wird taeglich mitgelesen - und nur taeglich', async () => {
  const { server, port, reads } = await startLogger();
  try {
    const flowStore = { inverter_config: SEL };

    // Erster Poll nach dem (Neu-)Start: der Zusatz-Umlauf laeuft, NACH den
    // Primaerbloecken.
    let out = await pollOnce(flowStore, port);
    assert.ok(out, 'poll cycle 1 completed');
    assert.deepStrictEqual(reads.map((r) => r.addr), [0x0000, 0x024b, 0x00e7],
      'die Grenze wird LETZTES gelesen, nach den Messwerten');
    assert.deepStrictEqual(reads[2], { addr: 0x00e7, count: 1 }, 'genau EIN Register');

    // Der Wert reist byte-getreu weiter (der Logger serviert Wert = Adresse).
    const block = out.deye.blocks[2];
    assert.strictEqual(block.start, 0x00e7);
    assert.deepStrictEqual(J(block.regs), [0x00e7]);
    const shaped = await runNode(MIRROR_RAW, out, flowStore);
    const raw = shaped && shaped.payload;
    assert.ok(raw, 'die Rohnachricht wird gebaut');
    const carried = raw.blocks.filter((b) => b.start === 0x00e7);
    assert.strictEqual(carried.length, 1, 'der Core bekommt den Block genau einmal');
    assert.deepStrictEqual(J(carried[0].regs), [0x00e7]);

    // Die folgenden Polls tragen ihn NICHT - das ist die Lastgarantie.
    for (let i = 0; i < 3; i += 1) {
      reads.length = 0;
      out = await pollOnce(flowStore, port);
      assert.deepStrictEqual(reads.map((r) => r.addr), [0x0000, 0x024b],
        'kein zweiter Umlauf am selben Tag');
    }
  } finally {
    server.close();
  }
});

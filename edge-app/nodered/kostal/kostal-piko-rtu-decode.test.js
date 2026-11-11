'use strict';

// kostal-piko-rtu-decode - Protokoll-Decoder-Tests des Modbus-RTU-Auswegs.
// Jeder Registerblock wird hier KONSTRUIERT, kein Geraet vorhanden - die
// Registerkarte und ihre Skalierung stammen aus dem Scout-Report
// (data/vp-kostal-piko20-anbindung/report.md §3.2), die Wortadressen sind
// gegen thenebu/dbus-kostal-piko (`read_holding_registers(client, 30001-1,
// 56)`) nachgerechnet. Offline, ohne Netz, ohne Geraet.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const R = require('./kostal-piko-rtu-decode');

function block(start, regs) {
  return { start, regs };
}

test('wordAt - findet eine Adresse ueber mehrere Bloecke, auch nicht am Blockanfang', () => {
  const blocks = [block(30000, [1, 2, 3]), block(30050, [10, 20])];
  assert.strictEqual(R.wordAt(blocks, 30001), 2);
  assert.strictEqual(R.wordAt(blocks, 30051), 20);
});

test('wordAt - Adresse ausserhalb jedes Blocks ist abwesend (undefined), nie 0', () => {
  const blocks = [block(30000, [1, 2, 3])];
  assert.strictEqual(R.wordAt(blocks, 30099), undefined);
  assert.strictEqual(R.wordAt([], 30000), undefined);
});

test('decode - AC-Leistung (Register 30031 -> Adresse 30030) -> pv_power_kw', () => {
  // ein Block ab REG.AC_TOTAL_W, ein einziges Register, Wert 1234 W.
  const out = R.decode([block(R.REG.AC_TOTAL_W, [1234])]);
  assert.deepStrictEqual(out, { reading: { pv_power_kw: 1.234 } });
});

test('decode - AC-Leistung fehlt -> null (abwesend, nie 0)', () => {
  assert.strictEqual(R.decode([block(30000, [1, 2, 3])]), null);
});

test('decodeVerbose - DC/AC-Strings und -Phasen mit der dokumentierten Skalierung (÷10 V, ÷100 A, W roh)', () => {
  // DC1: V=30000, A=30001, W=30002 -> 3654 (365.4 V), 1210 (12.10 A), 4420 W
  const blocks = [block(R.REG.DC1_V, [3654, 1210, 4420])];
  const v = R.decodeVerbose(blocks);
  assert.strictEqual(v.strings[0].vV, 365.4);
  assert.strictEqual(v.strings[0].aA, 12.1);
  assert.strictEqual(v.strings[0].pW, 4420);
  // nicht gelesene Strings bleiben abwesend.
  assert.strictEqual(v.strings[1].vV, undefined);
});

test('decodeVerbose - cos phi (÷100) und Netzfrequenz (÷10 Hz)', () => {
  const blocks = [block(R.REG.COS_PHI, [100, 500])]; // 30032=100 (cos=1.00), 30033=500 (50.0 Hz)
  const v = R.decodeVerbose(blocks);
  assert.strictEqual(v.cosPhi, 1);
  assert.strictEqual(v.frequencyHz, 50);
});

test('decodeVerbose - Gesamtertrag 32-Bit, hohes Wort zuerst', () => {
  // 32965300 Wh = 0x01F702B4 -> hi=503, lo=692.
  const hi = 32965300 >>> 16;
  const lo = 32965300 & 0xffff;
  assert.strictEqual((hi << 16) | lo, 32965300);
  const blocks = [block(R.REG.ENERGY_TOTAL_HI, [hi, lo])];
  assert.strictEqual(R.decodeVerbose(blocks).energyTotalKwh, 32965.3);
});

test('decodeVerbose - Betriebsstunden und Tagesertrag (roh Wh -> kWh)', () => {
  const blocks = [block(R.REG.OPERATING_HOURS, [33919]), block(R.REG.ENERGY_TODAY_WH, [22207])];
  const v = R.decodeVerbose(blocks);
  assert.strictEqual(v.operatingHours, 33919);
  assert.strictEqual(v.energyTodayKwh, 22.207);
});

test('decodeVerbose - Nennleistung roh in Watt', () => {
  assert.strictEqual(R.decodeVerbose([block(R.REG.RATED_W, [20000])]).ratedW, 20000);
});

test('decodeVerbose - Geraetename/Seriennummer: 2 ASCII-Zeichen je Register, hohe Byte zuerst (volles 13-Register-Feld)', () => {
  // "PIKO20" -> P=0x50 I=0x49, K=0x4B O=0x4F, 2=0x32 0=0x30, Rest mit Leerzeichen gepolstert.
  const name = [0x5049, 0x4b4f, 0x3230, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020, 0x2020];
  const blocks = [block(R.REG.NAME_START, name)];
  assert.strictEqual(R.decodeVerbose(blocks).name, 'PIKO20');
});

test('decodeVerbose - Name mit Fuellbytes 0x00 wird am ersten Nullbyte abgeschnitten', () => {
  // "PIKO" + Nullbytes fuer den Rest des 13-Register-Feldes.
  const regs = [0x5049, 0x4b4f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const blocks = [block(R.REG.NAME_START, regs)];
  assert.strictEqual(R.decodeVerbose(blocks).name, 'PIKO');
});

test('decodeVerbose - fehlendes Register im ASCII-Block -> Name/Seriennummer ganz abwesend', () => {
  const blocks = [block(R.REG.NAME_START, [0x5049])]; // nur 1 von 13 Registern
  assert.strictEqual(R.decodeVerbose(blocks).name, undefined);
});

test('decodeVerbose - jedes Feld einzeln abwesend ohne Bloecke', () => {
  const v = R.decodeVerbose([]);
  assert.strictEqual(v.pvPowerKw, undefined);
  assert.strictEqual(v.energyTotalKwh, undefined);
  assert.strictEqual(v.name, undefined);
  assert.deepStrictEqual(v.strings[0], { vV: undefined, aA: undefined, pW: undefined });
});

test('Modbus-RTU-Rahmenbildung ist die GEMEINSAME Deye-Funktion (keine zweite CRC16-Implementierung)', () => {
  // readHoldingRegistersRequest(unit, start, count) fuer FC03 ab REG.AC_TOTAL_W.
  const req = R.readHoldingRegistersRequest(1, R.REG.AC_TOTAL_W, 1);
  assert.strictEqual(req.length, 8); // addr, fn, startHi, startLo, countHi, countLo, crcLo, crcHi
  assert.strictEqual(req[0], 1);
  assert.strictEqual(req[1], 0x03);
  // Antwort: addr, fn, byteCount=2, dataHi, dataLo, crcLo, crcHi.
  const body = Buffer.from([1, 0x03, 0x02, 0x04, 0xd2]); // 1234 = 0x04D2
  const crc = R.modbusCrc16(body);
  const reply = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
  assert.deepStrictEqual(R.parseModbusResponse(reply), [1234]);
});

// --- makeKostalRtuReader: der TCP-Teil, gegen eine gefaelschte `net` --------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
  }
  connect(port, ip, cb) { this.port = port; this.ip = ip; this._connectCb = cb; return this; }
  write(buf) { this.written.push(buf); }
  setTimeout(ms, cb) { this._timeoutMs = ms; this._timeoutCb = cb; }
  destroy() { this.destroyed = true; }
}

function fakeNet(onSocket) {
  return { Socket: class extends FakeSocket { constructor() { super(); if (onSocket) onSocket(this); } } };
}

function fc03Reply(unitId, words) {
  const body = Buffer.alloc(3 + words.length * 2);
  body[0] = unitId;
  body[1] = 0x03;
  body[2] = words.length * 2;
  words.forEach((w, i) => body.writeUInt16BE(w, 3 + i * 2));
  const crc = R.modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

test('makeKostalRtuReader: schreibt genau die FC03-Anfrage und dekodiert die Antwort (schneller Takt, ein Register)', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = R.makeKostalRtuReader({ net, timeoutMs: 1000 });

  const promise = read({ ip: '192.168.0.50', port: 8899, unitId: 1 });
  socket._connectCb();
  assert.deepStrictEqual(socket.written[0], R.readHoldingRegistersRequest(1, R.REG.AC_TOTAL_W, 1));

  socket.emit('data', fc03Reply(1, [1234]));
  const out = await promise;
  assert.deepStrictEqual(out, { blocks: [{ start: R.REG.AC_TOTAL_W, regs: [1234] }] });
  assert.strictEqual(socket.destroyed, true);
});

test('makeKostalRtuReader: mehrere Bloecke werden sequenziell ueber EINE Verbindung abgefragt', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = R.makeKostalRtuReader({ net, timeoutMs: 1000 });
  const specs = [{ start: R.REG.AC_TOTAL_W, count: 1 }, { start: R.REG.RATED_W, count: 1 }];

  const promise = read({ ip: '192.168.0.50', port: 8899, unitId: 1, blocks: specs });
  socket._connectCb();
  assert.strictEqual(socket.written.length, 1);
  socket.emit('data', fc03Reply(1, [1234]));
  assert.strictEqual(socket.written.length, 2); // der zweite Block wurde erst NACH der ersten Antwort gesendet
  socket.emit('data', fc03Reply(1, [20000]));
  const out = await promise;
  assert.deepStrictEqual(out.blocks, [{ start: R.REG.AC_TOTAL_W, regs: [1234] }, { start: R.REG.RATED_W, regs: [20000] }]);
});

test('makeKostalRtuReader: eine Modbus-Ausnahme (5 Byte) beendet den Zyklus statt zu haengen', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = R.makeKostalRtuReader({ net, timeoutMs: 1000 });
  const promise = read({ ip: '192.168.0.50', port: 8899, unitId: 1 });
  socket._connectCb();
  const body = Buffer.from([1, 0x03 | 0x80, 0x02]);
  const crc = R.modbusCrc16(body);
  socket.emit('data', Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]));
  assert.strictEqual(await promise, null);
});

test('makeKostalRtuReader: ein Verbindungsfehler liefert null, nie einen Wurf', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = R.makeKostalRtuReader({ net });
  const promise = read({ ip: '192.168.0.50', port: 8899, unitId: 1 });
  socket._connectCb();
  socket.emit('error', new Error('ECONNREFUSED'));
  assert.strictEqual(await promise, null);
});

test('makeKostalRtuReader: ohne IP oder mit Geraeteadresse ausserhalb 1..247 wird gar nicht erst verbunden', async () => {
  const net = fakeNet(() => { throw new Error('darf nicht verbinden'); });
  const read = R.makeKostalRtuReader({ net });
  assert.strictEqual(await read({ ip: '', port: 8899, unitId: 1 }), null);
  assert.strictEqual(await read({ ip: '1.2.3.4', port: 8899, unitId: 0 }), null);
  assert.strictEqual(await read({ ip: '1.2.3.4', port: 8899, unitId: 248 }), null);
});

test('TEST_BLOCKS deckt jedes in REG benannte Register genau einmal ab (keine Luecke, kein Ueberlapp mit dem naechsten Block)', () => {
  const covered = new Set();
  for (const b of R.TEST_BLOCKS) {
    for (let i = 0; i < b.count; i++) covered.add(b.start + i);
  }
  for (const [key, addr] of Object.entries(R.REG)) {
    if (key.endsWith('_COUNT')) continue;
    assert.ok(covered.has(addr), key + ' (Adresse ' + addr + ') liegt in keinem TEST_BLOCKS-Block');
  }
});

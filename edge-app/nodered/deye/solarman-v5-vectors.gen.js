'use strict';

/**
 * Erzeugt solarman-v5-vectors.json: die GEMEINSAMEN Rahmen-Vektoren zwischen
 * solarman-v5.js (Node-RED, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/solarmanv5 (Edge Light).
 *
 * Jede erwartete Ausgabe entsteht aus dem JS-Modul selbst; der Test
 * solarman-v5-vectors.test.js schlaegt fehl, sobald Modul und Datei
 * auseinanderlaufen.
 *
 *   node edge-app/nodered/deye/solarman-v5-vectors.gen.js
 *
 * Fehlerfaelle tragen nur "error": true - die deutschen Meldungen beider Seiten
 * duerfen sich im Wortlaut unterscheiden, die ENTSCHEIDUNG (annehmen oder
 * ablehnen) nicht.
 */

const fs = require('fs');
const path = require('path');
const V5 = require('./solarman-v5.js');

const OUT = path.join(__dirname, 'solarman-v5-vectors.json');
const hex = (buf) => Buffer.from(buf).toString('hex');

// Ein Antwortrahmen, wie ein Logger ihn schickt (das JS-Modul baut nur
// ANFRAGEN). Der Aufbau folgt dem Kopfkommentar von solarman-v5.js:
//   A5 <len LE> 1510 <seq LE> <serial LE32> <frametype> <status> <3x u32 LE> <modbus> <cksum> 15
function responseFrame({ serial, seq, frameType = 0x02, status = 0x01, modbus, control = V5.V5_CONTROL_RESPONSE }) {
  const payload = Buffer.alloc(14);
  payload[0] = frameType;
  payload[1] = status;
  payload.writeUInt32LE(123456, 2); // Gesamtbetriebszeit - fuer den Parser bedeutungslos
  payload.writeUInt32LE(7890, 6);
  payload.writeUInt32LE(0, 10);
  const length = payload.length + modbus.length;
  const header = Buffer.alloc(11);
  header[0] = V5.V5_START;
  header.writeUInt16LE(length, 1);
  header.writeUInt16LE(control, 3);
  header.writeUInt16LE(seq & 0xffff, 5);
  header.writeUInt32LE(serial >>> 0, 7);
  const frame = Buffer.concat([header, payload, modbus, Buffer.from([0x00, V5.V5_END])]);
  frame[frame.length - 2] = V5.v5Checksum(frame);
  return frame;
}

// Eine Modbus-RTU-Leseantwort (fn 0x03) fuer die gegebenen Registerwoerter.
function readReply(slave, regs) {
  const body = Buffer.alloc(3 + regs.length * 2);
  body[0] = slave;
  body[1] = 0x03;
  body[2] = regs.length * 2;
  regs.forEach((r, i) => body.writeUInt16BE(r & 0xffff, 3 + i * 2));
  const crc = V5.modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

function withCrc(bytes) {
  const body = Buffer.from(bytes);
  const crc = V5.modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

const SERIAL = 2985159064; // der echte Pilot-Logger aus DEYE.md
const REGS = [0x0005, 0x1234, 0xffff, 0x0000, 0x8000];

// --- Antwortfaelle --------------------------------------------------------
const responses = [];
function respCase(name, buf, opts) {
  let expect;
  try {
    expect = { regs: V5.readRegistersFromResponse(buf, opts) };
  } catch (e) {
    expect = { error: true };
  }
  responses.push({ name, frame: hex(buf), opts: opts || {}, expect });
}

const good = responseFrame({ serial: SERIAL, seq: 7, modbus: readReply(1, REGS) });
respCase('gueltige Leseantwort', good, { expectLoggerSerial: SERIAL, expectSequence: 7 });
respCase('gueltige Leseantwort ohne Erwartungen', good);
respCase('gueltige Antwort + Folgebytes (naechstes TCP-Segment)', Buffer.concat([good, Buffer.from([0xa5, 0x01])]));
respCase('falsche Logger-Seriennummer', good, { expectLoggerSerial: SERIAL + 1 });
respCase('falsche Sequenznummer', good, { expectSequence: 8 });
{
  const bad = Buffer.from(good);
  bad[bad.length - 2] ^= 0x01;
  respCase('V5-Pruefsumme falsch', bad);
}
{
  const bad = Buffer.from(good);
  bad[bad.length - 1] = 0x16;
  respCase('Endbyte falsch', bad);
}
respCase('Frame kuerzer als Laengenfeld', good.slice(0, good.length - 3));
respCase('Frametyp 0x01 (Datenlogger-Stick)', responseFrame({ serial: SERIAL, seq: 1, frameType: 0x01, modbus: readReply(1, REGS) }));
respCase('falscher Controlcode', responseFrame({ serial: SERIAL, seq: 1, control: 0x4510, modbus: readReply(1, REGS) }));
respCase('Modbus-Ausnahme 0x02', responseFrame({ serial: SERIAL, seq: 1, modbus: withCrc([0x01, 0x83, 0x02]) }));
respCase('Modbus-Ausnahme 0x0B als verkuerzte Antwort', responseFrame({ serial: SERIAL, seq: 1, modbus: Buffer.from([0x01, 0x83, 0x0b]) }));
respCase('leere Modbus-Nutzlast', responseFrame({ serial: SERIAL, seq: 1, modbus: Buffer.alloc(0) }));
{
  const mb = readReply(1, REGS);
  mb[mb.length - 1] ^= 0xff;
  respCase('Modbus-CRC falsch', responseFrame({ serial: SERIAL, seq: 1, modbus: mb }));
}
respCase('unerwartete Modbus-Funktion 0x04', responseFrame({ serial: SERIAL, seq: 1, modbus: withCrc([0x01, 0x04, 0x02, 0x00, 0x01]) }));
respCase('Bytezahl groesser als Nutzlast', responseFrame({ serial: SERIAL, seq: 1, modbus: withCrc([0x01, 0x03, 0x08, 0x00, 0x01]) }));
respCase('Startbyte falsch', Buffer.concat([Buffer.from([0xa4]), good.slice(1)]));

// --- Schreibantworten -----------------------------------------------------
const writes = [];
function writeCase(name, mb, opts) {
  let expect;
  try {
    expect = V5.parseWriteResponse(mb, opts);
  } catch (e) {
    expect = { error: true };
  }
  writes.push({ name, modbus: hex(mb), opts: opts || {}, expect });
}
writeCase('fn 0x06 Echo', withCrc([0x01, 0x06, 0x00, 0x92, 0x00, 0xff]));
writeCase('fn 0x10 Bestaetigung', withCrc([0x01, 0x10, 0x00, 0x9a, 0x00, 0x02]));
writeCase('fn 0x06 erwartet, 0x10 erhalten', withCrc([0x01, 0x10, 0x00, 0x9a, 0x00, 0x02]), { expectFn: 0x06 });
writeCase('Schreib-Ausnahme', withCrc([0x01, 0x86, 0x03]));
{
  const mb = withCrc([0x01, 0x06, 0x00, 0x92, 0x00, 0xff]);
  mb[mb.length - 2] ^= 0x01;
  writeCase('Schreibantwort CRC falsch', mb);
}

// --- Rahmenlaenge (TCP-Reassemblierung) -----------------------------------
const frameLength = [];
function lenCase(name, buf) {
  let expect;
  try {
    const n = V5.expectedFrameLength(buf);
    expect = n === null ? { incomplete: true } : { length: n };
  } catch (e) {
    expect = { error: true };
  }
  frameLength.push({ name, prefix: hex(buf), expect });
}
lenCase('leer', Buffer.alloc(0));
lenCase('nur Startbyte', good.slice(0, 1));
lenCase('Startbyte + halbes Laengenfeld', good.slice(0, 2));
lenCase('Kopf mit Laengenfeld', good.slice(0, 3));
lenCase('ganzer Rahmen', good);
lenCase('falsches Startbyte', Buffer.from([0x15, 0x00, 0x00]));

const out = {
  _comment: [
    'GENERIERT von solarman-v5-vectors.gen.js aus solarman-v5.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: solarman-v5-vectors.test.js (JS) und edge-app/core/internal/solarmanv5 (Go, Edge Light).',
    'Alle Bytefolgen als Hex; Fehlerfaelle tragen nur "error": true (Wortlaut darf abweichen, die Entscheidung nicht).',
  ],
  crc16: [
    [], [0x01], [0x01, 0x03, 0x02, 0x4b, 0x00, 0x7a], [0xff, 0xff, 0xff], Array.from({ length: 64 }, (_, i) => i),
  ].map((b) => ({ bytes: hex(b), crc: V5.modbusCrc16(Buffer.from(b)) })),
  logger_serial: [
    { input: SERIAL, ok: true },
    { input: '2985159064', ok: true },
    { input: ' 42 ', ok: true },
    { input: '0x10', ok: true },
    { input: 0, ok: true },
    { input: 4294967295, ok: true },
    { input: 4294967296, ok: false },
    { input: -1, ok: false },
    { input: 1.5, ok: false },
    { input: 'abc', ok: false },
  ].map((c) => {
    try {
      return { input: c.input, value: V5.normLoggerSerial(c.input) };
    } catch (e) {
      return { input: c.input, error: true };
    }
  }),
  read_requests: [
    { serial: SERIAL, seq: 1, slave: 1, start: 0x0000, count: 0x0001 },
    { serial: SERIAL, seq: 2, slave: 1, start: 0x024b, count: 0x007a },
    { serial: SERIAL, seq: 65535, slave: 1, start: 0x00d2, count: 0x000e },
    { serial: 4294967295, seq: 0, slave: 247, start: 0xffff, count: 0x007d },
  ].map((c) => ({
    ...c,
    frame: hex(V5.buildReadRequest({ loggerSerial: c.serial, sequence: c.seq, slaveId: c.slave, startReg: c.start, count: c.count })),
  })),
  write_single_requests: [
    { serial: SERIAL, seq: 3, slave: 1, reg: 0x0092, value: 0x00ff },
    { serial: SERIAL, seq: 4, slave: 1, reg: 0x0028, value: 65535 },
  ].map((c) => ({
    ...c,
    frame: hex(V5.buildWriteSingleRequest({ loggerSerial: c.serial, sequence: c.seq, slaveId: c.slave, reg: c.reg, value: c.value })),
  })),
  write_multiple_requests: [
    { serial: SERIAL, seq: 5, slave: 1, start: 0x009a, values: [3000, 80] },
  ].map((c) => ({
    ...c,
    frame: hex(V5.buildWriteMultipleRequest({ loggerSerial: c.serial, sequence: c.seq, slaveId: c.slave, startReg: c.start, values: c.values })),
  })),
  responses,
  write_responses: writes,
  frame_length: frameLength,
};

const text = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT);
}

module.exports = { build: () => text, OUT };

'use strict';

// kaco-serial-decode - Protokoll-Decoder-Tests der dritten KACO-Plattform
// (Powador-Altgeraete, seriell ueber einen RS485-zu-Ethernet-Wandler). Jedes
// Frame wird hier KONSTRUIERT, kein Geraet vorhanden - die Feldwerte stammen
// aus dem oeffentlich dokumentierten Beispiel (plieningerweb/kacors485
// README: Antwort auf `#010\r`), die Feldbreiten/Offsets sind die aus dem
// Modul (CMD0_OFFSETS), gegen echte Aufzeichnungen verifiziert
// (g4bri3lDev/kaco-rs485 protocol.py). Offline, ohne Netz, ohne Geraet.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const K = require('./kaco-serial-decode');

// --- Hilfsbaustein: ein gueltiges Kommando-"0"-Frame zusammensetzen ----------

function padR(value, width) {
  const s = String(value);
  if (s.length > width) throw new Error('value too wide: ' + s + ' > ' + width);
  return ' '.repeat(width - s.length) + s;
}

/**
 * buildCmd0Frame - setzt ein Frame aus den Momentanwert-Feldern zusammen und
 * haengt die korrekte (oder, fuer Fehlerfall-Tests, eine ueberschriebene)
 * Pruefsumme an. `opts.type` ist der dekorative Typ-String nach der
 * Pruefsumme (optional, wie am echten Geraet).
 */
function buildCmd0Frame(f, opts) {
  opts = opts || {};
  const body = '*' + padR(f.address, 2) + '0' + ' ' +
    padR(f.status, 3) + ' ' +
    padR(f.dcVoltageV, 5) + ' ' +
    padR(f.dcCurrentA, 5) + ' ' +
    padR(f.dcPowerW, 5) + ' ' +
    padR(f.acVoltageV, 5) + ' ' +
    padR(f.acCurrentA, 5) + ' ' +
    padR(f.acPowerW, 5) + ' ' +
    padR(f.temperatureC, 3) + ' ' +
    padR(f.dailyYieldWh, 6) + ' ';
  const bodyBytes = Buffer.from(body, 'ascii');
  const checksum = opts.checksum !== undefined ? opts.checksum : K.kacoChecksum(bodyBytes);
  const tail = opts.type !== undefined ? ' ' + opts.type : ' 9600I';
  return Buffer.concat([
    Buffer.from([0x0a]), // LF
    bodyBytes,
    Buffer.from([checksum]),
    Buffer.from(tail + '\r', 'ascii'),
  ]);
}

// Das dokumentierte Beispiel (kacors485 README, Antwort auf "#010\r").
const EXAMPLE = {
  address: 1, status: 4, dcVoltageV: '585.9', dcCurrentA: '10.17', dcPowerW: 5958,
  acVoltageV: '229.5', acCurrentA: '24.90', acPowerW: 5720, temperatureC: 36,
  dailyYieldWh: 17614,
};

// --- buildRequest --------------------------------------------------------------

test('buildRequest: Adresse zweistellig, Kommando ein Zeichen, CR-terminiert', () => {
  assert.deepStrictEqual(K.buildRequest(1, '0'), Buffer.from('#010\r', 'ascii'));
  assert.deepStrictEqual(K.buildRequest(32, '3'), Buffer.from('#323\r', 'ascii'));
});

test('buildRequest: Adresse ausserhalb 1..32 wird abgelehnt', () => {
  assert.throws(() => K.buildRequest(0, '0'), RangeError);
  assert.throws(() => K.buildRequest(-1, '0'), RangeError);
  assert.throws(() => K.buildRequest(33, '0'), RangeError);
  assert.throws(() => K.buildRequest(1.5, '0'), RangeError);
});

test('buildRequest: Kommando muss genau ein Zeichen sein', () => {
  assert.throws(() => K.buildRequest(1, ''), RangeError);
  assert.throws(() => K.buildRequest(1, '00'), RangeError);
});

// --- Pruefsumme ------------------------------------------------------------

test('kacoChecksum: Summe der Byte-Werte mod 256', () => {
  assert.strictEqual(K.kacoChecksum(Buffer.from([1, 2, 3])), 6);
  assert.strictEqual(K.kacoChecksum(Buffer.from([255, 255, 2])), (255 + 255 + 2) & 0xff);
});

// --- parseCmd0: das gute Frame ----------------------------------------------

test('parseCmd0: dekodiert das dokumentierte Beispiel vollstaendig', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const out = K.parseCmd0(raw);
  assert.strictEqual(out.address, 1);
  assert.strictEqual(out.status, 4);
  assert.strictEqual(out.dcVoltageV, 585.9);
  assert.strictEqual(out.dcCurrentA, 10.17);
  assert.strictEqual(out.dcPowerW, 5958);
  assert.strictEqual(out.acVoltageV, 229.5);
  assert.strictEqual(out.acCurrentA, 24.9);
  assert.strictEqual(out.acPowerW, 5720);
  assert.strictEqual(out.temperatureC, 36);
  assert.strictEqual(out.dailyYieldWh, 17614);
  assert.strictEqual(out.inverterType, '9600I');
  assert.strictEqual(out.checksumOk, true);
});

test('parseCmd0: die hoechste Busadresse (32) und der dekorative Typ-String sind optional', () => {
  const raw = buildCmd0Frame({ ...EXAMPLE, address: 32 }, { type: '' });
  const out = K.parseCmd0(raw);
  assert.strictEqual(out.address, 32);
  assert.strictEqual(out.inverterType, '');
  assert.strictEqual(out.checksumOk, true);
});

// --- Pruefsummenfehler: nicht fatal, aber SICHTBAR -----------------------------

test('parseCmd0: eine falsche Pruefsumme verwirft NICHT die Werte, markiert sie aber', () => {
  const raw = buildCmd0Frame(EXAMPLE, { checksum: 0x00 });
  const out = K.parseCmd0(raw);
  assert.strictEqual(out.acPowerW, 5720); // die Felder sind trotzdem da
  assert.strictEqual(out.checksumOk, false);
  assert.notStrictEqual(out.checksumExpected, out.checksumActual);
});

test('verifyCmd0Checksum: liefert erwarteten und tatsaechlichen Wert', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const { ok, expected, actual } = K.verifyCmd0Checksum(raw);
  assert.strictEqual(ok, true);
  assert.strictEqual(expected, actual);
});

test('verifyCmd0Checksum: ein zu kurzes Frame ist kein Wurf, sondern ok:false', () => {
  assert.deepStrictEqual(K.verifyCmd0Checksum(Buffer.from('zu kurz')), { ok: false, expected: 0, actual: 0 });
  assert.deepStrictEqual(K.verifyCmd0Checksum(null), { ok: false, expected: 0, actual: 0 });
});

// --- Teilantworten / zu kurze Frames ----------------------------------------

test('parseCmd0: ein zu kurzes Frame wirft ParseError statt zu raten', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const truncated = raw.subarray(0, K.CMD0_MIN_LEN - 5); // vor der Pruefsumme abgeschnitten
  assert.throws(() => K.parseCmd0(truncated), K.ParseError);
});

test('parseCmd0: leeres/fehlendes Frame wirft ParseError', () => {
  assert.throws(() => K.parseCmd0(Buffer.alloc(0)), K.ParseError);
  assert.throws(() => K.parseCmd0(null), K.ParseError);
});

test('parseCmd0: fehlender LF*-Kopf wirft ParseError', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const corrupted = Buffer.from(raw);
  corrupted[0] = 0x41; // 'A' statt LF
  assert.throws(() => K.parseCmd0(corrupted), K.ParseError);
});

test('parseCmd0: nicht-numerisches Feld wirft ParseError (kein stilles NaN)', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const corrupted = Buffer.from(raw);
  // dcVoltage-Feld (Offset 10..14) mit Muell ueberschreiben, Laenge erhalten.
  corrupted.write('xxxxx', 10, 'ascii');
  assert.throws(() => K.parseCmd0(corrupted), K.ParseError);
});

// --- Protokoll-Mismatch: ein ANDERES KACO-Protokoll, nicht raten -----------

test('replyCommandByte liest das Kommando-Echo aus dem Antwortkopf', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  assert.strictEqual(K.replyCommandByte(raw), '0');
});

test('protocolMismatch: ein unbekanntes Kommando-Byte (z. B. CRC16-Variante "n") ist ein Mismatch', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const other = Buffer.from(raw);
  other[4] = 'n'.charCodeAt(0);
  assert.strictEqual(K.protocolMismatch(other), true);
  assert.throws(() => K.parseCmd0(other), K.ParseError);
});

test('protocolMismatch: Rauschen/keine Antwort (kein LF*-Kopf) ist KEIN Mismatch, sondern unbekannt', () => {
  assert.strictEqual(K.protocolMismatch(Buffer.from('ratlos')), false);
  assert.strictEqual(K.protocolMismatch(Buffer.alloc(0)), false);
  assert.strictEqual(K.replyCommandByte(Buffer.from('ratlos')), null);
});

// --- Framing: trimLeadingJunk / isCmd0Complete ------------------------------

test('trimLeadingJunk: Stoerbytes vor dem LF verwerfen, danach alles behalten', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const withJunk = Buffer.concat([Buffer.from([0x00, 0x00]), raw]);
  assert.deepStrictEqual(K.trimLeadingJunk(withJunk), raw);
});

test('trimLeadingJunk: ohne LF bisher -> leerer Buffer, nicht roh durchreichen', () => {
  assert.deepStrictEqual(K.trimLeadingJunk(Buffer.from([0x00, 0x01])), Buffer.alloc(0));
});

test('isCmd0Complete: erst die Laenge, dann CR - ein CR GENAU an der Pruefsumme beendet das Frame', () => {
  const raw = buildCmd0Frame(EXAMPLE, { checksum: 0x0d, type: '' }); // Pruefsumme IST ein CR
  assert.strictEqual(K.isCmd0Complete(raw), true);
});

test('isCmd0Complete: ein laengengleiches, aber noch unvollstaendiges Teilstueck ist NICHT vollstaendig', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const partial = raw.subarray(0, K.CMD0_MIN_LEN - 1); // einen Byte vor der Pruefsumme
  assert.strictEqual(K.isCmd0Complete(partial), false);
});

// --- decode(): die VoltPilot-Busform ----------------------------------------

test('decode: AC-Ausgangsleistung IST die Erzeugung (kein Speicher auf dieser Plattform)', () => {
  const raw = buildCmd0Frame(EXAMPLE);
  const out = K.decode(raw);
  assert.strictEqual(out.reading.pv_power_kw, 5.72);
  assert.strictEqual(out.meta.ac_kw, 5.72);
  assert.strictEqual(out.meta.dc_kw, 5.958);
  assert.strictEqual(out.meta.temp_c, 36);
  assert.strictEqual(out.meta.energy_today_kwh, 17.614);
  assert.strictEqual(out.checksumOk, true);
  assert.strictEqual(out.address, 1);
});

test('decode: eine negative Nachtleistung klemmt fuer PV auf 0, ac_kw bleibt vorzeichenbehaftet', () => {
  const raw = buildCmd0Frame({ ...EXAMPLE, acPowerW: -12 });
  const out = K.decode(raw);
  assert.strictEqual(out.reading.pv_power_kw, 0);
  assert.strictEqual(out.meta.ac_kw, -0.012);
});

test('decode: eine falsche Pruefsumme liefert trotzdem eine Probe, mit checksum_ok:false', () => {
  const raw = buildCmd0Frame(EXAMPLE, { checksum: 0x00 });
  const out = K.decode(raw);
  assert.notStrictEqual(out, null);
  assert.strictEqual(out.meta.checksum_ok, false);
});

test('decode: opts.requireChecksum verwirft eine falsche Pruefsumme GANZ', () => {
  const raw = buildCmd0Frame(EXAMPLE, { checksum: 0x00 });
  assert.strictEqual(K.decode(raw, { requireChecksum: true }), null);
  assert.notStrictEqual(K.decode(raw, { requireChecksum: false }), null);
});

test('decode: ein unparsebares Frame liefert null, nie einen Wurf', () => {
  assert.strictEqual(K.decode(Buffer.from('Rauschen')), null);
  assert.strictEqual(K.decode(Buffer.alloc(0)), null);
  assert.strictEqual(K.decode(null), null);
});

// --- makeKacoSerialReader: der TCP-Teil, gegen eine gefaelschte `net` --------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this._timeoutMs = null;
    this._timeoutCb = null;
  }
  connect(port, ip, cb) {
    this.port = port;
    this.ip = ip;
    this._connectCb = cb;
    return this;
  }
  write(buf) { this.written.push(buf); }
  setTimeout(ms, cb) { this._timeoutMs = ms; this._timeoutCb = cb; }
  destroy() { this.destroyed = true; }
}

function fakeNet(onSocket) {
  return {
    Socket: class extends FakeSocket {
      constructor() {
        super();
        if (onSocket) onSocket(this);
      }
    },
  };
}

test('makeKacoSerialReader: schreibt genau die Anfrage und dekodiert eine vollstaendige Antwort', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = K.makeKacoSerialReader({ net, timeoutMs: 1000, replyGapMs: 10 });

  const promise = read({ ip: '192.168.1.50', port: 8899, address: 1 });
  // connect() ruft den Verbindungs-Callback synchron in diesem Fake auf.
  socket._connectCb();
  assert.deepStrictEqual(socket.written[0], Buffer.from('#010\r', 'ascii'));

  socket.emit('data', buildCmd0Frame(EXAMPLE));
  const out = await promise;
  assert.strictEqual(out.reading.pv_power_kw, 5.72);
  assert.strictEqual(socket.destroyed, true);
});

test('makeKacoSerialReader: ohne jede Antwort liefert der Zeitabstand null (Timeout), nie einen haengenden Promise', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = K.makeKacoSerialReader({ net, timeoutMs: 50, replyGapMs: 10 });

  const promise = read({ ip: '192.168.1.50', port: 8899, address: 2 });
  socket._connectCb();
  socket._timeoutCb(); // der Socket-Timeout feuert
  assert.strictEqual(await promise, null);
});

test('makeKacoSerialReader: ein Verbindungsfehler liefert null, nie einen Wurf', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = K.makeKacoSerialReader({ net });

  const promise = read({ ip: '192.168.1.50', port: 8899, address: 3 });
  socket._connectCb();
  socket.emit('error', new Error('ECONNREFUSED'));
  assert.strictEqual(await promise, null);
});

test('makeKacoSerialReader: eine Teilantwort (fehlender Typ-String) wird ueber den Leerlauf-Zeitabstand trotzdem dekodiert', async () => {
  let socket;
  const net = fakeNet((s) => { socket = s; });
  const read = K.makeKacoSerialReader({ net, timeoutMs: 1000, replyGapMs: 10 });

  const promise = read({ ip: '192.168.1.50', port: 8899, address: 1 });
  socket._connectCb();

  const full = buildCmd0Frame(EXAMPLE, { type: '' });
  // In zwei Haeppchen schicken wie ein echter TCP-Strom - das zweite traegt
  // keinen eigenen CR mehr, der Leerlauf-Zeitabstand muss trotzdem feuern.
  socket.emit('data', full.subarray(0, 40));
  socket.emit('data', full.subarray(40));
  const out = await promise;
  assert.notStrictEqual(out, null);
  assert.strictEqual(out.reading.pv_power_kw, 5.72);
});

test('makeKacoSerialReader: ohne IP oder mit Adresse ausserhalb 1..32 wird gar nicht erst verbunden', async () => {
  const net = fakeNet(() => { throw new Error('darf nicht verbinden'); });
  const read = K.makeKacoSerialReader({ net });
  assert.strictEqual(await read({ ip: '', port: 8899, address: 1 }), null);
  assert.strictEqual(await read({ ip: '192.168.1.50', port: 8899, address: 0 }), null);
  assert.strictEqual(await read({ ip: '192.168.1.50', port: 8899, address: 99 }), null);
});

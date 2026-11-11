'use strict';

/**
 * Erzeugt kaco-serial-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * kaco-serial-decode.js (Node-RED, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/kacoserial (Edge Light).
 *
 * Das Muster von deye-decode-vectors.gen.js: Die erwarteten Ausgaben entstehen
 * nicht von Hand, sondern aus dem JS-Modul selbst. kaco-serial-vectors.test.js
 * rechnet sie bei jedem Lauf neu und schlaegt fehl, sobald Modul und Datei
 * auseinanderlaufen. Wer kaco-serial-decode.js aendert, fuehrt dieses Skript
 * aus und committet die neue Datei; der Go-Test zeigt dann, ob der Zwilling
 * mitziehen muss.
 *
 *   node edge-app/nodered/kaco/kaco-serial-vectors.gen.js
 *
 * Eingabe jedes Falls sind die ROHEN Bytes (hex), wie sie vom Wandler kommen -
 * so pruefen beide Seiten das Framing (Stoerbytes, Teilantworten, Pruefsumme
 * als 0x0A/0x0D) und das Zahlenlesen (JavaScripts Number() auf ein
 * 'ascii'-decodiertes Feld: leer = 0, hohes Bit faellt weg).
 */

const fs = require('fs');
const path = require('path');
const K = require('./kaco-serial-decode.js');

const OUT = path.join(__dirname, 'kaco-serial-vectors.json');

function padR(value, width) {
  const s = String(value);
  if (s.length > width) throw new Error('value too wide: ' + s + ' > ' + width);
  return ' '.repeat(width - s.length) + s;
}

// frame(f, opts) baut ein Kommando-"0"-Frame: `LF * AA 0 <Felder fester Breite> <Pruefsumme>[ <Typ>]\r`.
// opts.checksum ueberschreibt die Pruefsumme, opts.type den dekorativen Typ-String
// ('' = keiner), opts.noCR laesst das CR weg.
function frame(f, opts) {
  opts = opts || {};
  const body = '*' + padR(f.address, 2) + f.cmd + ' ' +
    padR(f.status, 3) + ' ' + padR(f.dcVoltageV, 5) + ' ' + padR(f.dcCurrentA, 5) + ' ' + padR(f.dcPowerW, 5) + ' ' +
    padR(f.acVoltageV, 5) + ' ' + padR(f.acCurrentA, 5) + ' ' + padR(f.acPowerW, 5) + ' ' + padR(f.temperatureC, 3) + ' ' +
    padR(f.dailyYieldWh, 6) + ' ';
  const bodyBytes = Buffer.from(body, 'latin1');
  const checksum = opts.checksum !== undefined ? opts.checksum : K.kacoChecksum(bodyBytes);
  const type = opts.type !== undefined ? opts.type : ' 9600I';
  return Buffer.concat([Buffer.from([0x0a]), bodyBytes, Buffer.from([checksum]), Buffer.from(type + (opts.noCR ? '' : '\r'), 'latin1')]);
}

// Das dokumentierte Beispiel (plieningerweb/kacors485 README, Antwort auf "#010\r").
const EXAMPLE = {
  address: '01', cmd: '0', status: 4, dcVoltageV: '585.9', dcCurrentA: '10.17', dcPowerW: 5958,
  acVoltageV: '229.5', acCurrentA: '24.90', acPowerW: 5720, temperatureC: 36, dailyYieldWh: 17614,
};
// Das Bild des Stand-ins der Kundenanlage (vp-kundenanlage-drei-geraete, kaco_sim.py).
const KUNDE = {
  address: '01', cmd: '0', status: 4, dcVoltageV: '417.5', dcCurrentA: '3.08', dcPowerW: 1284,
  acVoltageV: '230.4', acCurrentA: '5.37', acPowerW: 1236, temperatureC: 39, dailyYieldWh: 6567,
};

const hex = (b) => Buffer.from(b).toString('hex');
const at = (buf, i, byte) => { const c = Buffer.from(buf); c[i] = byte; return c; };
const text = (buf, i, s) => { const c = Buffer.from(buf); c.write(s, i, 'latin1'); return c; };
const ex = frame(EXAMPLE);

const cases = [
  // --- gute Frames ----------------------------------------------------------------
  { name: 'dokumentiertes Beispiel (kacors485 README, Typ 9600I)', raw: ex },
  { name: 'Kundenanlage: Stand-in des Powador 3200 (Typ 3200I)', raw: frame(KUNDE, { type: ' 3200I' }) },
  { name: 'hoechste Busadresse 32, kein Typ-String', raw: frame({ ...EXAMPLE, address: '32' }, { type: '' }) },
  { name: 'Adresse 7 (Kommando-Echo 0)', raw: frame({ ...EXAMPLE, address: '07' }) },
  { name: 'Nachts: AC-Leistung -12 W (Eigenverbrauch der Elektronik)', raw: frame({ ...EXAMPLE, acPowerW: -12, status: 1 }) },
  { name: 'AC-Leistung 0, Ertrag 0', raw: frame({ ...EXAMPLE, acPowerW: 0, dcPowerW: 0, dailyYieldWh: 0 }) },
  { name: 'Tagesertrag 999999 Wh (volle Feldbreite)', raw: frame({ ...EXAMPLE, dailyYieldWh: 999999 }) },
  { name: 'Leistung 99999 W (volle Feldbreite), Temperatur 100', raw: frame({ ...EXAMPLE, acPowerW: 99999, dcPowerW: 99999, temperatureC: 100 }) },
  { name: 'Rundung: 234,5 W wird 0,235 kW, Ertrag 1761,5 Wh wird 1,762 kWh (halb nach +unendlich)', raw: frame({ ...EXAMPLE, acPowerW: '234.5', dailyYieldWh: '1761.5' }) },
  { name: 'Rundung: -0,5 W (Math.round halb nach +unendlich)', raw: frame({ ...EXAMPLE, acPowerW: '-0.5', dcPowerW: '-0.5' }) },
  { name: 'Rundung: -1,5 W', raw: frame({ ...EXAMPLE, acPowerW: '-1.5', dcPowerW: '-1.5' }) },
  // --- Pruefsumme: nicht fatal, aber sichtbar ------------------------------------------
  { name: 'falsche Pruefsumme 0x00: Werte da, checksumOk false', raw: frame(EXAMPLE, { checksum: 0x00 }) },
  { name: 'Pruefsumme ist 0x0A (LF): Framing bleibt stabil', raw: frame(EXAMPLE, { checksum: 0x0a }) },
  { name: 'Pruefsumme ist 0x0D (CR) und kein Typ-String: CR genau an der Pruefsumme', raw: frame(EXAMPLE, { checksum: 0x0d, type: '' }) },
  { name: 'Pruefsumme ist 0x0D mit Typ-String', raw: frame(EXAMPLE, { checksum: 0x0d }) },
  { name: 'Pruefsumme 0xFF', raw: frame(EXAMPLE, { checksum: 0xff }) },
  // --- Teilantworten / Framing -----------------------------------------------------------
  { name: 'vor der Pruefsumme abgeschnitten (53 Bytes)', raw: ex.subarray(0, K.CMD0_MIN_LEN - 5) },
  { name: 'ein Byte vor der Pruefsumme (57 Bytes)', raw: ex.subarray(0, K.CMD0_MIN_LEN - 1) },
  { name: 'genau 58 Bytes: Pruefsumme da, kein CR - laengen-vollstaendig, aber nicht abgeschlossen', raw: ex.subarray(0, K.CMD0_MIN_LEN) },
  { name: '58 Bytes + CR', raw: Buffer.concat([ex.subarray(0, K.CMD0_MIN_LEN), Buffer.from([0x0d])]) },
  { name: 'Typ-String ohne CR (Teilantwort vor dem Leerlauf-Zeitabstand)', raw: frame(EXAMPLE, { noCR: true }) },
  { name: 'zwei Frames hintereinander: das erste gilt', raw: Buffer.concat([ex, frame({ ...EXAMPLE, acPowerW: 1 })]) },
  { name: 'Stoerbytes 00 00 vor dem Frame (roh, nicht bereinigt)', raw: Buffer.concat([Buffer.from([0x00, 0x00]), ex]) },
  { name: 'Stoerbytes mit CR vor dem LF', raw: Buffer.concat([Buffer.from([0x0d, 0x20]), ex]) },
  { name: 'nur Stoerbytes ohne LF', raw: Buffer.from([0x00, 0x01, 0xff]) },
  { name: 'nur ein LF', raw: Buffer.from([0x0a]) },
  { name: 'Rauschen "ratlos"', raw: Buffer.from('ratlos', 'latin1') },
  { name: 'leer', raw: Buffer.alloc(0) },
  { name: 'LF* und dann Muell in voller Laenge', raw: Buffer.concat([Buffer.from([0x0a, 0x2a]), Buffer.alloc(60, 0x41)]) },
  // --- Kopf und Kommando-Byte ----------------------------------------------------------
  { name: 'fehlender LF-Kopf ("A" statt LF)', raw: at(ex, 0, 0x41) },
  { name: 'fehlender Stern', raw: at(ex, 1, 0x23) },
  { name: 'Kommando-Byte "n" (CRC16-Variante der TL/TR-Linie): anderes Protokoll', raw: at(ex, 4, 'n'.charCodeAt(0)) },
  { name: 'Kommando-Byte "4" (Park-Wechselrichter 000xi): anderes Protokoll', raw: at(ex, 4, '4'.charCodeAt(0)) },
  { name: 'Kommando-Byte "3" (bekannt, aber nicht die Momentanwerte): kein Mismatch, kein Parse', raw: at(ex, 4, '3'.charCodeAt(0)) },
  { name: 'Kommando-Byte "s" (bekannt): kein Mismatch, kein Parse', raw: at(ex, 4, 's'.charCodeAt(0)) },
  // --- Adressfeld -------------------------------------------------------------------------
  { name: 'Adressfeld "  " (leer): Number("") ist 0', raw: text(ex, 2, '  ') },
  { name: 'Adressfeld " 1"', raw: text(ex, 2, ' 1') },
  { name: 'Adressfeld "1x": nicht numerisch', raw: text(ex, 2, '1x') },
  { name: 'Adressfeld "1.": ganzzahlig', raw: text(ex, 2, '1.') },
  { name: 'Adressfeld ".5": keine ganze Zahl', raw: text(ex, 2, '.5') },
  // --- Zahlenlesen wie JavaScripts Number() -------------------------------------------
  { name: 'nicht-numerisches Feld (dcVoltage "xxxxx")', raw: text(ex, 10, 'xxxxx') },
  { name: 'leeres Feld (status "   ") liest als 0', raw: text(ex, 6, '   ') },
  { name: 'Feld mit Exponent ("  1e3" = 1000 W)', raw: text(ex, 22, '  1e3') },
  { name: 'Feld hexadezimal (" 0x1F" = 31)', raw: text(ex, 22, ' 0x1F') },
  { name: 'Feld mit Pluszeichen ("+5958")', raw: text(ex, 22, '+5958') },
  { name: 'Feld ohne fuehrende Null ("  .50" = 0,5 A)', raw: text(ex, 16, '  .50') },
  { name: 'Feld "5." = 5', raw: text(ex, 16, '   5.') },
  { name: 'Feld "  Inf": nicht endlich', raw: text(ex, 22, '  Inf') },
  { name: 'Feld "1_000": nicht numerisch', raw: text(ex, 22, '1_000') },
  { name: 'Feld "  NaN"', raw: text(ex, 22, '  NaN') },
  { name: 'Feld mit Tabulator ("\\t4\\t" im Status)', raw: text(ex, 6, '\t4\t') },
  { name: 'Feld "1,5" (Komma): nicht numerisch', raw: text(ex, 22, '  1,5') },
  { name: 'Feld "0b101" = 5', raw: text(ex, 22, '0b101') },
  { name: 'Feld "0o17" = 15', raw: text(ex, 22, ' 0o17') },
  { name: 'Feld "-0" = 0', raw: text(ex, 40, '   -0') },
  { name: 'hohes Bit in einem Feld (0xB5 liest als "5")', raw: at(ex, 24, 0xb5) },
  { name: 'hohes Bit im Typ-String (0xC9 liest als "I")', raw: at(ex, 63, 0xc9) },
  { name: 'Typ-String mit Leerzeichen und Tab wird getrimmt', raw: frame(EXAMPLE, { type: ' \t Powador 3200 \t' }) },
];

// JSON kennt kein undefined: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

function parseFor(raw) {
  try {
    return clean(K.parseCmd0(raw));
  } catch (e) {
    if (!(e instanceof K.ParseError)) throw e;
    return { error: true };
  }
}

function caseFor(c) {
  const cmd = K.replyCommandByte(c.raw);
  return {
    name: c.name,
    hex: hex(c.raw),
    trim: hex(K.trimLeadingJunk(c.raw)),
    complete: K.isCmd0Complete(c.raw),
    reply_command_byte: cmd,
    protocol_mismatch: K.protocolMismatch(c.raw),
    verify_checksum: K.verifyCmd0Checksum(c.raw),
    parse: parseFor(c.raw),
    decode: clean(K.decode(c.raw)),
    decode_require_checksum: clean(K.decode(c.raw, { requireChecksum: true })),
  };
}

function requestFor(address, command) {
  try {
    return { address, command, hex: hex(K.buildRequest(address, command)) };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { address, command, error: true };
  }
}

const out = {
  _comment: [
    'GENERIERT von kaco-serial-vectors.gen.js aus kaco-serial-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: kaco-serial-vectors.test.js (JS) und edge-app/core/internal/kacoserial (Go, Edge Light).',
    'hex sind die rohen Bytes vom Wandler; trim/complete/verify_checksum/parse/decode sind die Modulfunktionen darauf; parse.error = ParseError.',
  ],
  constants: {
    min_address: K.MIN_ADDRESS,
    max_address: K.MAX_ADDRESS,
    default_port: K.DEFAULT_PORT,
    default_address: K.DEFAULT_ADDRESS,
    cmd_measure: K.CMD_MEASURE,
    cmd0_min_len: K.CMD0_MIN_LEN,
    families: Object.keys(K.FAMILIES),
    serial_params: K.SERIAL_PARAMS,
    offsets: K._offsets,
  },
  build_request: [[1, '0'], [32, '3'], [7, '0'], [10, '0'], [0, '0'], [33, '0'], [-1, '0'], [1, ''], [1, '00']].map((r) => requestFor(r[0], r[1])),
  checksum: [[], [1, 2, 3], [255, 255, 2], [0x2a, 0x30, 0x31, 0x30, 0x20], Array.from(ex.subarray(1, 57))].map((b) => ({ hex: hex(Buffer.from(b)), sum: K.kacoChecksum(Buffer.from(b)) })),
  cases: cases.map(caseFor),
};

const textOut = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, textOut);
  console.log('geschrieben: ' + OUT + ' (' + out.cases.length + ' Faelle)');
}

module.exports = { build: () => textOut, OUT };

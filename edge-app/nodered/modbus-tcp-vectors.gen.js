'use strict';

/**
 * Erzeugt modbus-tcp-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * generischen Modbus-TCP-Weg der Docker-Box (Quelle der Wahrheit) und seinem
 * Go-Zwilling in Edge Light:
 *
 *   - modbus-tcp.js registerCount/decodeValue/profileRead/decodeProfile
 *     -> edge-app/core/internal/modbusprofil
 *   - vp-palette/nodes/vp-modbus-probe.js classify/runOps (die Lese-Op des
 *     Probe-Kanals, „Register einmal lesen“) -> edge-app/core/internal/modbusprofil
 *     (probe.go)
 *
 * Das Muster von huawei-decode-vectors.gen.js: Die erwarteten Ausgaben entstehen
 * nicht von Hand, sondern aus den JS-Modulen selbst. modbus-tcp-vectors.test.js
 * rechnet sie bei jedem Lauf neu und schlaegt fehl, sobald Modul und Datei
 * auseinanderlaufen. Wer eines der Module aendert, fuehrt dieses Skript aus und
 * committet die neue Datei; der Go-Test zeigt dann, ob der Zwilling mitziehen
 * muss.
 *
 *   node edge-app/nodered/modbus-tcp-vectors.gen.js
 *
 * Die Probe-Faelle laufen runOps mit einem eingespielten Leser: jeder Aufruf
 * nimmt die naechste Antwort aus `antworten` ({regs} oder {fehler: Meldung}),
 * und der Fall haelt fest, mit welchem Leseplan der Leser gerufen wurde. Die
 * Meldungen sind die Woerter aus lib/modbus-conn.js und modbus-tcp.js - der
 * Go-Leser nennt seine Fehler mit denselben Anfaengen, damit classify auf beiden
 * Seiten dieselbe Klasse findet.
 */

const fs = require('fs');
const path = require('path');
const M = require('./modbus-tcp.js');
const P = require('./vp-palette/nodes/vp-modbus-probe.js');

const OUT = path.join(__dirname, 'modbus-tcp-vectors.json');

const f32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
};
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
};

// --- decodeValue -------------------------------------------------------------

const DECODE_VALUE = [
  { regs: [0], data_type: 'u16', word_order: 'big' },
  { regs: [65535], data_type: 'u16', word_order: 'big' },
  { regs: [65535], data_type: 's16', word_order: 'big' },
  { regs: [32768], data_type: 's16', word_order: 'big' },
  { regs: [32767, 1], data_type: 's16', word_order: 'little' },
  { regs: [1, 2], data_type: 'u32', word_order: 'big' },
  { regs: [1, 2], data_type: 'u32', word_order: 'little' },
  { regs: [0xffff, 0xffff], data_type: 'u32', word_order: 'big' },
  { regs: [0xffff, 0xffff], data_type: 's32', word_order: 'big' },
  { regs: i32(-123456), data_type: 's32', word_order: 'big' },
  { regs: i32(-123456).reverse(), data_type: 's32', word_order: 'little' },
  { regs: i32(2147483647), data_type: 's32', word_order: 'big' },
  { regs: [0x8000, 0], data_type: 's32', word_order: 'big' },
  { regs: f32(3.14), data_type: 'float32', word_order: 'big' },
  { regs: f32(-1250.5), data_type: 'float32', word_order: 'big' },
  { regs: f32(-1250.5).reverse(), data_type: 'float32', word_order: 'little' },
  { regs: f32(0.1), data_type: 'float32', word_order: 'big' },
  { regs: [0x7f80, 0], data_type: 'float32', word_order: 'big', name: '+Inf ist kein Wert' },
  { regs: [0xff80, 0], data_type: 'float32', word_order: 'big', name: '-Inf ist kein Wert' },
  { regs: [0x7fc0, 0], data_type: 'float32', word_order: 'big', name: 'NaN ist kein Wert' },
  { regs: [0, 0x7fc0], data_type: 'float32', word_order: 'little', name: 'NaN auch in Wortfolge little' },
  { regs: [0x0000, 0x0001], data_type: 'float32', word_order: 'big', name: 'kleinste Subnormale' },
  { regs: [1], data_type: 'u32', word_order: 'big', name: 'zu wenige Woerter' },
  { regs: [], data_type: 'u16', word_order: 'big', name: 'keine Woerter' },
  { regs: [1, 2], data_type: 'u64', word_order: 'big', name: 'unbekannter Typ' },
  { regs: [1, 2], data_type: '', word_order: 'big', name: 'leerer Typ' },
  { regs: [1, 2], data_type: 'u32', word_order: '', name: 'leere Wortfolge = big' },
  { regs: [1, 2], data_type: 'u32', word_order: 'LITTLE', name: 'nur genau little dreht' },
  { regs: [7, 99, 99], data_type: 'u16', word_order: 'big', name: 'ueberzaehlige Woerter stoeren nicht' },
];

// --- profile decode -------------------------------------------------------------

const s16w = (v) => v & 0xffff;
const sunspec = (grid, pv, load, batt, soc, wmax, conn) =>
  [s16w(grid), s16w(pv), s16w(load), s16w(batt), soc, wmax, conn, 0, 0];

const PROFILE_CASES = [
  { name: 'Simulator-Mittag: Einspeisung, Speicher laedt', profile: 'sunspec', regs: sunspec(-250, 520, 170, 100, 655, 10000, 3000) },
  { name: 'Nacht: Bezug, Speicher entlaedt', profile: 'sunspec', regs: sunspec(140, 0, 220, -80, 412, 10000, 3000) },
  { name: '§14a-Begrenzung 60 % von 11 kW', profile: 'sunspec', regs: sunspec(0, 0, 0, 0, 0, 6000, 1100) },
  { name: 'kleinste Einspeisung -10 W', profile: 'sunspec', regs: sunspec(-1, 0, 0, -1, 0, 0, 0) },
  { name: 'Rundung: Grenze 0,0005 kW (halbes Watt, JS Math.round)', profile: 'sunspec', regs: sunspec(0, 0, 0, 0, 0, 5, 100) },
  { name: 'Rundung: Grenze 0,0015 kW', profile: 'sunspec', regs: sunspec(0, 0, 0, 0, 0, 15, 100) },
  { name: 'kleine Werte', profile: 'sunspec', regs: sunspec(5, 15, 25, -5, 1, 1, 1) },
  { name: 'Groesste Woerter', profile: 'sunspec', regs: sunspec(32767, -32768, 32767, -32768, 65535, 65535, 65535) },
  { name: 'Grenzwert-Produkt mit Nachkommastellen', profile: 'sunspec', regs: sunspec(0, 0, 0, 0, 0, 3333, 777) },
  { name: 'nur sieben Woerter genuegen', profile: 'sunspec', regs: sunspec(10, 20, 30, 40, 500, 10000, 500).slice(0, 7) },
  { name: 'sechs Woerter sind zu wenig', profile: 'sunspec', regs: sunspec(10, 20, 30, 40, 500, 10000, 500).slice(0, 6) },
  { name: 'unbekanntes Profil', profile: 'kompakt2', regs: sunspec(10, 20, 30, 40, 500, 10000, 500) },
];

// --- probe: classify -------------------------------------------------------------

const CLASSIFY = [
  'Verbindungsaufbau-Timeout (8000 ms)',
  'Verbindung fehlgeschlagen: connect ECONNREFUSED 192.168.1.20:502',
  'Antwort-Timeout (8000 ms)',
  'Gesamt-Timeout nach 30000 ms',
  'Verbindung geschlossen ohne Antwort',
  'Modbus-Ausnahme 0x02',
  'Warteschlange für 192.168.1.20:502 voll - älteste Anfrage verworfen',
  'Transaktions-ID weicht ab: 7',
  'Modbus-Nutzlast unvollstaendig',
  '',
  'antwort-timeout (klein geschrieben ist kein Anfang)',
];

// --- probe: runOps (die Lese-Op) --------------------------------------------------

const op = (o) => Object.assign({ id: 'r1', host: '192.168.1.20', port: 502, unit_id: 1, fc: 3, address: 0, data_type: 'u16', word_order: 'big' }, o);

const PROBE_CASES = [
  { name: 'u16 gelesen', ops: [op({ address: 40083 })], antworten: [{ regs: [1234] }] },
  { name: 's32 little ueber FC4, Wortfolge sichtbar', ops: [op({ fc: 4, data_type: 's32', word_order: 'little', address: 30775, unit_id: 3, port: 1502 })], antworten: [{ regs: i32(-4500).reverse() }] },
  { name: 'float32 NaN passt nicht zum Datentyp', ops: [op({ data_type: 'float32' })], antworten: [{ regs: [0x7fc0, 0] }] },
  { name: 'float32 gelesen', ops: [op({ data_type: 'float32', address: 70 })], antworten: [{ regs: f32(229.7) }] },
  { name: 'zu wenige Woerter passen nicht zum Datentyp', ops: [op({ data_type: 'u32' })], antworten: [{ regs: [5] }] },
  { name: 'unbekannter Datentyp ist unvollstaendig', ops: [op({ data_type: 'string' })], antworten: [] },
  { name: 'leerer Host ist unvollstaendig', ops: [op({ host: '  ' })], antworten: [] },
  { name: 'Adresse ausserhalb ist unvollstaendig', ops: [op({ address: 65536 })], antworten: [] },
  { name: 'Port und Unit ausserhalb fallen auf 502 und 1', ops: [op({ port: 70000, unit_id: 300 })], antworten: [{ regs: [9] }] },
  { name: 'FC ungleich 4 liest Holding', ops: [op({ fc: 1 })], antworten: [{ regs: [9] }] },
  { name: 'Host wird getrimmt', ops: [op({ host: ' 10.0.0.7 ' })], antworten: [{ regs: [9] }] },
  { name: 'Modbus-Ausnahme', ops: [op({})], antworten: [{ fehler: 'Modbus-Ausnahme 0x02' }] },
  { name: 'nicht erreichbar', ops: [op({})], antworten: [{ fehler: 'Verbindung fehlgeschlagen: connect EHOSTUNREACH 192.168.1.20:502' }] },
  { name: 'Antwort-Timeout', ops: [op({})], antworten: [{ fehler: 'Antwort-Timeout (8000 ms)' }] },
  { name: 'unlesbare Antwort', ops: [op({})], antworten: [{ fehler: 'Transaktions-ID weicht ab: 3' }] },
  {
    name: 'drei Schritte nacheinander, einer scheitert, die Reihenfolge bleibt',
    ops: [op({ id: 'a', address: 1 }), op({ id: 'b', address: 2, data_type: 'u32' }), op({ id: 'c', address: 4, data_type: 's16' })],
    antworten: [{ regs: [1] }, { fehler: 'Verbindung geschlossen ohne Antwort' }, { regs: [0xfffe] }],
  },
  { name: 'ohne id traegt der Schritt seine Stelle', ops: [op({ id: undefined, address: 5 }), op({ id: undefined, address: 6 })], antworten: [{ regs: [1] }, { regs: [2] }] },
];

async function probeCase(c) {
  const antworten = c.antworten.slice();
  const plaene = [];
  const ops = c.ops.map((o) => JSON.parse(JSON.stringify(o)));
  const results = await P.runOps(ops, (plan) => {
    plaene.push(plan);
    const a = antworten.shift();
    if (!a) return Promise.reject(new Error('Vektor: keine Antwort mehr'));
    if (a.fehler !== undefined) return Promise.reject(new Error(a.fehler));
    return Promise.resolve(a.regs.slice());
  });
  return { name: c.name, ops, antworten: c.antworten, plaene, results };
}

// JSON kennt kein undefined/NaN: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

async function build() {
  const probe = [];
  for (const c of PROBE_CASES) probe.push(await probeCase(c));
  const out = {
    _comment: [
      'GENERIERT von modbus-tcp-vectors.gen.js aus modbus-tcp.js und vp-palette/nodes/vp-modbus-probe.js - nicht von Hand bearbeiten.',
      'Gepruefte Seiten: modbus-tcp-vectors.test.js (JS) und edge-app/core/internal/modbusprofil (Go, Edge Light).',
      'decode_value.value und profile.decode sind null, wo das JS-Modul null liefert; probe.antworten spielt der Leser der Reihe nach ab.',
    ],
    register_count: ['u16', 's16', 'u32', 's32', 'float32', 'u64', 'string', ''].map((t) => ({ data_type: t, count: M.registerCount(t) })),
    decode_value: DECODE_VALUE.map((c) => ({
      name: c.name || c.data_type + ' ' + c.word_order + ' ' + JSON.stringify(c.regs),
      regs: c.regs, data_type: c.data_type, word_order: c.word_order,
      value: clean(M.decodeValue(c.regs, c.data_type, c.word_order)),
    })),
    profile_read: { sunspec: M.profileRead('sunspec'), unbekannt: M.profileRead('kompakt2') },
    profile: PROFILE_CASES.map((c) => ({ name: c.name, profile: c.profile, regs: c.regs, decode: clean(M.decodeProfile(c.profile, c.regs)) })),
    classify: CLASSIFY.map((m) => ({ meldung: m, ergebnis: P.classify(m) })),
    probe,
  };
  return JSON.stringify(out, null, 2) + '\n';
}

if (require.main === module) {
  build().then((text) => {
    fs.writeFileSync(OUT, text);
    console.log('geschrieben: ' + OUT);
  });
}

module.exports = { build, OUT };

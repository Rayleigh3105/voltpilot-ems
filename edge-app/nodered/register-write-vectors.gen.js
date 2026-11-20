'use strict';

/**
 * Erzeugt register-write-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * Einmal-Schreibpfad der Modbus-TCP-Spur der Docker-Box (Quelle der Wahrheit:
 * vp-palette/lib/register-write.js plan/runOnce und switch-write.js classify)
 * und seinem Go-Zwilling in Edge Light (edge-app/core/internal/einmalschreiben).
 *
 * Das Muster von modbus-tcp-vectors.gen.js: Die erwarteten Ausgaben entstehen
 * aus den JS-Modulen selbst; register-write-vectors.test.js rechnet sie bei
 * jedem Lauf neu.
 *
 *   node edge-app/nodered/register-write-vectors.gen.js
 *
 * Die Lauf-Faelle spielen runOnce mit eingespielten Abhaengigkeiten: jeder
 * Lese- oder Schreibaufruf nimmt die naechste Antwort aus `antworten`
 * ({regs}, {coils}, {ok} oder {fehler: Meldung}), und der Fall haelt die Folge
 * der Aufrufe fest (lesen, Spulen lesen, schreiben, warten) - die Reihenfolge
 * IST die Ehrlichkeit dieses Pfads (erst lesen, dann vergleichen, genau einmal
 * schreiben, warten, zuruecklesen).
 */

const fs = require('fs');
const path = require('path');
const RW = require('./vp-palette/lib/register-write.js');
const SW = require('./vp-palette/lib/switch-write.js');

const OUT = path.join(__dirname, 'register-write-vectors.json');

const req = (o) => Object.assign({ request_id: 'w1', mode: 'apply', kind: 'holding', addr: 40100, value: 20,
  host: '192.168.1.20', port: 502, unit_id: 1 }, o);

const PLAN = [
  req({}),
  req({ mode: 'dry_run', value: undefined }),
  req({ mode: 'dry_run', value: 99999 }),
  req({ write_fc: 6 }),
  req({ write_fc: 16 }),
  req({ write_fc: 3 }),
  req({ write_fc: '6' }),
  req({ kind: 'coil', value: 1 }),
  req({ kind: 'coil', value: 2 }),
  req({ kind: 'coil', value: 0, write_fc: 5 }),
  req({ kind: 'coil', value: 1, write_fc: 15 }),
  req({ kind: 'input' }),
  req({ host: '8.8.8.8' }),
  req({ host: '' }),
  req({ host: 'wechselrichter' }),
  req({ host: ' box.local ' }),
  req({ addr: 65536 }),
  req({ addr: -1 }),
  req({ addr: '40100' }),
  req({ value: 65536 }),
  req({ value: undefined }),
  req({ value: 12.7 }),
  req({ expected_before: 7 }),
  req({ expected_before: null }),
  req({ expected_before: 70000 }),
  req({ port: 0, unit_id: 300 }),
  req({ port: '1502', unit_id: '3' }),
  null,
];

const CLASSIFY = [
  'Verbindungsaufbau-Timeout (8000 ms)',
  'Verbindung fehlgeschlagen: connect ECONNREFUSED 192.168.1.20:502',
  'Antwort-Timeout (8000 ms)',
  'Gesamt-Timeout nach 30000 ms',
  'Verbindung geschlossen ohne Antwort',
  'Modbus-Ausnahme 0x02',
  'Warteschlange für 192.168.1.20:502 voll - älteste Anfrage verworfen',
  'Transaktions-ID weicht ab: 7',
  '',
];

const LAEUFE = [
  { name: 'Vorschau liest nur', req: req({ mode: 'dry_run', value: undefined }), antworten: [{ regs: [42] }] },
  { name: 'Schreiben mit FC16, warten, zuruecklesen', req: req({}), antworten: [{ regs: [10] }, { ok: true }, { regs: [20] }] },
  { name: 'Schreiben mit FC6', req: req({ write_fc: 6 }), antworten: [{ regs: [10] }, { ok: true }, { regs: [20] }] },
  { name: 'Geraet uebernimmt nicht', req: req({}), antworten: [{ regs: [10] }, { ok: true }, { regs: [10] }] },
  { name: 'Spule einschalten', req: req({ kind: 'coil', value: 1, addr: 3 }), antworten: [{ coils: [false] }, { ok: true }, { coils: [true] }] },
  { name: 'Spule ausschalten mit FC5', req: req({ kind: 'coil', value: 0, write_fc: 5, addr: 3 }), antworten: [{ coils: [true] }, { ok: true }, { coils: [false] }] },
  { name: 'Vorbedingung erfuellt', req: req({ expected_before: 10 }), antworten: [{ regs: [10] }, { ok: true }, { regs: [20] }] },
  { name: 'Vorbedingung verfehlt: nichts geschrieben', req: req({ expected_before: 11 }), antworten: [{ regs: [10] }] },
  { name: 'Vorbedingung gegen unlesbaren Wert', req: req({ expected_before: 0 }), antworten: [{ regs: [] }] },
  { name: 'Zuruecklesen scheitert: Wert fehlt, kein erfundener Fehler', req: req({}), antworten: [{ regs: [10] }, { ok: true }, { fehler: 'Antwort-Timeout (8000 ms)' }] },
  { name: 'Schreibantwort bleibt aus: unbestaetigt', req: req({}), antworten: [{ regs: [10] }, { fehler: 'Antwort-Timeout (8000 ms)' }] },
  { name: 'Schreiben abgewiesen: unbestaetigt', req: req({}), antworten: [{ regs: [10] }, { fehler: 'Modbus-Ausnahme 0x02' }] },
  { name: 'Schreibantwort unlesbar', req: req({}), antworten: [{ regs: [10] }, { fehler: 'Transaktions-ID weicht ab: 9' }] },
  { name: 'Verbindung beim Schreiben weg', req: req({}), antworten: [{ regs: [10] }, { fehler: 'Verbindung fehlgeschlagen: read ECONNRESET' }] },
  { name: 'Erstes Lesen scheitert: nichts geschrieben', req: req({}), antworten: [{ fehler: 'Verbindung fehlgeschlagen: connect EHOSTUNREACH 192.168.1.20:502' }] },
  { name: 'Erstes Lesen abgewiesen', req: req({}), antworten: [{ fehler: 'Modbus-Ausnahme 0x02' }] },
  { name: 'Geraet belegt', req: req({}), antworten: [{ fehler: 'Warteschlange für 192.168.1.20:502 voll - älteste Anfrage verworfen' }] },
  { name: 'Unzulaessiges Ziel', req: req({ host: '8.8.8.8' }), antworten: [] },
  { name: 'Unzulaessiger Funktionscode', req: req({ write_fc: 3 }), antworten: [] },
];

// Schalt-Test (switch-write.js): writePlan und runWrite mit eingespielten
// Abhaengigkeiten - der Core hat Ziel, Register und Werte schon zugelassen.
const sop = (o) => Object.assign({ id: 's1', host: '192.168.1.30', port: 502, unit_id: 1, fc: 5, address: 7, value: 1 }, o);
const SCHALT_PLAN = [
  sop({}), sop({ fc: 6, value: 1234 }), sop({ fc: 16, value: 65535 }), sop({ fc: 5, value: 2 }), sop({ fc: 3 }),
  sop({ host: ' 10.0.0.9 ', port: '1502', unit_id: '0' }), sop({ host: '' }), sop({ address: 65536 }),
  sop({ address: -1 }), sop({ value: -1 }), sop({ address: '12.7', value: '1.9' }), sop({ port: 0, unit_id: 300 }),
  sop({ port: 'x', unit_id: null }), sop({ host: 7 }), null,
];
const SCHALT_LAEUFE = [
  { name: 'Spule ein, ohne Zuruecklesen', op: sop({}), antworten: [{ ok: true }] },
  { name: 'Spule ein, Zuruecklesen bestaetigt', op: sop({ readback_address: 7 }), antworten: [{ ok: true }, { coils: [1] }] },
  { name: 'Register mit FC6, Zuruecklesen anderer Adresse', op: sop({ fc: 6, value: 300, readback_address: 8 }), antworten: [{ ok: true }, { regs: [301] }] },
  { name: 'Zuruecklesen ungueltig: die geschriebene Adresse', op: sop({ fc: 16, value: 5, readback_address: 70000 }), antworten: [{ ok: true }, { regs: [5] }] },
  { name: 'Zuruecklesen leer', op: sop({ readback_address: 7 }), antworten: [{ ok: true }, { coils: [] }] },
  { name: 'Zuruecklesen scheitert: trotzdem geschaltet', op: sop({ readback_address: 7 }), antworten: [{ ok: true }, { fehler: 'Antwort-Timeout (8000 ms)' }] },
  { name: 'Schreiben abgewiesen', op: sop({}), antworten: [{ fehler: 'Modbus-Ausnahme 0x02' }] },
  { name: 'Geraet unerreichbar', op: sop({}), antworten: [{ fehler: 'Verbindung fehlgeschlagen: connect ECONNREFUSED 192.168.1.30:502' }] },
  { name: 'Geraet belegt', op: sop({}), antworten: [{ fehler: 'Warteschlange für 192.168.1.30:502 voll - älteste Anfrage verworfen' }] },
  { name: 'Unvollstaendig', op: sop({ fc: 1 }), antworten: [] },
  { name: 'ohne id', op: { host: '192.168.1.30', fc: 5, address: 1, value: 0 }, antworten: [{ ok: true }] },
];

async function schaltLauf(c) {
  const antworten = c.antworten.slice();
  const aufrufe = [];
  const next = () => {
    const a = antworten.shift();
    if (!a) return Promise.reject(new Error('Vektor: keine Antwort mehr'));
    if (a.fehler !== undefined) return Promise.reject(new Error(a.fehler));
    return Promise.resolve(a.regs || a.coils || null);
  };
  const deps = {
    writeValue: (p) => { aufrufe.push({ schreiben: p }); return next(); },
    readRegisters: (p) => { aufrufe.push({ lesen: p }); return next(); },
    readCoils: (p) => { aufrufe.push({ spulen: p }); return next(); },
    arbiter: { runControl: (key, fn) => { aufrufe.push({ spur: key }); return fn(); } },
  };
  const ergebnis = await SW.runWrite(JSON.parse(JSON.stringify(c.op)), deps);
  return { name: c.name, op: c.op, antworten: c.antworten, aufrufe, ergebnis };
}

async function lauf(c) {
  const antworten = c.antworten.slice();
  const aufrufe = [];
  const next = () => {
    const a = antworten.shift();
    if (!a) return Promise.reject(new Error('Vektor: keine Antwort mehr'));
    if (a.fehler !== undefined) return Promise.reject(new Error(a.fehler));
    return Promise.resolve(a.regs || a.coils || null);
  };
  const deps = {
    readRegisters: (p) => { aufrufe.push({ lesen: p }); return next(); },
    readCoils: (p) => { aufrufe.push({ spulen: p }); return next(); },
    writeValue: (p) => { aufrufe.push({ schreiben: p }); return next(); },
    sleep: (ms) => { aufrufe.push({ warten: ms }); return Promise.resolve(); },
    arbiter: { runControl: (key, fn) => { aufrufe.push({ spur: key }); return fn(); } },
  };
  const ergebnis = await RW.runOnce(JSON.parse(JSON.stringify(c.req)), deps);
  return { name: c.name, req: c.req, antworten: c.antworten, aufrufe, ergebnis };
}

// JSON kennt kein undefined: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

async function build() {
  const laeufe = [];
  for (const c of LAEUFE) laeufe.push(clean(await lauf(c)));
  const schaltLaeufe = [];
  for (const c of SCHALT_LAEUFE) schaltLaeufe.push(clean(await schaltLauf(c)));
  const out = {
    _comment: [
      'GENERIERT von register-write-vectors.gen.js aus vp-palette/lib/register-write.js und switch-write.js - nicht von Hand bearbeiten.',
      'Gepruefte Seiten: register-write-vectors.test.js (JS) und edge-app/core/internal/einmalschreiben (Go, Edge Light).',
      'plan ist null, wo plan() den Auftrag verwirft; laeufe.aufrufe ist die Folge der Geraetezugriffe von runOnce.',
      'schalt_plan/schalt_laeufe: writePlan und runWrite des Schalt-Tests (switch-write.js), Geraetezugriffe in Folge.',
    ],
    settle_ms: RW.SETTLE_MS,
    plan: PLAN.map((r) => ({ req: clean(r), plan: clean(RW.plan(r === null ? null : JSON.parse(JSON.stringify(r)))) })),
    classify: CLASSIFY.map((m) => ({ meldung: m, ergebnis: SW.classify(m) })),
    laeufe,
    schalt_plan: SCHALT_PLAN.map((o) => ({ op: clean(o), plan: clean(SW.writePlan(o === null ? null : JSON.parse(JSON.stringify(o)))) })),
    schalt_laeufe: schaltLaeufe,
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

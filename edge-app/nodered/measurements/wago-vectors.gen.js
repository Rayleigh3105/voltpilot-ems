'use strict';

/**
 * Erzeugt wago-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem Leser des
 * VoltPilot-Registerbilds WAGO v1 der Docker-Box (wago-registerbild.js,
 * wago-kopf.js, wago-ereignisse.js - Quelle der Wahrheit) und seinem Go-Zwilling
 * in Edge Light (edge-app/core/internal/wagobild).
 *
 *   node edge-app/nodered/measurements/wago-vectors.gen.js
 *
 * Die Lese-Faelle des Vertrags (V1-V13) prueft der Zwilling direkt gegen
 * docs/contracts/v2/wago-registerbild-vectors.json. Diese Datei ergaenzt, was
 * dort nicht steht: die Anfrageplanung, den Kopf-Bericht der Probe samt
 * Typenschild und die FOLGEN von Lesungen - jeder Fall der Simulator-Vektoren
 * (docs/contracts/v2/wago-simulator-vectors.json) wird mit dem Simulator-Store
 * Schritt fuer Schritt nachgespielt, durch pruefeLesung mit Herzschlag-Wacht
 * und durch WagoEreignisse; je Lesung stehen Woerter, Urteil, Ereignisse und
 * Qualitaeten in der Datei.
 */

const fs = require('fs');
const path = require('path');
const RB = require('./wago-registerbild.js');
const KOPF = require('./wago-kopf.js');
const { WagoEreignisse } = require('./wago-ereignisse.js');
const store = require('../vp-palette/test/fixtures/wago-registerbild-store.js');

const OUT = path.join(__dirname, 'wago-vectors.json');
const T0 = Date.parse('2026-11-20T08:00:00.000Z');
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const planung = [];
for (const p of [
  { basisadresse:0, kartenzahl:0 }, { basisadresse:0, kartenzahl:1 }, { basisadresse:0, kartenzahl:2 },
  { basisadresse:0, kartenzahl:3 }, { basisadresse:100, kartenzahl:4 }, { basisadresse:0, kartenzahl:5 },
  { basisadresse:0, kartenzahl:25 }, { basisadresse:5000, kartenzahl:4, kopflaenge:14, kartenblocklaenge:44 },
  { basisadresse:0, kartenzahl:3, maxWoerter:60 }, { basisadresse:65530, kartenzahl:1 },
  { basisadresse:-1, kartenzahl:1 }, { basisadresse:0, kartenzahl:-1 }, { basisadresse:0, kartenzahl:2, kopflaenge:11 },
  { basisadresse:0, kartenzahl:1, kartenblocklaenge:121 },
]) {
  let ergebnis;
  try { ergebnis = { anfragen:RB.planeAnfragen(p) }; } catch (e) { ergebnis = { error:true }; }
  planung.push({ parameter:p, ...ergebnis });
}

const werte = [];
for (const [w, wf, typ] of [[[0x0038, 0x52f0], 'big', 'UInt32'], [[0x52f0, 0x0038], 'little', 'UInt32'],
  [[0xffff, 0x8ad0], 'big', 'Int32'], [[0xffff, 0xffff], 'big', 'Int32'], [[0xffff, 0xffff], 'big', 'UInt32'],
  [[0x7fff, 0xffff], 'big', 'Int32'], [[0x8000, 0x0000], 'big', 'Int32'], [[1, 2], 'big', null], [[1, 2], 'big', 'Float32']]) {
  const roh = RB.wert32(w, 0, wf);
  werte.push({ woerter:w, wortfolge:wf, datentyp:typ, roh, wert:clean(RB.deute32(roh, typ)) });
}

const kopfWoerter = [0x5650, 0x5242, 1, 0, 12, 42, 4, 1731, 0x0102, 0x0304, 0, 1];
const schild = [0x3735, 0x302d, 0x3832, 0x3132, 0x0000, 0x0a7f, 0x2020, 0xffff];
const berichte = [
  { woerter:kopfWoerter, wortfolge:'big' },
  { woerter:kopfWoerter, wortfolge:'little' },
  { woerter:kopfWoerter.slice(0, 11), wortfolge:'big' },
  { woerter:[0x5650, 0x5243, ...kopfWoerter.slice(2)], wortfolge:'big' },
  { woerter:[0x5650, 0x5242, 2, ...kopfWoerter.slice(3)], wortfolge:'big' },
  { woerter:[...kopfWoerter.slice(0, 4), 11, ...kopfWoerter.slice(5)], wortfolge:'big' },
  { woerter:kopfWoerter, wortfolge:'big', typenschild:schild },
  { woerter:[1, 2], wortfolge:'big', typenschild:[0x2000, 0x0000] },
  { woerter:kopfWoerter, wortfolge:'big', typenschild:[] },
].map((b) => ({ ...b, bericht:clean(KOPF.kopfBericht(b.woerter, { wortfolge:b.wortfolge, typenschild:b.typenschild === undefined ? null : b.typenschild })) }));

const typenschilder = [schild, [], [0x0000], [0x4142, 0x4300]].map((w) => ({ woerter:w, text:clean(KOPF.liesTypenschild(w)) }));

// Folgen: jeder Simulator-Fall, Lesung fuer Lesung.
const { faelle } = store.ladeFaelle();
const folgen = faelle.map((fall) => {
  const s = fall.store();
  const wacht = new KOPF.HerzschlagWacht();
  const ereignisse = new WagoEreignisse();
  const a = fall.aufbau;
  const parameter = { basisadresse:a.basisadresse || 0, funktionscode:a.funktionscode || 3, wortfolge:a.wortfolge || 'big' };
  const soll = { kartenzahl:(a.karten || []).length,
    ...(a.controller_kennung !== undefined ? { controller_kennung:a.controller_kennung } : {}),
    karten:(a.karten || []).map((k) => ({ steckplatz:k.steckplatz, kartentyp:k.kartentyp,
      ...(Number.isInteger(k.variante) ? { variante:k.variante } : {}) })) };
  const lesungen = (fall.lesungen || []).map((l, i) => {
    for (const schritt of l.schritte || []) s.schritt(schritt);
    const woerter = s.woerter();
    const gelesen = KOPF.pruefeLesung(woerter, { steuerung:'source:sps', parameter, soll, wacht });
    const { ereignisse:ev, qualitaet } = ereignisse.lesung(gelesen, { datenquelle:'DQ-W', steuerung:'source:sps',
      komponente:(_k, index) => 'ek-' + (index + 1), zeitpunkt:new Date(T0 + i * 60000) });
    return { woerter, gelesen:clean(gelesen), ereignisse:clean(ev), qualitaet:clean(qualitaet) };
  });
  return { name:fall.name, parameter, soll, lesungen };
});

const out = {
  _comment: [
    'GENERIERT von wago-vectors.gen.js aus wago-registerbild.js, wago-kopf.js, wago-ereignisse.js und dem Simulator-Store - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: wago-vectors.test.js (JS) und edge-app/core/internal/wagobild (Go, Edge Light).',
    'folgen: Zeitpunkt der Lesung i ist ' + new Date(T0).toISOString() + ' + i Minuten; Datenquelle DQ-W, Steuerung source:sps, Karte n heisst ek-(n+1).',
  ],
  planung, werte, berichte, typenschilder, folgen,
};

const text = JSON.stringify(out) + '\n';
if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + folgen.length + ' Folgen, ' + Math.round(text.length / 1024) + ' KiB)');
}
module.exports = { build: () => text, OUT };

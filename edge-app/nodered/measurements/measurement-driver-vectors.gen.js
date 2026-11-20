'use strict';

/**
 * Erzeugt measurement-driver-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * dem Lesetreiber der Messwerte-Bibliothek der Docker-Box (measurement-driver.js,
 * Quelle der Wahrheit) und seinem Go-Zwilling in Edge Light
 * (edge-app/core/internal/messwerte).
 *
 * Das Muster der anderen Vektor-Generatoren: Die erwarteten Ausgaben entstehen
 * aus dem JS-Modul selbst; measurement-driver-vectors.test.js rechnet sie bei
 * jedem Lauf neu.
 *
 *   node edge-app/nodered/measurements/measurement-driver-vectors.gen.js
 *
 * Abgedeckt wird JEDER Dekodier-Weg des ausgelieferten Katalogs: die Punkte
 * werden nach ihrer Dekodier-Signatur zusammengefasst (Wertetyp, Wortfolge,
 * Breite, Skala, Bereich, Decoder ohne seinen Schluessel), und jede Signatur
 * bekommt feste Randwoerter und Zufallswoerter aus einem festen Startwert -
 * dazu die Optionen, die der Decoder liest (Byte-Reihenfolge, Variante,
 * Vergleichswerte, Vorwerte). Fehler des JS-Moduls (etwa ein zu kurzer Puffer)
 * stehen als {"error": true} in der Datei: der Zwilling muss an derselben Stelle
 * ablehnen.
 */

const fs = require('fs');
const path = require('path');
const D = require('./measurement-driver.js');

const OUT = path.join(__dirname, 'measurement-driver-vectors.json');
const catalog = D.catalogDocument;

// mulberry32: ein kleiner, deterministischer Zufall - dieselbe Datei auf jeder Maschine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v,
  (_k, x) => (typeof x === 'bigint' ? String(x) : x)));

// Die Probe ohne ihren point_key (er steht schon am Fall): die Datei bleibt halb so gross.
function ohneSchluessel(sample) {
  const out = clean(sample);
  if (out && typeof out === 'object') delete out.point_key;
  return out;
}

function signatur(p) {
  const decoder = p.decoder ? Object.assign({}, p.decoder) : null;
  if (decoder) delete decoder.source_key;
  return JSON.stringify([p.value_type, p.endian, p.address && p.address.width_words,
    p.address && p.address.registers && p.address.registers.length, p.scale, p.range || null, decoder]);
}

function adressen(p) {
  if (Array.isArray(p.address.registers)) return p.address.registers.slice();
  const start = 40000 + (Number.isInteger(p.address.offset_words) ? p.address.offset_words : 0);
  return Array.from({ length:p.address.width_words }, (_, i) => start + i);
}

function wortSaetze(p, zufall) {
  const n = p.address.width_words;
  const voll = (w) => Array.from({ length:n }, () => w);
  const saetze = [voll(0), voll(0xffff)];
  // Die Uhr- und Zeitformate brauchen gueltige Felder, sonst pruefen sie nur die Ablehnung.
  if (p.value_type === 'datetime' && n >= 6) saetze.push([2026, 11, 19, 21, 30, 5].concat(voll(0)).slice(0, n));
  if (p.value_type === 'datetime' && n === 3) saetze.push([0x1a0b, 0x1315, 0x1e05]);
  if (p.value_type === 'time') saetze.push(n === 1 ? [2130] : [21, 30, 5].concat(voll(0)).slice(0, n));
  saetze.push(Array.from({ length:n }, () => Math.floor(zufall() * 65536)));
  return saetze;
}

function optionen(p, worte) {
  const out = [{}];
  const d = p.decoder || {};
  if (d.byte_order) {
    out.push({ byteOrder:'big' }, { byteOrder:'little' }, { byteOrderWord:d.byte_order.big_value },
      { byteOrderWord:(d.byte_order.big_value || 0) + 1 });
  }
  if (d.variant) {
    for (const v of (d.variant.index_1_values || []).slice(0, 1)) out.push({ variantWord:v });
    out.push({ variantWord:0xfffe });
  }
  if (d.validation && d.validation.lookup) {
    out.push({ decodedValues:{ [d.validation.lookup]:5 } }, { decodedValues:{ [d.validation.lookup]:-1000 } });
  }
  if (d.validation && d.validation.dev != null && d.source_key) {
    out.push({ previousValues:{ [d.source_key]:0 } }, { previousValues:{ [d.source_key]:worte[0] } });
  }
  return out;
}

// Optionen als JS-Objekt fuer decodeRegisters: Maps statt Objekten, wie die Laufzeit sie fuehrt.
function alsOptionen(o) {
  const out = Object.assign({}, o);
  out.previousValues = new Map(Object.entries(o.previousValues || {}));
  out.decodedValues = new Map(Object.entries(o.decodedValues || {}));
  return out;
}

const registerFaelle = [];
const gesehen = new Set();
const zufall = rng(19112026);
for (const p of catalog.points) {
  if (!p.address || !['modbus_holding', 'sunspec_relative', 'registerbild_relative'].includes(p.address.kind)) continue;
  if (!Number.isInteger(p.address.width_words) || p.address.width_words < 1) continue;
  const sig = signatur(p);
  if (gesehen.has(sig)) continue;
  gesehen.add(sig);
  const addresses = adressen(p);
  const saetze = wortSaetze(p, zufall);
  saetze.forEach((worte, satz) => {
    // Die Optionen des Decoders an zwei Saetzen (Rand und Zufall), sonst ohne.
    const alle = satz === 1 || satz === saetze.length - 1 ? optionen(p, worte) : [{}];
    for (const o of alle) {
      const opts = alsOptionen(o);
      let ergebnis;
      try {
        ergebnis = { sample:ohneSchluessel(D.decodeRegisters(p, worte, null, addresses, opts)) };
        // Die Vergleichs- und Vorwerte nach dem Aufruf: nur, wo der Decoder sie fuehrt.
        if (opts.decodedValues.size) ergebnis.decoded_values = clean(Object.fromEntries(opts.decodedValues));
        if (opts.previousValues.size) ergebnis.previous_values = clean(Object.fromEntries(opts.previousValues));
      } catch (e) {
        ergebnis = { error:true };
      }
      registerFaelle.push({ point_key:p.point_key, words:worte, ...(Object.keys(o).length ? { options:o } : {}),
        ...ergebnis });
    }
  });
}

// Falscher Wortzahl: der Treiber dekodiert nur genau die Breite des Punkts.
{
  const p = catalog.points.find((x) => x.address && x.address.width_words === 2 && x.value_type === 'uint32');
  registerFaelle.push({ point_key:p.point_key, words:[1],
    sample:ohneSchluessel(D.decodeRegisters(p, [1], null, adressen(p), {})) });
}

// --- abgeleitete Punkte (Herstellerregeln ueber mehrere Register) ---------------
const abgeleitet = [];
for (const p of catalog.points.filter((x) => D.derivedAddresses(x).length && !x.address)) {
  const adr = D.derivedAddresses(p);
  for (const satz of [adr.map(() => 0), adr.map((_, i) => 100 + i * 7), adr.map(() => 65535), adr.slice(1).map(() => 3)]) {
    const words = new Map(adr.slice(0, satz.length).map((a, i) => [a, satz[i]]));
    abgeleitet.push({ point_key:p.point_key, words:Object.fromEntries(words),
      sample:clean(D.decodeDerived(p, words)) });
  }
}

// --- JSON-Punkte (go-e, Shelly, Fronius, KACO) -----------------------------------
// Je Selektor-Form eine Nutzlast, die den Pfad traegt: ein `*` wird zu zwei
// Eintraegen (bei Objekten mit Schluesseln, deren JS-Reihenfolge nicht die
// Einfuegereihenfolge ist), der Wert wechselt reihum durch die Formen, die der
// Treiber unterscheidet (Zahl, Text, Wahrheitswert, Objekt, null, grosse und
// kleine Zahl).
const WERTE = [12.5, 'an', true, { b:1, a:[1, 2.5], 10:'z', 2:null }, null, 1e21, 0.1, -0.0000001, 7];
function pfadTokens(point) {
  let selector = point.selector;
  if (selector.includes('?filter=')) selector = selector.split('?filter=')[1];
  else if (selector.includes('#')) selector = selector.split('#')[1];
  return selector.replace(/^\$\.?/, '').replace(/\[(\d+|\*)]/g, '.$1').split(/[./]/).filter(Boolean);
}
function nutzlast(tokens, wert, istArray) {
  if (!tokens.length) return wert;
  const [t, ...rest] = tokens;
  if (t === '*') {
    if (istArray) return [nutzlast(rest, wert, istArray), nutzlast(rest, wert === null ? 1 : null, istArray)];
    return { b:nutzlast(rest, wert, istArray), 10:nutzlast(rest, 3, istArray), 2:nutzlast(rest, 'zwei', istArray) };
  }
  if (/^\d+$/.test(t)) {
    const arr = [];
    arr[Number(t)] = nutzlast(rest, wert, istArray);
    for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = 0;
    return arr;
  }
  return { andere:1, [t]:nutzlast(rest, wert, istArray) };
}
const jsonFaelle = [];
{
  const formen = new Set();
  let i = 0;
  for (const p of catalog.points.filter((x) => ['http_api_key', 'rpc_json', 'rest_json'].includes(x.source_kind))) {
    const form = JSON.stringify([p.source_kind, pfadTokens(p).map((t) => (t === '*' || /^\d+$/.test(t) ? t : 'k')),
      p.scale, /\?id=\*/.test(p.selector), p.point_key.replace(/[^[\]*]/g, '')]);
    if (formen.has(form)) continue;
    formen.add(form);
    const tokens = pfadTokens(p);
    for (const istArray of [true, false]) {
      if (!istArray && !tokens.includes('*')) continue;
      const wert = WERTE[i++ % WERTE.length];
      const payload = nutzlast(tokens, wert, istArray);
      if (/\?id=\*/.test(p.selector) && payload && typeof payload === 'object' && !Array.isArray(payload)) payload.id = 4;
      jsonFaelle.push({ point_key:p.point_key, payload, samples:clean(D.decodeJSONSamples(p, payload)) });
    }
  }
  // Was eine Nutzlast nicht traegt, ist keine Probe - nie eine 0.
  const p = catalog.points.find((x) => x.source_kind === 'http_api_key');
  jsonFaelle.push({ point_key:p.point_key, payload:{ andere:1 }, samples:clean(D.decodeJSONSamples(p, { andere:1 })) });
  jsonFaelle.push({ point_key:p.point_key, payload:null, samples:clean(D.decodeJSONSamples(p, null)) });
}

// --- resolvePoint ---------------------------------------------------------------
const disc = { models:{ 160:{ base:40100, moduleCount:3 }, 103:{ base:40070 } } };
const aufloesen = [
  ['deye.hybrid_3p.settings.battery-low-soc'],
  ['gibt.es.nicht'],
  ['sunspec.model_160.module[1].dcw', disc],
  ['sunspec.model_160.module[3].dcw', disc],
  ['sunspec.model_160.module[0].dcw'],
  ['wago.pm494.karte[2].p_gesamt_w'],
  ['erzeuger.te[3].p_w'],
  ['custom.reg1', null, { sourceKind:'modbus_holding', address:100, widthBits:32, valueType:'int32', signed:true, endian:'big', scale:0.1 }],
  ['custom.reg2', null, { source_kind:'modbus_input', address:65535, width_bits:16, value_type:'uint16', scale:1 }],
  ['custom.reg3', null, { source_kind:'modbus_input', address:65535, width_bits:32 }],
  ['custom.reg4', null, { source_kind:'coil', address:1, width_bits:16 }],
  ['custom.reg5', null, { source_kind:'modbus_holding', address:'7', width_bits:48 }],
  ['custom.reg6', null, { source_kind:'modbus_holding', address:1.5, width_bits:16 }],
  ['shelly.gen2plus.switch[0].apower'],
  ['goe.api_v2.nrg'],
].map(([key, discovery, definition]) => {
  let point;
  try { point = clean(D.resolvePoint(key, discovery, definition)); } catch (e) { point = { error:true }; }
  return { key, discovery:discovery || null, definition:definition || null, point };
});
// Existierende Vorlagen fuer die Wago-/Erzeuger-/Modul-Faelle ergaenzen, wo der Schluessel anders heisst.
for (const fam of ['wago.pm494', 'wago.pm495', 'sunspec.model_160']) {
  const p = catalog.points.find((x) => x.family === fam && x.point_key.includes('[*]'));
  if (!p) continue;
  const key = p.point_key.replace('[*]', '[1]');
  let point;
  try { point = clean(D.resolvePoint(key, disc)); } catch (e) { point = { error:true }; }
  aufloesen.push({ key, discovery:disc, definition:null, point });
}
{
  const p = catalog.points.find((x) => x.family === 'voltpilot.erzeuger_registerbild_v1' && x.point_key.includes('[*]'));
  if (p) {
    const key = p.point_key.replace('[*]', '[2]');
    aufloesen.push({ key, discovery:null, definition:null, point:clean(D.resolvePoint(key)) });
  }
}

const out = {
  _comment: [
    'GENERIERT von measurement-driver-vectors.gen.js aus measurement-driver.js und catalog.json - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: measurement-driver-vectors.test.js (JS) und edge-app/core/internal/messwerte (Go, Edge Light).',
    'register: decodeRegisters je Dekodier-Signatur des Katalogs (sample ohne point_key - er ist der des Falls); error=true, wo das JS-Modul wirft.',
    'Adressen: die Register des Punkts, sonst 40000 + offset_words fortlaufend ueber width_words.',
  ],
  catalog_version: catalog.catalog_version,
  register: registerFaelle,
  abgeleitet,
  json:jsonFaelle,
  aufloesen,
};

const text = JSON.stringify(out) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + registerFaelle.length + ' Registerfaelle, ' + gesehen.size
    + ' Signaturen, ' + abgeleitet.length + ' abgeleitete, ' + jsonFaelle.length + ' JSON, ' + aufloesen.length + ' Aufloesungen, '
    + Math.round(text.length / 1024) + ' KiB)');
}

module.exports = { build: () => text, OUT };

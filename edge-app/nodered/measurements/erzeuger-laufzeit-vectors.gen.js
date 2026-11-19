'use strict';

/**
 * Erzeugt erzeuger-laufzeit-vectors.json: die GEMEINSAMEN Laufzeit-Vektoren zwischen dem
 * Erzeuger-Weg der Palette (Quelle der Wahrheit: `measurement-runtime.js` mit
 * `erzeuger-registerbild.js`, `erzeuger-ereignisse.js`, `erzeuger-meldung.js`, und die Probe-Art
 * `erzeuger_kopf` in `vp-palette/nodes/vp-modbus-probe.js`) und seinem Go-Zwilling auf Edge Light
 * (`edge-app/core/internal/erzeugerbild`, verdrahtet in `internal/layer1`).
 *
 * Der Vertrag (`docs/contracts/v2/erzeuger-registerbild-vectors.json`) sagt, wann ein Wort ein Wert
 * ist. Diese Datei sagt, was die Box DARAUS macht - am lokalen Bus beobachtbar:
 *
 *   messplan     `apply` einer Wunsch-Konfiguration: angenommene/abgelehnte Punkte, geplante
 *                Anfragen (Start, Anzahl, Funktionscode)
 *   laufzeit     Takte mit gelesenen Woertern: welche Anfragen, welche Samples (Melde-Regel,
 *                Qualitaet, Komponente), welche Ereignisse (`edge/events`), welches
 *                Standort-Sample (`edge/sources/<pin>/telemetry`), welche Lese-Belege
 *   kopfpruefung Ops `erzeuger_kopf` des Probe-Kanals: welche Lesungen, welcher Kopf-Bericht
 *
 * Das Muster von huawei-decode-vectors.gen.js: die Erwartung entsteht aus den JS-Modulen selbst,
 * erzeuger-laufzeit-vectors.test.js rechnet sie bei jedem Lauf neu. Wer einen der Module aendert,
 * fuehrt dieses Skript aus und committet die Datei; der Go-Test zeigt dann, ob der Zwilling
 * nachziehen muss.
 *
 *   node edge-app/nodered/measurements/erzeuger-laufzeit-vectors.gen.js
 *
 * ⚠ Simulator, kein Beleg: die Bilder sind ausgedacht (testdata/erzeuger-bilder.js).
 */

const fs = require('fs');
const path = require('path');
const { MeasurementRuntime } = require('./measurement-runtime');
const { catalogDocument } = require('./measurement-driver');
const { modbusFunktionscode } = require('../vp-palette/nodes/vp-measurements');
const probe = require('../vp-palette/nodes/vp-modbus-probe');
const bilder = require('./testdata/erzeuger-bilder');

const OUT = path.join(__dirname, 'erzeuger-laufzeit-vectors.json');

const START = Date.parse('2026-10-21T20:00:00Z');
const STEUERUNG = '00000000-0000-0000-0000-0000000e2001';
const ZWEITE = '00000000-0000-0000-0000-0000000e2002';
const DATENQUELLE = 'DQ-2001';
const PIN = 'sps-1';

const ALLE = ['erzeuger.kopf.te_anzahl', 'erzeuger.kopf.programmstand', 'erzeuger.kopf.steuerung_id',
  'erzeuger.kopf.anlagenart', 'erzeuger.a.a_gueltig', 'erzeuger.a.a_alter_s', 'erzeuger.a.p_nvp_w',
  'erzeuger.a.p_erzeugung_w', 'erzeuger.a.anlage_zustand', 'erzeuger.a.a_bits',
  'erzeuger.a.speicher_fuellstand', 'erzeuger.a.p_installiert_kw', 'erzeuger.nb.n_kanal',
  'erzeuger.nb.n_bits', 'erzeuger.nb.n_p_prozent', 'erzeuger.nb.n_cosphi', 'erzeuger.nb.n_seit_s',
  'erzeuger.nb.n_zaehler', 'erzeuger.dv.d_kanal', 'erzeuger.dv.d_bits', 'erzeuger.dv.d_soll_w',
  'erzeuger.dv.d_seit_s', 'erzeuger.dv.d_zaehler', 'erzeuger.wirkung.quelle_p',
  'erzeuger.wirkung.s_bits', 'erzeuger.wirkung.p_grenze_w', 'erzeuger.te[*].t_zustand',
  'erzeuger.te[*].t_bits', 'erzeuger.te[*].t_art', 'erzeuger.te[*].t_nenn_kw',
  'erzeuger.te[*].t_p_ist_w', 'erzeuger.te[*].t_p_soll_w', 'erzeuger.te[*].t_e'];

/** Die Bindung, wie die Palette sie aus Registry und Quellenliste baut. */
function bindung({ ohnePin = false, ohneQuelle = false } = {}) {
  return {
    entities: { [STEUERUNG]: { entity_id: STEUERUNG, entity_type: 'anlagensteuerung',
      edge_source_id: ohnePin ? '' : PIN, data_source_id: DATENQUELLE } },
    sources: ohneQuelle ? {} : { [PIN]: { id: PIN, role: 'plant-controller',
      communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port: 502, unit_id: 1 } } },
  };
}

function erzeugerbild(ueber = {}) {
  return Object.assign({ entity_id: STEUERUNG, basisadresse: 0, funktionscode: 4, wortfolge: 'big',
    te_anzahl: 3, anlagenart: 'pv', steuerung_kennung: 4711, veraltet_netzpunkt_s: 30 }, ueber);
}

function konfiguration({ punkte = ALLE, cadence = 60, bild = {}, mitBild = true, revision = 7,
  auswahl = null } = {}) {
  return { schema_version: '2.0', revision, catalog_version: catalogDocument.catalog_version,
    selections: auswahl || punkte.map((point_key) => ({ point_key,
      cadence_s: typeof cadence === 'function' ? cadence(point_key) : cadence, entity_id: STEUERUNG })),
    ...(mitBild ? { erzeuger_registerbilder: [erzeugerbild(bild)] } : {}) };
}

// ---------------------------------------------------------------- Laufzeit

/** Ein Fall der Laufzeit: Bindung, Konfiguration, Takte. */
function laufzeitFall({ name, why, binding = bindung(), config, takte }) {
  let jetzt = START;
  let bild = null; let basis = 0; let fehler = null;
  let lesungen = []; let belege = []; let gesendet = [];
  const io = {
    binding,
    monotonicNow: () => jetzt,
    readModbus: async ({ start, count, source_kind, target, funktionscode }) => {
      const fc = modbusFunktionscode(source_kind, funktionscode);
      lesungen.push({ start, count, fc, ziel: target.key });
      if (fehler) throw Object.assign(new Error(fehler), { error_class: fehler });
      const von = start - basis;
      if (!bild || von < 0 || von + count > bild.length) {
        throw Object.assign(new Error('Modbus-Ausnahme 0x02'), { error_class: 'no_answer' });
      }
      return bild.slice(von, von + count);
    },
    sourceStatus: (e) => belege.push(e),
  };
  const runtime = new MeasurementRuntime(io, (topic, payload) => gesendet.push({ topic, payload }),
    () => new Date(jetzt));
  const plan = runtime.apply(config);
  const status = gesendet.find((m) => m.topic === 'edge/measurements/config-status').payload;
  const erwartung = {
    status: { revision: status.revision, accepted: status.accepted, rejected: status.rejected },
    anfragen: (plan.blocks || []).map((b) => ({ start: b.start, count: b.count,
      fc: modbusFunktionscode(b.source_kind, b.funktionscode) })),
    takte: [],
  };
  const eingabeTakte = [];
  return (async () => {
    for (const t of takte) {
      jetzt += t.nach_ms;
      if (t.bild !== undefined) { bild = t.bild; basis = t.basis || 0; }
      fehler = t.fehler || null;
      lesungen = []; belege = []; gesendet = [];
      await runtime.tick();
      eingabeTakte.push(Object.assign({ nach_ms: t.nach_ms },
        t.bild !== undefined ? { bild: t.bild, basis: t.basis || 0 } : {},
        t.fehler ? { fehler: t.fehler } : {}));
      const fehlerKlassen = belege.filter((b) => b.failed).map((b) => b.error_class);
      erwartung.takte.push({
        lesungen: lesungen.map(({ start, count, fc }) => ({ start, count, fc })),
        nachrichten: gesendet.map(({ topic, payload }) => ({ topic, payload })),
        belege: { ids: [...new Set(belege.map((b) => b.target && b.target.dataSourceId).filter(Boolean))],
          requests: belege.reduce((n, b) => n + (b.requests || 0), 0),
          samples: belege.reduce((n, b) => n + (b.samples || 0), 0),
          fehler: fehlerKlassen },
      });
    }
    return { name, why, input: { binding, config, takte: eingabeTakte }, expected: erwartung };
  })();
}

/** Gore mit Herzschlag `hs` und einzelnen Feldern ueberschrieben. */
function gore(hs, anlage = {}, kopf = {}, einheiten = null) {
  return bilder.baueBild({
    kopf: Object.assign({ herzschlag: hs, programmstand: 2610, steuerung_id: 4711, anlagenart: 1 }, kopf),
    anlage: Object.assign({ a_gueltig: 0b1001, a_alter_s: 2, p_nvp_w: -1200, p_erzeugung_w: 182400,
      anlage_zustand: 3, a_bits: 0, p_installiert_kw: 265, n_kanal: 3, n_bits: 0b111, n_p_prozent: 600,
      n_cosphi: 950, n_seit_s: 1234, n_zaehler: 17, d_kanal: 0, d_bits: 0, d_zaehler: 0, quelle_p: 1,
      s_bits: 0b11, p_grenze_w: 159000 }, anlage),
    einheiten: einheiten || [1, 2, 3].map((n) => ({ t_zustand: 3, t_bits: 0b11, t_art: 1, t_nenn_kw: 125,
      t_p_ist_w: 60800 + n * 100, t_p_soll_w: 53000, t_e: 12345678 + n })),
    namen: null,
  });
}

async function laufzeitFaelle() {
  const faelle = [];
  faelle.push(await laufzeitFall({
    name: 'gore-melde-regel',
    why: 'Gore, alle 33 Punkte mit 60 s: der erste Takt sendet jeden Wert; Totband 500 W haelt 400 W '
      + 'zurueck, 600 W gehen; ein Zustand geht bei jeder Aenderung; nach 60 s geht alles erneut. '
      + 'Jeder Takt sendet das Standort-Sample (pv_power_kw, power_kw).',
    config: konfiguration(),
    takte: [
      { nach_ms: 0, bild: gore(1000) },
      { nach_ms: 5000, bild: gore(1005, { p_erzeugung_w: 182800 }) },
      { nach_ms: 5000, bild: gore(1010, { p_erzeugung_w: 183000, anlage_zustand: 2 }) },
      { nach_ms: 5000, bild: gore(1015, { p_erzeugung_w: 183000, anlage_zustand: 2, p_nvp_w: -1900 }) },
      { nach_ms: 2000, bild: gore(1017) },
      { nach_ms: 48000, bild: gore(1065, { p_erzeugung_w: 183000, anlage_zustand: 2, p_nvp_w: -1900 }) },
    ],
  }));
  faelle.push(await laufzeitFall({
    name: 'herzschlag-steht-und-neustart',
    why: 'Der Herzschlag steht: ab der dritten gleichen Lesung ist alles stale, frozen_source geht '
      + 'einmal (Datenquelle, Komponente, 3 Lesungen), das Standort-Sample faellt weg (nie 0). '
      + 'Dann laeuft er wieder, dann springt er zurueck: device_restart mit vorher/nachher. Steht er '
      + 'danach wieder, ist das eine neue Episode: frozen_source ein zweites Mal.',
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w', 'erzeuger.a.p_nvp_w',
      'erzeuger.nb.n_zaehler'] }),
    takte: [
      { nach_ms: 0, bild: gore(2000) },
      { nach_ms: 5000, bild: gore(2000) },
      { nach_ms: 5000, bild: gore(2000) },
      { nach_ms: 5000, bild: gore(2000) },
      { nach_ms: 5000, bild: gore(2010) },
      { nach_ms: 5000, bild: gore(3, { n_zaehler: 0 }) },
      { nach_ms: 5000, bild: gore(3, { n_zaehler: 0 }) },
      { nach_ms: 5000, bild: gore(3, { n_zaehler: 0 }) },
    ],
  }));
  faelle.push(await laufzeitFall({
    name: 'lesefehler-und-fremdes-bild',
    why: 'Ein Lesefehler liefert keinen Wert, nur den Beleg mit Klasse; ein fremdes Bild (Signatur '
      + 'der Energiekarten) ist layout_changed ohne Sample; danach ist der naechste Wert wieder der '
      + 'erste (Melde-Stand vergessen). Eine nicht lesbare Lesung unterbricht die Herzschlag-Folge nicht.',
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w', 'erzeuger.a.anlage_zustand'] }),
    takte: [
      { nach_ms: 0, bild: gore(100) },
      { nach_ms: 5000, fehler: 'unreachable' },
      { nach_ms: 5000, bild: gore(100, {}, { signatur: [0x5650, 0x5242] }) },
      { nach_ms: 5000, bild: gore(100) },
      { nach_ms: 5000, bild: gore(100) },
    ],
  }));
  faelle.push(await laufzeitFall({
    name: 'soll-abweichend',
    why: 'Das Bild meldet 4 Einheiten, eingerichtet sind 3: te_anzahl_abweichend, kein Wert, '
      + 'layout_changed; der Herzschlag zaehlt trotzdem (das Bild ist lesbar).',
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w'] }),
    takte: [
      { nach_ms: 0, bild: gore(50, {}, {}, [1, 2, 3, 4].map((n) => ({ t_zustand: 3, t_bits: 3, t_art: 1,
        t_nenn_kw: 125, t_p_ist_w: 1000 * n, t_p_soll_w: 53000, t_e: n }))) },
      { nach_ms: 5000, bild: gore(55) },
    ],
  }));
  faelle.push(await laufzeitFall({
    name: 'netzpunkt-alt-eigenbedarf-ungueltig',
    why: 'a_alter_s 45 > 30 s: p_nvp_w ist uncertain und fehlt im Standort-Sample; Eigenbedarf '
      + '(p_erzeugung_w −3 kW) wird pv 0; eine Anlagenart ausserhalb des Vokabulars ist invalid mit '
      + 'Rohwert; ein ungedeckter Wert sendet nichts.',
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w', 'erzeuger.a.p_nvp_w',
      'erzeuger.a.anlage_zustand', 'erzeuger.a.speicher_fuellstand', 'erzeuger.nb.n_cosphi',
      'erzeuger.nb.n_p_prozent'] }),
    takte: [
      { nach_ms: 0, bild: gore(10, { a_alter_s: 45, p_erzeugung_w: -3000, anlage_zustand: 9 }) },
      { nach_ms: 5000, bild: gore(15, { a_alter_s: 3, p_erzeugung_w: -3000, anlage_zustand: 3 }) },
      { nach_ms: 5000, bild: gore(20, { a_gueltig: 0b1000, p_erzeugung_w: 5000 }) },
    ],
  }));
  faelle.push(await laufzeitFall({
    name: 'buettner-bhkw-ohne-netzpunkt',
    why: 'BHKW mit zwei Motoren, ohne Netzpunkt: das Standort-Sample traegt nur pv_power_kw; '
      + 'speicher_fuellstand mit Faktor 0,1; n_zaehler 65535 ist ein Wert.',
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w', 'erzeuger.a.p_nvp_w',
      'erzeuger.a.speicher_fuellstand', 'erzeuger.nb.n_zaehler', 'erzeuger.dv.d_soll_w',
      'erzeuger.te[2].t_e', 'erzeuger.te[1].t_p_ist_w'], bild: { te_anzahl: 2, anlagenart: 'bhkw',
      steuerung_kennung: 4712 } }),
    takte: [{ nach_ms: 0, bild: bilder.buettner() }],
  }));
  faelle.push(await laufzeitFall({
    name: 'zehn-einheiten-fc3-little-basis',
    why: 'Zehn Einheiten ab Basis 100 mit FC 3 und niederwertigem Wort zuerst: zwei Anfragen '
      + '(118 + 20 Woerter), kein Block geteilt.',
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w', 'erzeuger.te[*].t_p_ist_w'],
      bild: { te_anzahl: 10, basisadresse: 100, funktionscode: 3, wortfolge: 'little',
        steuerung_kennung: 900 } }),
    takte: [{ nach_ms: 0, basis: 100, bild: bilder.baueBild({ wortfolge: 'little',
      kopf: { herzschlag: 7, steuerung_id: 900, anlagenart: 1 },
      anlage: { a_gueltig: 0b1001, a_alter_s: 1, p_nvp_w: -100000, p_erzeugung_w: 1234567, s_bits: 0 },
      einheiten: Array.from({ length: 10 }, (_, i) => ({ t_bits: 1, t_zustand: 2, t_art: 1, t_nenn_kw: 100,
        t_p_ist_w: -50 + i * 70000, t_e: 1 })) }) }],
  }));
  faelle.push(await laufzeitFall({
    name: 'messplan-ablehnungen',
    why: 'Einheit 4 bei drei eingerichteten, unbekanntes Feld, Takt unter 5 s, ein Punkt ohne '
      + 'Komponente (bindet an den Hauptwechselrichter, dort ist kein Bild) - je benannt abgelehnt.',
    config: konfiguration({ auswahl: [
      { point_key: 'erzeuger.a.p_erzeugung_w', cadence_s: 60, entity_id: STEUERUNG },
      { point_key: 'erzeuger.te[4].t_p_ist_w', cadence_s: 60, entity_id: STEUERUNG },
      { point_key: 'erzeuger.a.gibt_es_nicht', cadence_s: 60, entity_id: STEUERUNG },
      { point_key: 'erzeuger.a.p_nvp_w', cadence_s: 2, entity_id: STEUERUNG },
      { point_key: 'erzeuger.wirkung.quelle_p', cadence_s: 60 },
      { point_key: 'erzeuger.te[2].t_e', cadence_s: 60, entity_id: ZWEITE },
    ] }),
    takte: [{ nach_ms: 0, bild: gore(1) }],
  }));
  faelle.push(await laufzeitFall({
    name: 'ohne-bildparameter',
    why: 'Ohne erzeuger_registerbilder gibt es keine Basisadresse: jeder Punkt driver_unavailable, '
      + 'nie Register 0 von irgendwem.',
    config: konfiguration({ mitBild: false, punkte: ['erzeuger.a.p_erzeugung_w', 'erzeuger.te[*].t_e'] }),
    takte: [{ nach_ms: 0, bild: gore(1) }],
  }));
  faelle.push(await laufzeitFall({
    name: 'quelle-fehlt',
    why: 'Der Pin nennt eine Quelle, die die Box nicht (mehr) fuehrt: binding_unavailable.',
    binding: bindung({ ohneQuelle: true }),
    config: konfiguration({ punkte: ['erzeuger.a.p_erzeugung_w'] }),
    takte: [{ nach_ms: 0, bild: gore(1) }],
  }));
  return faelle;
}

// ---------------------------------------------------------------- Kopfpruefung

async function kopfFall({ name, why, ops, bild, basis = 0, fehler = null }) {
  const lesungen = [];
  const readRegisters = async (plan) => {
    lesungen.push({ fc: plan.fc, start: plan.addr, count: plan.count });
    if (fehler) throw new Error(fehler);
    const von = plan.addr - basis;
    if (!bild || von < 0 || von + plan.count > bild.length) throw new Error('Modbus-Ausnahme 0x02');
    return bild.slice(von, von + plan.count);
  };
  const results = await probe.runOps(ops, readRegisters);
  return { name, why, input: { ops, bild, basis, ...(fehler ? { fehler } : {}) },
    expected: { lesungen, results } };
}

function kopfOp(ueber = {}) {
  return Object.assign({ id: 'k1', op: 'erzeuger_kopf', host: '127.0.0.1', port: 502, unit_id: 1, fc: 4,
    address: 0, word_order: 'big' }, ueber);
}

async function kopfFaelle() {
  const goreMitNamen = bilder.gore();
  return [
    await kopfFall({ name: 'gore-mit-namen', why: 'Kopf, drei Einheiten, Namen in einer Anfrage; '
      + 'der leere Direktvermarkter ist "" (keiner).', ops: [kopfOp()], bild: goreMitNamen }),
    await kopfFall({ name: 'buettner-umlaut', why: 'Zwei Motoren, Umlaut im Namen (ISO 8859-1).',
      ops: [kopfOp()], bild: bilder.buettner() }),
    await kopfFall({ name: 'ohne-namen', why: 'beschreibung_ab 0: keine Namen im Bericht, kein Fehler.',
      ops: [kopfOp()], bild: gore(9) }),
    await kopfFall({ name: 'namen-fehlen-im-geraet', why: 'Der Kopf nennt Namen ab 140, die Steuerung '
      + 'beantwortet nur bis zur letzten Einheit: der Bericht ist erkannt, ohne Namen.',
      ops: [kopfOp()], bild: goreMitNamen.slice(0, 68) }),
    await kopfFall({ name: 'einheiten-fehlen', why: 'Der Kopf nennt drei Einheiten, die Steuerung hat '
      + 'nur Register fuer zwei: zu_wenig_woerter mit te_anzahl.', ops: [kopfOp()],
      bild: goreMitNamen.slice(0, 58) }),
    await kopfFall({ name: 'signatur-fremd', why: 'Ein Energiekarten-Bild: nur signatur_ok false.',
      ops: [kopfOp()], bild: gore(1, {}, { signatur: [0x5650, 0x5242] }) }),
    await kopfFall({ name: 'version-fremd', why: 'Hauptversion 2: nur die Version im Bericht.',
      ops: [kopfOp()], bild: gore(1, {}, { version: 0x0201 }) }),
    await kopfFall({ name: 'wortfolge-falsch', why: 'Der Pruefwert passt nicht zur gewaehlten Wortfolge.',
      ops: [kopfOp({ word_order: 'little' })], bild: goreMitNamen }),
    await kopfFall({ name: 'te-anzahl-elf', why: 'te_anzahl 11 ist ungueltig: Version und te_anzahl.',
      ops: [kopfOp()], bild: gore(1, {}, { te_anzahl: 11 }) }),
    await kopfFall({ name: 'fc3-basis-200-zehn-einheiten', why: 'FC 3 ab Basis 200, zehn Einheiten, '
      + 'Namen in zwei Anfragen (7 + 5 Texte).', basis: 200,
      ops: [kopfOp({ fc: 3, address: 200 })], bild: bilder.baueBild({
        kopf: { herzschlag: 3, steuerung_id: 77, anlagenart: 3 },
        anlage: { a_gueltig: 0 },
        einheiten: Array.from({ length: 10 }, (_, i) => ({ t_art: i < 6 ? 1 : 2, t_nenn_kw: 50 + i })),
        namen: { netzbetreiber: 'Netz A', direktvermarkter: 'DV B',
          typen: Array.from({ length: 10 }, (_, i) => `Typ ${i + 1}`) } }) }),
    await kopfFall({ name: 'nicht-erreichbar', why: 'Die Lesung des Kopfs scheitert: die Klasse der '
      + 'Lesung, kein Bericht.', ops: [kopfOp()], bild: null, fehler: 'Verbindungsaufbau-Timeout' }),
    await kopfFall({ name: 'zwei-ops-und-unvollstaendig', why: 'Zwei Ops nacheinander; eine ohne Host '
      + 'ist invalid_request und wird nicht gelesen.', ops: [kopfOp({ id: 'a' }), kopfOp({ id: 'b', host: '' })],
      bild: goreMitNamen }),
  ];
}

async function build() {
  const data = {
    _comment: [
      'ERZEUGT von erzeuger-laufzeit-vectors.gen.js - nicht von Hand aendern.',
      'Gemeinsame Laufzeit-Vektoren des Erzeuger-Wegs: Palette (Quelle der Wahrheit) und Go-Zwilling',
      '(edge-app/core/internal/erzeugerbild, internal/layer1). Simulator, kein Beleg.',
    ],
    katalog_version: catalogDocument.catalog_version,
    start: new Date(START).toISOString(),
    laufzeit: await laufzeitFaelle(),
    kopfpruefung: await kopfFaelle(),
  };
  return JSON.stringify(data, null, 1) + '\n';
}

if (require.main === module) {
  build().then((text) => { fs.writeFileSync(OUT, text); console.log('geschrieben:', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { OUT, build };

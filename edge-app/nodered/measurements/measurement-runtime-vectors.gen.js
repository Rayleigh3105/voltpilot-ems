'use strict';

/**
 * Erzeugt measurement-runtime-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * der Laufzeit der Messwerte-Bibliothek der Docker-Box (measurement-runtime.js
 * MeasurementRuntime, Quelle der Wahrheit) und ihrem Go-Zwilling in Edge Light
 * (edge-app/core/internal/messwerte).
 *
 *   node edge-app/nodered/measurements/measurement-runtime-vectors.gen.js
 *
 * Jeder Fall faehrt die echte Laufzeit mit einer eingespielten Uhr und
 * eingespielten Geraeteantworten: Plan anwenden, Takte, OCPP-Abstimmung,
 * Zaehlerwerte. Je Schritt steht in der Datei, was die Laufzeit veroeffentlicht
 * hat (Thema, Inhalt, retained), welche Anfragen sie gestellt hat und welche
 * Lese-Belege (sourceStatus) sie abgegeben hat. Zeitstempel und Belegnummern
 * stammen aus der eingespielten Uhr - die Datei ist auf jeder Maschine gleich.
 */

const fs = require('fs');
const path = require('path');
const { MeasurementRuntime } = require('./measurement-runtime.js');
const { catalogDocument } = require('./measurement-driver.js');

const OUT = path.join(__dirname, 'measurement-runtime-vectors.json');
const V = catalogDocument.catalog_version;
const punkt = (key) => { const p = catalogDocument.points.find((x) => x.point_key === key); if (!p) throw new Error(key); return p; };
const T0 = Date.parse('2026-11-20T08:00:00.000Z');

function fehler(f) {
  return Object.assign(new Error(f.fehler), f.code ? { code:f.code } : {});
}

async function fahre(fall) {
  let jetzt = T0; let mono = 1000000;
  const io = Object.assign({ monotonicNow:() => mono }, fall.io || {});
  let schritt = null;
  const antwort = (tabelle, key) => {
    const a = tabelle && tabelle[key];
    if (a === undefined) return Promise.reject(fehler({ fehler:'Vektor: keine Antwort fuer ' + key, code:'no_answer' }));
    if (a && a.fehler) return Promise.reject(fehler(a));
    return Promise.resolve(JSON.parse(JSON.stringify(a)));
  };
  io.readModbus = (r) => {
    const key = `${r.target.key}:${r.start}:${r.count}`;
    schritt.anfragen.push({ modbus:key, source_kind:r.source_kind || null, ...(r.funktionscode ? { funktionscode:r.funktionscode } : {}) });
    return antwort(schritt.modbus, key);
  };
  io.readJSON = (r) => {
    schritt.anfragen.push({ json:r.group, filter:r.filter, points:r.points.map((p) => p.point_key) });
    return antwort(schritt.json, r.group);
  };
  io.sourceStatus = (e) => {
    const out = Object.assign({}, e);
    out.target = e.target ? { key:e.target.key, ...(e.target.sourceId ? { sourceId:e.target.sourceId } : {}),
      ...(e.target.dataSourceId ? { dataSourceId:e.target.dataSourceId } : {}) } : null;
    if (out.entity_id === undefined) delete out.entity_id;
    schritt.belege.push(out);
  };
  const ocpp = [];
  io.applyOcppConfiguration = (x) => new Promise((resolve) => { schritt.ocpp_auftraege.push(x); ocpp.push({ revision:x.revision, resolve }); });
  const rt = new MeasurementRuntime(io, (topic, payload, retained) => schritt.veroeffentlicht.push({ topic, payload, retained:!!retained }),
    () => new Date(jetzt));
  const protokoll = [];
  for (const s of fall.schritte) {
    schritt = { veroeffentlicht:[], anfragen:[], belege:[], ocpp_auftraege:[], modbus:s.modbus, json:s.json };
    if (s.zeit !== undefined) { jetzt = T0 + s.zeit; mono = 1000000 + s.zeit; }
    let ergebnis = null;
    if (s.apply) {
      const plan = rt.apply(JSON.parse(JSON.stringify(s.apply)), s.options || {});
      ergebnis = { applied:!!plan.applied, pending:!!plan.pending };
    } else if (s.tick) {
      const kept = await rt.tick();
      ergebnis = { samples:kept.length };
    } else if (s.ocpp_ergebnis) {
      const p = ocpp.find((x) => x.revision === s.ocpp_ergebnis.revision);
      p.resolve(s.ocpp_ergebnis.antwort);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } else if (s.zaehler) {
      const kept = rt.onMeterValues(s.zaehler.values, s.zaehler.at ? new Date(T0 + s.zaehler.at) : undefined);
      ergebnis = { samples:kept.length };
    }
    protokoll.push({ schritt:s, ergebnis, veroeffentlicht:schritt.veroeffentlicht, anfragen:schritt.anfragen,
      belege:schritt.belege, ocpp_auftraege:schritt.ocpp_auftraege });
  }
  return protokoll;
}

const plan = (revision, selections, extra) => Object.assign({ revision, catalog_version:V, selections }, extra || {});

// WAGO: das Bild der Steuerung C-1 aus dem Simulator-Store (vier Karten 750-494 an Steckplatz 2-5),
// an Basisadresse 100 einer Quelle; Antworten je Anfrage aus den Woertern des Stores.
const wagoStore = require('../vp-palette/test/fixtures/wago-registerbild-store.js');
const wagoFall = wagoStore.ladeFall('S1');
const wago = wagoFall.store();
const WAGO_BASIS = 100;
const wagoAntworten = (woerter) => ({ [`source:src-sps:${WAGO_BASIS}:96`]:woerter.slice(0, 96),
  [`source:src-sps:${WAGO_BASIS + 96}:84`]:woerter.slice(96, 180) });
const wagoBild = { entity_id:'sps-1', basisadresse:WAGO_BASIS, funktionscode:4, wortfolge:'big', kartenzahl:4,
  controller_kennung:wagoFall.aufbau.controller_kennung,
  karten:wagoFall.aufbau.karten.map((k) => ({ steckplatz:k.steckplatz, kartentyp:k.kartentyp, variante:k.variante })) };
const WAGO_BINDUNG = {
  entities:{ 'sps-1':{ entity_id:'sps-1', entity_type:'anlagensteuerung', edge_source_id:'src-sps', data_source_id:'DQ-W' },
    'ek-2':{ entity_id:'ek-2', entity_type:'energiekarte', edge_source_id:'src-sps', data_source_id:'DQ-W' } },
  sources:{ 'src-sps':{ id:'src-sps', communication:'modbus_tcp', connection:{ ip:'10.0.0.20', port:502, unit_id:1 } } },
};
const woerterStehen = wago.woerter();
const woerterFremd = woerterStehen.slice(); woerterFremd[0] = 0x1234;
const reg = (p) => punkt(p).address.registers;

const deyeLast = 'deye.hybrid_1p.load.power';
const deyeVoraus = punkt(deyeLast).decoder.validation.lookup;
const voraus = catalogDocument.points.find((p) => p.family === 'hybrid_1p' && p.decoder && p.decoder.source_key === deyeVoraus && p.address);
const vorausKey = `primary:${Math.min(...voraus.address.registers)}:${voraus.address.width_words}`;
// Die Nennleistung (in Watt, niederwertiges Wort zuerst) als Woerter des Vergleichspunkts.
const vorausWorte = (kw) => [kw * 1000 & 0xffff, Math.floor(kw * 1000 / 65536)].slice(0, voraus.address.width_words);
const zaehler = 'deye.hybrid_1p.meter.total-production';
const akku = 'deye.hybrid_1p.battery.battery';
const kostal = 'kostal_plenticore.battery-work-capacity';

const BINDUNG = {
  entities:{
    'akku-1':{ entity_id:'akku-1', entity_type:'battery-hybrid', edge_source_id:'', data_source_id:'DQ-1' },
    'wr-2':{ entity_id:'wr-2', entity_type:'inverter', edge_source_id:'src-fronius', data_source_id:'DQ-2' },
  },
  sources:{ 'src-fronius':{ id:'src-fronius', communication:'sunspec_tcp', connection:{ ip:'10.0.0.9', port:502 } } },
};

const FAELLE = [
  {
    name:'Deye: Takte, Fehler eines Blocks, Abweichungspruefung ueber Takte',
    schritte:[
      { zeit:0, apply:plan(3, [{ point_key:akku, cadence_s:30 }, { point_key:zaehler, cadence_s:30 }]) },
      { zeit:0, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[61], [`primary:${reg(zaehler)[0]}:2`]:[1000, 0] } },
      { zeit:1000, tick:true },
      { zeit:30000, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:{ fehler:'Zeitueberschreitung', code:'no_answer' }, [`primary:${reg(zaehler)[0]}:2`]:[1050, 0] } },
      { zeit:60000, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[62], [`primary:${reg(zaehler)[0]}:2`]:[9000, 0] } },
      { zeit:90000, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[63], [`primary:${reg(zaehler)[0]}:2`]:[1, 0] } },
    ],
  },
  {
    name:'geteilter Punkt: eine Lesung im schnellsten Takt, Proben je Komponente',
    io:{ binding:BINDUNG },
    schritte:[
      { zeit:0, apply:plan(4, [{ point_key:akku, cadence_s:30, entity_id:'akku-1' }, { point_key:akku, cadence_s:60, entity_id:'wr-9' },
        { point_key:akku, cadence_s:90 }]) },
      { zeit:0, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[50] } },
      { zeit:30000, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[51] } },
      { zeit:60000, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[52] } },
    ],
  },
  {
    name:'Vergleichswert und invalidate_all: der ganze Takt wird verworfen',
    schritte:[
      { zeit:0, apply:plan(5, [{ point_key:deyeLast, cadence_s:5 }]) },
      { zeit:0, tick:true, modbus:{ [vorausKey]:vorausWorte(50), [`primary:${reg(deyeLast)[0]}:1`]:[20] } },
      { zeit:5000, tick:true, modbus:{ [vorausKey]:vorausWorte(5), [`primary:${reg(deyeLast)[0]}:1`]:[60000] } },
    ],
  },
  {
    name:'Byte-Reihenfolge aus dem Geraet, SunSpec ueber die erkannte Basis einer Quelle',
    io:{ binding:BINDUNG, discoveries:{ 'source:src-fronius':{ models:{ 103:{ base:40070 } } } } },
    schritte:[
      { zeit:0, apply:plan(6, [{ point_key:kostal, cadence_s:900 }, { point_key:'sunspec.model_103.a', cadence_s:60, entity_id:'wr-2' }]) },
      { zeit:0, tick:true, modbus:{ 'primary:5:1':[1], [`primary:${reg(kostal)[0]}:2`]:[0x4120, 0], 'source:src-fronius:40072:1':[123] } },
    ],
  },
  {
    name:'HTTP: go-e mit Filter, Shelly mit mehreren Antworten, Fehler',
    schritte:[
      { zeit:0, apply:plan(7, [{ point_key:'goe.api_v2.acp', cadence_s:3600 }, { point_key:'goe.api_v2.acs', cadence_s:3600 },
        { point_key:'shelly.gen2plus.cover[*].aenergy.minute_ts', cadence_s:60 }, { point_key:'fronius_solar_api.grid-power', cadence_s:60 }]) },
      { zeit:0, tick:true, json:{
        'primary:goe:api_v2:config:3600':{ acp:true, acs:2, andere:1 },
        'primary:shelly:shelly.gen2plus:cover.getstatus-id-*:60':{ __vpResponses:[{ id:0, aenergy:{ minute_ts:1700000000 } }, { id:1, aenergy:{ minute_ts:12 } }] },
        'primary:fronius_solar_api:/solar_api/v1/GetPowerFlowRealtimeData.fcgi:60':{ fehler:'HTTP 500', code:'invalid_response' } } },
    ],
  },
  {
    name:'abgelehnter Plan: der vorige laeuft weiter',
    schritte:[
      { zeit:0, apply:plan(8, [{ point_key:akku, cadence_s:30 }]) },
      { zeit:0, apply:{ revision:9, catalog_version:'1999.01.01.1', selections:[{ point_key:akku, cadence_s:30 }] } },
      { zeit:0, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[44] } },
    ],
  },
  {
    name:'OCPP: Abstimmung bestaetigt, Zaehlerwerte im Takt je Komponente',
    io:{ ocppCapability:{ supported:true, readonly:false, maxLength:1024 } },
    schritte:[
      { zeit:0, apply:plan(10, [{ point_key:'ocpp.1_6.metervalues.energy.active.import.register.context[*].format[*].phase[*].location[*].unit[*]', cadence_s:60 }]) },
      { zeit:0, ocpp_ergebnis:{ revision:10, antwort:{ applied:true } } },
      { zeit:1000, zaehler:{ at:1000, values:[{ measurand:'Energy.Active.Import.Register', value:'1234.5', unit:'Wh' },
        { measurand:'Energy.Active.Import.Register', value:'99999999999999999999', unit:'Wh', format:'Raw' },
        { measurand:'Current.Import', value:'7' }] } },
      { zeit:30000, zaehler:{ at:30000, values:[{ measurand:'Energy.Active.Import.Register', value:'1300', unit:'Wh' }] } },
      { zeit:61000, zaehler:{ at:61000, values:[{ measurand:'Energy.Active.Import.Register', value:'1400', unit:'Wh' }] } },
    ],
  },
  {
    name:'OCPP: Abstimmung abgelehnt, Rueckfall ohne OCPP',
    io:{ ocppCapability:{ supported:true, readonly:false, maxLength:1024 } },
    schritte:[
      { zeit:0, apply:plan(11, [{ point_key:'ocpp.1_6.metervalues.current.import.context[*].format[*].phase[*].location[*].unit[*]', cadence_s:60 },
        { point_key:akku, cadence_s:30 }]) },
      { zeit:0, ocpp_ergebnis:{ revision:11, antwort:{ applied:false, reason:'Rejected' } } },
      { zeit:0, tick:true, modbus:{ [`primary:${reg(akku)[0]}:1`]:[45] } },
    ],
  },
  {
    name:'WAGO: Kartenwerte, Herzschlag steht dreimal, Bild fremd',
    io:{ binding:WAGO_BINDUNG },
    schritte:[
      { zeit:0, apply:plan(12, [{ point_key:'wago.pm494.karte[*].kartenregister_35', cadence_s:60, entity_id:'sps-1' },
        { point_key:'wago.pm494.karte[1].gueltigkeit', cadence_s:60, entity_id:'ek-2' }], { registerbilder:[wagoBild] }) },
      { zeit:0, tick:true, modbus:wagoAntworten(woerterStehen) },
      { zeit:60000, tick:true, modbus:wagoAntworten(woerterStehen) },
      { zeit:120000, tick:true, modbus:wagoAntworten(woerterStehen) },
      { zeit:180000, tick:true, modbus:wagoAntworten(woerterStehen) },
      { zeit:240000, tick:true, modbus:wagoAntworten(woerterFremd) },
    ],
  },
];

async function build() {
  const faelle = [];
  for (const f of FAELLE) faelle.push({ name:f.name, io:f.io || {}, protokoll:await fahre(f) });
  const out = {
    _comment: [
      'GENERIERT von measurement-runtime-vectors.gen.js aus measurement-runtime.js und catalog.json - nicht von Hand bearbeiten.',
      'Gepruefte Seiten: measurement-runtime-vectors.test.js (JS) und edge-app/core/internal/messwerte (Go, Edge Light).',
      'zeit ist ms nach ' + new Date(T0).toISOString() + '; modbus-Antworten sind nach "ziel:start:anzahl" geschluesselt, JSON nach der HTTP-Gruppe.',
    ],
    t0:new Date(T0).toISOString(),
    catalog_version:V,
    faelle,
  };
  return JSON.stringify(out, null, 1) + '\n';
}

if (require.main === module) {
  build().then((text) => {
    fs.writeFileSync(OUT, text);
    console.log('geschrieben: ' + OUT + ' (' + Math.round(text.length / 1024) + ' KiB)');
  });
}

module.exports = { build, OUT };

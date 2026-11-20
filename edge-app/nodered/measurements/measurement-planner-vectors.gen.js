'use strict';

/**
 * Erzeugt measurement-planner-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * dem Planer der Messwerte-Bibliothek der Docker-Box (measurement-planner.js
 * buildPlan, Quelle der Wahrheit) und seinem Go-Zwilling in Edge Light
 * (edge-app/core/internal/messwerte).
 *
 *   node edge-app/nodered/measurements/measurement-planner-vectors.gen.js
 *
 * Die Faelle nehmen echte Punkte des ausgelieferten Katalogs (gesucht nach
 * ihren Eigenschaften, nicht nach festen Schluesseln) und halten fest, was
 * buildPlan daraus macht: angenommen/abgelehnt mit Grund, die Lesebloecke je
 * Ziel, die HTTP-Gruppen, die Voraussetzungen der Decoder, die OCPP-Abstimmung
 * und die Last. Erzeuger-Punkte fehlen bewusst: das Erzeuger-Bild beurteilt
 * Edge Light in seinem eigenen Zwilling (internal/erzeugerbild). Die Punkte des
 * WAGO-Registerbilds plant der Planer selbst (registerbilder je Ziel).
 */

const fs = require('fs');
const path = require('path');
const P = require('./measurement-planner.js');
const { catalogDocument } = require('./measurement-driver.js');

const OUT = path.join(__dirname, 'measurement-planner-vectors.json');
const V = catalogDocument.catalog_version;
const pts = catalogDocument.points;
const finde = (f) => { const p = pts.find(f); if (!p) throw new Error('kein Punkt fuer ' + f); return p; };
const alle = (f, n) => pts.filter(f).slice(0, n);

const deye3 = alle((p) => p.family === 'hybrid_3p' && p.address && !p.decoder?.validation?.lookup
  && !p.decoder?.byte_order && !p.decoder?.variant, 6);
const deyeLookup = finde((p) => p.decoder && p.decoder.validation && p.decoder.validation.lookup && p.address);
const deyeVariante = finde((p) => p.decoder && p.decoder.variant && p.address);
const deyeByteOrder = finde((p) => p.decoder && p.decoder.byte_order && p.address);
const abgeleitet = finde((p) => !p.address && (p.derived_from || []).length > 1);
const sunspec = alle((p) => p.family === 'sunspec.model_103' && p.address, 3);
const modul = finde((p) => p.family === 'sunspec.model_160' && p.point_key.includes('[*]'));
const goe = alle((p) => p.source_kind === 'http_api_key', 3);
const shelly = alle((p) => p.source_kind === 'rpc_json' && !p.point_key.includes('[*]'), 2);
const fronius = alle((p) => p.source_kind === 'rest_json' && p.family === 'fronius_solar_api', 2);
const ocpp = alle((p) => p.source_kind === 'ocpp_sampled_value', 2);
const schnell = alle((p) => p.family === 'hybrid_3p' && p.address && (p.min_cadence_s || 1) <= 10
  && p.address.registers.length === 1 && !p.decoder?.byte_order && !p.decoder?.variant && !p.decoder?.validation?.lookup, 200);
// Viele Proben (Warnung) bei wenigen Anfragen: das erste Fenster schneller
// Punkte, das buildPlan selbst mit Warnung annimmt.
const nachbarn = (() => {
  const reihe = schnell.slice().sort((x, y) => x.address.registers[0] - y.address.registers[0]);
  for (let n = 24; n >= 10; n--) {
    for (let i = 0; i + n <= reihe.length; i++) {
      const fenster = reihe.slice(i, i + n);
      const plan = P.buildPlan({ revision:1, catalog_version:V, selections:fenster.map((p) => ({ point_key:p.point_key, cadence_s:5 })) });
      if (plan.applied && plan.metrics.warning) return fenster;
    }
  }
  throw new Error('kein Fenster mit Warnung');
})();
const weit = alle((p) => p.family === 'hybrid_3p' && p.address && p.address.registers.length === 1
  && !p.decoder?.byte_order && !p.decoder?.variant && !p.decoder?.validation?.lookup, 400);
// Register, die einen Block ueber 120 Woerter oder mit Luecke > 1 erzwingen.
const spreizung = [weit[0], ...weit.filter((p) => p.address.registers[0] - weit[0].address.registers[0] > 1
  && p.address.registers[0] - weit[0].address.registers[0] < 3), ...weit.filter((p) =>
  p.address.registers[0] - weit[0].address.registers[0] > 125)].slice(0, 4);

// Der Takt wird auf den kleinsten zulaessigen des Punkts gehoben - ausser wo ein
// Fall gerade den unzulaessigen Takt prueft (exakt).
const sel = (p, cadence, extra) => {
  const e = Object.assign({}, extra || {});
  const exakt = e.exakt; delete e.exakt;
  const min = typeof p === 'object' && p.min_cadence_s || 1;
  return Object.assign({ point_key:p.point_key || p, cadence_s:exakt ? cadence : Math.max(cadence, min) }, e);
};
const cad = (p) => Math.max(p.min_cadence_s || 1, 60);

const BINDUNG = {
  entities:{
    'akku-1':{ entity_id:'akku-1', entity_type:'battery-hybrid', edge_source_id:'', data_source_id:'DQ-1' },
    'wr-2':{ entity_id:'wr-2', entity_type:'inverter', edge_source_id:'src-fronius', data_source_id:'DQ-2' },
    'wr-3':{ entity_id:'wr-3', entity_type:'inverter', edge_source_id:'src-weg' },
    'wr-4':{ entity_id:'wr-4', entity_type:'inverter', edge_source_id:'' },
    'wr-5':{ entity_id:'wr-5', entity_type:'inverter', edge_source_id:'inverter' },
  },
  sources:{ 'src-fronius':{ id:'src-fronius', communication:'sunspec_tcp', connection:{ ip:'10.0.0.9', port:502 } } },
};
const DISC = { models:{ 103:{ base:40070 }, 160:{ base:40200, moduleCount:2 } } };

// WAGO: eine Steuerung als Quelle, an die eine Anlagensteuerung gebunden ist.
const WAGO_BINDUNG = {
  entities:{
    'sps-1':{ entity_id:'sps-1', entity_type:'anlagensteuerung', edge_source_id:'src-sps', data_source_id:'DQ-W' },
    'sps-2':{ entity_id:'sps-2', entity_type:'anlagensteuerung', edge_source_id:'src-sps' },
    'sps-3':{ entity_id:'sps-3', entity_type:'anlagensteuerung', edge_source_id:'src-sps-b' },
  },
  sources:{ 'src-sps':{ id:'src-sps', communication:'modbus_tcp', connection:{ ip:'10.0.0.20', port:502, unit_id:1 } },
    'src-sps-b':{ id:'src-sps-b', communication:'modbus_tcp', connection:{ ip:'10.0.0.21', port:502, unit_id:1 } } },
};
const BILD = (entity, extra) => Object.assign({ entity_id:entity, basisadresse:100, funktionscode:4, wortfolge:'big', kartenzahl:4,
  controller_kennung:1, karten:[2, 3, 4, 5].map((steckplatz, i) => ({ steckplatz, kartentyp:i < 2 ? 494 : 495, variante:1 })) }, extra || {});

const FAELLE = [
  { name:'falsche Katalogfassung', config:{ revision:1, catalog_version:'1999.01.01.1', selections:[sel(deye3[0], 60)] } },
  { name:'Deye-Punkte am Primaer-Wechselrichter', config:{ revision:2, catalog_version:V,
    selections:deye3.slice(0, 4).map((p) => sel(p, cad(p))) } },
  { name:'unbekannt, zu schnell, doppelt', config:{ revision:3, catalog_version:V, selections:[
    sel('gibt.es.nicht', 60), sel(deye3[0], 0, { exakt:true }), sel(deye3[1], 90000, { exakt:true }),
    sel(deye3[2], 60), sel(deye3[2], 120), sel(schnell[0], (schnell[0].min_cadence_s || 1) - 1, { exakt:true })] } },
  { name:'geteilter Punkt je Komponente', options:{ binding:BINDUNG }, config:{ revision:4, catalog_version:V, selections:[
    sel(deye3[0], 60, { entity_id:'akku-1' }), sel(deye3[0], 30, { entity_id:'wr-5' }), sel(deye3[1], 60, { entity_id:'akku-1' }),
    sel(deye3[1], 60)] } },
  { name:'Bindung: Quelle, fehlende Quelle, ohne Pin, Pin inverter', options:{ binding:BINDUNG, discoveries:{ 'source:src-fronius':DISC } },
    config:{ revision:5, catalog_version:V, selections:[
      sel(sunspec[0], 60, { entity_id:'wr-2' }), sel(sunspec[1], 60, { entity_id:'wr-3' }),
      sel(deye3[3], 60, { entity_id:'wr-4' }), sel(deye3[4], 60, { entity_id:'wr-5' }), sel(deye3[5], 60, { entity_id:'gibts-nicht' })] } },
  { name:'SunSpec mit und ohne Erkennung, Modul-Vorlage', options:{ discovery:DISC }, config:{ revision:6, catalog_version:V, selections:[
    sel(sunspec[0], 60), sel(sunspec[2], 60), sel(modul, 60)] } },
  { name:'SunSpec ohne Erkennung', config:{ revision:7, catalog_version:V, selections:[sel(sunspec[0], 60), sel(modul, 60)] } },
  { name:'HTTP-Gruppen: go-e Filter, Shelly, Fronius, zwei Takte', config:{ revision:8, catalog_version:V, selections:[
    ...goe.map((p) => sel(p, 60)), sel(goe[0].point_key.replace(/x/, 'x'), 60), ...shelly.map((p) => sel(p, 30)),
    ...fronius.map((p, i) => sel(p, i ? 120 : 60))] } },
  { name:'Decoder-Voraussetzungen: Vergleichswert, Variante, Byte-Reihenfolge', config:{ revision:9, catalog_version:V, selections:[
    sel(deyeLookup, cad(deyeLookup)), sel(deyeVariante, cad(deyeVariante)), sel(deyeByteOrder, cad(deyeByteOrder))] } },
  { name:'Byte-Reihenfolge eingestellt', options:{ byteOrder:'big' }, config:{ revision:10, catalog_version:V, selections:[
    sel(deyeByteOrder, cad(deyeByteOrder))] } },
  { name:'abgeleiteter Punkt', config:{ revision:11, catalog_version:V, selections:[sel(abgeleitet, cad(abgeleitet))] } },
  { name:'Bloecke: Luecke und Hoechstbreite', config:{ revision:12, catalog_version:V, selections:spreizung.map((p) => sel(p, 60)) } },
  { name:'freie Register: benachbart, je eigener Block', config:{ revision:13, catalog_version:V,
    selections:Array.from({ length:6 }, (_, i) => ({ point_key:`custom.r${i}`, cadence_s:60,
      definition:{ sourceKind:'modbus_holding', address:42 + i, widthBits:16, valueType:'uint16', signed:false, endian:'big', scale:1 } })) } },
  { name:'freies Register zu schnell: Busbelegung', config:{ revision:14, catalog_version:V,
    selections:[{ point_key:'custom.r', cadence_s:5, definition:{ sourceKind:'modbus_input', address:7, widthBits:32, valueType:'int32', scale:0.1 } }] } },
  { name:'Budget: zu viele Proben', config:{ revision:15, catalog_version:V, selections:schnell.slice(0, 120).map((p) => sel(p, 10)) } },
  { name:'Budget: Warnung, aber angenommen', config:{ revision:20, catalog_version:V, selections:nachbarn.map((p) => sel(p, 5)) } },
  { name:'OCPP unterstuetzt', options:{ ocppCapability:{ supported:true, readonly:false, maxLength:1024 } }, config:{ revision:16,
    catalog_version:V, selections:ocpp.map((p) => sel(p, 60)) } },
  { name:'OCPP nur lesend', options:{ ocppCapability:{ supported:true, readonly:true } }, config:{ revision:17,
    catalog_version:V, selections:[...ocpp.map((p) => sel(p, 60)), sel(deye3[0], 60)] } },
  { name:'OCPP zu lang', options:{ ocppCapability:{ supported:true, readonly:false, maxLength:5 } }, config:{ revision:18,
    catalog_version:V, selections:ocpp.map((p) => sel(p, 60)) } },
  { name:'OCPP ohne Faehigkeit', config:{ revision:19, catalog_version:V, selections:ocpp.map((p) => sel(p, 60)) } },
  { name:'WAGO: Vorlage je Karte, einzelne Karte, Karte ausserhalb, ohne Bild', options:{ binding:WAGO_BINDUNG },
    config:{ revision:21, catalog_version:V, registerbilder:[BILD('sps-1')], selections:[
      { point_key:'wago.pm495.karte[*].power_l1', cadence_s:60, entity_id:'sps-1' },
      { point_key:'wago.pm494.karte[1].energy_import_total', cadence_s:60, entity_id:'sps-1' },
      { point_key:'wago.pm494.karte[1].kartenregister_35', cadence_s:300, entity_id:'sps-1' },
      { point_key:'wago.pm495.karte[7].power_l1', cadence_s:60, entity_id:'sps-1' },
      { point_key:'wago.pm495.karte[4].power_l2', cadence_s:60, entity_id:'sps-1' },
      { point_key:'wago.pm495.karte[0].power_l2', cadence_s:60, entity_id:'sps-3' },
      { point_key:'wago.pm495.karte[0].power_l3', cadence_s:60 }] } },
  { name:'WAGO: zwei Bilder auf einem Ziel - keines gilt', options:{ binding:WAGO_BINDUNG },
    config:{ revision:22, catalog_version:V, registerbilder:[BILD('sps-1'), BILD('sps-2', { basisadresse:500 })], selections:[
      { point_key:'wago.pm495.karte[0].power_l1', cadence_s:60, entity_id:'sps-1' }] } },
  { name:'WAGO: fuenf Karten, Bild ohne Kennung und Variante', options:{ binding:WAGO_BINDUNG },
    config:{ revision:23, catalog_version:V, registerbilder:[{ entity_id:'sps-1', basisadresse:0, funktionscode:3, wortfolge:'little', kartenzahl:5,
      karten:[1, 2, 3, 4, 5].map((steckplatz) => ({ steckplatz, kartentyp:495 })) }], selections:[
      { point_key:'wago.pm495.karte[*].energy_import_total', cadence_s:60, entity_id:'sps-1' }] } },
];

const zielAus = (t) => (t ? { key:t.key, ...(t.sourceId ? { sourceId:t.sourceId } : {}),
  ...(t.dataSourceId ? { dataSourceId:t.dataSourceId } : {}) } : null);

function ergebnis(plan) {
  const out = { applied:plan.applied, accepted:plan.accepted, rejected:plan.rejected,
    metrics:plan.metrics || null };
  if (!plan.applied) return out;
  return Object.assign(out, {
    selections:plan.selections.map((s) => ({ requested_key:s.requested_key, point_key:s.point.point_key,
      cadence_s:s.cadence_s, target:zielAus(s.target), ...(s.entity_id ? { entity_id:s.entity_id } : {}) })),
    blocks:plan.blocks.map((b) => ({ key:b.key, start:b.start, count:b.count, cadence_s:b.cadence_s,
      source_kind:b.source_kind, target:zielAus(b.target), points:b.points, requestCostMs:b.requestCostMs,
      ...(b.funktionscode ? { funktionscode:b.funktionscode } : {}) })),
    registerbilder:plan.registerbilder,
    httpGroups:plan.httpGroups.map((g) => ({ key:g.key, target:zielAus(g.target) })),
    decoderPrerequisites:plan.decoderPrerequisites.map((x) => ({ point_key:x.point.point_key, cadence_s:x.cadence_s,
      target:zielAus(x.target), requested_key:x.requested_key, trigger_key:x.trigger_key })),
    ocppConfiguration:plan.ocppConfiguration,
  });
}

const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

// Wie die Laufzeit (apply): die Bilder je Ziel aus der Konfiguration und der Bindung.
const planen = (c) => {
  const options = JSON.parse(JSON.stringify(c.options || {}));
  options.registerbilder = P.registerbilderJeZiel(c.config.registerbilder, options.binding);
  return P.buildPlan(JSON.parse(JSON.stringify(c.config)), options);
};
const faelle = FAELLE.map((c) => ({ name:c.name, config:c.config, options:c.options || {}, result:clean(ergebnis(planen(c))) }));

const out = {
  _comment: [
    'GENERIERT von measurement-planner-vectors.gen.js aus measurement-planner.js und catalog.json - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: measurement-planner-vectors.test.js (JS) und edge-app/core/internal/messwerte (Go, Edge Light).',
  ],
  catalog_version:V,
  faelle,
};

const text = JSON.stringify(out, null, 1) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + faelle.length + ' Faelle, ' + Math.round(text.length / 1024) + ' KiB)');
}

module.exports = { build: () => text, OUT };

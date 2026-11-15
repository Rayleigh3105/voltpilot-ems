'use strict';
/**
 * regel-kern-vectors.gen.js - der Gleichheitsbeleg für Stufe 6 (Zusammenführen) des
 * Steuerlogik-Konzepts: eine Regel des Regel-Baukastens, mit DIESEM Compiler (flowc) zu
 * Node-RED kompiliert und so ausgeführt, wie Node-RED den Flow auf der Docker-Box ausführt,
 * Sekunde für Sekunde. Der Kern der Regelsprache muss die übersetzte Regel genauso
 * entscheiden (edge-app/core/internal/logikdienst/regel/gleichheit_test.go).
 *
 * Ausgeführt wird das Bündel selbst: die generierten Funktionsknoten mit ihrem Code aus
 * catalog.js (Schwelle, Zeitfenster, Und/Oder mit Zweig-Marken, Wenn/Dann, Preis-Wächter,
 * Slot-Grenze), die Inject-Knoten mit Node-REDs Zeitverhalten (einmal nach onceDelay, dann
 * alle `repeat` Sekunden) und die Palettenknoten nach ihrem Code: vp-entity-read (jede Probe
 * geht weiter, ein Auslöser wiederholt die letzte), vp-feed (jede Nachricht geht weiter, ein
 * Auslöser wiederholt die letzte), vp-desired (über seine shape()-Funktion: der Wunsch gilt
 * ttl_s Sekunden).
 *
 * Die Uhr der Funktionsknoten ist die der Zeitleiste in Europe/Berlin. Auf der Docker-Box
 * läuft Node-RED heute OHNE Zeitzone (UTC, kein TZ im Compose-Dienst `nodered`): dort
 * schaltet ein Zeitfenster eine bzw. zwei Stunden später, als der Probelauf zeigt. Die
 * Vektoren rechnen mit der gemeinten Ortszeit der Anlage, die der Kern verwendet; der
 * Unterschied steht als Befund im Vertrag (docs/contracts/v2/steuerlogik.md, Zusammenführen).
 *
 * Aufruf: node regel-kern-vectors.gen.js            schreibt die Datei
 *         node regel-kern-vectors.gen.js --check    prüft, dass die Datei aktuell ist
 */

process.env.TZ = 'Europe/Berlin';

const fs = require('fs');
const path = require('path');
const { compile } = require('./compile');
const { shape } = require('../vp-palette/nodes/vp-desired');
const { parse } = require('../vp-palette/nodes/vp-entity-read');

const OUT = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2', 'regel-kern-vectors.json');

// ---------------------------------------------------------------------------
// Die Anlage der Vektoren (erfundene Kennungen)
// ---------------------------------------------------------------------------

const NETZ = '11111111-1111-4111-8111-111111111111';
const SPEICHER = '22222222-2222-4222-8222-222222222222';
const HEIZSTAB = '33333333-3333-4333-8333-333333333333';
const PUMPE = '44444444-4444-4444-8444-444444444444';

const ANLAGE = [
  { id: NETZ, name: 'Netzanschluss', typ: 'grid-meter', misst: ['power_kw'] },
  { id: SPEICHER, name: 'Speicher', typ: 'battery-hybrid', misst: ['soc_pct', 'power_kw'] },
  { id: HEIZSTAB, name: 'Heizstab', typ: 'heating-rod', misst: ['power_kw'] },
  { id: PUMPE, name: 'Pumpe', typ: 'pump', misst: [] },
];

// Welche feste Quelle des Kerns einen Messwert trägt (die Übersetzung ordnet genau so zu).
const QUELLE = { [NETZ + '/power_kw']: 'site.grid', [SPEICHER + '/soc_pct']: 'battery.soc' };

const TTL = 930; // GUIDED_WISH_TTL_S (frontend/portal/src/flows/guidedBuilder.ts)

// ---------------------------------------------------------------------------
// buildGuidedFlow, Zeile für Zeile (frontend/portal/src/flows/guidedBuilder.ts). Dass dieser
// Spiegel genau das Dokument des Portals baut, prüft guidedBuilder.test.ts gegen die Datei.
// ---------------------------------------------------------------------------

const PRAEFIX = {
  'vp.entity.read': 'lesen', 'vp.price.current': 'preis', 'vp.logic.threshold': 'schwelle',
  'vp.schedule.window': 'zeit', 'vp.logic.and': 'und', 'vp.logic.or': 'oder', 'vp.logic.if': 'wert',
  'vp.logic.gate': 'wenn', 'vp.entity.control': 'steuern', 'vp.notify.push': 'melden',
};
// type_version wie der Katalog des Portals (frontend/portal/src/flows/catalog.json), aus dem buildGuidedFlow sie liest.
const VERSION = {
  'vp.entity.read': '1.0.0', 'vp.price.current': '1.0.0', 'vp.logic.threshold': '1.1.0',
  'vp.schedule.window': '1.0.0', 'vp.logic.and': '1.0.0', 'vp.logic.or': '1.0.0', 'vp.logic.if': '1.0.0',
  'vp.logic.gate': '1.0.0', 'vp.entity.control': '1.0.0', 'vp.notify.push': '1.0.0',
};

function baueRegel(regel, name) {
  const b = { nodes: [], edges: [], counters: {} };
  const id = (p) => { b.counters[p] = (b.counters[p] || 0) + 1; return p + b.counters[p]; };
  const node = (type, parameters) => {
    const nid = id(PRAEFIX[type]);
    b.nodes.push({ id: nid, type, type_version: VERSION[type], parameters });
    return nid;
  };
  const edge = (from, to) => b.edges.push({ id: id('e'), from, to });
  const bedingung = (c) => {
    if (c.kind === 'schedule') {
      return { node: node('vp.schedule.window', { from: c.from, to: c.to, days: c.days }), port: 'active' };
    }
    const quelle = c.kind === 'entity'
      ? { node: node('vp.entity.read', { entity_id: c.entityId, channel: c.channel }), port: 'value' }
      : { node: node('vp.price.current', {}), port: 'value' };
    const p = { threshold: c.threshold, direction: c.direction };
    if (c.hysteresis !== undefined) p.hysteresis = c.hysteresis;
    const t = node('vp.logic.threshold', p);
    edge(quelle, { node: t, port: 'input' });
    return { node: t, port: 'result' };
  };
  const bools = regel.conditions.map(bedingung);
  let acc = bools[0];
  const comb = regel.combinator === 'and' ? 'vp.logic.and' : 'vp.logic.or';
  for (let i = 1; i < bools.length; i += 1) {
    const c = node(comb, {});
    edge(acc, { node: c, port: 'a' });
    edge(bools[i], { node: c, port: 'b' });
    acc = { node: c, port: 'result' };
  }
  const a = regel.action;
  if (a.kind === 'setpoint') {
    const w = node('vp.logic.if', { then_value: a.value });
    edge(acc, { node: w, port: 'condition' });
    const s = node('vp.entity.control', { entity_id: a.entityId, command: 'setpoint_kw', ttl_s: a.ttlS });
    edge({ node: w, port: 'value' }, { node: s, port: 'setpoint' });
  } else {
    const s = node('vp.entity.control', { entity_id: a.entityId, command: 'on_off', ttl_s: a.ttlS });
    edge(acc, { node: s, port: 'value' });
  }
  // applyDerivedClaims (flows/model.ts): der Steuern-Knoten trägt seinen Anspruch.
  for (const n of b.nodes) {
    if (n.type === 'vp.entity.control') n.claims = [{ entity_id: n.parameters.entity_id, commands: [n.parameters.command] }];
  }
  return {
    schema_version: '1.0', name, runtime: 'edge', nodes: b.nodes, edges: b.edges,
    triggers: [{ id: 't1', kind: 'slot-boundary' }],
  };
}

// ---------------------------------------------------------------------------
// Ein kleines Node-RED für das kompilierte Bündel
// ---------------------------------------------------------------------------

function fakeDate(jetztMs) {
  const Echt = Date;
  class D extends Echt {
    constructor(...a) {
      if (a.length === 0) super(jetztMs());
      else super(...a);
    }
    static now() { return jetztMs(); }
  }
  D.parse = Echt.parse;
  D.UTC = Echt.UTC;
  return D;
}

/** Führt ein Bündel aus: liefert die Knoten-Ereignisse und die Wünsche an vp-desired. */
function laufzeit(bundle, startMs) {
  let jetzt = startMs;
  const D = fakeDate(() => jetzt);
  const knoten = {};
  for (const n of bundle.nodered_flows) if (n.type !== 'tab') knoten[n.id] = n;
  const kontext = {};
  const wuensche = [];
  const queue = [];
  const sende = (vonId, msg) => {
    if (msg == null) return;
    for (const ziel of (knoten[vonId].wires || [[]])[0] || []) {
      queue.push([ziel, JSON.parse(JSON.stringify(msg))]);
    }
  };
  const letzte = {}; // vp-entity-read / vp-feed: letzter Wert
  const fn = {};
  // Die Bedingung, die zuletzt am Wenn/Dann einer Sollwert-Regel ankam (für den Nachlauf).
  const bedingung = { wert: null };
  const eingang = (id, msg) => {
    const n = knoten[id];
    switch (n.type) {
      case 'function': {
        if (/-wert1$/.test(id)) bedingung.wert = !!msg.payload;
        if (!fn[id]) {
          // eslint-disable-next-line no-new-func
          fn[id] = new Function('msg', 'node', 'context', 'Date', n.func);
        }
        const ctx = (kontext[id] = kontext[id] || {});
        const context = { get: (k) => ctx[k], set: (k, v) => { ctx[k] = v; } };
        const out = fn[id](msg, { status() {}, error() {} }, context, D);
        sende(id, out);
        break;
      }
      case 'vp-entity-read':
      case 'vp-feed':
        if (letzte[id] !== undefined) sende(id, { payload: letzte[id].payload, topic: letzte[id].topic });
        break;
      case 'vp-desired': {
        const p = shape({ entity: n.entity, command: n.command, ttl_s: n.ttl_s, override: n.override,
          flowId: n.flowId, flowVersion: n.flowVersion, nodeId: n.nodeId }, msg.payload, new D().toISOString());
        if (!p) throw new Error('vp-desired lehnte einen Wunsch ab: ' + JSON.stringify(msg.payload));
        wuensche.push({ ms: jetzt, wert: p.command.value, ttl: p.ttl_s });
        break;
      }
      default:
        throw new Error('Knotenart im Bündel unbekannt: ' + n.type);
    }
  };
  const abarbeiten = () => {
    for (let i = 0; i < 10000 && queue.length; i++) {
      const [id, msg] = queue.shift();
      eingang(id, msg);
    }
    if (queue.length) throw new Error('Schleife im Bündel');
  };
  // Inject-Knoten: einmal nach onceDelay (Sekunden), dann alle `repeat` Sekunden.
  const injects = Object.values(knoten).filter((n) => n.type === 'inject').map((n) => ({
    id: n.id, naechste: startMs + Number(n.onceDelay) * 1000, alle: Number(n.repeat) * 1000,
  }));
  return {
    wuensche,
    bedingung,
    /** Uhr vorstellen und alles feuern, was bis dahin fällig ist. */
    bis(ms) {
      for (;;) {
        let erste = null;
        for (const i of injects) if (i.naechste <= ms && (!erste || i.naechste < erste.naechste)) erste = i;
        if (!erste) break;
        jetzt = erste.naechste;
        sende(erste.id, { payload: jetzt, topic: '' }); // ein Inject sendet an seine Drähte
        abarbeiten();
        erste.naechste += erste.alle;
      }
      jetzt = ms;
    },
    telemetrie(entity, kanal, wert) {
      const raw = Buffer.from(JSON.stringify({ schema_version: '1.0', entity_id: entity, ts: new D().toISOString(),
        channels: { [kanal]: wert } }));
      for (const n of Object.values(knoten)) {
        if (n.type !== 'vp-entity-read' || n.entity !== entity) continue;
        const v = parse(entity, n.channel, raw);
        if (v === null) continue;
        letzte[n.id] = { payload: v, topic: entity + '/' + n.channel };
        sende(n.id, letzte[n.id]); // deadband 0: jede Probe geht weiter
      }
      abarbeiten();
    },
    preis(payload) {
      for (const n of Object.values(knoten)) {
        if (n.type !== 'vp-feed' || n.feed !== 'price_current') continue;
        letzte[n.id] = { payload, topic: 'edge/price/current' };
        sende(n.id, letzte[n.id]);
      }
      abarbeiten();
    },
  };
}

// ---------------------------------------------------------------------------
// Zeitleisten
// ---------------------------------------------------------------------------

/** Proben eines Messwerts alle `alle` Sekunden von `von` bis `bis` nach einer Funktion. */
function proben(entity, kanal, von, bis, alle, f) {
  const out = [];
  for (let t = von; t < bis; t += alle) out.push({ t, art: 'messwert', entity, kanal, wert: Math.round(f(t) * 1000) / 1000 });
  return out;
}

/** Ein Börsenpreis je Viertelstunde (wie die API ihn sendet), gültig bis Slotende + 5 min. */
function preise(startMs, von, bis, f) {
  const out = [];
  const ersteGrenze = Math.ceil(startMs / 900000) * 900000;
  // Der Preis des laufenden Slots liegt retained bereit, wenn der Flow startet.
  const slotAnfang = Math.floor(startMs / 900000) * 900000;
  const ein = (ms) => {
    const t = Math.round((ms - startMs) / 1000);
    const slot = Math.floor(ms / 900000) * 900000;
    out.push({ t: Math.max(0, t), art: 'preis', wert: f(Math.max(0, t)), gueltig_bis: Math.round((slot + 900000 + 300000 - startMs) / 1000) });
  };
  ein(slotAnfang);
  for (let ms = ersteGrenze; ms < startMs + bis * 1000; ms += 900000) {
    const t = Math.round((ms - startMs) / 1000);
    if (t >= von) ein(ms);
  }
  return out;
}

const welle = (mitte, amp, periode, phase = 0) => (t) => mitte + amp * Math.sin((2 * Math.PI * (t + phase)) / periode);

// Die Fälle. `abweichungen` nennt, wo der Kern bewusst anders entscheidet als der alte Weg,
// mit seinem Wert und dem Grund; überall sonst muss er gleich entscheiden.
const FAELLE = [
  {
    name: 'Sonnen-Überschuss: Pumpe einschalten',
    satz: 'Wenn mehr als 2,0 kW Sonnenstrom übrig sind: Pumpe einschalten',
    start: '2026-06-16T11:59:59+02:00',
    dauer: 7200,
    regel: { conditions: [{ kind: 'entity', entityId: NETZ, channel: 'power_kw', direction: 'below', threshold: -2, hysteresis: 0.3 }],
      combinator: 'and', action: { kind: 'onoff', entityId: PUMPE, ttlS: TTL } },
    ereignisse: () => proben(NETZ, 'power_kw', 3, 7200, 5, (t) => welle(-1.9, 0.9, 1800)(t) + 0.25 * Math.sin(t / 37)),
    abweichungen: [],
  },
  {
    name: 'Speicher voll: Heizstab einschalten',
    satz: 'Wenn der Speicher über 90 % hat: Heizstab einschalten',
    start: '2026-06-16T13:29:59+02:00',
    dauer: 5400,
    regel: { conditions: [{ kind: 'entity', entityId: SPEICHER, channel: 'soc_pct', direction: 'above', threshold: 90, hysteresis: 2 }],
      combinator: 'and', action: { kind: 'onoff', entityId: HEIZSTAB, ttlS: TTL } },
    ereignisse: () => proben(SPEICHER, 'soc_pct', 1, 5400, 10, welle(89.5, 3, 2400)),
    abweichungen: [],
  },
  {
    name: 'Günstig heizen',
    satz: 'Wenn der Börsenpreis unter 10,0 ct/kWh liegt: Heizstab einschalten',
    start: '2026-11-16T01:59:59+01:00',
    dauer: 21600,
    regel: { conditions: [{ kind: 'price', direction: 'below', threshold: 10, hysteresis: 0.5 }],
      combinator: 'and', action: { kind: 'onoff', entityId: HEIZSTAB, ttlS: TTL } },
    ereignisse: (startMs) => preise(startMs, 0, 21600, (t) => [11, 10.2, 9.8, 10.4, 10.6, 9.4, 8, 10.5, 10.51][Math.floor(t / 900) % 9]),
    abweichungen: [],
  },
  {
    name: 'Negativpreise mitnehmen',
    satz: 'Wenn der Börsenpreis unter 0,0 ct/kWh liegt: Heizstab einschalten',
    start: '2026-06-14T12:59:59+02:00',
    dauer: 14400,
    regel: { conditions: [{ kind: 'price', direction: 'below', threshold: 0, hysteresis: 0.5 }],
      combinator: 'and', action: { kind: 'onoff', entityId: HEIZSTAB, ttlS: TTL } },
    ereignisse: (startMs) => preise(startMs, 0, 14400, (t) => [1.2, -0.1, -2.5, -0.3, 0.2, 0.5, 0.6, -1, 3][Math.floor(t / 900) % 9]),
    abweichungen: [],
  },
  {
    name: 'Nachts laufen lassen',
    satz: 'Wenn es zwischen 22:00 und 06:00 Uhr ist: Pumpe einschalten',
    start: '2026-11-16T21:29:59+01:00',
    dauer: 32400,
    regel: { conditions: [{ kind: 'schedule', from: '22:00', to: '06:00', days: 'alle' }],
      combinator: 'and', action: { kind: 'onoff', entityId: PUMPE, ttlS: TTL } },
    ereignisse: () => [],
    abweichungen: [],
  },
  {
    name: 'Mittagssonne im Zeitfenster',
    satz: 'Wenn mehr als 1,5 kW Sonnenstrom übrig sind und es zwischen 11:00 und 15:00 Uhr ist: Pumpe einschalten',
    start: '2026-06-16T10:29:59+02:00',
    dauer: 18000,
    regel: { conditions: [
      { kind: 'entity', entityId: NETZ, channel: 'power_kw', direction: 'below', threshold: -1.5, hysteresis: 0.3 },
      { kind: 'schedule', from: '11:00', to: '15:00', days: 'alle' }],
    combinator: 'and', action: { kind: 'onoff', entityId: PUMPE, ttlS: TTL } },
    ereignisse: () => proben(NETZ, 'power_kw', 2, 18000, 10, (t) => welle(-1.6, 1.2, 3000)(t) + 0.2 * Math.sin(t / 53)),
    abweichungen: [],
  },
  {
    name: 'Preis oder Speicher',
    satz: 'Wenn der Börsenpreis unter 8,0 ct/kWh liegt oder der Speicher über 95 % hat: Heizstab einschalten',
    start: '2026-06-16T09:59:59+02:00',
    dauer: 10800,
    regel: { conditions: [
      { kind: 'price', direction: 'below', threshold: 8, hysteresis: 0.5 },
      { kind: 'entity', entityId: SPEICHER, channel: 'soc_pct', direction: 'above', threshold: 95, hysteresis: 2 }],
    combinator: 'or', action: { kind: 'onoff', entityId: HEIZSTAB, ttlS: TTL } },
    ereignisse: (startMs) => [
      ...preise(startMs, 0, 10800, (t) => [9, 7.9, 8.2, 8.6, 12, 7, 9][Math.floor(t / 900) % 7]),
      ...proben(SPEICHER, 'soc_pct', 4, 10800, 10, welle(94, 2.5, 3600)),
    ].sort((a, b) => a.t - b.t),
    abweichungen: [],
  },
  {
    name: 'Vier Bedingungen',
    satz: 'Wenn mehr als 1,0 kW Sonnenstrom übrig sind und der Speicher über 80 % hat und der Börsenpreis unter 20,0 ct/kWh liegt und es zwischen 10:00 und 16:00 Uhr ist: Heizstab einschalten',
    start: '2026-06-16T09:44:59+02:00',
    dauer: 25200,
    regel: { conditions: [
      { kind: 'entity', entityId: NETZ, channel: 'power_kw', direction: 'below', threshold: -1, hysteresis: 0.3 },
      { kind: 'entity', entityId: SPEICHER, channel: 'soc_pct', direction: 'above', threshold: 80, hysteresis: 2 },
      { kind: 'price', direction: 'below', threshold: 20, hysteresis: 0.5 },
      { kind: 'schedule', from: '10:00', to: '16:00', days: 'alle' }],
    combinator: 'and', action: { kind: 'onoff', entityId: HEIZSTAB, ttlS: TTL } },
    ereignisse: (startMs) => [
      ...proben(NETZ, 'power_kw', 1, 25200, 10, (t) => welle(-1.2, 1.1, 2700)(t)),
      ...proben(SPEICHER, 'soc_pct', 2, 25200, 30, welle(81, 3, 5000)),
      ...preise(startMs, 0, 25200, (t) => [15, 19.8, 20.2, 21, 18][Math.floor(t / 900) % 5]),
    ].sort((a, b) => a.t - b.t),
    abweichungen: [],
  },
  {
    name: 'Heizstab voll mit Sonnenstrom',
    satz: 'Wenn mehr als 3,0 kW Sonnenstrom übrig sind: Heizstab voll einschalten',
    start: '2026-06-16T11:59:59+02:00',
    dauer: 7200,
    regel: { conditions: [{ kind: 'entity', entityId: NETZ, channel: 'power_kw', direction: 'below', threshold: -3, hysteresis: 0.3 }],
      combinator: 'and', action: { kind: 'setpoint', entityId: HEIZSTAB, value: 3, ttlS: TTL } },
    ereignisse: () => proben(NETZ, 'power_kw', 1, 7200, 5, (t) => welle(-2.8, 0.8, 2400)(t)),
    abweichungen: [],
  },
  {
    name: 'Werktags am Vormittag',
    satz: 'Wenn es zwischen 08:00 und 12:00 Uhr ist (werktags): Pumpe einschalten',
    start: '2026-11-20T07:29:59+01:00',
    dauer: 108000,
    regel: { conditions: [{ kind: 'schedule', from: '08:00', to: '12:00', days: 'werktage' }],
      combinator: 'and', action: { kind: 'onoff', entityId: PUMPE, ttlS: TTL } },
    ereignisse: () => [],
    abweichungen: [],
  },
  {
    name: 'Abweichung: Messwert bleibt aus',
    satz: 'Wenn mehr als 2,0 kW Sonnenstrom übrig sind: Pumpe einschalten (der Zähler schweigt 10 Minuten)',
    start: '2026-06-16T11:59:59+02:00',
    dauer: 3600,
    regel: { conditions: [{ kind: 'entity', entityId: NETZ, channel: 'power_kw', direction: 'below', threshold: -2, hysteresis: 0.3 }],
      combinator: 'and', action: { kind: 'onoff', entityId: PUMPE, ttlS: TTL } },
    ereignisse: () => [...proben(NETZ, 'power_kw', 1, 1200, 5, () => -3), ...proben(NETZ, 'power_kw', 1800, 3600, 5, () => -3)],
    // Node-RED rechnet mit der letzten Probe weiter, solange keine neue kommt; der Kern hält
    // einen Messwert nach max_age (60 s) für unbekannt, dann gilt die Bedingung nicht.
    abweichungen: [{ von: 1257, bis: 1800, kern: false, grund: 'veraltet' }],
  },
  {
    name: 'Abweichung: Preis läuft ab',
    satz: 'Wenn der Börsenpreis unter 10,0 ct/kWh liegt: Heizstab einschalten (kein neuer Preis kommt)',
    start: '2026-11-16T01:59:59+01:00',
    dauer: 5400,
    regel: { conditions: [{ kind: 'price', direction: 'below', threshold: 10, hysteresis: 0.5 }],
      combinator: 'and', action: { kind: 'onoff', entityId: HEIZSTAB, ttlS: TTL } },
    ereignisse: (startMs) => preise(startMs, 0, 1800, () => 5),
    // Der Preis des Slots ab 02:15 gilt bis 02:35. Der Preis-Wächter des Flows prüft die Frist
    // erst, wenn ihn das Slot-Raster wieder anstößt (02:45); der Kern liest den Preis nur, solange er gilt.
    abweichungen: [{ von: 2101, bis: 2701, kern: false, grund: 'preis_abgelaufen' }],
  },
  {
    name: 'Abweichung: Slot-Raster versetzt',
    satz: 'Wenn es zwischen 22:00 und 06:00 Uhr ist: Pumpe einschalten (Flow 23 s nach der vollen Minute geladen)',
    start: '2026-11-16T21:44:37+01:00',
    dauer: 1800,
    regel: { conditions: [{ kind: 'schedule', from: '22:00', to: '06:00', days: 'alle' }],
      combinator: 'and', action: { kind: 'onoff', entityId: PUMPE, ttlS: TTL } },
    ereignisse: () => [],
    // Das Slot-Raster feuert alle 30 s ab dem Laden des Flows: hier 8 s nach jeder halben Minute.
    abweichungen: [{ von: 923, bis: 931, kern: true, grund: 'raster' }],
  },
];

// ---------------------------------------------------------------------------

function rle(werte) {
  const out = [];
  for (const v of werte) {
    const letzter = out[out.length - 1];
    if (letzter && JSON.stringify(letzter[0]) === JSON.stringify(v)) letzter[1]++;
    else out.push([v, 1]);
  }
  return out;
}

function fall(f, nr) {
  const flowId = '00000000-0000-4000-8000-' + String(nr + 1).padStart(12, '0');
  const dokument = baueRegel(f.regel, f.name);
  const art = compile({ ...dokument, flow_id: flowId, flow_version: 1 });
  const startMs = Date.parse(f.start);
  const ereignisse = f.ereignisse(startMs);
  const lz = laufzeit(art.bundle, startMs);
  const stehend = [];
  const bedingt = [];
  let e = 0;
  for (let t = 0; t < f.dauer; t++) {
    const ms = startMs + t * 1000;
    while (e < ereignisse.length && ereignisse[e].t <= t) {
      const ev = ereignisse[e++];
      lz.bis(startMs + ev.t * 1000);
      if (ev.art === 'messwert') lz.telemetrie(ev.entity, ev.kanal, ev.wert);
      else {
        const slot = Math.floor((startMs + ev.t * 1000) / 900000) * 900000;
        lz.preis({ schema_version: '1.0', price_ct_kwh: ev.wert, unit: 'ct/kWh',
          slot_start: new Date(slot).toISOString(), slot_end: new Date(slot + 900000).toISOString(),
          valid_until: new Date(startMs + ev.gueltig_bis * 1000).toISOString(), bidding_zone: 'DE-LU' });
      }
    }
    lz.bis(ms + 999);
    // Der stehende Wunsch am Ende dieser Sekunde: der letzte, solange seine TTL läuft.
    const w = lz.wuensche[lz.wuensche.length - 1];
    stehend.push(w && ms + 999 - w.ms < w.ttl * 1000 ? w.wert : null);
    bedingt.push(lz.bedingung.wert);
  }
  // Abschnitte [von, bis), in denen eine Eigenschaft gilt.
  const abschnitte = (gilt) => {
    const out = [];
    let von = null;
    for (let t = 0; t <= f.dauer; t++) {
      const ja = t < f.dauer && gilt(t);
      if (ja && von === null) von = t;
      if (!ja && von !== null) {
        out.push([von, t]);
        von = null;
      }
    }
    return out;
  };
  const abweichungen = [];
  if (f.regel.action.kind === 'onoff') {
    // Vor dem ersten Wunsch (das Slot-Raster feuert 1 s nach dem Laden, ein Messwert kommt mit
    // seiner ersten Probe) wünscht der Flow nichts; der Kern beginnt mit „aus“.
    const erster = stehend.findIndex((v) => v !== null);
    if (erster > 0) abweichungen.push({ von: 0, bis: erster, kern: false, grund: 'start' });
  } else {
    // Der alte Weg schickt außerhalb der Bedingung nichts (vp.logic.if ohne Sonst-Wert): sein
    // letzter Wunsch „voll“ gilt noch ttl_s weiter. Der Kern wünscht sofort nichts mehr.
    for (const [von, bis] of abschnitte((t) => stehend[t] !== null && bedingt[t] === false)) {
      abweichungen.push({ von, bis, kern: null, grund: 'nachlauf' });
    }
  }
  abweichungen.push(...f.abweichungen);
  return {
    name: f.name,
    satz: f.satz,
    start: f.start,
    dauer_s: f.dauer,
    regel: f.regel,
    dokument,
    // Messwerte je Quelle als [t, wert], Preise als [t, ct/kWh, gültig bis t].
    messwerte: Object.values(ereignisse.filter((ev) => ev.art === 'messwert').reduce((acc, ev) => {
      const k = ev.entity + '/' + ev.kanal;
      acc[k] = acc[k] || { quelle: QUELLE[k], entity: ev.entity, kanal: ev.kanal, proben: [] };
      acc[k].proben.push([ev.t, ev.wert]);
      return acc;
    }, {})),
    preise: ereignisse.filter((ev) => ev.art === 'preis').map((ev) => [ev.t, ev.wert, ev.gueltig_bis]),
    nodered: rle(stehend),
    nodered_wuensche: lz.wuensche.length,
    abweichungen,
  };
}

function baue() {
  return {
    $comment: [
      'Gleichheitsbeleg Regel-Baukasten -> Kern (Steuerlogik Stufe 6, Zusammenführen; Vertrag steuerlogik.md).',
      'Erzeugt von edge-app/nodered/flowc/regel-kern-vectors.gen.js: jede Regel mit flowc kompiliert und ausgeführt wie Node-RED auf der Docker-Box (Ortszeit Europe/Berlin).',
      'Gelesen von: edge-app/core/internal/logikdienst/regel/gleichheit_test.go (Kern gegen nodered, Sekunde für Sekunde) und frontend/portal/src/flows/guidedBuilder.test.ts (dokument = buildGuidedFlow(regel, name)).',
    ],
    $regel: 't in Sekunden ab dem Laden des Flows (start). nodered: der stehende Wunsch am Ende jeder Sekunde, lauflängen-kodiert [[wert, sekunden], …]: true/false (Ein/Aus), eine Zahl (Sollwert in kW) oder null (kein Wunsch). abweichungen: [von, bis) mit dem Wert des Kerns und dem Grund (start: vor dem ersten Messwert wünscht der Flow nichts, der Kern aus; veraltet: der Kern hält einen Messwert nach max_age für unbekannt; preis_abgelaufen: der Flow prüft die Frist des Preises erst beim nächsten Slot-Raster; raster: der Flow prüft ein Zeitfenster erst, wenn sein Slot-Raster feuert; nachlauf: der Flow hält „voll“ nach dem Ende der Bedingung bis zum Ablauf der TTL).',
    ttl_s: TTL,
    anlage: ANLAGE,
    faelle: FAELLE.map(fall),
  };
}

/** JSON mit Einzug, Reihen aus Zahlen und kurze Paare aber in einer Zeile. */
function schreibe(v, einzug = '') {
  const innen = einzug + ' ';
  const flach = (x) => x === null || typeof x !== 'object'
    || (Array.isArray(x) && x.every((y) => y === null || typeof y !== 'object'));
  if (flach(v)) return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.every(flach)) return '[' + v.map((x) => JSON.stringify(x)).join(',') + ']';
    return '[\n' + v.map((x) => innen + schreibe(x, innen)).join(',\n') + '\n' + einzug + ']';
  }
  const teile = Object.entries(v).map(([k, x]) => innen + JSON.stringify(k) + ': ' + schreibe(x, innen));
  return '{\n' + teile.join(',\n') + '\n' + einzug + '}';
}

if (require.main === module) {
  const text = schreibe(baue()) + '\n';
  if (process.argv.includes('--check')) {
    const alt = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (alt !== text) {
      console.error('regel-kern-vectors.json ist nicht aktuell: node regel-kern-vectors.gen.js');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(OUT, text);
  }
}

module.exports = { baue, baueRegel, laufzeit, schreibe, OUT };

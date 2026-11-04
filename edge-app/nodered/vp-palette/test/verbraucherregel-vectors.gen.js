#!/usr/bin/env node
/**
 * Generates docs/contracts/v2/verbraucherregel-vectors.json: step-by-step
 * scenarios of the generated reactive consumer rule (vp-consumer-policy). The
 * INPUTS are written here; the EXPECTED outputs come from the JS reference
 * (lib/consumer-policy-runtime.js, which the Node-RED node runs). Edge Light's
 * Go twin (edge-app/core/internal/verbraucherregel) must produce the same
 * desired at every step.
 *
 *   node test/verbraucherregel-vectors.gen.js           # write the file
 *   node test/verbraucherregel-vectors.gen.js --check   # exit 1 on drift
 *
 * The node config of each scenario is shaped exactly like the compiler's
 * (ConsumerPolicyCompiler: ttl_s 45, renew_s 15, off_delay_s 15, leaves with
 * signal/source/channel/op/value/reset_value/max_age_s, cloud conditions as
 * precomputed UTC windows).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Runtime } = require('../lib/consumer-policy-runtime');

const OUT = path.join(__dirname, '..', '..', '..', '..', 'docs', 'contracts', 'v2',
  'verbraucherregel-vectors.json');

const FLOW = '0d9c3c1e-5b7a-3f4e-9a61-2f0c8a7b6d51';

function node(entity, command, requirements, extra) {
  return Object.assign({
    entity,
    command,
    ttl_s: 45,
    renew_s: 15,
    off_delay_s: 15,
    requirements,
    flowId: FLOW,
    flowVersion: 2,
    nodeId: 'reaktiv',
  }, extra || {});
}

const surplus = (value, reset) => ({
  signal: 'site.pv_surplus_kw', source: 'site', channel: 'pv_surplus_kw',
  op: 'gt', value, reset_value: reset, max_age_s: 120,
});
const site = (pv, load, extra) => Object.assign({ pv_power_kw: pv, load_kw: load }, extra || {});
const ent = (entity, channels, extra) =>
  Object.assign({ schema_version: '1.0', entity_id: entity, channels }, extra || {});

// Each step: t_s (seconds after start), art site|entity|takt, nachricht.
const SZENARIEN = [
  {
    name: 'ueberschuss_schaltlast',
    beschreibung: 'Steuerart Überschuss an einer Schaltlast (SteuerartDokument: Schwelle 1,5 kW, '
      + 'Rückfall 0,75 x = 1,125 kW, 120 s frisch): Start sofort aus der Telemetrie, gleiche '
      + 'Telemetrie sendet nichts neu, der Takt erneuert, Totband hält, unter dem Rückfall '
      + 'endet es erst nach der Abfallverzögerung.',
    knoten: node('schaltlast-1', 'on_off', [
      { id: 'ueberschuss', must_run: false, value: true, condition: surplus(1.5, 1.125) },
    ]),
    schritte: [
      { t_s: 0, art: 'site', nachricht: site(2.2, 1.0) },
      { t_s: 1, art: 'takt' },
      { t_s: 5, art: 'site', nachricht: site(3.0, 1.0) },
      { t_s: 10, art: 'site', nachricht: site(2.3, 1.0) },
      { t_s: 16, art: 'takt' },
      { t_s: 20, art: 'site', nachricht: site(1.0, 1.0) },
      { t_s: 31, art: 'takt' },
      { t_s: 35, art: 'site', nachricht: site(1.0, 1.0) },
      { t_s: 46, art: 'takt' },
      { t_s: 50, art: 'site', nachricht: site(2.0, 1.0) },
      { t_s: 55, art: 'site', nachricht: site(2.6, 1.0) },
    ],
  },
  {
    name: 'ueberschuss_braucht_pv_und_last',
    beschreibung: 'Ohne Last-Messung gibt es keinen Überschuss (nie eine erfundene 0): '
      + 'das Signal bleibt unbekannt und startet nichts.',
    knoten: node('schaltlast-1', 'on_off', [
      { id: 'ueberschuss', must_run: false, value: true, condition: surplus(1.5, 1.125) },
    ]),
    schritte: [
      { t_s: 0, art: 'site', nachricht: { pv_power_kw: 5.0, soc_pct: 50 } },
      { t_s: 1, art: 'takt' },
      { t_s: 2, art: 'site', nachricht: { pv_power_kw: 'viel', load_kw: 0.5 } },
      { t_s: 16, art: 'takt' },
    ],
  },
  {
    name: 'veraltet_startet_nie',
    beschreibung: 'Ein Messwert älter als max_age_s ist unbekannt: er startet nie und beendet '
      + 'einen Lauf (nach der Abfallverzögerung); die Hysterese vergisst ihn.',
    knoten: node('schaltlast-1', 'on_off', [
      { id: 'ueberschuss', must_run: false, value: true, condition: surplus(1.5, 1.125) },
    ]),
    schritte: [
      { t_s: 0, art: 'site', nachricht: site(4.0, 1.0) },
      { t_s: 119, art: 'takt' },
      { t_s: 121, art: 'takt' },
      { t_s: 130, art: 'takt' },
      { t_s: 137, art: 'takt' },
      { t_s: 140, art: 'site', nachricht: site(2.3, 1.0) },
      { t_s: 141, art: 'takt' },
    ],
  },
  {
    name: 'speicher_hysterese_unten',
    beschreibung: 'Hysterese in Richtung lt: Laden des Verbrauchers, wenn der Speicher unter 20 % '
      + 'fällt, Rückfall erst über 25 %; Totband am Anfang ist aus.',
    knoten: node('pumpe-1', 'on_off', [
      { id: 'speicher-leer', must_run: true, value: true,
        condition: { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
          op: 'lt', value: 20, reset_value: 25, max_age_s: 60 } },
    ], { off_delay_s: 0 }),
    schritte: [
      { t_s: 0, art: 'site', nachricht: { soc_pct: 22 } },
      { t_s: 5, art: 'site', nachricht: { soc_pct: 19.5 } },
      { t_s: 10, art: 'site', nachricht: { soc_pct: 24 } },
      { t_s: 15, art: 'takt' },
      { t_s: 20, art: 'site', nachricht: { soc_pct: 25.5 } },
      { t_s: 25, art: 'site', nachricht: { soc_pct: 21 } },
    ],
  },
  {
    name: 'fenster_mitternacht_und_zeitumstellung',
    beschreibung: 'Vorberechnete UTC-Fenster (die Cloud rechnet Ortszeit und Sommerzeit um): '
      + 'ein Fenster über Mitternacht Ortszeit (22:30-01:30 MESZ = 20:30Z-23:30Z) und eines in der '
      + 'Nacht der Zeitumstellung 25.10.2026 (02:00-04:00 MEZ = 01:00Z-03:00Z, die '
      + 'doppelte Stunde liegt darin). Drinnen wahr, dazwischen falsch, nach dem letzten '
      + 'unbekannt (ein abgelaufenes Fenster startet nie neu). Lokales UND Fenster.',
    knoten: node('schaltlast-1', 'setpoint_kw', [
      { id: 'guenstig-und-sonne', must_run: false, value: 2.5,
        condition: { all: [
          { windows: [['2026-10-24T20:30:00Z', '2026-10-24T23:30:00Z'],
            ['2026-10-25T01:00:00Z', '2026-10-25T03:00:00Z']] },
          { not: { signal: 'site.grid_power_kw', source: 'site', channel: 'grid_power_kw',
            op: 'gt', value: 10, max_age_s: 120 } },
        ] } },
    ], { off_delay_s: 0 }),
    start: '2026-10-24T20:00:00Z',
    schritte: [
      { t_s: 0, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 1800, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 1815, art: 'takt' },
      { t_s: 1830, art: 'site', nachricht: { power_kw: 12.0 } },
      { t_s: 1840, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 12600, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 18000, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 25199, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 25200, art: 'site', nachricht: { power_kw: 1.0 } },
      { t_s: 25215, art: 'takt' },
    ],
  },
  {
    name: 'fahrzeug_flackert',
    beschreibung: 'Pflichtregel an der Entitäts-Telemetrie (0/1-Kanal): Anstecken startet sofort '
      + 'mit override, ein kurzes Flackern hält die Abfallverzögerung, fremde oder falsch '
      + 'versionierte Telemetrie und ein boolescher Kanal zählen nicht.',
    knoten: node('wallbox-1', 'setpoint_kw', [
      { id: 'laden-wenn-angesteckt', must_run: true, value: 11,
        condition: { signal: 'consumer.vehicle_connected', source: 'entity',
          channel: 'vehicle_connected', op: 'eq', value: 1, max_age_s: 20 } },
    ]),
    schritte: [
      { t_s: 0, art: 'entity', nachricht: ent('wallbox-2', { vehicle_connected: 1 }) },
      { t_s: 1, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: 1 }, { schema_version: '2.0' }) },
      { t_s: 2, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: true }) },
      { t_s: 3, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: 1 }) },
      { t_s: 8, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: 0 }) },
      { t_s: 12, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: 1 }) },
      { t_s: 18, art: 'takt' },
      { t_s: 20, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: 0 }) },
      { t_s: 33, art: 'takt' },
      { t_s: 35, art: 'entity', nachricht: ent('wallbox-1', { vehicle_connected: 0 }) },
    ],
  },
  {
    name: 'zusammenfuehren',
    beschreibung: 'Mehrere aktive Anforderungen: der höchste Wert gewinnt, override sobald eine '
      + 'aktive must_run trägt; ein neuer Wert sendet aus der Telemetrie sofort neu '
      + '(request_id ändert sich), Kleene: unbekannt im ODER verliert gegen wahr.',
    knoten: node('heizung-1', 'setpoint_kw', [
      { id: 'soc-voll', must_run: false, value: 4.2,
        condition: { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
          op: 'gt', value: 80, reset_value: 75, max_age_s: 120 } },
      { id: 'angesteckt', must_run: true, value: 3.7,
        condition: { any: [
          { signal: 'consumer.available', source: 'entity', channel: 'available',
            op: 'eq', value: 1, max_age_s: 60 },
          { signal: 'site.pv_surplus_kw', source: 'site', channel: 'pv_surplus_kw',
            op: 'gte', value: 6, max_age_s: 120 },
        ] } },
    ]),
    schritte: [
      { t_s: 0, art: 'site', nachricht: site(1.0, 0.5, { soc_pct: 85 }) },
      { t_s: 2, art: 'entity', nachricht: ent('heizung-1', { available: 1 }) },
      { t_s: 4, art: 'site', nachricht: site(1.0, 0.5, { soc_pct: 70 }) },
      { t_s: 6, art: 'entity', nachricht: ent('heizung-1', { available: 0 }) },
      { t_s: 8, art: 'site', nachricht: site(7.0, 0.5, { soc_pct: 70 }) },
      { t_s: 10, art: 'takt' },
    ],
  },
  {
    name: 'kleene_und_unbekannt',
    beschreibung: 'UND mit einem unbekannten Teil ist unbekannt (startet nicht), UND mit einem '
      + 'falschen Teil ist falsch; NICHT von unbekannt bleibt unbekannt.',
    knoten: node('schaltlast-1', 'on_off', [
      { id: 'beides', must_run: false, value: true,
        condition: { all: [
          { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
            op: 'gte', value: 50, max_age_s: 60 },
          { not: { signal: 'consumer.available', source: 'entity', channel: 'available',
            op: 'ne', value: 1, max_age_s: 60 } },
        ] } },
    ], { off_delay_s: 0 }),
    schritte: [
      { t_s: 0, art: 'site', nachricht: { soc_pct: 60 } },
      { t_s: 1, art: 'site', nachricht: { soc_pct: 40 } },
      { t_s: 2, art: 'entity', nachricht: ent('schaltlast-1', { available: 1 }) },
      { t_s: 3, art: 'site', nachricht: { soc_pct: 55 } },
      { t_s: 4, art: 'entity', nachricht: ent('schaltlast-1', { available: 0 }) },
    ],
  },
  {
    name: 'modus_reihenfolge',
    beschreibung: 'mode: die erste aktive Anforderung in Dokumentreihenfolge gewinnt.',
    knoten: node('wp-1', 'mode', [
      { id: 'boost', must_run: false, value: 'boost',
        condition: { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
          op: 'gt', value: 90, max_age_s: 60 } },
      { id: 'eco', must_run: false, value: 'eco',
        condition: { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
          op: 'gt', value: 50, max_age_s: 60 } },
    ], { off_delay_s: 0 }),
    schritte: [
      { t_s: 0, art: 'site', nachricht: { soc_pct: 60 } },
      { t_s: 1, art: 'site', nachricht: { soc_pct: 95 } },
      { t_s: 2, art: 'takt' },
    ],
  },
  {
    name: 'sollwert_ohne_zahl',
    beschreibung: 'Ein Sollwert, der keine Zahl ist, ergibt keinen Wunsch.',
    knoten: node('heizung-1', 'setpoint_kw', [
      { id: 'kaputt', must_run: false, value: 'viel',
        condition: { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
          op: 'gt', value: 50, max_age_s: 60 } },
    ], { off_delay_s: 0 }),
    schritte: [
      { t_s: 0, art: 'site', nachricht: { soc_pct: 60 } },
      { t_s: 1, art: 'takt' },
    ],
  },
];

const DEFAULT_START = '2026-08-10T10:00:00Z';

function run() {
  const szenarien = SZENARIEN.map((s) => {
    const start = s.start || DEFAULT_START;
    const t0 = Date.parse(start);
    const rt = new Runtime(s.knoten);
    const schritte = s.schritte.map((st) => {
      const now = t0 + st.t_s * 1000;
      let out;
      if (st.art === 'site') out = rt.onSite(st.nachricht, now);
      else if (st.art === 'entity') out = rt.onEntity(st.nachricht, now);
      else out = rt.onTrigger(now);
      const r = out.result;
      const erwartet = {
        aktiv: r.active,
        gehalten: r.held,
        unbekannt: r.anyUnknown,
      };
      if (r.active) {
        erwartet.must_run = r.mustRun;
        erwartet.wert = r.value === undefined ? null : r.value;
        erwartet.anforderungen = r.requirementIds;
      }
      erwartet.unbrauchbar = out.unusable;
      erwartet.wunsch = out.publish;
      const step = { t_s: st.t_s, art: st.art };
      if (st.nachricht !== undefined) step.nachricht = st.nachricht;
      step.erwartet = erwartet;
      return step;
    });
    return { name: s.name, beschreibung: s.beschreibung, start, knoten: s.knoten, schritte };
  });
  return {
    schema_version: '1.0',
    beschreibung: 'Gemeinsame Vektoren der generierten reaktiven Verbraucherregel '
      + '(vp-consumer-policy). Erzeugt von edge-app/nodered/vp-palette/test/'
      + 'verbraucherregel-vectors.gen.js aus der JS-Referenz; Docker-Box (Palette) und Edge Light '
      + '(Go-Zwilling internal/verbraucherregel) liefern an jedem Schritt denselben Wunsch. '
      + 'art: site = edge/telemetry, entity = edge/entities/<id>/telemetry, takt = der kompilierte '
      + 'Intervall-Auslöser. wunsch = was auf edge/entities/<id>/desired geht, null = nichts.',
    szenarien,
  };
}

function render() {
  return JSON.stringify(run(), null, 2) + '\n';
}

module.exports = { render, OUT };

if (require.main === module) {
  const text = render();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have !== text) {
      console.error('verbraucherregel-vectors.json ist veraltet: node test/verbraucherregel-vectors.gen.js');
      process.exit(1);
    }
    console.log('verbraucherregel-vectors.json aktuell');
  } else {
    fs.writeFileSync(OUT, text);
    console.log('geschrieben: ' + OUT);
  }
}

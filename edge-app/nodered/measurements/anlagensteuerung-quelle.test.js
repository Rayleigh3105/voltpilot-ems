'use strict';

/**
 * Die Quelle einer Anlagensteuerung (UEMS EZ-21) im Lesepfad der Palette: die Komponente kommt so, wie der Core sie
 * aus dem Registry-Push der Cloud retained auf edge/entities/{id}/config legt (Typ `anlagensteuerung`, Pin
 * `edge_source_id`, Treiber mit `data_source_id`), die Quelle so, wie der Core sie in edge/sources/config
 * veroeffentlicht (`bus_eintrag`). Daraus muss die Bindung das Ziel der Quelle finden, das Lesegeraet die Adresse,
 * Port und Geraete-ID der Steuerung liefern und der Planer das Erzeuger-Bild annehmen - bis EZ-21 endete genau das
 * in `binding_unavailable`. Die Faelle stehen in docs/contracts/v2/anlagensteuerung-quelle-vectors.json; Go
 * (componentapply) und Java (AnlagensteuerungQuelle) pruefen dieselben.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const binding = require('./measurement-binding');
const { erzeugerbilderJeZiel } = require('./measurement-planner');
const sourcesConfig = require('../vp-palette/nodes/vp-sources-config');
const sourcesRouting = require('../sources-routing');

const vektoren = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2',
  'anlagensteuerung-quelle-vectors.json'), 'utf8'));

const STEUERUNG = '00000000-0000-0000-0000-0000000e2001';

/** edge/entities/{id}/config, wie entities.Entity.ConfigPayload sie aus dem Push schreibt. */
function entitaetsKonfiguration(fall) {
  return Buffer.from(JSON.stringify({ schema_version:'1.0', entity_id:STEUERUNG, entity_type:'anlagensteuerung',
    label:fall.label, edge_source_id:fall.edge_source_id, capabilities:{}, guards:{}, driver:fall.driver,
    revision:'2026-10-23T08:00:00Z' }));
}

/** edge/sources/config, wie sources.BusConfig sie schreibt. */
function quellenKonfiguration(fall) {
  return Buffer.from(JSON.stringify({ schema_version:'1.0', sources:[fall.bus_eintrag] }));
}

function bindungVon(fall) {
  const entitaet = binding.parseEntityConfig(entitaetsKonfiguration(fall));
  const liste = sourcesConfig.parse(quellenKonfiguration(fall));
  assert.ok(entitaet, 'die Komponente ist lesbar');
  assert.ok(Array.isArray(liste) && liste.length === 1, 'die Quelle ueberlebt die Strukturpruefung der Palette');
  return { entities:{ [STEUERUNG]:entitaet }, sources:binding.sourceMap(liste) };
}

for (const fall of vektoren.faelle) {
  test(`${fall.name}: die Komponente bindet ueber ihren Pin an die Quelle der Steuerung`, () => {
    const b = bindungVon(fall);
    const ziel = binding.resolveTarget({ entity_id:STEUERUNG }, null, b);
    assert.deepStrictEqual(ziel, { key:'source:' + fall.edge_source_id, sourceId:fall.edge_source_id,
      dataSourceId:fall.kennzeichen });
    const geraet = binding.resolveDevice(ziel, { inverter:null, sources:b.sources });
    assert.strictEqual(geraet.communication, vektoren.kommunikation);
    assert.strictEqual(geraet.connection.ip, fall.driver.connection.ip);
    assert.strictEqual(geraet.connection.port, fall.driver.connection.port);
    assert.strictEqual(geraet.connection.unit_id, fall.driver.connection.unit_id);
  });

  test(`${fall.name}: der Planer nimmt das Erzeuger-Bild fuer das Ziel der Quelle an`, () => {
    const bilder = erzeugerbilderJeZiel([{ entity_id:STEUERUNG, basisadresse:0, funktionscode:4, wortfolge:'big',
      te_anzahl:3, anlagenart:'pv' }], bindungVon(fall));
    assert.deepStrictEqual(Object.keys(bilder), ['source:' + fall.edge_source_id]);
    assert.strictEqual(bilder['source:' + fall.edge_source_id].entity_id, STEUERUNG);
  });
}

test('ohne Quelle in edge/sources/config bleibt es die ehrliche Ablehnung (alter Box-Stand)', () => {
  const fall = vektoren.faelle[0];
  const b = { entities:{ [STEUERUNG]:binding.parseEntityConfig(entitaetsKonfiguration(fall)) }, sources:{} };
  assert.deepStrictEqual(binding.resolveTarget({ entity_id:STEUERUNG }, null, b),
    { reason:binding.REASON_UNBOUND });
  assert.deepStrictEqual(erzeugerbilderJeZiel([{ entity_id:STEUERUNG, basisadresse:0, funktionscode:4,
    wortfolge:'big', te_anzahl:3, anlagenart:'pv' }], b), {});
});

test('die Selbstverdrahtung pollt die Steuerung nicht - das Bild liest allein der Messplan', () => {
  const fall = vektoren.faelle[0];
  const eintraege = sourcesRouting.parseSourcesConfig(quellenKonfiguration(fall));
  assert.strictEqual(sourcesRouting.ROLE_PLANT_CONTROLLER, vektoren.rolle);
  assert.deepStrictEqual(sourcesRouting.planSources(eintraege), []);
});

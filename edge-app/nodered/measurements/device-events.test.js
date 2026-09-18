'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const events = require('./device-events');
const wagoKopf = require('./wago-kopf');
const registerbild = require('./wago-registerbild');

const VERTRAG = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2',
  'mqtt-events-2.1.schema.json');

test('das Vokabular ist Wort fuer Wort das des gebauten Vertrags', () => {
  const schema = JSON.parse(fs.readFileSync(VERTRAG, 'utf8'));
  for (const art of events.ARTEN) {
    const def = schema.$defs['box_' + art];
    assert.ok(def, `Vertrag kennt ${art} nicht`);
    // Der Treiber liefert `ereignis_id` nicht zwingend mit; der Kern vergibt sie.
    const pflicht = def.required.filter((f) => f !== 'ereignis_id').sort();
    assert.deepEqual(events.REGELN[art].pflicht.slice().sort(), pflicht, art);
    const erlaubt = Object.keys(def.properties).filter((f) => f !== 'ereignis_id').sort();
    assert.deepEqual(Object.keys(events.REGELN[art].felder).sort(), erlaubt, art);
  }
  // Die zwei Arten, die nur der KERN kennt, darf ein Treiber nicht einliefern.
  for (const art of ['box_restart', 'data_gap']) {
    assert.ok(schema.$defs['box_' + art], `${art} fehlt im Vertrag`);
    assert.equal(events.ARTEN.includes(art), false, `${art} darf kein Treiber melden`);
  }
});

test('clock_jump ist kein Box-Wort und faellt hier durch', () => {
  // Urheber ist die Datenannahme (events-vocabulary.md Paragraf 4, Spalte "Box" = "-");
  // ein gesendeter clock_jump wuerde den GANZEN Umschlag verwerfen.
  const schema = JSON.parse(fs.readFileSync(VERTRAG, 'utf8'));
  assert.equal(schema.$defs.box_clock_jump, undefined);
  assert.equal(events.ereignis({ art:'clock_jump', zeitpunkt:'2027-02-01T10:00:00Z', sprung_s:600 }), null);
  assert.equal(events.nachricht({ art:'clock_jump', zeitpunkt:'2027-02-01T10:00:00Z' }), null);
});

test('ein gueltiges Geraete-Ereignis wird zur Bus-Nachricht', () => {
  const now = new Date('2027-02-01T10:00:00.900Z');
  const msg = events.nachricht({ art:'device_restart', datenquelle:'DQ-4',
    herzschlag_vorher:6104, herzschlag_nachher:3 }, now);
  assert.equal(msg.topic, 'edge/events');
  assert.deepEqual(msg.payload, { art:'device_restart', zeitpunkt:'2027-02-01T10:00:00Z',
    datenquelle:'DQ-4', herzschlag_vorher:6104, herzschlag_nachher:3 });
  // Die Ereignis-Kennung darf fehlen - der Kern vergibt sie EINMAL.
  assert.equal('ereignis_id' in msg.payload, false);
});

test('ein fremdes Feld, ein falscher Typ oder eine fehlende Pflicht sendet nichts', () => {
  const now = new Date('2027-02-01T10:00:00Z');
  const schlecht = [
    { art:'range_limit', datenquelle:'EK-3', messstelle:'MS-10' },   // die Box kennt keine Messstelle
    { art:'range_limit', datenquelle:'EK-3', statuswort:65536 },      // ueber dem Wertebereich
    { art:'range_limit', datenquelle:'EK-3', statuswort:1.5 },        // keine ganze Zahl
    { art:'range_limit' },                                            // Datenquelle fehlt
    { art:'frozen_source', datenquelle:'DQ-4', lesungen:0 },          // ab 1
    { art:'device_restart', datenquelle:'DQ 4' },                     // Leerzeichen
    { art:'layout_changed', datenquelle:'EK-7', zeitpunkt:'2027-02-01T10:00:00.500Z' },
    { art:'layout_changed', datenquelle:'EK-7', zeitpunkt:'2027-02-01T11:00:00+01:00' },
    { art:'layout_changed', datenquelle:'EK-7', ereignis_id:'keine-uuid' },
    { art:'unbekannt', datenquelle:'EK-7' },
    null, 'text', 42,
  ];
  for (const fall of schlecht) {
    assert.equal(events.ereignis(fall, now), null, JSON.stringify(fall));
  }
});

test('ein leeres Feld wird weggelassen, nie als 0 erfunden', () => {
  const now = new Date('2027-02-01T10:00:00Z');
  const e = events.ereignis({ art:'frozen_source', datenquelle:'DQ-4',
    komponente:undefined, messkanal:null, lesungen:3 }, now);
  assert.deepEqual(e, { art:'frozen_source', zeitpunkt:'2027-02-01T10:00:00Z',
    datenquelle:'DQ-4', lesungen:3 });
});

// Der belegte Beispiel-Absender aus dem BESTAND: die Kopf-Pruefung aus PR 945.
// Ihre Ausloeser gehoeren AP-05 IP-8, nicht diesem Paket - hier wird nur gezeigt,
// dass ihr echter Befund und ihr echtes Herzschlag-Urteil durch diesen Weg passen.
test('die gebaute WAGO-Kopf-Pruefung passt ohne Umbau durch den Einliefer-Weg', () => {
  const now = new Date('2027-03-01T08:00:00Z');
  const fremd = new Array(registerbild.KOPFLAENGE_MIN).fill(0);
  const gelesen = wagoKopf.pruefeLesung(fremd, { steuerung:'EK-7' });
  assert.equal(gelesen.befund.finding, 'registerbild_unbekannt');
  assert.equal(gelesen.befund.error_class, 'layout_changed');
  const layout = events.ereignis({ art: gelesen.befund.error_class, datenquelle:'EK-7' }, now);
  assert.deepEqual(layout, { art:'layout_changed', zeitpunkt:'2027-03-01T08:00:00Z',
    datenquelle:'EK-7' });

  // Und der stehende Herzschlag derselben Steuerung: drei gleiche Lesungen in Folge.
  const wacht = new wagoKopf.HerzschlagWacht();
  let letzte = null;
  for (let i = 0; i < 4; i += 1) letzte = wacht.beobachte('EK-7', 42);
  assert.equal(letzte.qualitaet, wagoKopf.QUALITAET_ALT);
  const frozen = events.ereignis({ art:'frozen_source', datenquelle:'EK-7',
    lesungen: letzte.steht, herzschlag: 42 }, now);
  assert.deepEqual(frozen, { art:'frozen_source', zeitpunkt:'2027-03-01T08:00:00Z',
    datenquelle:'EK-7', lesungen: letzte.steht, herzschlag: 42 });
});

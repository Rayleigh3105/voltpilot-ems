'use strict';

/**
 * Die Verdrahtung des WAGO-Registerbilds in der Mess-Laufzeit (UEMS AP-05, Befund aus PR 1135
 * „aktiviert heisst noch nicht gelesen").
 *
 * Ende zu Ende auf der Buehne aus IP-12: die Wunsch-Konfiguration traegt `registerbilder`
 * (mqtt-measurement-config 2.0, additiv), `MeasurementRuntime.apply` reicht sie je Ziel an den
 * Planer, `readModbus` faehrt Funktionscode und Adresse aus dem Registerbild ueber den ECHTEN
 * Modbus-Weg (`modbus-tcp.js` gegen den In-Process-Server der Buehne), die Kopfpruefung (IP-7)
 * urteilt je Steuerung, die Ereignisse (IP-8) gehen auf `edge/events`.
 *
 * ⚠ Simulator, kein Beleg: nichts hier sagt, dass eine echte WAGO-Steuerung sich so verhaelt.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { MeasurementRuntime } = require('./measurement-runtime');
const { registerbilderJeZiel } = require('./measurement-planner');
const { catalogDocument } = require('./measurement-driver');
const { buildReadRequest, parseReadResponse } = require('../modbus-tcp');
const { modbusFunktionscode } = require('../vp-palette/nodes/vp-measurements');

const BUEHNE = path.join(__dirname, '..', 'vp-palette', 'test', 'fixtures',
  'wago-registerbild-store.js');
const buehneDa = fs.existsSync(BUEHNE);

const STEUERUNG = '00000000-0000-0000-0000-00000000c001';
const KARTE_494 = '00000000-0000-0000-0000-00000000c494';
const KARTE_495 = '00000000-0000-0000-0000-00000000c495';
const DATENQUELLE = '00000000-0000-0000-0000-00000000d001';
const PIN = 'wago-halle-2';

/** Die Anlage: Basisadresse 4096, FC 4, niederwertiges Wort zuerst - nichts davon ist Vorgabe. */
const ANLAGE = Object.freeze({ basisadresse:4096, funktionscode:4, wortfolge:'little',
  controller_kennung:7 });
const KARTEN = Object.freeze([
  { steckplatz:2, kartentyp:494, variante:1 },
  { steckplatz:3, kartentyp:495, variante:25001 },
]);

function bindung() {
  const eintrag = (id) => ({ entity_id:id, entity_type:'meter', edge_source_id:PIN,
    data_source_id:DATENQUELLE });
  return { entities:{ [STEUERUNG]:eintrag(STEUERUNG), [KARTE_494]:eintrag(KARTE_494),
    [KARTE_495]:eintrag(KARTE_495) },
  sources:{ [PIN]:{ connection:{ ip:'127.0.0.1' } } } };
}

function registerbild(ueberschreiben = {}) {
  return Object.assign({ entity_id:STEUERUNG, basisadresse:ANLAGE.basisadresse,
    funktionscode:ANLAGE.funktionscode, wortfolge:ANLAGE.wortfolge, kartenzahl:KARTEN.length,
    controller_kennung:ANLAGE.controller_kennung, karten:KARTEN.map((k) => ({ ...k })) },
  ueberschreiben);
}

function konfiguration({ mitRegisterbild = true, revision = 1 } = {}) {
  return { schema_version:'2.0', revision, catalog_version:catalogDocument.catalog_version,
    selections:[
      { point_key:'wago.pm495.karte[1].frequency', cadence_s:60, entity_id:KARTE_495 },
      { point_key:'wago.pm495.karte[1].energy_import_total', cadence_s:60, entity_id:KARTE_495 },
      { point_key:'wago.pm494.karte[0].power_l1', cadence_s:60, entity_id:KARTE_494 },
    ],
    ...(mitRegisterbild ? { registerbilder:[registerbild()] } : {}) };
}

/** Eine Modbus-TCP-Lesung mit den Bausteinen dieses Repos - der Weg von `vp-measurements.js`. */
function liesUeberModbus(port, { fc, addr, count, txid }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host:'127.0.0.1' }, () => {
      sock.write(buildReadRequest({ txid, unitId:1, addr, count, fc }));
    });
    const teile = [];
    sock.on('data', (buf) => {
      teile.push(buf);
      const alles = Buffer.concat(teile);
      if (alles.length < 6 || alles.length < 6 + alles.readUInt16BE(4)) return;
      sock.end();
      try { resolve(parseReadResponse(alles, { expectTxid:txid, expectUnit:1, expectFn:fc })); }
      catch (error) { reject(error); }
    });
    sock.on('error', reject);
  });
}

/** Die Laufzeit mit der Box-Verdrahtung: FC aus `modbusFunktionscode`, Bindung wie Stufe 3c. */
async function aufbauen(storeCfg = {}) {
  const buehne = require(BUEHNE);
  const store = buehne.erstelleRegisterbild(Object.assign({ ...ANLAGE, herzschlag:100,
    karten:[
      { ...KARTEN[0], messwerte:[1000, { roh:0 }, 200, 0, 0, 23000, 0, 0, 0, 0, 0, 50000] },
      { ...KARTEN[1], messwerte:[3691248, { roh:0 }, 0, 0, 0, 23000, 0, 0, 0, 0, 0, 49990] },
    ] }, storeCfg));
  const server = await buehne.starteRegisterbildServer(store);
  const lesungen = []; const befunde = []; const gesendet = [];
  let txid = 0; let jetzt = Date.parse('2026-09-23T10:00:00Z');
  const io = {
    binding:bindung(),
    readModbus:async ({ start, count, source_kind, target, funktionscode }) => {
      const fc = modbusFunktionscode(source_kind, funktionscode);
      lesungen.push({ start, count, fc, target:target.key });
      return liesUeberModbus(server.port, { fc, addr:start, count, txid:(txid = (txid + 1) & 0xffff) });
    },
    sourceStatus:(beleg) => befunde.push(beleg),
  };
  const runtime = new MeasurementRuntime(io, (topic, payload) => gesendet.push({ topic, payload }),
    () => new Date(jetzt));
  const weiter = () => { jetzt += 60000; };
  return { store, server, runtime, lesungen, befunde, gesendet, weiter };
}

const samplesVon = (gesendet) => gesendet.filter((m) => m.topic === 'edge/measurements/samples')
  .flatMap((m) => m.payload.samples);

test('ein 495-Punkt wird gelesen - FC und Adresse aus dem Registerbild, nie Adresse 0',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      const plan = b.runtime.apply(konfiguration());
      assert.strictEqual(plan.applied, true);
      assert.deepStrictEqual(plan.accepted,
        ['wago.pm495.karte[1].frequency', 'wago.pm495.karte[1].energy_import_total']);
      // Die 750-494 bleibt ohne belegten Datentyp unlesbar (Befund 4) - auch MIT Registerbild.
      // Kein 495-Punkt faellt mehr als driver_unavailable.
      assert.deepStrictEqual(plan.rejected.map((r) => [r.point_key, r.reason]),
        [['wago.pm494.karte[0].power_l1', 'unknown_point']]);
      await b.runtime.tick();
      // 12 + 2 · 42 = 96 Woerter = EINE Anfrage ab der Basisadresse mit FC 4.
      assert.deepStrictEqual(b.lesungen, [{ start:4096, count:96, fc:4, target:`source:${PIN}` }]);
      assert.strictEqual(b.server.state.ausnahmen, 0);
      assert.ok(b.lesungen.every((l) => l.start >= ANLAGE.basisadresse));
      const samples = samplesVon(b.gesendet);
      const frequenz = samples.find((s) => s.point_key === 'wago.pm495.karte[1].frequency');
      assert.strictEqual(frequenz.decoded, 49.99);
      assert.strictEqual(frequenz.quality, 'good');
      assert.strictEqual(frequenz.entity_id, KARTE_495);
      // Die Umrechnung des Zaehlerstands haengt am Messbereich (conditional_factor): die Box
      // liefert den Rohwert in Wortfolge des Drahts und erfindet keinen Faktor.
      const zaehler = samples.find((s) => s.point_key === 'wago.pm495.karte[1].energy_import_total');
      assert.strictEqual(zaehler.decoded, undefined);
      assert.strictEqual(zaehler.raw, '52f00038'); // 3 691 248 = 0x0038_52F0, little
      assert.ok(!b.befunde.some((x) => x.failed), JSON.stringify(b.befunde));
    } finally { await b.server.close(); }
  });

test('ohne Registerbild wird kein 495-Punkt gelesen - driver_unavailable, kein Lesen',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      const plan = b.runtime.apply(konfiguration({ mitRegisterbild:false }));
      assert.deepStrictEqual(plan.rejected.map((r) => [r.point_key, r.reason]), [
        ['wago.pm495.karte[1].frequency', 'driver_unavailable'],
        ['wago.pm495.karte[1].energy_import_total', 'driver_unavailable'],
        ['wago.pm494.karte[0].power_l1', 'unknown_point'],
      ]);
      await b.runtime.tick();
      assert.deepStrictEqual(b.lesungen, []);
      assert.strictEqual(b.server.state.anfragen, 0);
    } finally { await b.server.close(); }
  });

test('Kopfpruefung im Laufzeitweg: ein fremdes Registerbild liefert keinen Kartenwert',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen({ hauptversion:2 });
    try {
      b.runtime.apply(konfiguration());
      await b.runtime.tick();
      assert.strictEqual(b.lesungen.length, 1);
      assert.deepStrictEqual(samplesVon(b.gesendet), []);
      // Der Befund faehrt auf dem Findings-Weg der Quelle als layout_changed (IP-7).
      assert.ok(b.befunde.some((x) => x.failed && x.error_class === 'layout_changed'));
    } finally { await b.server.close(); }
  });

test('ein anderes Soll (Karte umgesteckt) liefert keinen Wert dieser Karte', { skip:!buehneDa },
  async () => {
    const b = await aufbauen();
    try {
      const cfg = konfiguration();
      cfg.registerbilder = [registerbild({ karten:[KARTEN[0], { ...KARTEN[1], steckplatz:4 }] })];
      b.runtime.apply(cfg);
      await b.runtime.tick();
      assert.deepStrictEqual(samplesVon(b.gesendet), []);
    } finally { await b.server.close(); }
  });

test('stehender Herzschlag macht die Werte stale, ein Ruecksprung meldet device_restart',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      b.runtime.apply(konfiguration());
      const qualitaet = [];
      for (let i = 0; i < 5; i++) {
        const vorher = b.gesendet.length;
        await b.runtime.tick(); b.weiter();
        const frequenz = samplesVon(b.gesendet.slice(vorher))
          .find((s) => s.point_key === 'wago.pm495.karte[1].frequency');
        qualitaet.push(frequenz.quality);
      }
      // HerzschlagWacht zaehlt stehende Uebergaenge (STEHT_AB = 3): stale ab der vierten Lesung.
      assert.deepStrictEqual(qualitaet, ['good', 'good', 'good', 'stale', 'stale']);
      assert.ok(b.gesendet.some((m) => m.topic === 'edge/events'
        && m.payload.art === 'frozen_source' && m.payload.datenquelle === DATENQUELLE));
      // Herzschlag 100 -> 10: kein Ueberlauf (Abstand > 120), das Programm ist neu angelaufen.
      b.store.herzschlagTick(0x10000 - 90);
      await b.runtime.tick();
      const ruecksprung = b.gesendet.find((m) => m.topic === 'edge/events'
        && m.payload.art === 'device_restart');
      assert.ok(ruecksprung, 'device_restart');
      assert.strictEqual(ruecksprung.payload.datenquelle, DATENQUELLE);
    } finally { await b.server.close(); }
  });

test('ohne Variante und Controller-Kennung wird gelesen - Steckplatz und Kartentyp pruefen weiter',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      // So sendet die api heute (Entscheid firstmate B): das Soll kennt Steckplatz und Typ.
      const ohneSoll = registerbild({ karten:KARTEN.map(({ steckplatz, kartentyp }) =>
        ({ steckplatz, kartentyp })) });
      delete ohneSoll.controller_kennung;
      const cfg = konfiguration(); cfg.registerbilder = [ohneSoll];
      b.runtime.apply(cfg);
      await b.runtime.tick();
      const frequenz = samplesVon(b.gesendet)
        .find((s) => s.point_key === 'wago.pm495.karte[1].frequency');
      assert.strictEqual(frequenz.decoded, 49.99);
      // Ein falscher Kartentyp bleibt ein Aufbau-Befund: kein Wert.
      const b2 = await aufbauen();
      try {
        const falsch = registerbild({ karten:[{ steckplatz:2, kartentyp:494 },
          { steckplatz:3, kartentyp:494 }] });
        const cfg2 = konfiguration(); cfg2.registerbilder = [falsch];
        b2.runtime.apply(cfg2);
        await b2.runtime.tick();
        assert.deepStrictEqual(samplesVon(b2.gesendet), []);
      } finally { await b2.server.close(); }
    } finally { await b.server.close(); }
  });

test('Registerbilder je Ziel: unbekannte Komponente und Doppelbelegung werden verworfen', () => {
  const b = bindung();
  const eins = registerbilderJeZiel([registerbild()], b);
  assert.deepStrictEqual(Object.keys(eins), [`source:${PIN}`]);
  assert.strictEqual(eins[`source:${PIN}`].funktionscode, 4);
  assert.deepStrictEqual(eins[`source:${PIN}`].soll.karten.map((k) => k.steckplatz), [2, 3]);
  // Eine Komponente, die diese Box nicht kennt: kein Ziel, kein Registerbild - nie das primaere.
  assert.deepStrictEqual(registerbilderJeZiel([registerbild({ entity_id:'00000000-0000-0000-0000-0000000000ff' })], b), {});
  // Zwei Registerbilder auf DEMSELBEN Ziel: die Box raet nicht, welches gilt.
  assert.deepStrictEqual(registerbilderJeZiel([registerbild(),
    registerbild({ entity_id:KARTE_495, basisadresse:0 })], b), {});
  // Heutige Konfiguration ohne das Feld: nichts.
  assert.deepStrictEqual(registerbilderJeZiel(undefined, b), {});
});

test('readModbus: FC aus dem Registerbild, jede andere Quelle wie bisher', () => {
  assert.strictEqual(modbusFunktionscode('wago_registerbild', 4), 4);
  assert.strictEqual(modbusFunktionscode('wago_registerbild', 3), 3);
  assert.throws(() => modbusFunktionscode('wago_registerbild', undefined), /Funktionscode/);
  assert.strictEqual(modbusFunktionscode('modbus_input', 4), 4);
  assert.strictEqual(modbusFunktionscode('modbus_holding', 4), 3);
  assert.strictEqual(modbusFunktionscode('sunspec_model'), 3);
});

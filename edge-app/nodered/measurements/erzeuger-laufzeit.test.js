'use strict';

/**
 * Das Erzeuger-Bild im Laufzeitweg der Box (EZ-5), Ende zu Ende: die Wunsch-Konfiguration traegt
 * `erzeuger_registerbilder` (mqtt-measurement-config 2.0, additiv, Form der Cloud aus EZ-6),
 * `MeasurementRuntime.apply` reicht sie
 * je Ziel an den Planer, `readModbus` faehrt Funktionscode und Adresse aus dem Bild ueber den
 * ECHTEN Modbus-Weg (`modbus-tcp.js` gegen den In-Process-Server der WAGO-Buehne), die Stufe
 * urteilt je Steuerung, die Melde-Regel entscheidet je Wert, die Ereignisse gehen auf `edge/events`.
 *
 * Die Punkte sind die der Katalogfamilie `voltpilot.erzeuger_registerbild_v1` (EZ-6) im
 * Box-Katalog des Laufzeitstands 2026.10.21.1.
 *
 * ⚠ Simulator, kein Beleg: nichts hier sagt, dass eine echte Steuerung sich so verhaelt.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { MeasurementRuntime } = require('./measurement-runtime');
const { catalogDocument } = require('./measurement-driver');
const { buildReadRequest, parseReadResponse } = require('../modbus-tcp');
const { modbusFunktionscode } = require('../vp-palette/nodes/vp-measurements');
const bilder = require('./testdata/erzeuger-bilder');

const BUEHNE = path.join(__dirname, '..', 'vp-palette', 'test', 'fixtures',
  'wago-registerbild-store.js');
const buehneDa = fs.existsSync(BUEHNE);

const STEUERUNG = '00000000-0000-0000-0000-0000000e2001';
const DATENQUELLE = '00000000-0000-0000-0000-0000000d2001';
const PIN = 'gore-sps';

function bindung() {
  return { entities:{ [STEUERUNG]:{ entity_id:STEUERUNG, entity_type:'anlagensteuerung',
    edge_source_id:PIN, data_source_id:DATENQUELLE } },
  sources:{ [PIN]:{ connection:{ ip:'127.0.0.1' } } } };
}

const PUNKTE = ['erzeuger.a.p_erzeugung_w', 'erzeuger.a.p_nvp_w', 'erzeuger.a.anlage_zustand',
  'erzeuger.nb.n_p_prozent', 'erzeuger.nb.n_zaehler', 'erzeuger.wirkung.quelle_p',
  'erzeuger.te[1].t_p_ist_w', 'erzeuger.te[3].t_zustand', 'erzeuger.kopf.programmstand'];

/** Ein Eintrag von `erzeuger_registerbilder`, wie ihn der Publisher aus EZ-6 sendet. */
function erzeugerbild(ueberschreiben = {}) {
  return Object.assign({ entity_id:STEUERUNG, basisadresse:0, funktionscode:4, wortfolge:'big',
    te_anzahl:3, anlagenart:'pv', steuerung_kennung:4711, veraltet_netzpunkt_s:30 }, ueberschreiben);
}

function konfiguration({ mitBild = true, bild = {}, punkte = PUNKTE, revision = 1, cadence = 60 } = {}) {
  return { schema_version:'2.0', revision, catalog_version:catalogDocument.catalog_version,
    selections:punkte.map((point_key) => ({ point_key, cadence_s:cadence, entity_id:STEUERUNG })),
    ...(mitBild ? { erzeuger_registerbilder:[erzeugerbild(bild)] } : {}) };
}

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

async function aufbauen(woerter = bilder.gore()) {
  const buehne = require(BUEHNE);
  const store = bilder.store(woerter);
  const server = await buehne.starteRegisterbildServer(store);
  const lesungen = []; const befunde = []; const gesendet = [];
  let txid = 0; let jetzt = Date.parse('2026-10-21T20:00:00Z'); let herzschlag = 1000;
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
  // Die Steuerung laeuft: der Herzschlag zaehlt +1 je s mit der Zeit.
  const weiter = (ms = 5000, { laeuft = true } = {}) => {
    jetzt += ms;
    if (laeuft) { herzschlag = (herzschlag + Math.round(ms / 1000)) & 0xffff; store.setze(6, herzschlag); }
  };
  const runde = async (ms, optionen) => {
    weiter(ms, optionen);
    const vorher = gesendet.length;
    await runtime.tick();
    return gesendet.slice(vorher);
  };
  return { store, server, runtime, lesungen, befunde, gesendet, weiter, runde };
}

const samplesVon = (nachrichten) => nachrichten.filter((m) => m.topic === 'edge/measurements/samples')
  .flatMap((m) => m.payload.samples);
const nach = (samples, key) => samples.find((s) => s.point_key === key);

test('Gore: EINE Anfrage fuer 68 Woerter mit FC 4, Werte mit Komponente',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      const plan = b.runtime.apply(konfiguration());
      assert.strictEqual(plan.applied, true);
      assert.deepStrictEqual(plan.accepted, PUNKTE);
      assert.deepStrictEqual(plan.rejected, []);
      // 12 Anfragen je Minute (alle 5 s eine), 400 ms je Anfrage = 8 % Buszeit (Konzept §4.3).
      assert.strictEqual(plan.metrics.requestsPerMinute, 12);
      assert.strictEqual(Math.round(plan.metrics.dutyPercent * 1000) / 1000, 8);
      // cadence_s ist der laengste Abstand zweier Werte: geplant wird je Punkt ein Wert je Minute.
      assert.strictEqual(plan.metrics.samplesPerMinute, PUNKTE.length);
      await b.runtime.tick();
      // Nur das laufende Bild - die Namen ab 140 sind keine Messpunkte (EZ-6), sie liest die Probe.
      assert.deepStrictEqual(b.lesungen, [{ start:0, count:68, fc:4, target:`source:${PIN}` }]);
      assert.strictEqual(b.server.state.ausnahmen, 0);
      const samples = samplesVon(b.gesendet);
      assert.deepStrictEqual(nach(samples, 'erzeuger.a.p_erzeugung_w'),
        { point_key:'erzeuger.a.p_erzeugung_w', raw:182400, decoded:182400, quality:'good', entity_id:STEUERUNG });
      assert.strictEqual(nach(samples, 'erzeuger.a.p_nvp_w').decoded, -1200);
      assert.strictEqual(nach(samples, 'erzeuger.nb.n_p_prozent').decoded, 60);
      assert.strictEqual(nach(samples, 'erzeuger.wirkung.quelle_p').decoded, 1);
      assert.strictEqual(nach(samples, 'erzeuger.te[3].t_zustand').decoded, 3);
      assert.strictEqual(nach(samples, 'erzeuger.kopf.programmstand').decoded, 2610);
      assert.strictEqual(samples.length, PUNKTE.length);
      assert.ok(!b.befunde.some((x) => x.failed), JSON.stringify(b.befunde));
      assert.ok(b.befunde.some((x) => x.requests === 1 && x.target.dataSourceId === DATENQUELLE));
    } finally { await b.server.close(); }
  });

test('alle 5 s gelesen, gesendet nur bei Aenderung ueber dem Totband - spaetestens nach cadence_s',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      b.runtime.apply(konfiguration());
      await b.runtime.tick();
      b.lesungen.length = 0;
      // Nichts bewegt sich: gelesen wird, gesendet nicht.
      assert.deepStrictEqual(samplesVon(await b.runde(5000)), []);
      assert.deepStrictEqual(b.lesungen, [{ start:0, count:68, fc:4, target:`source:${PIN}` }]);
      // 300 W liegen im Totband (500 W), 2 kW nicht.
      bilder.woerterVon('S32', 182700, 'big').forEach((w, i) => b.store.setze(16 + i, w));
      assert.deepStrictEqual(samplesVon(await b.runde(5000)), []);
      bilder.woerterVon('S32', 184700, 'big').forEach((w, i) => b.store.setze(16 + i, w));
      assert.deepStrictEqual(samplesVon(await b.runde(5000)).map((s) => [s.point_key, s.decoded]),
        [['erzeuger.a.p_erzeugung_w', 184700]]);
      // Ein Zustand meldet jede Aenderung - der Netzbetreiber gibt ab, der Direktvermarkter regelt.
      b.store.setze(34, 2);
      assert.deepStrictEqual(samplesVon(await b.runde(5000)).map((s) => [s.point_key, s.decoded]),
        [['erzeuger.wirkung.quelle_p', 2]]);
      // Ein Zaehler wartet auf seinen Takt, auch wenn er sich bewegt.
      b.store.setze(27, 18);
      assert.deepStrictEqual(samplesVon(await b.runde(5000)), []);
      // 60 s nach seiner letzten Meldung geht jeder Wert noch einmal (Runde bei 65 s). Was bei 15 s
      // und 20 s ging, folgt bei 75 s und 80 s.
      const frisch = ['erzeuger.a.p_erzeugung_w', 'erzeuger.wirkung.quelle_p'];
      const spaeter = samplesVon(await b.runde(40000));
      assert.deepStrictEqual(spaeter.map((s) => s.point_key).sort(), PUNKTE.filter((p) => !frisch.includes(p))
        .sort());
      assert.strictEqual(nach(spaeter, 'erzeuger.nb.n_zaehler').decoded, 18);
      assert.deepStrictEqual(samplesVon(await b.runde(10000)).map((s) => s.point_key), [frisch[0]]);
      assert.deepStrictEqual(samplesVon(await b.runde(5000)).map((s) => s.point_key), [frisch[1]]);
      assert.ok(b.lesungen.every((l) => l.start === 0 && l.count === 68), JSON.stringify(b.lesungen));
    } finally { await b.server.close(); }
  });

test('die Vorlage erzeuger.te[*] liest genau die Einheiten des Solls', { skip:!buehneDa }, async () => {
  const b = await aufbauen();
  try {
    const plan = b.runtime.apply(konfiguration({ punkte:['erzeuger.te[*].t_p_ist_w'] }));
    assert.deepStrictEqual(plan.accepted, ['erzeuger.te[*].t_p_ist_w']);
    await b.runtime.tick();
    assert.deepStrictEqual(samplesVon(b.gesendet).map((s) => [s.point_key, s.decoded]),
      [['erzeuger.te[1].t_p_ist_w', 60900], ['erzeuger.te[2].t_p_ist_w', 61000], ['erzeuger.te[3].t_p_ist_w', 61100]]);
  } finally { await b.server.close(); }
});

test('eine andere Anlagenart als im Soll liefert keinen Wert - ein unbekanntes Wort kein Bild', { skip:!buehneDa },
  async () => {
    const b = await aufbauen();
    try {
      b.runtime.apply(konfiguration({ bild:{ anlagenart:'bhkw' }, punkte:['erzeuger.a.anlage_zustand'] }));
      await b.runtime.tick();
      assert.deepStrictEqual(samplesVon(b.gesendet), []);
      assert.ok(b.befunde.some((x) => x.failed && x.error_class === 'layout_changed'));
      const fremd = b.runtime.apply(konfiguration({ revision:2, bild:{ anlagenart:'wind' },
        punkte:['erzeuger.a.anlage_zustand'] }));
      assert.deepStrictEqual(fremd.rejected.map((r) => r.reason), ['driver_unavailable']);
    } finally { await b.server.close(); }
  });

test('Herzschlag steht: ab der dritten Lesung stale, frozen_source EINMAL auf edge/events',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      b.runtime.apply(konfiguration({ punkte:['erzeuger.a.anlage_zustand'] }));
      await b.runtime.tick();
      await b.runde(5000, { laeuft:false });
      const dritte = await b.runde(5000, { laeuft:false });
      assert.deepStrictEqual(samplesVon(dritte).map((s) => [s.point_key, s.quality]),
        [['erzeuger.a.anlage_zustand', 'stale']]);
      const ereignisse = dritte.filter((m) => m.topic === 'edge/events').map((m) => m.payload);
      assert.deepStrictEqual(ereignisse, [{ art:'frozen_source', zeitpunkt:'2026-10-21T20:00:10Z',
        datenquelle:DATENQUELLE, komponente:STEUERUNG, lesungen:3, herzschlag:1000 }]);
      const vierte = await b.runde(5000, { laeuft:false });
      assert.deepStrictEqual(vierte.filter((m) => m.topic === 'edge/events'), []);
      // Das Programm startet neu: device_restart, die Werte sind wieder gut.
      b.store.setze(6, 3);
      const neu = await b.runde(5000, { laeuft:false });
      assert.deepStrictEqual(neu.filter((m) => m.topic === 'edge/events').map((m) => m.payload.art),
        ['device_restart']);
      assert.deepStrictEqual(samplesVon(neu).map((s) => s.quality), ['good']);
    } finally { await b.server.close(); }
  });

test('ohne Erzeuger-Bild kein Lesen - driver_unavailable, auch fuer eine Einheit, die das Soll nicht hat',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      const ohne = b.runtime.apply(konfiguration({ mitBild:false, punkte:['erzeuger.a.anlage_zustand'] }));
      assert.deepStrictEqual(ohne.rejected.map((r) => [r.point_key, r.reason]),
        [['erzeuger.a.anlage_zustand', 'driver_unavailable']]);
      const plan = b.runtime.apply(konfiguration({ revision:2,
        punkte:['erzeuger.a.anlage_zustand', 'erzeuger.te[4].t_p_ist_w', 'erzeuger.te[11].t_p_ist_w'] }));
      assert.deepStrictEqual(plan.rejected.map((r) => [r.point_key, r.reason]),
        [['erzeuger.te[4].t_p_ist_w', 'driver_unavailable'], ['erzeuger.te[11].t_p_ist_w', 'driver_unavailable']]);
      await b.runtime.tick();
      assert.ok(b.lesungen.every((l) => l.count === 68));
      // Unter 5 s gibt es keine Erzeuger-Kadenz.
      const schnell = b.runtime.apply(konfiguration({ revision:3, cadence:2, punkte:['erzeuger.a.anlage_zustand'] }));
      assert.deepStrictEqual(schnell.rejected.map((r) => r.reason), ['invalid_cadence']);
    } finally { await b.server.close(); }
  });

test('Soll weicht ab (3 statt 2 Einheiten): kein Wert, Befund layout_changed - nichts umgehaengt',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      b.runtime.apply(konfiguration({ bild:{ te_anzahl:2 }, punkte:['erzeuger.a.anlage_zustand'] }));
      await b.runtime.tick();
      assert.deepStrictEqual(b.lesungen, [{ start:0, count:58, fc:4, target:`source:${PIN}` }]);
      assert.deepStrictEqual(samplesVon(b.gesendet), []);
      assert.ok(b.befunde.some((x) => x.failed && x.error_class === 'layout_changed'));
    } finally { await b.server.close(); }
  });

test('Lesefehler: keine Werte, der Quellenstatus meldet ihn - danach ist der naechste Wert der erste',
  { skip:!buehneDa }, async () => {
    const b = await aufbauen();
    try {
      b.runtime.apply(konfiguration({ punkte:['erzeuger.a.anlage_zustand'] }));
      await b.runtime.tick();
      // Die Steuerung antwortet mit einer Ausnahme (Adresse ausserhalb).
      const woerter = b.store.woerter;
      b.store.woerter = woerter.slice(0, 40);
      assert.deepStrictEqual(samplesVon(await b.runde(5000)), []);
      assert.ok(b.befunde.some((x) => x.failed && x.requests === 1), JSON.stringify(b.befunde));
      b.store.woerter = woerter;
      assert.deepStrictEqual(samplesVon(await b.runde(5000)).map((s) => s.point_key), ['erzeuger.a.anlage_zustand']);
    } finally { await b.server.close(); }
  });

test('zehn Einheiten: zwei Anfragen (118 + 20 Woerter), kein Block geteilt', { skip:!buehneDa }, async () => {
  const einheit = (n) => ({ t_zustand:2, t_bits:1, t_art:1, t_nenn_kw:10, t_p_ist_w:n * 1000 });
  const b = await aufbauen(bilder.baueBild({ kopf:{ steuerung_id:4711, anlagenart:1 },
    anlage:{ anlage_zustand:2 }, einheiten:Array.from({ length:10 }, (_, i) => einheit(i + 1)) }));
  try {
    const plan = b.runtime.apply(konfiguration({ bild:{ te_anzahl:10 },
      punkte:['erzeuger.te[8].t_p_ist_w', 'erzeuger.te[9].t_p_ist_w', 'erzeuger.te[10].t_p_ist_w'] }));
    assert.strictEqual(plan.metrics.requestsPerMinute, 24);
    await b.runtime.tick();
    assert.deepStrictEqual(b.lesungen.map((l) => [l.start, l.count]), [[0, 118], [118, 20]]);
    assert.deepStrictEqual(samplesVon(b.gesendet).map((s) => [s.point_key, s.decoded]),
      [['erzeuger.te[8].t_p_ist_w', 8000], ['erzeuger.te[9].t_p_ist_w', 9000], ['erzeuger.te[10].t_p_ist_w', 10000]]);
  } finally { await b.server.close(); }
});

test('readModbus: FC aus dem Erzeuger-Bild, ohne Funktionscode keine Lesung', () => {
  assert.strictEqual(modbusFunktionscode('erzeuger_registerbild', 4), 4);
  assert.strictEqual(modbusFunktionscode('erzeuger_registerbild', 3), 3);
  assert.throws(() => modbusFunktionscode('erzeuger_registerbild', undefined), /Funktionscode/);
  assert.strictEqual(modbusFunktionscode('modbus_holding', 4), 3);
});

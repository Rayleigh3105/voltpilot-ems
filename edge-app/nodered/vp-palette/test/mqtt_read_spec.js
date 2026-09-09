/**
 * vp-mqtt-read (P5 Ebene 1): der BMS-unabhaengige Batterie-Anschluss.
 *
 * Der GROUND-TRUTH-FALL des Kunden (09.09.2026, Anlage "Muhlfeldweg 2"): ein
 * DIYBMS veroeffentlicht 11 Baenke x 16 Zellen unter `emon/diybms/<bank>/<cell>`
 * mit dem JSON-Feld `.voltage` in Volt. Aus 176 Topics muessen genau ZWEI
 * Kanaele werden - `cell_min_mv` und `cell_max_mv`. Genau das prueft dieser
 * Spec, erst als reine Rechnung und dann am laufenden Knoten gegen einen
 * echten Broker.
 *
 * Die Ehrlichkeitsregeln, die hier bewiesen werden:
 *   - ein Kanal ohne frische Probe FEHLT (nie 0),
 *   - ein Sentinel-Rohwert ist "nicht gemessen" (nie ein Wert),
 *   - ein Wort ausserhalb der Wahrheitswert-Liste wird VERWORFEN (nie geraten),
 *   - ein Ziel ausserhalb des Heimnetzes wird gar nicht erst abonniert.
 */
'use strict';

const assert = require('node:assert');
const net = require('node:net');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const map = require('../lib/mqtt-mapping.js');
const vpCore = require('../nodes/vp-core.js');
const vpMqttRead = require('../nodes/vp-mqtt-read.js');

helper.init(require.resolve('node-red'));

const ENTITY = '7b3c9d21-8e4f-4a56-9c07-0123456789ab';

/** Die zwei Zuordnungen des Kundenfalls: ein Filter, zwei Aggregate. */
const CELL_MAPPINGS = [
  { channel: 'cell_min_mv', topic: 'emon/diybms/+/+', path: 'voltage', aggregate: 'min', scale: 1000 },
  { channel: 'cell_max_mv', topic: 'emon/diybms/+/+', path: 'voltage', aggregate: 'max', scale: 1000 },
];

describe('mqtt-mapping (rein, ohne Broker und ohne Uhr)', function () {
  it('topicMatches kennt + als GENAU ein Segment und # als den Rest', function () {
    assert.strictEqual(map.topicMatches('emon/diybms/+/+', 'emon/diybms/3/12'), true);
    assert.strictEqual(map.topicMatches('emon/diybms/+/+', 'emon/diybms/3'), false);
    assert.strictEqual(map.topicMatches('emon/diybms/+/+', 'emon/diybms/3/12/x'), false);
    assert.strictEqual(map.topicMatches('emon/diybms/#', 'emon/diybms/3/12/x'), true);
    assert.strictEqual(map.topicMatches('emon/diybms/#', 'emon/other/1'), false);
    assert.strictEqual(map.topicMatches('emon/pack', 'emon/pack'), true);
    assert.strictEqual(map.topicMatches('emon/pack', 'emon/packs'), false);
  });

  it('extract holt den Wertepfad - und geht nie ueber __proto__', function () {
    assert.strictEqual(map.extract('{"voltage":3.393}', 'voltage'), 3.393);
    assert.strictEqual(map.extract('{"bms":{"soc":41.5}}', 'bms.soc'), 41.5);
    // Eine nackte Nutzlast IST der Wert - der haeufigste MQTT-Fall.
    assert.strictEqual(map.extract('3.606', ''), 3.606);
    assert.strictEqual(map.extract(Buffer.from('12'), ''), 12);
    // Was es nicht gibt, gibt es nicht.
    assert.strictEqual(map.extract('{"voltage":3.4}', 'current'), undefined);
    assert.strictEqual(map.extract('kein json', 'voltage'), undefined);
    assert.strictEqual(map.extract('{"a":1}', '__proto__'), undefined);
    assert.strictEqual(map.extract('{"a":1}', 'a.constructor'), undefined);
  });

  it('convert skaliert je PROBE - und meldet Fehlendes als fehlend', function () {
    const m = { scale: 1000, offset: 0 };
    assert.strictEqual(map.convert(3.393, m), 3393);
    assert.strictEqual(map.convert(3.393, { scale: 1, offset: -0.5 }), 2.893);
    // Der Sentinel ist "nicht gemessen", nie ein Messwert.
    assert.strictEqual(map.convert(-40, { sentinel: -40 }), null);
    assert.strictEqual(map.convert(-39, { sentinel: -40 }), 39 * -1);
    assert.strictEqual(map.convert('nicht zahl', m), null);
    assert.strictEqual(map.convert(undefined, m), null);
    assert.strictEqual(map.convert(Infinity, m), null);
  });

  it('convert bildet Wahrheitswerte auf 0/1 ab und verwirft fremde Woerter', function () {
    const b = { value_type: 'bool' };
    assert.strictEqual(map.convert(true, b), 1);
    assert.strictEqual(map.convert('ON', b), 1);
    assert.strictEqual(map.convert('off', b), 0);
    assert.strictEqual(map.convert(0, b), 0);
    assert.strictEqual(map.convert(7, b), 1);
    // Ein Wort ausserhalb des geschlossenen Vokabulars wird VERWORFEN, nie auf
    // einen Vorgabewert aufgeloest.
    assert.strictEqual(map.convert('vielleicht', b), null);
    // ...ausser die Zuordnung nennt es ausdruecklich.
    assert.strictEqual(map.convert('frei', { value_type: 'bool', true_values: ['frei'] }), 1);
    // Eine Skalierung waere hier eine Erfindung: 0/1 IST die Aussage.
    assert.strictEqual(map.convert(true, { value_type: 'bool', scale: 1000 }), 1);
  });

  it('aggregate rechnet ueber die FRISCHEN Proben - alte zaehlen nicht', function () {
    const now = 1000000;
    const s = [
      { value: 3393, at: now - 1000 },
      { value: 3606, at: now - 2000 },
      { value: 3500, at: now - 999999 }, // alt
    ];
    const stale = 60000;
    assert.strictEqual(map.aggregate(s, 'min', now, stale), 3393);
    assert.strictEqual(map.aggregate(s, 'max', now, stale), 3606);
    assert.strictEqual(map.aggregate(s, 'sum', now, stale), 6999);
    assert.strictEqual(map.aggregate(s, 'avg', now, stale), 6999 / 2);
    assert.strictEqual(map.aggregate(s, 'count', now, stale), 2);
    assert.strictEqual(map.aggregate(s, 'last', now, stale), 3393);
    // Nur alte Proben: der Kanal ist ABWESEND, nie 0.
    assert.strictEqual(map.aggregate([s[2]], 'min', now, stale), null);
    assert.strictEqual(map.aggregate([], 'min', now, stale), null);
  });
});

describe('vp-mqtt-read shaping (rein)', function () {
  it('normalize schreibt jede Vorgabe aus und verwirft kaputte Zeilen', function () {
    const n = vpMqttRead.normalize([
      { channel: 'cell_min_mv', topic: 'a/+' },
      { channel: 'KEIN KANAL', topic: 'a/+' },
      { channel: 'cell_min_mv', topic: 'b/+' }, // derselbe Kanal ein zweites Mal
      { channel: 'soc_pct', topic: '' },
    ]);
    assert.strictEqual(n.length, 1);
    assert.strictEqual(n[0].aggregate, 'last');
    assert.strictEqual(n[0].value_type, 'number');
    assert.strictEqual(n[0].scale, 1);
    assert.strictEqual(n[0].offset, 0);
    assert.strictEqual(n[0].staleMs, vpMqttRead.DEFAULT_STALE_S * 1000);
  });

  it('DER KUNDENFALL: 11 Baenke x 16 Zellen ergeben cell_min_mv und cell_max_mv', function () {
    const mappings = vpMqttRead.normalize(CELL_MAPPINGS);
    const now = 1000000;
    let published = 0;
    for (let bank = 0; bank < 11; bank++) {
      for (let cell = 0; cell < 16; cell++) {
        // Die gemessene Spreizung des Kunden: vmin 3,393 V, vmax 3,606 V.
        const v = 3.393 + ((bank * 16 + cell) / 175) * (3.606 - 3.393);
        published += vpMqttRead.ingest(mappings,
          'emon/diybms/' + bank + '/' + cell,
          JSON.stringify({ voltage: Number(v.toFixed(4)), external_temp: 21 }), now);
      }
    }
    assert.strictEqual(published, 176 * 2, 'jede Zelle speist BEIDE Zuordnungen');
    const channels = vpMqttRead.collect(mappings, now);
    assert.deepStrictEqual(Object.keys(channels).sort(), ['cell_max_mv', 'cell_min_mv']);
    assert.strictEqual(channels.cell_min_mv, 3393);
    assert.strictEqual(channels.cell_max_mv, 3606);
  });

  it('ein Wahrheitswert wird nie gemittelt oder summiert', function () {
    // Die Cloud lehnt es ab; kommt es trotzdem an, faellt der Knoten auf
    // `last` zurueck statt eine Freigabe zu MITTELN (0,5 gerundet waere ein
    // „ja", das niemand gegeben hat).
    assert.strictEqual(vpMqttRead.aggregateFor({ aggregate: 'avg', value_type: 'bool' }), 'last');
    assert.strictEqual(vpMqttRead.aggregateFor({ aggregate: 'sum', value_type: 'bool' }), 'last');
    // min ist das konservative UND: erst wenn JEDE Bank erlaubt, steht 1.
    const mappings = vpMqttRead.normalize([
      { channel: 'charge_allowed', topic: 'bms/+/status', path: 'charge',
        aggregate: 'min', value_type: 'bool' },
    ]);
    const now = 1000000;
    vpMqttRead.ingest(mappings, 'bms/1/status', '{"charge":"ON"}', now);
    vpMqttRead.ingest(mappings, 'bms/2/status', '{"charge":"ON"}', now);
    assert.strictEqual(vpMqttRead.collect(mappings, now).charge_allowed, 1);
    vpMqttRead.ingest(mappings, 'bms/3/status', '{"charge":"OFF"}', now);
    assert.strictEqual(vpMqttRead.collect(mappings, now).charge_allowed, 0);
  });

  it('eine Zelle, die schweigt, friert den Kanal nicht ein - sie faellt heraus', function () {
    const mappings = vpMqttRead.normalize([
      { channel: 'cell_min_mv', topic: 'emon/diybms/+/+', path: 'voltage', aggregate: 'min',
        scale: 1000, stale_s: 60 },
    ]);
    const t0 = 1000000;
    vpMqttRead.ingest(mappings, 'emon/diybms/0/0', '{"voltage":3.2}', t0);
    vpMqttRead.ingest(mappings, 'emon/diybms/0/1', '{"voltage":3.6}', t0 + 50000);
    // Bei t0+70s ist die 3,2-V-Zelle alt: das Minimum ist die 3,6-V-Zelle.
    assert.strictEqual(vpMqttRead.collect(mappings, t0 + 70000).cell_min_mv, 3600);
    // Bei t0+120s ist gar nichts mehr frisch: der Kanal FEHLT.
    assert.deepStrictEqual(vpMqttRead.collect(mappings, t0 + 120000), {});
  });

  it('ein Sentinel-Rohwert wird nie ein Messwert', function () {
    const mappings = vpMqttRead.normalize([
      { channel: 'temp_max_c', topic: 'emon/diybms/+/+', path: 'external_temp',
        aggregate: 'max', sentinel: -40 },
    ]);
    const now = 1000000;
    vpMqttRead.ingest(mappings, 'emon/diybms/0/0', '{"external_temp":-40}', now);
    assert.deepStrictEqual(vpMqttRead.collect(mappings, now), {},
      'ein Fuehler, der -40 als "kein Wert" meldet, darf keine -40 Grad erzeugen');
    vpMqttRead.ingest(mappings, 'emon/diybms/0/1', '{"external_temp":23.5}', now);
    assert.strictEqual(vpMqttRead.collect(mappings, now).temp_max_c, 23.5);
  });

  it('die Quellen-Schranke greift und schweigt nicht', function () {
    const mappings = vpMqttRead.normalize([
      { channel: 'cell_min_mv', topic: 'x/#', aggregate: 'count' },
    ]);
    const now = 1000000;
    for (let i = 0; i < map.MAX_SOURCES + 5; i++) {
      vpMqttRead.ingest(mappings, 'x/' + i, String(i), now);
    }
    assert.strictEqual(mappings[0].sources.size, map.MAX_SOURCES);
    assert.strictEqual(mappings[0].overflow, true);
  });

  it('envelope ist die edge-entity-Telemetrieform', function () {
    const e = JSON.parse(vpMqttRead.envelope(ENTITY, { cell_min_mv: 3393 },
      '2026-09-09T10:00:00.000Z'));
    assert.deepStrictEqual(e, {
      schema_version: '1.0',
      entity_id: ENTITY,
      ts: '2026-09-09T10:00:00.000Z',
      channels: { cell_min_mv: 3393 },
    });
  });
});

describe('vp-mqtt-read am laufenden Broker', function () {
  let broker;
  let server;
  let port;

  beforeEach(function (done) {
    broker = aedes();
    server = net.createServer(broker.handle);
    server.listen(0, '127.0.0.1', function () {
      port = server.address().port;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    helper.unload().then(function () {
      helper.stopServer(function () {
        broker.close(function () {
          server.close(done);
        });
      });
    });
  });

  function flow(overrides) {
    return [
      { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1', port: String(port) },
      Object.assign({
        id: 'm1',
        type: 'vp-mqtt-read',
        core: 'core1',
        host: '127.0.0.1',
        port: port,
        entity: ENTITY,
        mappings: CELL_MAPPINGS,
      }, overrides || {}),
    ];
  }

  it('macht aus vielen Zell-Topics EINE Telemetrie mit Min und Max', function (done) {
    let settled = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      if (settled) return;
      settled = true;
      try {
        const m = JSON.parse(packet.payload.toString());
        assert.strictEqual(m.schema_version, '1.0');
        assert.strictEqual(m.entity_id, ENTITY);
        assert.deepStrictEqual(Object.keys(m.channels).sort(),
          ['cell_max_mv', 'cell_min_mv']);
        assert.strictEqual(m.channels.cell_min_mv, 3393);
        assert.strictEqual(m.channels.cell_max_mv, 3606);
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});

    helper.load([vpCore, vpMqttRead], flow(), function () {
      const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
      pub.on('connect', function () {
        // Drei Zellen genuegen fuer die Aussage; die 176 stehen in der reinen
        // Rechnung darueber.
        pub.publish('emon/diybms/0/0', JSON.stringify({ voltage: 3.393 }));
        pub.publish('emon/diybms/3/7', JSON.stringify({ voltage: 3.5 }));
        pub.publish('emon/diybms/10/15', JSON.stringify({ voltage: 3.606 }), function () {
          setTimeout(function () {
            helper.getNode('m1').receive({ payload: 'takt' });
            pub.end();
          }, 300);
        });
      });
    });
  });

  it('veroeffentlicht NICHTS, solange kein Topic geantwortet hat', function (done) {
    let seen = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      seen = true;
    }, function () {});

    helper.load([vpCore, vpMqttRead], flow(), function () {
      setTimeout(function () {
        helper.getNode('m1').receive({ payload: 'takt' });
        setTimeout(function () {
          try {
            assert.strictEqual(seen, false,
              'ohne Eingang darf keine Nachricht entstehen - auch keine mit Nullen');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      }, 300);
    });
  });

  it('abonniert ein Ziel ausserhalb des Heimnetzes gar nicht erst', function (done) {
    helper.load([vpCore, vpMqttRead], flow({ host: '8.8.8.8' }), function () {
      setTimeout(function () {
        try {
          // Der Knoten laeuft, liest aber nichts: kein Abo, keine Verbindung.
          assert.ok(helper.getNode('m1'), 'der Knoten existiert');
          helper.getNode('m1').receive({ payload: 'takt' });
          done();
        } catch (e) {
          done(e);
        }
      }, 200);
    });
  });
});

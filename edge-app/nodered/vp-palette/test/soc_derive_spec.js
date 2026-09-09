/**
 * vp-soc-derive (P5b Ebene 2): die SoC-ABLEITUNG der selbst angebundenen
 * Batterie.
 *
 * DER BELEG-FALL steht in `docs/contracts/v2/soc-derivation-vectors.json` und
 * wird hier PER PFAD gelesen, nicht abgeschrieben: die beiden OCV->SoC-Tabellen
 * sind verbatim der Home-Assistant-/Node-RED-Flow des Kunden (Ground Truth
 * 09.09.2026). Am Messtag stand der Pack bei vmin 3,393 V und vmax 3,606 V -
 * die Ladekurve auf der HOECHSTEN Zelle ergaebe 31,5 %, die Entladekurve auf
 * der NIEDRIGSTEN 7,3 %, und das KONSERVATIVE Minimum ist genau der Ladestand,
 * den der Kunde in HA sieht (und der Grund fuer seinen 'Boden ~8 %').
 *
 * Die Ehrlichkeitsregeln, die hier bewiesen werden:
 *   - kein Ladestand ohne EINGANG (weder Kennlinie noch Zaehlung erfinden ihn),
 *   - eine frische MESSUNG schlaegt jede Rechnung,
 *   - ein eingefrorener Wert bekommt NIE einen frischen Zeitstempel - er wird
 *     gar nicht erst erneut veroeffentlicht,
 *   - nach der Haltefrist ist er ABWESEND, und die Zaehlung braucht einen
 *     neuen Anker.
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const aedes = require('aedes');
const helper = require('node-red-node-test-helper');

const soc = require('../lib/soc-derivation.js');
const vpCore = require('../nodes/vp-core.js');
const vpSocDerive = require('../nodes/vp-soc-derive.js');

helper.init(require.resolve('node-red'));

const ENTITY = '7b3c9d21-8e4f-4a56-9c07-0123456789ab';

/** Die GETEILTEN Vektoren - gelesen, nie kopiert. */
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname,
  '../../../../docs/contracts/v2/soc-derivation-vectors.json'), 'utf8'));
const TEMPLATE = VECTORS.vorlage;

/** Die Konfiguration eines Falls aus den Vektoren. */
function cfgFor(fall) {
  return {
    method: fall.method,
    hold_s: 900,
    inputs: {},
    params: {
      curve_charge: TEMPLATE.curve_charge,
      curve_discharge: TEMPLATE.curve_discharge,
      cells_in_series: TEMPLATE.cells_in_series,
      conservative_min: fall.conservative_min !== false,
    },
  };
}

describe('soc-derivation (rein, ohne Broker und ohne Uhr)', function () {
  it('faehrt JEDEN geteilten Vektor durch die echte Rechnung', function () {
    for (const fall of VECTORS.faelle) {
      const got = soc.derive(fall.channels, cfgFor(fall), null, 1000000);
      if (fall.erwartet_soc_pct === null) {
        assert.ok(got.reason, fall.name + ': es darf KEINEN Ladestand geben');
        assert.strictEqual(got.soc_pct, undefined, fall.name + ': und keine Zahl');
        if (fall.erwartet_grund) {
          assert.strictEqual(got.reason, fall.erwartet_grund, fall.name + ': der Grund');
        }
        continue;
      }
      assert.strictEqual(got.soc_pct, fall.erwartet_soc_pct, fall.name);
      assert.strictEqual(got.source, fall.erwartet_source, fall.name + ': die Herkunft');
      assert.strictEqual(got.code, soc.SOURCE_CODES[fall.erwartet_source],
        fall.name + ': der Herkunfts-Code');
    }
  });

  it('der GEMESSENE Tag des Kunden: vmin 3,393 / vmax 3,606 -> konservativ 7,3 %', function () {
    // Die Kunden-Kurven gegen eine bekannte Vmin/Vmax - der Test, an dem die
    // ganze Methode haengt. Wuerde VoltPilot die HOECHSTE Zelle nehmen, stuende
    // hier 31,5 % und der Speicher waere scheinbar viermal so voll.
    const high = soc.socFromVoltage(3.606, TEMPLATE.curve_charge);
    const low = soc.socFromVoltage(3.393, TEMPLATE.curve_discharge);
    assert.strictEqual(soc.roundTo(high, 0.1), 31.5);
    assert.strictEqual(soc.roundTo(low, 0.1), 7.3);

    const got = soc.derive({ cell_min_mv: 3393, cell_max_mv: 3606 },
      cfgFor({ method: 'ocv_curve' }), null, 1000000);
    assert.strictEqual(got.soc_pct, 7.3, 'das konservative Minimum gewinnt');
    assert.strictEqual(got.source, 'berechnet:kennlinie');
    assert.strictEqual(got.code, 2);
  });

  it('klemmt ausserhalb der Kurve, statt zu extrapolieren', function () {
    // Eine Extrapolation ueber das Ende einer GEMESSENEN Kurve hinaus waere
    // eine erfundene Chemie - und ein Ladestand unter 0 bzw. ueber 100 %.
    assert.strictEqual(soc.socFromVoltage(2.0, TEMPLATE.curve_charge), 0);
    assert.strictEqual(soc.socFromVoltage(4.9, TEMPLATE.curve_charge), 100);
    assert.strictEqual(soc.socFromVoltage(3.26, TEMPLATE.curve_charge), 0);
    assert.strictEqual(soc.socFromVoltage(4.18, TEMPLATE.curve_charge), 100);
  });

  it('interpoliert LINEAR zwischen zwei Stuetzpunkten', function () {
    // Genau in der Mitte zwischen 3,60 V/30 % und 3,62 V/35 %.
    assert.strictEqual(soc.roundTo(soc.socFromVoltage(3.61, TEMPLATE.curve_charge), 0.1), 32.5);
  });

  it('nimmt eine Kurve in beliebiger Reihenfolge an - und rechnet gleich', function () {
    const shuffled = TEMPLATE.curve_discharge.slice().reverse();
    assert.strictEqual(soc.roundTo(soc.socFromVoltage(3.393, shuffled), 0.1), 7.3);
  });

  it('verwirft eine Kurve, die mit steigender Spannung FAELLT', function () {
    // Sie beschreibt keine Lithium-Zelle: ein Tippfehler mit Ergebnis.
    assert.strictEqual(soc.curve([[3.3, 60], [3.9, 10]]), null);
    assert.strictEqual(soc.curve([[3.3, 0]]), null, 'ein Punkt ist keine Kurve');
    assert.strictEqual(soc.curve([[9.9, 0], [10.1, 100]]), null, 'keine Zellspannung');
    assert.strictEqual(soc.curve([[3.3, 0], [3.9, 140]]), null, '140 % gibt es nicht');
  });

  it('EINE MESSUNG SCHLAEGT DIE RECHNUNG - und die Herkunft sagt es', function () {
    const cfg = cfgFor({ method: 'ocv_curve' });
    const got = soc.derive({ soc_pct: 42.0, cell_min_mv: 3393, cell_max_mv: 3606 },
      cfg, null, 1000000);
    assert.strictEqual(got.soc_pct, 42.0);
    assert.strictEqual(got.source, 'gemessen');
    assert.strictEqual(got.code, 1);

    // ⚠ UEBERNEHMEN heisst UEBERNEHMEN: derselbe Kanal traegt in derselben
    // Sekunde schon die ROHE Messung der Ebene 1. Wuerde die Ableitung sie
    // auch nur runden, stuenden zwei verschiedene Zahlen fuer denselben
    // Ladestand in derselben Sekunde in der Historie.
    const krumm = soc.derive({ soc_pct: 41.5347 }, cfgFor({ method: 'direct' }), null, 1000000);
    assert.strictEqual(krumm.soc_pct, 41.5347, 'kein Runden an einer Messung');

    // Nur der ausdrueckliche Vergleichsbetrieb schaltet die Praeferenz ab.
    cfg.prefer_direct = false;
    const rechnet = soc.derive({ soc_pct: 42.0, cell_min_mv: 3393, cell_max_mv: 3606 },
      cfg, null, 1000000);
    assert.strictEqual(rechnet.soc_pct, 7.3);
    assert.strictEqual(rechnet.source, 'berechnet:kennlinie');
  });

  it('die vereinfachte Variante: Packspannung geteilt durch die Zellzahl', function () {
    // 176 x 3,71 V = 652,96 V -> die Ladekurve sagt 50 %. Sie sieht die
    // SPREIZUNG nicht und ist deshalb nie die erste Wahl.
    const cfg = cfgFor({ method: 'ocv_curve' });
    const got = soc.derive({ voltage_v: 652.96 }, cfg, null, 1000000);
    assert.strictEqual(got.soc_pct, 50);
    assert.strictEqual(got.source, 'berechnet:kennlinie');
  });

  it('KEIN Ladestand ohne Eingang - weder Kennlinie noch Zaehlung erfinden ihn', function () {
    const ocv = soc.derive({ temp_max_c: 21.5 }, cfgFor({ method: 'ocv_curve' }), null, 1000);
    assert.strictEqual(ocv.soc_pct, undefined);
    assert.ok(/Zellspannung/.test(ocv.reason));

    const direct = soc.derive({ voltage_v: 612 }, cfgFor({ method: 'direct' }), null, 1000);
    assert.strictEqual(direct.soc_pct, undefined);

    // Die Zaehlung ohne Anker: eine Zahl, die bei einem geratenen Startwert
    // beginnt, ist eine Behauptung mit Nachkommastellen.
    const ohneAnker = soc.derive({ power_kw: 5 },
      { method: 'coulomb', params: { capacity_kwh: 40 } }, null, 1000);
    assert.strictEqual(ohneAnker.soc_pct, undefined);
    assert.ok(/Anker/.test(ohneAnker.reason));
  });

  it('die Ladungszaehlung zaehlt - ab dem Anker, geklemmt, mit Wirkungsgrad', function () {
    const cfg = {
      method: 'coulomb',
      hold_s: 900,
      params: { capacity_kwh: 40, anchor: { soc_pct: 50, at: '2026-09-09T10:00:00Z' } },
    };
    const t0 = 1000000;
    const start = soc.derive({ power_kw: 4 }, cfg, null, t0);
    assert.strictEqual(start.soc_pct, 50, 'der Anker IST der Startpunkt');
    assert.strictEqual(start.source, 'berechnet:ladungszaehlung');
    assert.strictEqual(start.code, 3);

    // 6 Minuten (0,1 h) bei 4 kW Laden = 0,4 kWh auf 40 kWh nutzbar = +1 Punkt.
    const spaeter = soc.derive({ power_kw: 4 }, cfg, start.state, t0 + 360000);
    assert.strictEqual(spaeter.soc_pct, 51);

    // Entladen zaehlt rueckwaerts, und die Klemmung haelt bei 0.
    const leer = soc.derive({ power_kw: -400 }, cfg, spaeter.state, t0 + 720000);
    assert.strictEqual(leer.soc_pct, 0, 'unter 0 gibt es keinen Speicher');
  });

  it('der Wirkungsgrad daempft die LADE-Seite, nicht beide', function () {
    const cfg = {
      method: 'coulomb',
      hold_s: 900,
      params: { capacity_kwh: 40, efficiency_pct: 90, anchor: { soc_pct: 50 } },
    };
    const t0 = 1000000;
    const start = soc.derive({ power_kw: 4 }, cfg, null, t0);
    const laden = soc.derive({ power_kw: 4 }, cfg, start.state, t0 + 360000);
    assert.strictEqual(laden.soc_pct, 50.9, '1 Punkt x 0,9');
    const entladen = soc.derive({ power_kw: -4 }, cfg, start.state, t0 + 360000);
    assert.strictEqual(entladen.soc_pct, 49, 'die Entladung wird NICHT zweimal bepreist');
  });

  it('eine LUECKE laesst die Zaehlung fallen, statt darueber hinwegzurechnen', function () {
    const cfg = {
      method: 'coulomb',
      hold_s: 900,
      params: { capacity_kwh: 40, anchor: { soc_pct: 50 } },
    };
    const t0 = 1000000;
    const start = soc.derive({ power_kw: 4 }, cfg, null, t0);
    // 20 Minuten Stille bei einer Haltefrist von 15: was der Speicher in der
    // Zwischenzeit getan hat, weiss niemand.
    const nachLuecke = soc.derive({ power_kw: 4 }, cfg, start.state, t0 + 1200000);
    assert.strictEqual(nachLuecke.soc_pct, undefined);
    assert.strictEqual(nachLuecke.drop, true);
    assert.ok(/Anker/.test(nachLuecke.reason));
  });

  it('die Zaehlung nimmt Strom x Spannung, wenn keine Leistung dasteht', function () {
    const cfg = {
      method: 'coulomb',
      hold_s: 900,
      params: { capacity_kwh: 40, anchor: { soc_pct: 50 } },
    };
    const t0 = 1000000;
    const start = soc.derive({ current_a: 10, voltage_v: 400 }, cfg, null, t0);
    // 10 A x 400 V = 4 kW -> nach 6 Minuten +1 Punkt auf 40 kWh nutzbar.
    const spaeter = soc.derive({ current_a: 10, voltage_v: 400 }, cfg, start.state,
      t0 + 360000);
    assert.strictEqual(spaeter.soc_pct, 51);
  });

  it('die Rekalibrierung am Endpunkt schlaegt die Zaehlung', function () {
    const cfg = {
      method: 'coulomb',
      hold_s: 900,
      params: {
        capacity_kwh: 40,
        anchor: { soc_pct: 50 },
        recalibrate: { full_cell_mv: 4060, full_soc_pct: 95, empty_cell_mv: 3400,
          empty_soc_pct: 5 },
      },
    };
    const t0 = 1000000;
    const start = soc.derive({ power_kw: 1 }, cfg, null, t0);
    const voll = soc.derive({ power_kw: 1, cell_max_mv: 4100 }, cfg, start.state, t0 + 60000);
    assert.strictEqual(voll.soc_pct, 95, 'eine Messung schlaegt eine Integration');
    const leer = soc.derive({ power_kw: -1, cell_min_mv: 3390 }, cfg, start.state, t0 + 60000);
    assert.strictEqual(leer.soc_pct, 5);
  });

  it('eine unbrauchbare Konfiguration wird VERWORFEN, nie aufgefuellt', function () {
    assert.strictEqual(soc.normalize(null), null);
    assert.strictEqual(soc.normalize({ method: 'raten' }), null);
    assert.strictEqual(soc.normalize({ method: 'ocv_curve', params: {} }), null,
      'eine Kennlinie ohne Stuetzpunkte rechnet nichts');
    assert.strictEqual(soc.normalize({ method: 'coulomb', params: {} }), null,
      'ohne Kapazitaet zaehlt niemand');
  });

  it('channelsFor traegt IMMER beide Kanaele - Wert und Herkunft', function () {
    const out = vpSocDerive.channelsFor({ soc_pct: 7.3, source: 'berechnet:kennlinie', code: 2 });
    assert.deepStrictEqual(out, { soc_pct: 7.3, soc_source_code: 2 });
  });

  it('payloadChannels nimmt beide Formen an und verwirft alles andere', function () {
    assert.deepStrictEqual(vpSocDerive.payloadChannels({ cell_min_mv: 3393 }),
      { cell_min_mv: 3393 });
    assert.deepStrictEqual(vpSocDerive.payloadChannels({ channels: { cell_min_mv: 3393 } }),
      { cell_min_mv: 3393 });
    // Was keine Zahl ist, ist kein Messwert.
    assert.deepStrictEqual(vpSocDerive.payloadChannels({ a: 'x', b: 2 }), { b: 2 });
    assert.strictEqual(vpSocDerive.payloadChannels({ a: 'x' }), null);
    assert.strictEqual(vpSocDerive.payloadChannels('takt'), null);
    assert.strictEqual(vpSocDerive.payloadChannels(null), null);
  });

  it('envelope ist die edge-entity-Telemetrieform', function () {
    const e = JSON.parse(vpSocDerive.envelope(ENTITY, { soc_pct: 7.3, soc_source_code: 2 },
      '2026-09-09T10:00:00.000Z'));
    assert.deepStrictEqual(e, {
      schema_version: '1.0',
      entity_id: ENTITY,
      ts: '2026-09-09T10:00:00.000Z',
      channels: { soc_pct: 7.3, soc_source_code: 2 },
    });
  });
});

describe('vp-soc-derive am laufenden Bus', function () {
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
        id: 's1',
        type: 'vp-soc-derive',
        core: 'core1',
        entity: ENTITY,
        method: 'ocv_curve',
        prefer_direct: true,
        hold_s: 900,
        inputs: {},
        params: {
          curve_charge: TEMPLATE.curve_charge,
          curve_discharge: TEMPLATE.curve_discharge,
          conservative_min: true,
        },
      }, overrides || {}),
    ];
  }

  it('veroeffentlicht Ladestand UND Herkunft in EINER Nachricht', function (done) {
    let settled = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      if (settled) return;
      settled = true;
      try {
        const m = JSON.parse(packet.payload.toString());
        assert.strictEqual(m.schema_version, '1.0');
        assert.strictEqual(m.entity_id, ENTITY);
        assert.deepStrictEqual(m.channels, { soc_pct: 7.3, soc_source_code: 2 });
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});

    helper.load([vpCore, vpSocDerive], flow(), function () {
      setTimeout(function () {
        helper.getNode('s1').receive({ payload: { cell_min_mv: 3393, cell_max_mv: 3606 } });
      }, 300);
    });
  });

  it('veroeffentlicht NICHTS, wenn der Eingang fehlt', function (done) {
    let seen = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      seen = true;
    }, function () {});

    helper.load([vpCore, vpSocDerive], flow(), function () {
      setTimeout(function () {
        helper.getNode('s1').receive({ payload: { temp_max_c: 21.5 } });
        setTimeout(function () {
          try {
            assert.strictEqual(seen, false,
              'ohne Zellspannung darf kein Ladestand entstehen - auch keine 50');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      }, 300);
    });
  });

  it('friert ein statt neu zu senden: ein alter Wert bekommt keine frische Zeit', function (done) {
    const seen = [];
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      seen.push(JSON.parse(packet.payload.toString()));
    }, function () {});

    helper.load([vpCore, vpSocDerive], flow(), function () {
      setTimeout(function () {
        const node = helper.getNode('s1');
        node.receive({ payload: { cell_min_mv: 3393, cell_max_mv: 3606 } });
        setTimeout(function () {
          // Zweiter Takt OHNE Zellspannung: der Wert ist eingefroren und wird
          // im Status samt Alter gezeigt - aber NICHT erneut veroeffentlicht.
          node.receive({ payload: { temp_max_c: 21.5 } });
          setTimeout(function () {
            try {
              assert.strictEqual(seen.length, 1,
                'ein eingefrorener Wert reist nie mit einem frischen Zeitstempel');
              assert.strictEqual(seen[0].channels.soc_pct, 7.3);
              done();
            } catch (e) {
              done(e);
            }
          }, 300);
        }, 300);
      }, 300);
    });
  });

  it('eine unbrauchbare Konfiguration liest gar nichts', function (done) {
    helper.load([vpCore, vpSocDerive], flow({ method: 'raten' }), function () {
      setTimeout(function () {
        try {
          const node = helper.getNode('s1');
          assert.ok(node, 'der Knoten existiert');
          // Er nimmt keine Nachricht an - es gibt keinen input-Handler.
          node.receive({ payload: { cell_min_mv: 3393 } });
          done();
        } catch (e) {
          done(e);
        }
      }, 200);
    });
  });
});

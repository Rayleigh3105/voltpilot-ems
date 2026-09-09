/**
 * vp-limit-guard (P5c): der SCHUTZ-/GRENZBAUSTEIN der selbst angebundenen
 * Batterie.
 *
 * DIE VORLAGE steht in `docs/contracts/v2/limit-protection-vectors.json` und
 * wird hier PER PFAD gelesen, nicht abgeschrieben: die beiden Strom-Treppen und
 * die vier Hysterese-Schwellen sind verbatim der Node-RED-Flow des Kunden
 * (Ground Truth 09.09.2026, derselbe Pack wie in soc-derivation-vectors.json).
 * Dieselbe Datei fahren die Go-Waechter-Tests (guards/bmslimit_test.go) und die
 * Java-Vorlagen-Pruefung (ProtectionProfileTest) - so kann die Box keine andere
 * Treppe rechnen, als das Portal anbietet, und der Waechter keine andere
 * Grenze klemmen, als die Box meldet.
 *
 * Die Regeln, die hier bewiesen werden:
 *   - die TREPPE interpoliert nicht (die Stufe gilt bis zur naechsten Schwelle)
 *     und klemmt unterhalb der ersten Schwelle statt zu extrapolieren,
 *   - der RIEGEL ist ein Gedaechtnis: er faellt nur beim UEBERSCHREITEN der
 *     Stopp-Schwelle und oeffnet nur an der Freigabe-Schwelle,
 *   - eine gesperrte Richtung meldet BEIDES (allowed = 0 UND limit_a = 0),
 *   - was der Baustein nicht sagen kann, sagt er nicht: ohne Ladestand keine
 *     Treppe, ohne Zellspannung keine Freigabe, ohne beides gar nichts,
 *   - er SCHREIBT auf kein Geraet - er veroeffentlicht ausschliesslich auf dem
 *     lokalen VoltPilot-Bus.
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const aedes = require('aedes');
const helper = require('node-red-node-test-helper');

const prot = require('../lib/limit-protection.js');
const vpCore = require('../nodes/vp-core.js');
const vpLimitGuard = require('../nodes/vp-limit-guard.js');

helper.init(require.resolve('node-red'));

const ENTITY = '8c4d0e32-9f50-4b67-ad18-1234567890bc';

/** Die GETEILTEN Vektoren - gelesen, nie kopiert. */
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname,
  '../../../../docs/contracts/v2/limit-protection-vectors.json'), 'utf8'));
const TEMPLATE = VECTORS.vorlage;

/** Die Konfiguration aus der Vorlage - genau die, die die Cloud ausrollt. */
function templateCfg(overrides) {
  return Object.assign({
    inputs: {},
    charge: { steps: TEMPLATE.charge.steps, max_a: TEMPLATE.charge.max_a },
    discharge: { steps: TEMPLATE.discharge.steps, max_a: TEMPLATE.discharge.max_a },
    hysteresis: TEMPLATE.hysteresis,
    round_a: TEMPLATE.round_a,
    hold_s: 900,
  }, overrides || {});
}

describe('limit-protection (rein, ohne Broker und ohne Uhr)', function () {
  it('faehrt JEDEN geteilten Vektor durch die echte Rechnung', function () {
    for (const fall of VECTORS.faelle) {
      const state = fall.zustand
        ? Object.assign({ at: 1000000 }, fall.zustand) : null;
      const got = prot.evaluate(fall.channels, templateCfg(), state, 1000000);
      assert.ok(!got.reason, fall.name + ': ' + got.reason);

      for (const channel of Object.keys(fall.erwartet || {})) {
        assert.strictEqual(got.channels[channel], fall.erwartet[channel],
          fall.name + ' / ' + channel + ' - ' + fall.why);
      }
      for (const channel of fall.erwartet_fehlt || []) {
        assert.ok(!(channel in got.channels),
          fall.name + ': ' + channel + ' darf FEHLEN, nie erfunden werden - ' + fall.why);
      }
      if (fall.erwartet_leer) {
        assert.deepStrictEqual(got.channels, {},
          fall.name + ': ohne Eingang sagt der Baustein NICHTS - ' + fall.why);
      }
      if (fall.erwartet_zustand) {
        assert.strictEqual(got.state.charge_blocked,
          fall.erwartet_zustand.charge_blocked, fall.name + ' / Lade-Riegel');
        assert.strictEqual(got.state.discharge_blocked,
          fall.erwartet_zustand.discharge_blocked, fall.name + ' / Entlade-Riegel');
      }
    }
  });

  it('prueft die ROHE Treppe dort, wo die Vektoren sie ausweisen', function () {
    for (const fall of VECTORS.faelle) {
      if (!fall.erwartet_roh) continue;
      assert.strictEqual(
        prot.currentFromSoc(fall.channels.soc_pct, TEMPLATE.charge.steps),
        fall.erwartet_roh.charge_step_a, fall.name + ' / Ladetreppe roh');
      assert.strictEqual(
        prot.currentFromSoc(fall.channels.soc_pct, TEMPLATE.discharge.steps),
        fall.erwartet_roh.discharge_step_a, fall.name + ' / Entladetreppe roh');
    }
  });

  it('die Treppe gewinnt mit dem LETZTEN Stuetzpunkt <= SoC, ohne Interpolation',
    function () {
      const steps = TEMPLATE.charge.steps;
      assert.strictEqual(prot.currentFromSoc(80, steps), 43);
      assert.strictEqual(prot.currentFromSoc(84.999, steps), 43);
      assert.strictEqual(prot.currentFromSoc(85, steps), 22);
      // Ueber der letzten Schwelle gilt die letzte Stufe weiter - das IST eine
      // Aussage der Tabelle, anders als unterhalb der ersten Schwelle.
      assert.strictEqual(prot.currentFromSoc(100, steps), 22);
      // Unterhalb der ersten Schwelle wird geklemmt, nie extrapoliert.
      assert.strictEqual(prot.currentFromSoc(0, steps), 270);
    });

  it('der Riegel faellt nur beim UEBERSCHREITEN und oeffnet nur an der Freigabe',
    function () {
      const h = { stop_v: 4.06, resume_v: 4.0 };
      // Ohne vorigen Zustand ist im Zwischenband NICHTS gesperrt: eine Sperre,
      // die niemand ausgeloest hat, waere erfunden.
      assert.strictEqual(prot.latch(4.03, h, true, null), false);
      assert.strictEqual(prot.latch(4.06, h, true, null), true);
      // Der Riegel HAELT im Zwischenband ...
      assert.strictEqual(prot.latch(4.03, h, true, true), true);
      // ... und oeffnet erst an der Freigabe.
      assert.strictEqual(prot.latch(4.0, h, true, true), false);
      // Ohne frische Zellspannung gilt der vorige Riegel weiter - ihn von
      // selbst zu oeffnen waere die gefaehrliche Richtung.
      assert.strictEqual(prot.latch(null, h, true, true), true);
      assert.strictEqual(prot.latch(null, h, true, null), null);
    });

  it('verwirft eine Konfiguration, statt Vorgaben zu erfinden', function () {
    // Weder Treppe noch Riegel: dieser Baustein prueft nichts.
    assert.strictEqual(prot.normalize({}), null);
    assert.strictEqual(prot.normalize(null), null);
    // Eine Freigabe UEBER dem Lade-Stopp waere ein Riegel, der sich im Moment
    // des Zuschiebens selbst wieder oeffnet.
    assert.strictEqual(prot.normalize({
      hysteresis: { charge_stop_v: 4.0, charge_resume_v: 4.06 },
    }), null);
    // Eine doppelte Schwelle waere zweideutig.
    assert.strictEqual(prot.normalize({
      charge: { steps: [[5, 270], [5, 22]], max_a: 40 },
    }), null);
    // Eine Treppe ohne Geraete-Maximum: das Maximum IST die halbe Aussage.
    assert.strictEqual(prot.normalize({ charge: { steps: [[5, 270]] } }), null);
  });

  it('vergisst einen Riegel-Zustand, der die Haltefrist gerissen hat', function () {
    const alt = { charge_blocked: true, discharge_blocked: false, at: 0 };
    // 901 s spaeter: was der Pack in der Zwischenzeit getan hat, weiss niemand.
    const got = prot.evaluate({ soc_pct: 90, cell_max_mv: 4030, cell_min_mv: 3900 },
      templateCfg(), alt, 901 * 1000);
    assert.strictEqual(got.channels[prot.CHARGE_ALLOWED_CHANNEL], 1);
    assert.strictEqual(got.channels[prot.CHARGE_LIMIT_CHANNEL], 22);
    // Innerhalb der Frist haelt er.
    const hielt = prot.evaluate({ soc_pct: 90, cell_max_mv: 4030, cell_min_mv: 3900 },
      templateCfg(), alt, 899 * 1000);
    assert.strictEqual(hielt.channels[prot.CHARGE_ALLOWED_CHANNEL], 0);
    assert.strictEqual(hielt.channels[prot.CHARGE_LIMIT_CHANNEL], 0);
  });

  it('baut die Telemetrie-Huelle wie jeder andere Knoten', function () {
    const e = JSON.parse(vpLimitGuard.envelope(ENTITY,
      { charge_limit_a: 22, charge_allowed: 1 }, '2026-09-09T10:00:00.000Z'));
    assert.deepStrictEqual(e, {
      schema_version: '1.0',
      entity_id: ENTITY,
      ts: '2026-09-09T10:00:00.000Z',
      channels: { charge_limit_a: 22, charge_allowed: 1 },
    });
  });

  it('payloadChannels nimmt beide Formen an und verwirft alles andere', function () {
    assert.deepStrictEqual(vpLimitGuard.payloadChannels({ soc_pct: 7.3 }), { soc_pct: 7.3 });
    assert.deepStrictEqual(vpLimitGuard.payloadChannels({ channels: { soc_pct: 7.3 } }),
      { soc_pct: 7.3 });
    assert.strictEqual(vpLimitGuard.payloadChannels('takt'), null);
    assert.strictEqual(vpLimitGuard.payloadChannels(null), null);
  });

  it('sagt im Status, was gerade erlaubt ist', function () {
    assert.strictEqual(vpLimitGuard.statusText({
      charge_limit_a: 22, charge_allowed: 1, discharge_limit_a: 40, discharge_allowed: 1,
    }), 'Laden max. 22 A · Entladen max. 40 A');
    assert.strictEqual(vpLimitGuard.statusText({
      charge_limit_a: 0, charge_allowed: 0, discharge_limit_a: 40, discharge_allowed: 1,
    }), 'Laden gesperrt · Entladen max. 40 A');
  });
});

describe('vp-limit-guard am laufenden Bus', function () {
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
        id: 'g1',
        type: 'vp-limit-guard',
        core: 'core1',
        entity: ENTITY,
      }, templateCfg(), overrides || {}),
    ];
  }

  it('veroeffentlicht die Grenzen UND die Freigaben in EINER Nachricht', function (done) {
    let settled = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      if (settled) return;
      settled = true;
      try {
        const m = JSON.parse(packet.payload.toString());
        assert.strictEqual(m.schema_version, '1.0');
        assert.strictEqual(m.entity_id, ENTITY);
        assert.deepStrictEqual(m.channels, {
          charge_limit_a: 22,
          charge_allowed: 1,
          discharge_limit_a: 40,
          discharge_allowed: 1,
        });
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});

    helper.load([vpCore, vpLimitGuard], flow(), function () {
      setTimeout(function () {
        helper.getNode('g1').receive({
          payload: { soc_pct: 86, cell_min_mv: 3900, cell_max_mv: 4020 },
        });
      }, 300);
    });
  });

  it('meldet die Sperre als 0 A UND als 0 - beides, nie nur eines', function (done) {
    let settled = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      if (settled) return;
      settled = true;
      try {
        const m = JSON.parse(packet.payload.toString());
        assert.strictEqual(m.channels.charge_allowed, 0);
        assert.strictEqual(m.channels.charge_limit_a, 0);
        // Die Entlade-Seite bleibt unberuehrt: ein voller Pack darf entladen.
        assert.strictEqual(m.channels.discharge_allowed, 1);
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});

    helper.load([vpCore, vpLimitGuard], flow(), function () {
      setTimeout(function () {
        helper.getNode('g1').receive({
          payload: { soc_pct: 92, cell_min_mv: 3950, cell_max_mv: 4060 },
        });
      }, 300);
    });
  });

  it('veroeffentlicht NICHTS, wenn es nichts zu sagen gibt', function (done) {
    let seen = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      seen = true;
    }, function () {});

    helper.load([vpCore, vpLimitGuard], flow(), function () {
      setTimeout(function () {
        helper.getNode('g1').receive({ payload: { temp_max_c: 21.5 } });
        setTimeout(function () {
          try {
            assert.strictEqual(seen, false,
              'ohne Ladestand und ohne Zellspannung gibt es keine Schutzgrenze - auch keine 0');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      }, 300);
    });
  });

  it('wiederholt eine UNVERAENDERTE Grenze nicht bei jedem Takt', function (done) {
    const seen = [];
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      seen.push(JSON.parse(packet.payload.toString()));
    }, function () {});

    helper.load([vpCore, vpLimitGuard], flow(), function () {
      setTimeout(function () {
        const node = helper.getNode('g1');
        const sample = { soc_pct: 86, cell_min_mv: 3900, cell_max_mv: 4020 };
        node.receive({ payload: sample });
        setTimeout(function () {
          node.receive({ payload: Object.assign({}, sample) });
          setTimeout(function () {
            try {
              assert.strictEqual(seen.length, 1,
                'derselbe Satz Grenzen reist einmal - der rbe-Teil des Kundenflows');
              // Eine GEAENDERTE Grenze reist sofort.
              node.receive({ payload: { soc_pct: 20, cell_min_mv: 3600, cell_max_mv: 3700 } });
              setTimeout(function () {
                try {
                  assert.strictEqual(seen.length, 2);
                  assert.strictEqual(seen[1].channels.charge_limit_a, 40);
                  done();
                } catch (e) {
                  done(e);
                }
              }, 300);
            } catch (e) {
              done(e);
            }
          }, 300);
        }, 300);
      }, 300);
    });
  });

  it('reicht die Kanaele weiter, damit ein Strang eine Kette bleibt', function (done) {
    helper.load([vpCore, vpLimitGuard], flow().concat([
      { id: 'sink', type: 'helper' },
    ]).map(function (n) {
      return n.id === 'g1' ? Object.assign({}, n, { wires: [['sink']] }) : n;
    }), function () {
      const sink = helper.getNode('sink');
      sink.on('input', function (msg) {
        try {
          // Die Rohkanaele UND die abgeleiteten Grenzen - jede Stufe reicht
          // weiter, was sie weiss.
          assert.strictEqual(msg.payload.soc_pct, 86);
          assert.strictEqual(msg.payload.cell_max_mv, 4020);
          assert.strictEqual(msg.payload.charge_limit_a, 22);
          done();
        } catch (e) {
          done(e);
        }
      });
      setTimeout(function () {
        helper.getNode('g1').receive({
          payload: { soc_pct: 86, cell_min_mv: 3900, cell_max_mv: 4020 },
        });
      }, 300);
    });
  });
});

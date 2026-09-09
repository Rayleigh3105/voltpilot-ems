/**
 * vp-http-read (P5 Ebene 1 „HTTP/JSON"): der ZWEITE Lesetyp des
 * BMS-unabhaengigen Batterie-Anschlusses.
 *
 * Der Vorlagen-Fall: ein DIYBMS v4 beantwortet `GET /ha` mit dem Kopfzeilen-
 * Schluessel `ApiKey` und einem flachen Dokument (soc, v, c, pwr, lowcellv,
 * highcellv …). Genau das prueft dieser Spec - erst als reine Rechnung, dann am
 * laufenden Knoten gegen einen echten HTTP-Server im Prozess.
 *
 * Die Ehrlichkeitsregeln, die hier bewiesen werden:
 *   - ein Kanal, den die Antwort nicht hergibt, FEHLT (nie 0),
 *   - ein Fehlschlag veroeffentlicht GAR NICHTS (nie die vorige Antwort),
 *   - ein Sentinel-Rohwert ist "nicht gemessen" (nie ein Wert),
 *   - ein Wort ausserhalb der Wahrheitswert-Liste wird VERWORFEN,
 *   - ein Ziel ausserhalb des Heimnetzes wird gar nicht erst abgefragt,
 *   - ohne Zugangsdaten wird NICHT abgefragt (ein 401 waere kein Geraetefehler),
 *   - das Geheimnis kommt aus der Entitaets-Konfiguration, NIE aus dem Flow,
 *   - es laeuft immer nur EINE Abfrage je Host.
 */
'use strict';

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const map = require('../lib/http-mapping.js');
const vpCore = require('../nodes/vp-core.js');
const vpHttpRead = require('../nodes/vp-http-read.js');

helper.init(require.resolve('node-red'));

const ENTITY = '9d5e1f34-2a6b-4c78-8e90-fedcba987654';
const API_KEY = 'geheim-123';

/** Die Antwort des DIYBMS v4 auf `/ha`, gekuerzt auf das Wesentliche. */
const HA_BODY = {
  soc: 41.5,
  v: 55.6,
  c: -12.3,
  pwr: -684,
  lowcellv: 3393,
  highcellv: 3606,
  chargeallowed: true,
  dischargeallowed: 'on',
  modules: [
    { exttemp: 21 },
    { exttemp: 23.5 },
    { exttemp: -40 },
  ],
};

/** Die Zuordnung der Vorlage „DIYBMS v4 - /ha". */
const HA_MAPPINGS = [
  { channel: 'soc_pct', path: 'soc' },
  { channel: 'voltage_v', path: 'v' },
  { channel: 'current_a', path: 'c' },
  { channel: 'power_kw', path: 'pwr', scale: 0.001 },
  { channel: 'cell_min_mv', path: 'lowcellv' },
  { channel: 'cell_max_mv', path: 'highcellv' },
  { channel: 'temp_max_c', path: 'modules.*.exttemp', aggregate: 'max', sentinel: -40 },
  { channel: 'charge_allowed', path: 'chargeallowed', value_type: 'bool' },
  { channel: 'discharge_allowed', path: 'dischargeallowed', value_type: 'bool' },
];

describe('http-mapping (rein, ohne Server und ohne Uhr)', function () {
  it('collect geht den Wertepfad - und nie ueber __proto__', function () {
    assert.deepStrictEqual(map.collect({ soc: 41.5 }, 'soc').values, [41.5]);
    assert.deepStrictEqual(map.collect({ bms: { soc: 41.5 } }, 'bms.soc').values, [41.5]);
    assert.deepStrictEqual(map.collect({ cells: [{ v: 1 }, { v: 2 }] }, 'cells.1.v').values, [2]);
    // Was es nicht gibt, gibt es nicht.
    assert.deepStrictEqual(map.collect({ soc: 41.5 }, 'current').values, []);
    assert.deepStrictEqual(map.collect({ soc: 41.5 }, 'soc.tiefer').values, []);
    assert.strictEqual(map.isValidPath('__proto__'), false);
    assert.strictEqual(map.isValidPath('a.constructor'), false);
    // Ein LEERER Pfad ist hier kein Wert: eine HTTP-Antwort ist ein Dokument.
    assert.strictEqual(map.isValidPath(''), false);
  });

  it('DER AGGREGAT-FALL: ein PLATZHALTER trifft jede Zelle der Liste', function () {
    const doc = { cells: [{ v: 3393 }, { v: 3500 }, { v: 3606 }] };
    assert.deepStrictEqual(map.collect(doc, 'cells.*.v').values, [3393, 3500, 3606]);
    // Auch ueber ein OBJEKT (ein BMS, das seine Zellen benennt).
    const named = { banks: { a: { v: 1 }, b: { v: 2 } } };
    assert.deepStrictEqual(map.collect(named, 'banks.*.v').values, [1, 2]);
    // Und ueber zwei Ebenen.
    const deep = { banks: [{ cells: [{ v: 1 }, { v: 2 }] }, { cells: [{ v: 3 }] }] };
    assert.deepStrictEqual(map.collect(deep, 'banks.*.cells.*.v').values, [1, 2, 3]);
  });

  it('die Werte-Schranke greift und schweigt nicht', function () {
    const many = { cells: [] };
    for (let i = 0; i < map.MAX_SOURCES + 5; i++) many.cells.push({ v: i });
    const found = map.collect(many, 'cells.*.v');
    assert.strictEqual(found.values.length, map.MAX_SOURCES);
    assert.strictEqual(found.overflow, true);
  });

  it('decode macht aus der /ha-Antwort genau die Standard-Kanaele', function () {
    const mappings = vpHttpRead.normalize(HA_MAPPINGS);
    const out = map.decode(HA_BODY, mappings, 1000000);
    assert.deepStrictEqual(out.channels, {
      soc_pct: 41.5,
      voltage_v: 55.6,
      current_a: -12.3,
      power_kw: -0.684,
      cell_min_mv: 3393,
      cell_max_mv: 3606,
      // Der -40-Fuehler ist "nicht gemessen" - das Maximum der ECHTEN Werte.
      temp_max_c: 23.5,
      charge_allowed: 1,
      discharge_allowed: 1,
    });
  });

  it('ein Kanal ohne Wert FEHLT - er wird nie 0', function () {
    const mappings = vpHttpRead.normalize([
      { channel: 'soc_pct', path: 'soc' },
      { channel: 'voltage_v', path: 'gibtesnicht' },
      { channel: 'temp_max_c', path: 'modules.*.exttemp', aggregate: 'max', sentinel: -40 },
    ]);
    const out = map.decode({ soc: 41.5, modules: [{ exttemp: -40 }] }, mappings, 1);
    assert.deepStrictEqual(out.channels, { soc_pct: 41.5 },
      'weder eine fehlende Spannung noch ein Sentinel-Fuehler darf eine 0 erzeugen');
  });

  it('ein Wahrheitswert ausserhalb des Vokabulars wird VERWORFEN', function () {
    const mappings = vpHttpRead.normalize([
      { channel: 'charge_allowed', path: 'flag', value_type: 'bool' },
    ]);
    assert.deepStrictEqual(map.decode({ flag: 'vielleicht' }, mappings, 1).channels, {});
    assert.strictEqual(map.decode({ flag: 'ja' }, mappings, 1).channels.charge_allowed, 1);
  });

  it('url() setzt die Adresse zusammen, ohne etwas dazuzuerfinden', function () {
    assert.strictEqual(map.url({ host: '192.168.0.44', port: 80, path: '/ha' }),
      'http://192.168.0.44/ha');
    assert.strictEqual(map.url({ host: '192.168.0.44', port: 8080, path: '/ha' }),
      'http://192.168.0.44:8080/ha');
    assert.strictEqual(map.url({ host: '192.168.0.44', port: 443, path: '/api/v1', tls: true }),
      'https://192.168.0.44/api/v1');
  });

  it('authHeaders traegt das Geheimnis - und schweigt, wenn es fehlt', function () {
    assert.deepStrictEqual(map.authHeaders({ mode: 'none' }, null), {});
    assert.deepStrictEqual(map.authHeaders({ mode: 'header', header: 'ApiKey' }, 'x'),
      { ApiKey: 'x' });
    assert.deepStrictEqual(map.authHeaders({ mode: 'bearer' }, 'x'),
      { Authorization: 'Bearer x' });
    assert.deepStrictEqual(map.authHeaders({ mode: 'basic', username: 'admin' }, 'pw'),
      { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') });
    // OHNE Geheimnis entstehen keine Kopfzeilen: der Aufrufer fragt dann gar
    // nicht erst ab, statt sich einen 401 als Geraetefehler einzuhandeln.
    assert.strictEqual(map.authHeaders({ mode: 'header', header: 'ApiKey' }, ''), null);
    assert.strictEqual(map.authHeaders({ mode: 'bearer' }, null), null);
    assert.strictEqual(map.needsSecret({ mode: 'none' }), false);
    assert.strictEqual(map.needsSecret({ mode: 'basic' }), true);
  });
});

describe('vp-http-read shaping (rein)', function () {
  it('normalize schreibt jede Vorgabe aus und verwirft kaputte Zeilen', function () {
    const n = vpHttpRead.normalize([
      { channel: 'soc_pct', path: 'soc' },
      { channel: 'KEIN KANAL', path: 'soc' },
      { channel: 'soc_pct', path: 'anders' }, // derselbe Kanal ein zweites Mal
      { channel: 'voltage_v', path: '' }, // ein leerer Pfad ist kein Wert
      { channel: 'current_a', path: '__proto__' },
    ]);
    assert.strictEqual(n.length, 1);
    assert.strictEqual(n[0].aggregate, 'last');
    assert.strictEqual(n[0].value_type, 'number');
    assert.strictEqual(n[0].scale, 1);
    assert.strictEqual(n[0].offset, 0);
    assert.strictEqual(n[0].staleMs, undefined, 'eine HTTP-Antwort ist EIN Zeitpunkt');
  });

  it('ein Wahrheitswert wird nie gemittelt oder summiert', function () {
    assert.strictEqual(vpHttpRead.aggregateFor({ aggregate: 'avg', value_type: 'bool' }), 'last');
    assert.strictEqual(vpHttpRead.aggregateFor({ aggregate: 'sum', value_type: 'bool' }), 'last');
    assert.strictEqual(vpHttpRead.aggregateFor({ aggregate: 'min', value_type: 'bool' }), 'min');
  });

  it('secretFrom liest NUR die eigene Entitaets-Konfiguration', function () {
    const config = (id, secret) => Buffer.from(JSON.stringify({
      schema_version: '1.0',
      entity_id: id,
      entity_type: 'user-defined-battery',
      capabilities: {},
      guards: {},
      driver: { communication: 'http_local', connection: { auth_secret: secret } },
    }));
    assert.strictEqual(vpHttpRead.secretFrom(ENTITY, config(ENTITY, API_KEY)), API_KEY);
    // Eine Konfiguration, die eine ANDERE Entitaet nennt, wird verworfen -
    // ihr Kennwort gehoert einem anderen Geraet.
    assert.strictEqual(vpHttpRead.secretFrom(ENTITY, config('fremd', API_KEY)), null);
    assert.strictEqual(vpHttpRead.secretFrom(ENTITY, Buffer.from('kein json')), null);
    assert.strictEqual(vpHttpRead.secretFrom(ENTITY, config(ENTITY, '')), null);
  });

  it('classify benennt jeden Fehlschlag - Schweigen ist nicht Unerreichbarkeit',
    function () {
      assert.strictEqual(vpHttpRead.classify({ code: 'ETIMEDOUT' }), 'no_answer');
      assert.strictEqual(vpHttpRead.classify({ code: 'ECONNREFUSED' }), 'unreachable');
      assert.strictEqual(vpHttpRead.classify({}), 'unreachable');
    });

  it('envelope ist die edge-entity-Telemetrieform', function () {
    const e = JSON.parse(vpHttpRead.envelope(ENTITY, { soc_pct: 41.5 },
      '2026-09-09T10:00:00.000Z'));
    assert.deepStrictEqual(e, {
      schema_version: '1.0',
      entity_id: ENTITY,
      ts: '2026-09-09T10:00:00.000Z',
      channels: { soc_pct: 41.5 },
    });
  });
});

describe('fetchJson gegen einen echten Server', function () {
  let server;
  let port;
  let handler;

  beforeEach(function (done) {
    server = http.createServer(function (req, res) {
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', function () {
      port = server.address().port;
      done();
    });
  });

  afterEach(function (done) {
    server.close(done);
  });

  const deps = { http: http, https: require('node:https') };

  it('liest EIN JSON-Dokument und traegt dabei die Kopfzeile', function (done) {
    let seenKey = null;
    handler = function (req, res) {
      seenKey = req.headers.apikey || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(HA_BODY));
    };
    vpHttpRead.fetchJson(deps, 'http://127.0.0.1:' + port + '/ha', { ApiKey: API_KEY }, 2000)
      .then(function (r) {
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.doc.soc, 41.5);
        assert.strictEqual(seenKey, API_KEY, 'die Anmeldung reist mit');
        done();
      })
      .catch(done);
  });

  it('nennt jeden Fehlschlag beim Namen', function (done) {
    handler = function (req, res) {
      res.writeHead(401);
      res.end('nope');
    };
    vpHttpRead.fetchJson(deps, 'http://127.0.0.1:' + port + '/ha', {}, 2000)
      .then(function (r) {
        // Ein 401 ist eine ANTWORT: die Anmeldung wurde abgelehnt. Das ist
        // etwas anderes als "das Geraet schweigt".
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error_code, 'invalid_response');
        assert.strictEqual(r.status, 401);
        handler = function (req, res) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>kein json</html>');
        };
        return vpHttpRead.fetchJson(deps, 'http://127.0.0.1:' + port + '/ha', {}, 2000);
      })
      .then(function (r) {
        assert.strictEqual(r.error_code, 'invalid_response');
        // Ein geschlossener Port: nicht erreichbar.
        return vpHttpRead.fetchJson(deps, 'http://127.0.0.1:1/ha', {}, 2000);
      })
      .then(function (r) {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error_code, 'unreachable');
        done();
      })
      .catch(done);
  });

  it('ein Server, der nie antwortet, ist keine Antwort - kein Absturz', function (done) {
    handler = function () { /* absichtlich stumm */ };
    vpHttpRead.fetchJson(deps, 'http://127.0.0.1:' + port + '/ha', {}, 300)
      .then(function (r) {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error_code, 'no_answer');
        done();
      })
      .catch(done);
  });
});

describe('vp-http-read am laufenden Knoten', function () {
  let broker;
  let busServer;
  let busPort;
  let api;
  let apiPort;
  let handler;
  let requests;

  beforeEach(function (done) {
    requests = [];
    handler = function (req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(HA_BODY));
    };
    broker = aedes();
    busServer = net.createServer(broker.handle);
    api = http.createServer(function (req, res) {
      requests.push({ url: req.url, headers: req.headers });
      handler(req, res);
    });
    busServer.listen(0, '127.0.0.1', function () {
      busPort = busServer.address().port;
      api.listen(0, '127.0.0.1', function () {
        apiPort = api.address().port;
        helper.startServer(done);
      });
    });
  });

  afterEach(function (done) {
    helper.unload().then(function () {
      helper.stopServer(function () {
        api.close(function () {
          broker.close(function () {
            busServer.close(done);
          });
        });
      });
    });
  });

  function flow(overrides) {
    return [
      { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1',
        port: String(busPort) },
      Object.assign({
        id: 'h1',
        type: 'vp-http-read',
        core: 'core1',
        host: '127.0.0.1',
        port: apiPort,
        path: '/ha',
        timeout_ms: 2000,
        entity: ENTITY,
        auth: { mode: 'header', header: 'ApiKey' },
        mappings: HA_MAPPINGS,
      }, overrides || {}),
    ];
  }

  /** Die retained Entitaets-Konfiguration, die das Geheimnis traegt. */
  function publishConfig(client, secret, cb) {
    client.publish('edge/entities/' + ENTITY + '/config', JSON.stringify({
      schema_version: '1.0',
      entity_id: ENTITY,
      entity_type: 'user-defined-battery',
      capabilities: { measure: [] },
      guards: {},
      driver: { communication: 'http_local', connection: { auth_secret: secret } },
    }), { qos: 1, retain: true }, cb);
  }

  it('macht aus EINER /ha-Antwort EINE Telemetrie mit allen Kanaelen', function (done) {
    let settled = false;
    broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
      cb();
      if (settled) return;
      settled = true;
      try {
        const m = JSON.parse(packet.payload.toString());
        assert.strictEqual(m.schema_version, '1.0');
        assert.strictEqual(m.entity_id, ENTITY);
        assert.strictEqual(m.channels.soc_pct, 41.5);
        assert.strictEqual(m.channels.cell_min_mv, 3393);
        assert.strictEqual(m.channels.cell_max_mv, 3606);
        assert.strictEqual(m.channels.power_kw, -0.684);
        assert.strictEqual(m.channels.temp_max_c, 23.5);
        assert.strictEqual(m.channels.charge_allowed, 1);
        // Die Anmeldung kam aus der Entitaets-Konfiguration, nicht aus dem Flow.
        assert.strictEqual(requests[0].headers.apikey, API_KEY);
        assert.strictEqual(requests[0].url, '/ha');
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});

    helper.load([vpCore, vpHttpRead], flow(), function () {
      const pub = mqtt.connect('mqtt://127.0.0.1:' + busPort);
      pub.on('connect', function () {
        publishConfig(pub, API_KEY, function () {
          setTimeout(function () {
            helper.getNode('h1').receive({ payload: 'takt' });
            pub.end();
          }, 300);
        });
      });
    });
  });

  it('fragt OHNE Zugangsdaten gar nicht erst ab', function (done) {
    helper.load([vpCore, vpHttpRead], flow(), function () {
      setTimeout(function () {
        helper.getNode('h1').receive({ payload: 'takt' });
        setTimeout(function () {
          try {
            assert.strictEqual(requests.length, 0,
              'ein 401 waere ein Geraetefehler, den niemand verschuldet hat');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      }, 300);
    });
  });

  it('veroeffentlicht bei einem Fehlschlag NICHTS - auch nicht die vorige Antwort',
    function (done) {
      let seen = 0;
      broker.subscribe('edge/entities/' + ENTITY + '/telemetry', function (packet, cb) {
        cb();
        seen += 1;
      }, function () {});

      helper.load([vpCore, vpHttpRead], flow({ auth: { mode: 'none' } }), function () {
        const node = helper.getNode('h1');
        node.receive({ payload: 'takt' });
        setTimeout(function () {
          assert.strictEqual(seen, 1, 'die erste Antwort ist echt');
          handler = function (req, res) {
            res.writeHead(500);
            res.end('kaputt');
          };
          node.receive({ payload: 'takt' });
          setTimeout(function () {
            try {
              assert.strictEqual(seen, 1,
                'ein Fehlschlag darf die vorige Antwort nicht mit frischer Zeit wiederholen');
              done();
            } catch (e) {
              done(e);
            }
          }, 400);
        }, 400);
      });
    });

  it('laesst immer nur EINE Abfrage je Host laufen', function (done) {
    let open = 0;
    let maxOpen = 0;
    handler = function (req, res) {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      setTimeout(function () {
        open -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(HA_BODY));
      }, 250);
    };

    helper.load([vpCore, vpHttpRead], flow({ auth: { mode: 'none' } }), function () {
      const node = helper.getNode('h1');
      node.receive({ payload: 'takt' });
      node.receive({ payload: 'takt' });
      node.receive({ payload: 'takt' });
      setTimeout(function () {
        try {
          assert.strictEqual(maxOpen, 1,
            'ein Takt, der auf eine laufende Abfrage trifft, wird uebersprungen');
          assert.strictEqual(requests.length, 1);
          done();
        } catch (e) {
          done(e);
        }
      }, 600);
    });
  });

  it('fragt ein Ziel ausserhalb des Heimnetzes gar nicht erst ab', function (done) {
    helper.load([vpCore, vpHttpRead], flow({ host: '8.8.8.8', auth: { mode: 'none' } }),
      function () {
        setTimeout(function () {
          const node = helper.getNode('h1');
          node.receive({ payload: 'takt' });
          setTimeout(function () {
            try {
              assert.strictEqual(requests.length, 0);
              done();
            } catch (e) {
              done(e);
            }
          }, 300);
        }, 200);
      });
  });
});

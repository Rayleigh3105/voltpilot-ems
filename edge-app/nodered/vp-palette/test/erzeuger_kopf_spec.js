/**
 * Probe-Op `erzeuger_kopf` (EZ-5) ueber den ECHTEN Modbus-Weg: der Probe-Knoten
 * (`nodes/vp-modbus-probe.js`) liest mit `lib/modbus-conn.js` - derselbe Socket, dieselbe
 * Warteschlange, dieselben Zeitkappen wie im Betrieb - einen In-Process-Modbus-TCP-Server der
 * WAGO-Buehne, vor dem hier ein Erzeuger-Bild steht (`measurements/testdata/erzeuger-bilder.js`,
 * gebaut aus der Vorlage, nicht aus dem Leser).
 *
 * WARNUNG: **KEIN BELEG.** Gore und Buettner sind plausible Bilder nach dem Konzept, keine
 * Lesung an einer echten Steuerung.
 */
'use strict';

const assert = require('node:assert');

const conn = require('../lib/modbus-conn.js');
const probeNode = require('../nodes/vp-modbus-probe.js');
const buehne = require('./fixtures/wago-registerbild-store.js');
const bilder = require('../../measurements/testdata/erzeuger-bilder');

const lesen = (plan) => conn.readRegisters(plan);

function kopfOp(port, ueber = {}) {
  return Object.assign({ id: 'steuerung', op: probeNode.OP_ERZEUGER_KOPF, host: '127.0.0.1', port,
    unit_id: 1, fc: 4, address: 0, word_order: 'big' }, ueber);
}

async function mitServer(woerter, pruefe, optionen = {}) {
  const store = bilder.store(woerter, optionen);
  const srv = await buehne.starteRegisterbildServer(store);
  try { return await pruefe(srv, store); } finally { await srv.close(); }
}

describe('EZ-5: Probe-Op erzeuger_kopf', function () {
  this.timeout(20000);

  it('Buettner: Anlagenart, Motoren mit Art, Nennleistung und Typ, Netzbetreiber und Direktvermarkter', async function () {
    await mitServer(bilder.buettner(), async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.erzeuger_kopf, {
        signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, te_anzahl: 2,
        herzschlag: 500, programmstand: 2611, steuerung_id: 4712, anlagenart: 2, beschreibung_ab: 140,
        einheiten: [
          { einheit: 1, art: 2, nenn_kw: 66, typ_name: 'MAN E0836LE' },
          { einheit: 2, art: 2, nenn_kw: 33, typ_name: 'KW Energie Smartblock 33' }],
        netzbetreiber_name: 'N-ERGIE Netz GmbH', direktvermarkter_name: 'WVV (Stadtwerke Würzburg)' });
      // Kopf, Einheiten, Namen - drei Lesungen dokumentierter Laenge, keine Ausnahme der Steuerung.
      assert.strictEqual(srv.state.anfragen, 3);
      assert.strictEqual(srv.state.ausnahmen, 0);
    });
  });

  it('Gore: drei Wechselrichter, kein Direktvermarkter = ein gelesener leerer Name', async function () {
    await mitServer(bilder.gore(), async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.strictEqual(r.erzeuger_kopf.anlagenart, 1);
      assert.deepStrictEqual(r.erzeuger_kopf.einheiten.map((e) => [e.art, e.nenn_kw]), [[1, 125], [1, 125], [1, 125]]);
      assert.strictEqual(r.erzeuger_kopf.direktvermarkter_name, '');
    });
  });

  it('ein WAGO-Registerbild ist nicht unser Bild: nur signatur_ok false, keine weitere Lesung', async function () {
    await mitServer(bilder.gore({ kopf: { signatur: [0x5650, 0x5242] } }), async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.deepStrictEqual(r, { id: 'steuerung', ok: true,
        erzeuger_kopf: { signatur_ok: false, erkannt: false, grund: 'signatur_fremd' } });
      assert.strictEqual(srv.state.anfragen, 1);
    });
  });

  it('ohne Namen (beschreibung_ab 0) fehlen die Namen - der Bericht bleibt erkannt', async function () {
    const ohneNamen = bilder.baueBild({ kopf: { steuerung_id: 9, anlagenart: 1 },
      einheiten: [{ t_art: 1, t_nenn_kw: 50 }] });
    await mitServer(ohneNamen, async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.strictEqual(r.erzeuger_kopf.erkannt, true);
      assert.ok(!('netzbetreiber_name' in r.erzeuger_kopf));
      assert.deepStrictEqual(r.erzeuger_kopf.einheiten, [{ einheit: 1, art: 1, nenn_kw: 50 }]);
      assert.strictEqual(srv.state.anfragen, 2);
    });
  });

  it('die Steuerung beantwortet die Namen nicht: Namen fehlen, keine Ablehnung', async function () {
    // Nur das laufende Bild (0-67): die Lesung ab 140 endet in der Ausnahme 0x02.
    await mitServer(bilder.gore().slice(0, 68), async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.erzeuger_kopf.erkannt, true);
      assert.ok(!('netzbetreiber_name' in r.erzeuger_kopf));
      assert.ok(!('typ_name' in r.erzeuger_kopf.einheiten[0]));
      assert.strictEqual(srv.state.ausnahmen, 1);
    });
  });

  it('der Kopf nennt mehr Einheiten, als die Steuerung Register hat: zu_wenig_woerter', async function () {
    await mitServer(bilder.gore({ kopf: { te_anzahl: 5 } }).slice(0, 68), async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.deepStrictEqual([r.erzeuger_kopf.erkannt, r.erzeuger_kopf.grund, r.erzeuger_kopf.te_anzahl],
        [false, 'zu_wenig_woerter', 5]);
    });
  });

  it('falsche Wortfolge: wortfolge_falsch - die Version reist mit, sonst nichts', async function () {
    await mitServer(bilder.gore({ wortfolge: 'little' }), async (srv) => {
      const [r] = await probeNode.runOps([kopfOp(srv.port)], lesen);
      assert.deepStrictEqual(r.erzeuger_kopf, { signatur_ok: true, erkannt: false,
        grund: 'wortfolge_falsch', hauptversion: 1, nebenversion: 0 });
      const [richtig] = await probeNode.runOps([kopfOp(srv.port, { word_order: 'little' })], lesen);
      assert.strictEqual(richtig.erzeuger_kopf.erkannt, true);
    });
  });

  it('niemand antwortet: die Klasse der Lesung, kein erfundener Kopf', async function () {
    const [r] = await probeNode.runOps([kopfOp(1)], lesen);
    assert.strictEqual(r.ok, false);
    assert.ok(['unreachable', 'no_answer'].includes(r.error_code), r.error_code);
    assert.ok(!('erzeuger_kopf' in r));
  });

  it('ohne Basisadresse kein Kopf', async function () {
    const [r] = await probeNode.runOps([kopfOp(502, { address: undefined })], lesen);
    assert.deepStrictEqual([r.ok, r.error_code], [false, 'invalid_request']);
  });
});

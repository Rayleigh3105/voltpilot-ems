/**
 * Kopf-Pruefung und Probe-Op `wago_kopf` (UEMS AP-05 IP-7) auf der Buehne aus IP-12.
 *
 * Alles hier laeuft ueber den ECHTEN Modbus-Weg: `fixtures/wago-registerbild-store.js` baut den
 * Register-Store, ein In-Process-Modbus-TCP-Server liefert ihn aus, und der Probe-Knoten
 * (`nodes/vp-modbus-probe.js`) liest ihn mit `lib/modbus-conn.js` - derselbe Socket, dieselbe
 * Warteschlange, dieselben Zeitkappen wie im Betrieb.
 *
 * Zwei Faelle der Vektor-Datei tragen die Abnahme: **S4 version-fremd** (Finding
 * `registerbild_unbekannt`, kein einziger Kartenwert) und **S3 herzschlag-steht** (Qualitaet
 * `stale` nach genau drei stehenden Lesungen, mit Basisadresse 4096, FC4 und little-endian - der
 * Fall, in dem drei Parameter gleichzeitig von der Voreinstellung abweichen).
 *
 * WARNUNG: **KEIN BELEG.** Es gibt keine WAGO-Hardware; jede Zahl der Buehne ist ausgedacht. Der
 * Simulator dient dem Bauen, nie dem Beleg.
 */
'use strict';

const assert = require('node:assert');

const conn = require('../lib/modbus-conn.js');
const probeNode = require('../nodes/vp-modbus-probe.js');
const buehne = require('./fixtures/wago-registerbild-store.js');
const kopfStufe = require('../../measurements/wago-kopf');
const registerbild = require('../../measurements/wago-registerbild');

const DA = buehne.vertragVorhanden();

/** Der echte Leseweg des Knotens - genau der, den der Probe-Knoten im Betrieb benutzt. */
const lesen = (plan) => conn.readRegisters(plan);

/** Eine `wago_kopf`-Op wie sie der Core auf den lokalen Bus legt. */
function kopfOp(store, port, ueber = {}) {
  return Object.assign({
    id: 'kopf', op: probeNode.OP_WAGO_KOPF, host: '127.0.0.1', port, unit_id: 1,
    fc: store.funktionscode, address: store.basisadresse, word_order: store.wortfolge,
  }, ueber);
}

/** Eine ganze Lesung des Registerbilds ueber den echten Weg (Anfragen wie Vertrag Paragraf 7). */
async function liesAlles(store, port) {
  const woerter = [];
  for (const a of registerbild.planeAnfragen({
    basisadresse: store.basisadresse, kartenzahl: store.kartenzahl,
    kopflaenge: store.kopflaenge, kartenblocklaenge: store.kartenblocklaenge,
  })) {
    /* eslint-disable-next-line no-await-in-loop */
    const teil = await conn.readRegisters({ host: '127.0.0.1', port, unitId: 1,
      fc: store.funktionscode, addr: a.start, count: a.count });
    woerter.push(...teil);
  }
  return woerter;
}

describe('AP-05 IP-7: Kopf-Pruefung der WAGO-Steuerung', function () {
  this.timeout(20000);

  describe('Fall S4 - Version fremd', function () {
    it('liefert das Finding registerbild_unbekannt und keinen einzigen Kartenwert', async function () {
      if (!DA) this.skip();
      const fall = buehne.ladeFall('S4');
      const store = fall.store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const woerter = await liesAlles(store, srv.port);
        const soll = { kartenzahl: store.kartenzahl, controller_kennung: store.controllerKennung,
          karten: fall.aufbau.karten };
        const gelesen = kopfStufe.pruefeLesung(woerter, { steuerung: 'wago-s4',
          parameter: { basisadresse: store.basisadresse, wortfolge: store.wortfolge }, soll });

        assert.strictEqual(gelesen.ergebnis, 'nicht_lesbar');
        assert.strictEqual(gelesen.grund, 'hauptversion_fremd');
        assert.deepStrictEqual(gelesen.karten, [], 'kein einziger Kartenwert');
        assert.strictEqual(gelesen.befund.finding, 'registerbild_unbekannt');
        // Auf dem bestehenden Findings-Weg der Mess-Runtime faehrt er als layout_changed.
        assert.deepStrictEqual(kopfStufe.quellenBeleg(gelesen.befund),
          { requests: 1, failed: true, error_class: 'layout_changed' });
      } finally {
        await srv.close();
      }
    });

    it('sagt im Probe-Ergebnis, WELCHE Version dort steht', async function () {
      if (!DA) this.skip();
      const store = buehne.ladeFall('S4').store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const [r] = await probeNode.runOps([kopfOp(store, srv.port)], lesen);
        assert.strictEqual(r.ok, true, 'die LESUNG ist gelungen - das Urteil faellt der Core');
        assert.strictEqual(r.wago_kopf.signatur_ok, true, 'die Signatur passt, nur die Version nicht');
        assert.strictEqual(r.wago_kopf.erkannt, false);
        assert.strictEqual(r.wago_kopf.grund, 'hauptversion_fremd');
        assert.strictEqual(r.wago_kopf.hauptversion, 2, 'die Version IST die Auskunft');
        // Und sonst nichts: in einem v2-Registerbild bedeuten die Woerter an Offset 4-11 nicht
        // mehr, was ein v1-Leser aus ihnen machen wuerde (Vektor V4).
        for (const feld of ['kartenzahl', 'herzschlag', 'controller_kennung', 'kopflaenge']) {
          assert.ok(!Object.hasOwn(r.wago_kopf, feld), `${feld} waere geraten`);
        }
      } finally {
        await srv.close();
      }
    });
  });

  describe('Fall S3 - Herzschlag steht', function () {
    it('vergibt stale nach genau drei stehenden Lesungen und erholt sich danach', async function () {
      if (!DA) this.skip();
      const fall = buehne.ladeFall('S3');
      const store = fall.store();
      const srv = await buehne.starteRegisterbildServer(store);
      const wacht = new kopfStufe.HerzschlagWacht();
      const soll = { kartenzahl: store.kartenzahl, controller_kennung: store.controllerKennung,
        karten: fall.aufbau.karten };
      const parameter = { basisadresse: store.basisadresse, wortfolge: store.wortfolge };
      try {
        const urteile = [];
        for (const l of fall.lesungen) {
          l.schritte.forEach((sch) => store.schritt(sch));
          /* eslint-disable-next-line no-await-in-loop */
          const woerter = await liesAlles(store, srv.port);
          const g = kopfStufe.pruefeLesung(woerter, { steuerung: 'wago-s3', parameter, soll, wacht });
          assert.strictEqual(g.ergebnis, 'erkannt', `Lesung ${l.nr}`);
          assert.strictEqual(g.herzschlag_urteil, l.herzschlag_urteil, `Lesung ${l.nr}: Urteil`);
          urteile.push([g.steht, g.qualitaet]);
        }
        // Die Vektor-Datei faehrt genau vier Lesungen: erste + drei stehende.
        assert.deepStrictEqual(urteile,
          [[0, 'good'], [1, 'good'], [2, 'good'], [3, 'stale']]);

        // Die erste laufende Lesung raeumt es sofort wieder weg - ueber denselben echten Weg.
        store.schritt({ art: 'herzschlag_tick', wert: 1 });
        const frisch = kopfStufe.pruefeLesung(await liesAlles(store, srv.port),
          { steuerung: 'wago-s3', parameter, soll, wacht });
        assert.strictEqual(frisch.herzschlag_urteil, 'laeuft');
        assert.strictEqual(frisch.qualitaet, 'good');
        assert.strictEqual(frisch.steht, 0);
      } finally {
        await srv.close();
      }
    });

    it('liest den Kopf mit FC4, little-endian und Basisadresse 4096', async function () {
      if (!DA) this.skip();
      const store = buehne.ladeFall('S3').store();
      assert.strictEqual(store.basisadresse, 4096);
      assert.strictEqual(store.funktionscode, 4);
      assert.strictEqual(store.wortfolge, 'little');
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const [r] = await probeNode.runOps([kopfOp(store, srv.port)], lesen);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.wago_kopf, { signatur_ok: true, erkannt: true, hauptversion: 1,
          nebenversion: 0, kopflaenge: 12, kartenblocklaenge: 42, kartenzahl: 4, herzschlag: 900,
          controller_kennung: 7 });
        // Der Verbindungstest liest NUR den Kopf: eine Anfrage ueber zwoelf Woerter.
        assert.strictEqual(srv.state.anfragen, 1);
        assert.deepStrictEqual(srv.state.letzte, { fn: 4, addr: 4096, count: 12 });
      } finally {
        await srv.close();
      }
    });

    it('nennt die falsche Wortfolge beim Namen statt eine Zahl zu erfinden', async function () {
      if (!DA) this.skip();
      const store = buehne.ladeFall('S3').store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const [r] = await probeNode.runOps([kopfOp(store, srv.port, { word_order: 'big' })], lesen);
        assert.strictEqual(r.wago_kopf.erkannt, false);
        assert.strictEqual(r.wago_kopf.grund, 'wortfolge_abweichend');
        assert.strictEqual(r.wago_kopf.hauptversion, 1);
        assert.ok(!Object.hasOwn(r.wago_kopf, 'controller_kennung'));
      } finally {
        await srv.close();
      }
    });
  });

  describe('Das Typenschild - nur Anzeige', function () {
    it('kommt still ohne die Register aus, wenn sie nicht antworten (Beleg H2)', async function () {
      if (!DA) this.skip();
      const store = buehne.ladeFall('S1').store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        // 0xFA10 liegt ausserhalb des Registerbilds: der Server antwortet mit Ausnahme 0x02 -
        // genau der Fall, den Beleg H2 offen laesst.
        const [mit] = await probeNode.runOps(
          [kopfOp(store, srv.port, { nameplate: true })], lesen);
        const [ohne] = await probeNode.runOps([kopfOp(store, srv.port)], lesen);
        assert.strictEqual(mit.ok, true, 'ein schweigendes Typenschild ist kein Fehlschlag');
        assert.ok(!Object.hasOwn(mit.wago_kopf, 'typenschild'), 'kein erfundener Text');
        assert.deepStrictEqual(mit.wago_kopf, ohne.wago_kopf,
          'das Typenschild aendert kein einziges Urteil');
        assert.ok(srv.state.ausnahmen >= 1, 'die Steuerung hat die Anfrage wirklich abgewiesen');
      } finally {
        await srv.close();
      }
    });
  });

  describe('Mischbetrieb', function () {
    it('laesst die alte read-Op unveraendert neben der neuen laufen', async function () {
      if (!DA) this.skip();
      const store = buehne.ladeFall('S1').store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const alt = { id: 'alt', host: '127.0.0.1', port: srv.port, unit_id: 1,
          fc: store.funktionscode, address: store.basisadresse, data_type: 'u16' };
        const [a, b] = await probeNode.runOps([alt, kopfOp(store, srv.port)], lesen);
        // Die alte Op antwortet genau wie bisher: raw + die gelesenen Woerter, kein Kopf-Block.
        assert.strictEqual(a.ok, true);
        assert.strictEqual(a.raw, registerbild.SIGNATUR[0]);
        assert.ok(!Object.hasOwn(a, 'wago_kopf'));
        assert.strictEqual(b.wago_kopf.erkannt, true);
      } finally {
        await srv.close();
      }
    });

    it('weist eine Kopf-Op ohne Basisadresse als unvollstaendig ab', async function () {
      if (!DA) this.skip();
      const [r] = await probeNode.runOps(
        [{ id: 'kopf', op: probeNode.OP_WAGO_KOPF, host: '127.0.0.1' }],
        () => Promise.reject(new Error('nie gefragt')));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error_code, 'invalid_request');
    });
  });
});

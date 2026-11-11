/**
 * Simulator-Fälle zum „VoltPilot-Registerbild Erzeuger", schlanke Fassung 1.0 (EZ-2).
 *
 * Der Prüfer der Bühne: `fixtures/erzeuger-registerbild-store.js` baut den Register-Store, der
 * In-Process-Modbus-TCP-Server liefert ihn über FC4 aus, und ein KLEINER, UNABHÄNGIGER Leser hier
 * im Spec rechnet die Wörter zurück und vergleicht sie mit
 * `docs/contracts/v2/erzeuger-simulator-vectors.json`: je Fall Signatur, Wortfolge und ein Feld je
 * Abschnitt, dazu Herzschlag, „seit"/Zähler über die Zeit und die Fehlerfälle.
 *
 * Warum der Leser hier steht und nicht in der Fixture: die Fixture ist die Bühne, die EZ-5
 * importiert, um SEINEN Leser zu prüfen. Der Leser hier kennt die Adressen aus `registerbild` der
 * Vektor-Datei (nicht aus der Fixture) und liest nach den Lesarten von EZ-1 (`lesarten_ez1`):
 * Prüfreihenfolge, Gültigkeitsbits je Feld, Zähler ohne Ungültig-Wert, Namen ab `beschreibung_ab`.
 *
 * ⚠ **KEIN BELEG.** Jede Zahl ist ausgedacht; die Gegenprobe steht unten.
 */
'use strict';

const assert = require('node:assert');

const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');
const buehne = require('./fixtures/erzeuger-registerbild-store.js');

const DA = buehne.vektorenVorhanden();
const TYP_CODE = { U16: 'u16', S16: 's16', U32: 'u32', S32: 's32' };
const UNIT_ID = 1;

/**
 * Anfragen des laufenden Bilds: Kopf und Abschnitte bis 37, danach ganze Einheiten-Blöcke, höchstens
 * `anfrage_max_woerter` je Anfrage. Ein Block wird nie geteilt (EZ-1 A1: bis 8 Einheiten eine Anfrage).
 */
function anfragen(rb, te) {
  const max = rb.lesarten_ez1.anfrage_max_woerter;
  const aus = [];
  let addr = rb.basis;
  let offen = rb.einheit.start;
  for (let n = 0; n < te; n++) {
    if (offen + rb.einheit.woerter > max) {
      aus.push({ addr, count: offen });
      addr += offen;
      offen = 0;
    }
    offen += rb.einheit.woerter;
  }
  aus.push({ addr, count: offen });
  return aus;
}

async function lesenAb(port, addr, count) {
  return conn.readRegisters({
    host: '127.0.0.1', port, unitId: UNIT_ID, fc: codec.FN_READ_INPUT, addr, count,
  });
}

/** Eine Lesung: so viele Einheiten, wie die Anlage beim Einrichten hatte (`te_soll`). */
async function lesen(rb, port, teSoll) {
  const woerter = [];
  for (const a of anfragen(rb, teSoll)) {
    /* eslint-disable no-await-in-loop */
    woerter.push(...await lesenAb(port, a.addr, a.count));
  }
  return woerter;
}

function textAus(woerter) {
  const bytes = [];
  for (const w of woerter) bytes.push((w >> 8) & 0xff, w & 0xff);
  const ende = bytes.indexOf(0);
  const s = Buffer.from(ende < 0 ? bytes : bytes.slice(0, ende)).toString('latin1');
  return s === '' ? null : s;
}

/**
 * Der unabhängige Leser: Wörter → Felder. Prüfreihenfolge nach EZ-1 Lesart 4; Ungültig ist das
 * Typ-Maximum (außer bei den drei Zählern, A2), und ein gelöschtes Gültigkeitsbit macht seine Felder
 * unbekannt (Lesart 5) - beides heißt `null`, nie 0.
 */
function liesErzeugerbild(woerter, rb) {
  const feld = Object.fromEntries(rb.felder.map((f) => [f.feld, f]));
  const u16 = (i) => woerter[i] & 0xffff;
  const nein = (grund) => ({ ergebnis: 'nicht_lesbar', grund });
  const lz = rb.lesarten_ez1;

  if (u16(feld.signatur.adresse) !== rb.signatur[0]
      || u16(feld.signatur.adresse + 1) !== rb.signatur[1]) return nein('signatur_fremd');
  if ((u16(feld.version.adresse) >> 8) !== (rb.version >> 8)) return nein('version_fremd');
  const pw = codec.decodeValue(woerter.slice(feld.wortfolge.adresse, feld.wortfolge.adresse + 2), 'u32', 'big');
  if (pw !== rb.pruefwert) return nein('wortfolge_abweichend');
  const te = u16(feld.te_anzahl.adresse);
  if (te < lz.te_anzahl.min || te > lz.te_anzahl.max) return nein('te_anzahl_ungueltig');
  assert.ok(woerter.length >= rb.einheit.start + te * rb.einheit.woerter,
    `der Prüfer hat zu wenig gelesen (${woerter.length} Wörter für ${te} Einheiten)`);

  const zaehler = new Set(lz.zaehler_ohne_ungueltig);
  const wert = (adresse, f) => {
    const w = codec.decodeValue(woerter.slice(adresse, adresse + f.woerter), TYP_CODE[f.typ], 'big');
    const roh = f.woerter === 2 && w < 0 ? w + 0x100000000 : (f.woerter === 1 && w < 0 ? w + 0x10000 : w);
    if (!zaehler.has(f.feld) && roh === rb.ungueltig[f.typ]) return null;
    return w;
  };
  const gedeckt = (werte, bitfeld, roh) => lz.deckung.filter((d) => d.bitfeld === bitfeld)
    .forEach((d) => { if (!((roh >> d.bit) & 1)) d.felder.forEach((k) => { werte[k] = null; }); });

  const felder = {};
  const bitsRoh = {};
  rb.felder.filter((f) => !['signatur', 'wortfolge', 'version'].includes(f.feld)).forEach((f) => {
    felder[f.feld] = wert(f.adresse, f);
    if (f.einheit === 'Bitfeld') bitsRoh[f.feld] = u16(f.adresse);
  });
  Object.entries(bitsRoh).forEach(([k, roh]) => gedeckt(felder, k, roh));

  const einheiten = [];
  for (let n = 0; n < te; n++) {
    const start = rb.einheit.start + n * rb.einheit.woerter;
    const e = {};
    rb.einheit.felder.forEach((f) => { e[f.feld] = wert(start + f.offset, f); });
    gedeckt(e, 't_bits', u16(start + rb.einheit.felder.find((f) => f.feld === 't_bits').offset));
    einheiten.push(e);
  }
  return { ergebnis: 'erkannt', grund: null, felder, bitsRoh, einheiten };
}

/** Die Namen ab `beschreibung_ab` (Lesart 1, 2) - eine eigene Anfrage, nicht im 5-s-Takt. */
async function lesNamen(rb, port, ab, te) {
  const n = rb.namen.woerter_je_text;
  if (ab === 0 || ab === rb.ungueltig.U16 || ab < rb.einheit.start + te * rb.einheit.woerter) return null;
  const w = await lesenAb(port, ab, (2 + te) * n);
  const text = (i) => textAus(w.slice(i * n, (i + 1) * n));
  return {
    netzbetreiber_name: text(0),
    direktvermarkter_name: text(1),
    t_typ_name: Array.from({ length: te }, (_, i) => text(2 + i)),
  };
}

/** Wie sich der Herzschlag zur vorigen erkannten Lesung verhält - eine Beobachtung, keine Leserregel. */
function herzschlagUrteil(jetzt, vorher, schrittgrenze) {
  if (vorher === null || vorher === undefined) return 'erste_lesung';
  if (jetzt === vorher) return 'steht';
  if (jetzt > vorher) return 'laeuft';
  return (jetzt + 0x10000 - vorher) <= schrittgrenze ? 'ueberlauf' : 'rueckwaerts';
}

describe('Erzeuger-Registerbild: Simulator-Fälle (EZ-2)', function () {
  if (!DA) {
    it('ohne die Vektor-Datei des Repos gibt es nichts zu prüfen', function () { this.skip(); });
    return;
  }

  const { datei, faelle } = buehne.ladeFaelle();
  const rb = datei.registerbild;
  const ABSCHNITTE = ['K', 'A', 'N', 'D', 'S'];
  const abschnittVon = Object.fromEntries(rb.felder.map((f) => [f.feld, f.abschnitt]));

  describe('kein Beleg', function () {
    it('jeder Fall ist herkunft: simulator, belegt: false und trägt nie einen Nachweis', function () {
      assert.deepStrictEqual(faelle.map((f) => f.name), [
        'E1 gore', 'E2 buettner', 'F1 herzschlag-steht', 'F2 kopf-fremd', 'F3 wortfolge-falsch',
        'F4 abschnitt-veraltet', 'F5 ungueltig-werte', 'F6 te-anzahl-ungueltig', 'F7 neustart',
      ]);
      faelle.forEach((f) => {
        assert.strictEqual(f.herkunft, 'simulator', `${f.name}: herkunft`);
        assert.strictEqual(f.belegt, false, `${f.name}: belegt MUSS false sein`);
        assert.ok(!('nachweis' in f), `${f.name}: ein Simulator-Fall kann nie einen Nachweis tragen`);
        assert.ok(f.kein_beleg.length > 0, `${f.name}: kein_beleg`);
      });
      assert.match(datei.beweisregel, /nie dem Beleg/);
      assert.match(datei.runtime_version_unberuehrt, /EZ-5/);
    });
  });

  describe('der Aufbau aus der Vorlage geht auf', function () {
    it('Abschnitte liegen lückenlos, jedes Feld in seinem Abschnitt, 32-Bit-Werte auf geraden Adressen', function () {
      let erwartet = 0;
      rb.abschnitte.filter((a) => a.kurz !== 'T').forEach((a) => {
        assert.strictEqual(a.start, erwartet, `${a.kurz} beginnt lückenlos`);
        const eigene = rb.felder.filter((f) => f.abschnitt === a.kurz);
        let w = a.start;
        eigene.forEach((f) => {
          assert.strictEqual(f.adresse, w, `${f.feld} folgt lückenlos`);
          if (f.woerter === 2) assert.strictEqual(f.adresse % 2, 0, `${f.feld} auf gerader Adresse`);
          w += f.woerter;
        });
        assert.strictEqual(w, a.start + a.woerter, `${a.kurz} hat ${a.woerter} Wörter`);
        erwartet = a.start + a.woerter;
      });
      assert.strictEqual(rb.einheit.start, erwartet);
      let o = 0;
      rb.einheit.felder.forEach((f) => {
        assert.strictEqual(f.offset, o, `${f.feld}`);
        if (f.woerter === 2) assert.strictEqual((rb.einheit.start + f.offset) % 2, 0, `${f.feld} gerade`);
        o += f.woerter;
      });
      assert.strictEqual(o, rb.einheit.woerter);
      assert.strictEqual(rb.einheit.woerter % 2, 0, 'jeder Block hält die geraden Adressen');
    });

    it('Gore 68 und Büttner 58 Wörter, Namen bis 219 bzw. 203, Signatur „VP" „EZ", FC4 ab 0', function () {
      const laufend = (te) => rb.einheit.start + te * rb.einheit.woerter;
      assert.strictEqual(laufend(3), rb.woerter_gore);
      assert.strictEqual(laufend(2), rb.woerter_buettner);
      const namenEnde = (te) => rb.namen.ab + (2 + te) * rb.namen.woerter_je_text - 1;
      assert.strictEqual(namenEnde(3), rb.letzte_adresse_gore);
      assert.strictEqual(namenEnde(2), rb.letzte_adresse_buettner);
      assert.deepStrictEqual(rb.signatur, [0x5650, 0x455a]);
      assert.strictEqual(rb.pruefwert, 0x01020304);
      assert.strictEqual(rb.funktionscode, 4);
      assert.strictEqual(rb.basis, 0);
    });

    it('bis 8 Einheiten eine Anfrage, 9 und 10 in zwei, kein Block geteilt (EZ-1 A1)', function () {
      const TABELLE = { 1: 1, 2: 1, 3: 1, 8: 1, 9: 2, 10: 2 };
      Object.entries(TABELLE).forEach(([te, zahl]) => {
        const teile = anfragen(rb, Number(te));
        assert.strictEqual(teile.length, zahl, `${te} Einheiten → ${zahl} Anfragen`);
        teile.forEach((t) => assert.ok(t.count <= rb.lesarten_ez1.anfrage_max_woerter));
        assert.strictEqual(teile.reduce((s, t) => s + t.count, 0), rb.einheit.start + 10 * Number(te));
        teile.slice(1).forEach((t) => assert.strictEqual((t.addr - rb.einheit.start) % rb.einheit.woerter, 0));
      });
    });
  });

  describe('Vokabular und Form der Fälle', function () {
    it('jeder Schritt, jedes Urteil und jeder Grund steht im geschlossenen Vokabular der Datei', function () {
      const schritte = new Set(datei.schritte.wert);
      const urteile = new Set(datei.herzschlag_urteile.wert);
      const gruende = new Set(datei.gruende.wert);
      faelle.forEach((f) => f.lesungen.forEach((l) => {
        l.schritte.forEach((s) => assert.ok(schritte.has(s.art), `${f.name}: Schritt ${s.art}`));
        if (l.herzschlag_urteil !== null) assert.ok(urteile.has(l.herzschlag_urteil), `${f.name}: Urteil`);
        if (l.erwartet.grund !== null) assert.ok(gruende.has(l.erwartet.grund), `${f.name}: Grund`);
      }));
    });

    it('je Fall Signatur und Wortfolge als Rohwörter, und wo lesbar ein Feld je Abschnitt', function () {
      faelle.forEach((f) => {
        const adressen = new Set(f.lesungen[0].woerter.map((w) => w.adresse));
        [0, 1, 2, 3].forEach((a) => assert.ok(adressen.has(a), `${f.name}: Wort ${a} in Lesung 1`));
        const erkannt = f.lesungen.find((l) => l.erwartet.ergebnis === 'erkannt');
        if (!erkannt) {
          // F3: die Wortfolge ist falsch - dann gibt es keinen einzigen Wert, nur den Grund.
          assert.ok(f.lesungen.every((l) => l.erwartet.grund), `${f.name}: nur Gründe`);
          return;
        }
        const gedeckt = new Set(Object.keys(erkannt.erwartet.felder).map((k) => abschnittVon[k]));
        ABSCHNITTE.forEach((a) => assert.ok(gedeckt.has(a), `${f.name}: ein Feld aus Abschnitt ${a}`));
        const einheiten = erkannt.erwartet.einheiten || [];
        assert.ok(einheiten.some((e) => Object.keys(e).length > 0), `${f.name}: ein Feld je Einheit`);
      });
    });
  });

  describe('die Fixture erfindet nichts', function () {
    it('ein vergessenes Feld wird nicht still 0', function () {
      const fall = buehne.ladeFall('E1');
      const a = JSON.parse(JSON.stringify(fall.aufbau));
      delete a.felder.p_nvp_w;
      assert.throws(() => buehne.erstelleErzeugerbild(a), /p_nvp_w fehlt/);
    });

    it('Werte außerhalb des Typs und Namen über 32 Zeichen oder ohne ISO 8859-1 werden abgewiesen', function () {
      const fall = buehne.ladeFall('E1');
      const a = JSON.parse(JSON.stringify(fall.aufbau));
      a.felder.n_cosphi = 40000;
      assert.throws(() => buehne.erstelleErzeugerbild(a), /außerhalb von S16/);
      assert.throws(() => buehne.textWoerter('x'.repeat(33), 16, 'Name'), /mehr als 32/);
      assert.throws(() => buehne.textWoerter('Netz €', 16, 'Name'), /ISO 8859-1/);
      assert.deepStrictEqual(buehne.textWoerter('Wü', 16, 'Name').slice(0, 2), [0x57fc, 0]);
    });

    it('„seit" bleibt bei 65 534 stehen, ungültig bleibt ungültig, der Herzschlag läuft über', function () {
      const store = buehne.ladeFall('E2').store().schritt({ art: 'sekunden', wert: 70000 });
      const adr = (k) => rb.felder.find((f) => f.feld === k).adresse;
      assert.strictEqual(store.lies(adr('d_seit_s'), 1)[0], 65534);
      assert.strictEqual(store.lies(adr('n_seit_s'), 1)[0], rb.ungueltig.U16, 'Büttner: kein Stufenwechsel');
      assert.strictEqual(store.lies(adr('herzschlag'), 1)[0], (65530 + 70000) % 0x10000);
    });

    it('ein 10-Einheiten-Bild liest sich in zwei Anfragen, Einheit 10 vollständig', async function () {
      const fall = buehne.ladeFall('E1');
      const a = JSON.parse(JSON.stringify(fall.aufbau));
      a.einheiten = Array.from({ length: 10 }, (_, i) => ({ ...a.einheiten[0], t_p_ist_w: 1000 * (i + 1) }));
      a.namen.t_typ_name = new Array(10).fill('Growatt');
      a.laenge = undefined;
      const store = buehne.erstelleErzeugerbild(a);
      const srv = await buehne.starteServer(store);
      try {
        const gelesen = liesErzeugerbild(await lesen(rb, srv.port, 10), rb);
        assert.strictEqual(srv.state.anfragen, 2);
        assert.strictEqual(gelesen.einheiten.length, 10);
        assert.strictEqual(gelesen.einheiten[9].t_p_ist_w, 10000);
        assert.strictEqual(gelesen.einheiten[7].t_p_ist_w, 8000, 'Einheit 8 noch in Anfrage 1');
      } finally { await srv.close(); }
    });

    it('FC3 oder eine Adresse hinter dem Bild beantwortet der Server mit einer Ausnahme', async function () {
      const store = buehne.ladeFall('E2').store();
      const srv = await buehne.starteServer(store);
      try {
        await assert.rejects(conn.readRegisters({
          host: '127.0.0.1', port: srv.port, unitId: UNIT_ID, fc: codec.FN_READ_HOLDING, addr: 0, count: 12,
        }));
        await assert.rejects(lesenAb(srv.port, 200, 10), 'Büttner endet bei 203');
        assert.strictEqual(srv.state.ausnahmen, 2);
      } finally { await srv.close(); }
    });
  });

  faelle.forEach((fall) => {
    describe(`Fall ${fall.name}`, function () {
      let store;
      let srv;

      beforeEach(async function () {
        store = fall.store();
        srv = await buehne.starteServer(store);
      });

      afterEach(async function () {
        if (srv) await srv.close();
      });

      it('liefert jede Lesung über FC4 so aus, wie die Vektor-Datei sie beschreibt', async function () {
        const teSoll = fall.aufbau.einheiten.length;
        const grenze = (fall.herzschlag_regel && fall.herzschlag_regel.schrittgrenze) || 120;
        let vorher = null;
        let gleich = 0;
        const gleicheInFolge = [];
        for (const l of fall.lesungen) {
          l.schritte.forEach((s) => store.schritt(s));
          assert.strictEqual(store.zeit(), l.t_s, `Lesung ${l.nr}: Uhr des Falls`);
          /* eslint-disable no-await-in-loop */
          const woerter = await lesen(rb, srv.port, teSoll);
          // Rohwörter, unabhängig vom Leser; jenseits des laufenden Bilds (Lücke, Namen) eigene Anfrage.
          for (const w of (l.woerter || [])) {
            const ist = w.adresse < woerter.length
              ? woerter[w.adresse] : (await lesenAb(srv.port, w.adresse, 1))[0];
            assert.strictEqual(ist, w.wort, `Lesung ${l.nr}, Wort ${w.adresse}: ${w.warum}`);
          }

          const g = liesErzeugerbild(woerter, rb);
          const e = l.erwartet;
          assert.strictEqual(g.ergebnis, e.ergebnis, `Lesung ${l.nr}: ergebnis`);
          assert.strictEqual(g.grund, e.grund, `Lesung ${l.nr}: grund`);
          if (g.ergebnis !== 'erkannt') {
            assert.strictEqual(l.herzschlag_urteil, null, `Lesung ${l.nr}: kein Urteil ohne Bild`);
            continue;
          }

          const hs = g.felder.herzschlag;
          assert.strictEqual(herzschlagUrteil(hs, vorher, grenze), l.herzschlag_urteil, `Lesung ${l.nr}: Herzschlag`);
          gleich = hs === vorher ? gleich + 1 : 1;
          gleicheInFolge.push(gleich);
          vorher = hs;

          Object.entries(e.felder).forEach(([k, w]) => assert.strictEqual(g.felder[k], w, `Lesung ${l.nr}: ${k}`));
          Object.entries(e.bits || {}).forEach(([k, bits]) => Object.entries(bits).forEach(([b, an]) => {
            assert.strictEqual(((g.bitsRoh[k] >> Number(b)) & 1) === 1, an, `Lesung ${l.nr}: ${k} Bit ${b}`);
          }));
          if (e.einheiten) {
            assert.strictEqual(g.einheiten.length, e.einheiten.length, `Lesung ${l.nr}: Einheiten`);
            e.einheiten.forEach((soll, i) => Object.entries(soll).forEach(([k, w]) => {
              assert.strictEqual(g.einheiten[i][k], w, `Lesung ${l.nr}, Einheit ${i + 1}: ${k}`);
            }));
          }
          if (e.namen) {
            assert.deepStrictEqual(await lesNamen(rb, srv.port, g.felder.beschreibung_ab, g.felder.te_anzahl),
              e.namen, `Lesung ${l.nr}: Namen`);
          }
          // Das Protokoll (EZ-7) datiert den Beginn einer Vorgabe auf Lesezeit − „seit".
          Object.entries(e.beginn_t_s || {}).forEach(([kanal, t]) => {
            assert.strictEqual(l.t_s - g.felder[`${kanal}_seit_s`], t, `Lesung ${l.nr}: Beginn ${kanal}`);
          });
          Object.entries(e.ueber_schwelle || {}).forEach(([abschnitt, ueber]) => {
            assert.strictEqual(g.felder.a_alter_s > fall.schwelle_s[abschnitt], ueber,
              `Lesung ${l.nr}: Abschnitt ${abschnitt} über der Schwelle`);
          });
        }
        if (fall.gleiche_lesungen_in_folge) {
          assert.deepStrictEqual(gleicheInFolge, fall.gleiche_lesungen_in_folge);
          assert.strictEqual(gleicheInFolge.indexOf(3) + 1, fall.stillstand_ab_lesung,
            'dreimal derselbe Herzschlag: ab der dritten Lesung veraltet (EZ-1 Lesart 8)');
        }
      });
    });
  });
});

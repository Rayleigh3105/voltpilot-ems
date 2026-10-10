/**
 * Simulator-Vorstufe WAGO-Registerbild v1 (UEMS AP-05 IP-12).
 *
 * Der Prüfer der Bühne: `fixtures/wago-registerbild-store.js` baut den Register-Store, ein
 * In-Process-Modbus-TCP-Server liefert ihn aus, und ein KLEINER, UNABHÄNGIGER Leser hier im Spec
 * rechnet die Wörter zurück und vergleicht sie mit `docs/contracts/v2/wago-simulator-vectors.json`.
 * Sechs Fälle: Normallast, Rücksetzung, Herzschlag steht, Version fremd, Karte fehlt,
 * Bereichsbegrenzung (S6 kam mit IP-8 und setzt ein ganzes Statuswort - die Bitlage darin
 * ist nicht belegt).
 *
 * Warum der Leser hier steht und nicht in der Fixture: die Fixture ist die Bühne, die IP-6 und
 * IP-7 importieren, um IHREN Leser zu prüfen. Läge der Leser in der Fixture, prüfte IP-6 seinen
 * Leser gegen einen Zwilling seiner selbst. Der Leser hier ist bewusst schlicht und bleibt hier.
 *
 * ⚠ **KEIN BELEG.** Es gibt keine WAGO-Hardware; jede Zahl ist ausgedacht. Der Simulator dient dem
 * Bauen, nie dem Beleg — die Gegenprobe steht unten („kein Fall ist belegt"). Aus einem Rohwert
 * wird hier nie eine kWh-Zahl: der Skalierungsfaktor der 750-494 ist nicht belegt.
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');
const buehne = require('./fixtures/wago-registerbild-store.js');

const DA = buehne.vertragVorhanden();
const TYP_CODE = { UInt32: 'u32', Int32: 's32' };

/**
 * Höchstens 120 Wörter je Anfrage - aus dem gemeinsamen Messbudget-Vertrag gelesen, nicht
 * abgeschrieben (`families.modbus.units_per_request`). Das ist die Zahl, die auf dem DRAHT gilt
 * und aus der Vertrag §7 seine Anfragenrechnung ableitet.
 *
 * ⚠ Nicht verwechseln mit der PLANUNGSeinheit `families.wago_registerbild` desselben Vertrags
 * (fünf Energiekarten je Anfrage, AP-07 IP-4): die zählt Budgetkosten, nicht Telegramme - fünf
 * Karten wären 222 Wörter und passen in kein Modbus-Telegramm. Welche der beiden Zahlen die
 * echte Anfrage baut, entscheidet IP-6; hier steht die Wirkung auf dem Draht.
 */
const MAX_WOERTER = (() => {
  const budget = path.join(path.dirname(buehne.VERTRAG_VEKTOREN), 'measurement-budget-vectors.json');
  if (!fs.existsSync(budget)) return 120;
  return JSON.parse(fs.readFileSync(budget, 'utf8')).families.modbus.units_per_request;
})();

/**
 * Anfragen einer Lesung: Kopf zuerst, danach ganze Karten-Blöcke. Ein Karten-Block wird NIE auf
 * zwei Anfragen geteilt (Vertrag §7) - sonst könnten die Hälften aus zwei Lesesätzen stammen.
 */
function anfragen(store) {
  const aus = [];
  let addr = store.basisadresse;
  let offen = store.kopflaenge;
  for (let n = 0; n < store.kartenzahl; n++) {
    if (offen + store.kartenblocklaenge > MAX_WOERTER) {
      aus.push({ addr, count: offen });
      addr += offen;
      offen = 0;
    }
    offen += store.kartenblocklaenge;
  }
  if (offen > 0) aus.push({ addr, count: offen });
  return aus;
}

/** Eine ganze Lesung über den echten Modbus-Weg - so viele Anfragen, wie §7 vorsieht. */
async function lesen(store, port) {
  const woerter = [];
  for (const a of anfragen(store)) {
    /* eslint-disable no-await-in-loop */
    const teil = await conn.readRegisters({
      host: '127.0.0.1', port, unitId: 1, fc: store.funktionscode, addr: a.addr, count: a.count,
    });
    woerter.push(...teil);
  }
  return woerter;
}

/**
 * Der unabhängige Leser: Wörter → Registerbild, in der Reihenfolge des Vertrags §5. Er kennt die
 * Offsets aus dem Vertrag (nicht aus der Fixture) und navigiert mit den Längen AUS DEM KOPF.
 */
function liesRegisterbild(woerter, { wortfolge, soll, aufbau }) {
  const u16 = (i) => woerter[i] & 0xffff;
  const u32 = (i) => codec.decodeValue([woerter[i], woerter[i + 1]], 'u32', wortfolge);
  const o = (feld) => aufbau.kopf[feld].offset;
  const nein = (grund) => ({ ergebnis: 'nicht_lesbar', grund, karten: [] });

  if (u16(o('signatur_1')) !== aufbau.kopf.signatur_1.festlegung
      || u16(o('signatur_2')) !== aufbau.kopf.signatur_2.festlegung) return nein('signatur_fremd');
  if (u16(o('hauptversion')) !== aufbau.kopf.hauptversion.festlegung) return nein('hauptversion_fremd');
  const kopflaenge = u16(o('kopflaenge'));
  const blocklaenge = u16(o('kartenblocklaenge'));
  const kartenzahl = u16(o('kartenzahl'));
  if (kopflaenge < aufbau.kopflaenge || blocklaenge < aufbau.kartenblocklaenge
      || woerter.length < kopflaenge + kartenzahl * blocklaenge) return nein('laenge_ungueltig');
  if (u32(o('wortfolge_pruefwert')) !== aufbau.kopf.wortfolge_pruefwert.festlegung) {
    return nein('wortfolge_abweichend');
  }
  if (kartenzahl !== soll.kartenzahl) return nein('kartenzahl_abweichend');
  const kennung = u32(o('controller_kennung'));
  if (kennung !== soll.controller_kennung) return nein('controller_kennung_abweichend');

  const kopf = {
    hauptversion: u16(o('hauptversion')),
    nebenversion: u16(o('nebenversion')),
    kopflaenge,
    kartenblocklaenge: blocklaenge,
    kartenzahl,
    herzschlag: u16(o('herzschlag')),
    controller_kennung: kennung,
  };

  const bits = aufbau.gueltigkeitBits;
  const karten = [];
  for (let n = 0; n < kartenzahl; n++) {
    const start = kopflaenge + n * blocklaenge;
    const f = (feld) => start + aufbau.karte[feld].offset;
    const k = {
      steckplatz: u16(f('steckplatz')),
      kartentyp: u16(f('kartentyp')),
      variante: u16(f('variante')),
      gueltigkeit: u16(f('gueltigkeit')),
    };
    const sollKarte = soll.karten[n] || {};
    if (k.kartentyp !== 494 && k.kartentyp !== 495) {
      karten.push({ ...k, ergebnis: 'kartentyp_fremd' });
    } else if (k.steckplatz !== sollKarte.steckplatz || k.kartentyp !== sollKarte.kartentyp
        || k.variante !== (sollKarte.variante === undefined ? 0 : sollKarte.variante)) {
      karten.push({ ...k, ergebnis: 'aufbau_abweichend' });
    } else if (!(k.gueltigkeit & (1 << bits.karte_gelesen))) {
      karten.push({
        ...k,
        ergebnis: 'nicht_gelesen',
        kartenregister_32: null,
        kartenregister_35: null,
        statuswoerter: null,
        messwerte_roh: null,
        messwerte: null,
      });
    } else {
      const rohe = [];
      const werte = [];
      aufbau.messwerte.forEach((m) => {
        const paar = [woerter[start + m.offset], woerter[start + m.offset + 1]];
        const roh = codec.decodeValue(paar, 'u32', wortfolge);
        rohe.push(roh);
        if (!m.datentyp) { werte.push(null); return; } // ohne belegten Datentyp kein Wert
        const wert = codec.decodeValue(paar, TYP_CODE[m.datentyp], wortfolge);
        // Ungültig ist nicht 0: der größte Wert des Datentyps heißt kein Messwert.
        werte.push(wert === buehne.UNGUELTIG[m.datentyp] ? null : wert);
      });
      const status = aufbau.karte.statuswoerter;
      karten.push({
        ...k,
        ergebnis: 'gelesen',
        kartenregister_32: (k.gueltigkeit & (1 << bits.kartenregister_32_gelesen))
          ? u16(f('kartenregister_32')) : null,
        kartenregister_35: (k.gueltigkeit & (1 << bits.kartenregister_35_gelesen))
          ? u16(f('kartenregister_35')) : null,
        statuswoerter: (k.gueltigkeit & (1 << bits.statuswoerter_gelesen))
          ? woerter.slice(f('statuswoerter'), f('statuswoerter') + status.woerter) : null,
        messwerte_roh: rohe,
        messwerte: werte,
      });
    }
  }
  return { ergebnis: 'erkannt', grund: null, kopf, karten };
}

/** Wie sich der Herzschlag zur vorigen Lesung verhält - eine Beobachtung, keine Leserregel. */
function herzschlagUrteil(jetzt, vorher, schrittgrenze) {
  if (vorher === null || vorher === undefined) return 'erste_lesung';
  if (jetzt === vorher) return 'steht';
  if (jetzt > vorher) return 'laeuft';
  return (jetzt + 0x10000 - vorher) <= schrittgrenze ? 'ueberlauf' : 'rueckwaerts';
}

describe('WAGO-Registerbild v1: Simulator-Vorstufe (AP-05 IP-12)', function () {
  if (!DA) {
    it('ohne die Vertragsdateien des Repos gibt es nichts zu prüfen', function () { this.skip(); });
    return;
  }

  const { datei, faelle } = buehne.ladeFaelle();
  const aufbau = buehne.ladeAufbau();
  const vertrag = JSON.parse(fs.readFileSync(buehne.VERTRAG_VEKTOREN, 'utf8'));

  describe('kein Beleg (die Beweisregel des Konzepts)', function () {
    it('jeder Fall ist herkunft: simulator, belegt: false und trägt nie einen Nachweis', function () {
      assert.strictEqual(faelle.length, 6, 'sechs Fälle: Normallast, Rücksetzung, Herzschlag '
        + 'steht, Version fremd, Karte fehlt, Bereichsbegrenzung (S6 kam mit IP-8)');
      faelle.forEach((f) => {
        assert.strictEqual(f.herkunft, 'simulator', `${f.name}: herkunft`);
        assert.strictEqual(f.belegt, false, `${f.name}: belegt MUSS false sein`);
        assert.ok(!('nachweis' in f), `${f.name}: ein Simulator-Fall kann nie einen Nachweis tragen`);
        assert.ok(typeof f.kein_beleg === 'string' && f.kein_beleg.length > 0, `${f.name}: kein_beleg`);
      });
      assert.match(datei.beweisregel, /nie dem Beleg/);
    });

    it('wo ein Wert vom unbelegten Faktor der 750-494 abhinge, steht das am Fall', function () {
      faelle.forEach((f) => {
        assert.match(f.faktor_hinweis, /nicht belegt/i, `${f.name}: faktor_hinweis`);
        assert.match(f.faktor_hinweis, /Rohw/, `${f.name}: der Store liefert nur Rohwörter`);
      });
      // Gegenprobe im Bau: weder Bühne noch Fälle kennen einen Skalierungsfaktor oder eine
      // Einheit - im Registerbild wird nichts umgerechnet (Vertrag §4.3). Erst Katalog (IP-4)
      // und Hardwareblatt-Fassung machen aus einem Rohwert eine Menge.
      const quelle = fs.readFileSync(require.resolve('./fixtures/wago-registerbild-store.js'), 'utf8');
      assert.ok(!/0\.01|0\.05/.test(quelle), 'die Fixture rechnet mit keinem Faktor');
      const werte = faelle.flatMap((f) => f.lesungen.flatMap(
        (l) => l.erwartet.karten.flatMap((k) => k.messwerte || [])));
      werte.forEach((w) => assert.ok(w === null || Number.isInteger(w),
        `erwarteter Messwert ${w} ist keine ganze Zahl - im Registerbild wird nichts umgerechnet`));
    });

    it('die RUNTIME_VERSION der Box bleibt unberührt (Befund 8: das hebt erst IP-6)', function () {
      assert.match(datei.runtime_version_unberuehrt, /IP-6/);
    });
  });

  describe('Aufbau und Vokabular kommen aus dem Vertrag von IP-2', function () {
    it('Kopflänge, Kartenblocklänge und Datentypen stammen aus wago-registerbild-vectors.json', function () {
      assert.strictEqual(aufbau.kopflaenge, 12);
      assert.strictEqual(aufbau.kartenblocklaenge, 42);
      assert.strictEqual(aufbau.messwerte.length, 12);
      assert.strictEqual(aufbau.messwerte[0].datentyp, 'UInt32');
      // Messwert 2 (Wirkenergie Lieferung gesamt): Datentyp zu erheben → kein Wert.
      assert.strictEqual(aufbau.messwerte[1].datentyp, null);
      assert.strictEqual(datei.vertrags_vektoren, './wago-registerbild-vectors.json');
    });

    it('jeder Grund und jedes Karten-Ergebnis steht im Vokabular des Vertrags', function () {
      const gruende = new Set(vertrag.lesen.pruefreihenfolge.wert);
      const kartenWorte = new Set(vertrag.lesen.karten_pruefreihenfolge.wert);
      faelle.forEach((f) => f.lesungen.forEach((l) => {
        if (l.erwartet.grund !== null) {
          assert.ok(gruende.has(l.erwartet.grund), `${f.name}: Grund ${l.erwartet.grund}`);
        }
        l.erwartet.karten.forEach((k) => assert.ok(kartenWorte.has(k.ergebnis),
          `${f.name}: Karten-Ergebnis ${k.ergebnis}`));
      }));
    });

    it('jeder Schritt und jedes Herzschlag-Urteil steht im geschlossenen Vokabular der Datei', function () {
      const schritte = new Set(datei.schritte.wert);
      const urteile = new Set(datei.herzschlag_urteile.wert);
      faelle.forEach((f) => f.lesungen.forEach((l) => {
        l.schritte.forEach((s) => assert.ok(schritte.has(s.art), `${f.name}: Schritt ${s.art}`));
        assert.ok(urteile.has(l.herzschlag_urteil), `${f.name}: Urteil ${l.herzschlag_urteil}`);
      }));
    });
  });

  describe('der Store hält die Anfragenrechnung des Vertrags §7 ein', function () {
    // §7: 1 Karte → 1 Anfrage, 2 → 1, 3 → 2, 4 → 2, 5 → 3. Ein Block wird nie geteilt.
    const TABELLE = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3 };
    it('teilt keinen Karten-Block und bleibt unter 120 Wörtern je Anfrage', function () {
      Object.entries(TABELLE).forEach(([k, erwartet]) => {
        const karten = [];
        for (let i = 0; i < Number(k); i++) {
          karten.push({ steckplatz: i + 2, kartentyp: 494, variante: 1, messwerte: [] });
        }
        const store = buehne.erstelleRegisterbild({ karten }, aufbau);
        const teile = anfragen(store);
        assert.strictEqual(teile.length, erwartet, `${k} Karten → ${erwartet} Anfragen (§7)`);
        teile.forEach((t) => assert.ok(t.count <= MAX_WOERTER,
          `höchstens ${MAX_WOERTER} Wörter je Anfrage`));
        const summe = teile.reduce((s, t) => s + t.count, 0);
        assert.strictEqual(summe, 12 + 42 * Number(k), 'lückenlos, ohne Überlappung');
        // jede Anfrage endet auf einer Blockgrenze
        teile.slice(0, -1).forEach((t, i) => {
          const bisher = teile.slice(0, i + 1).reduce((s, x) => s + x.count, 0);
          assert.strictEqual((bisher - 12) % 42, 0, 'Blockgrenze');
        });
      });
    });
  });

  describe('die Fixture erfindet keine Hardware-Wahrheit', function () {
    it('ein gedeuteter Messwert ohne belegten Datentyp wird abgewiesen', function () {
      const werte = new Array(12).fill(0);
      werte[1] = 618437; // Messwert 2: Datentyp zu erheben
      assert.throws(
        () => buehne.erstelleRegisterbild(
          { karten: [{ steckplatz: 2, kartentyp: 494, variante: 1, messwerte: werte }] }, aufbau),
        /keinen belegten Datentyp/,
        'ohne belegten Datentyp ist nur { roh: N } zulässig');
    });

    it('„ungueltig" braucht einen belegten Datentyp', function () {
      const werte = new Array(12).fill(0);
      werte[1] = 'ungueltig';
      assert.throws(
        () => buehne.erstelleRegisterbild(
          { karten: [{ steckplatz: 2, kartentyp: 494, variante: 1, messwerte: werte }] }, aufbau),
        /belegten Datentyp/);
    });

    it('Basisadresse, Funktionscode und Wortfolge sind Parameter, keine Konstanten', function () {
      const gesetzt = new Set();
      faelle.forEach((f) => gesetzt.add(`${f.aufbau.funktionscode}/${f.aufbau.wortfolge}`));
      assert.ok(gesetzt.has('3/big') && gesetzt.has('4/little'),
        'die Fälle decken beide Funktionscodes und beide Wortfolgen ab');
      assert.ok(faelle.some((f) => f.aufbau.basisadresse !== 0), 'und mehr als eine Basisadresse');
    });
  });

  faelle.forEach((fall) => {
    describe(`Fall ${fall.name}`, function () {
      let store;
      let srv;

      beforeEach(async function () {
        store = fall.store();
        srv = await buehne.starteRegisterbildServer(store);
      });

      afterEach(async function () {
        if (srv) await srv.close();
      });

      it('liefert jede Lesung so aus, wie die Vektor-Datei sie beschreibt', async function () {
        const soll = {
          kartenzahl: fall.aufbau.karten.length,
          controller_kennung: fall.aufbau.controller_kennung,
          karten: fall.aufbau.karten,
        };
        const grenze = (fall.herzschlag_regel && fall.herzschlag_regel.schrittgrenze) || 120;
        let vorher = null;
        let gleicheInFolge = 0;
        for (const l of fall.lesungen) {
          l.schritte.forEach((s) => store.schritt(s));
          /* eslint-disable no-await-in-loop */
          const woerter = await lesen(store, srv.port);
          assert.strictEqual(woerter.length, store.laenge(), `${l.nr}: alle Wörter gelesen`);
          const gelesen = liesRegisterbild(woerter, { wortfolge: store.wortfolge, soll, aufbau });

          assert.strictEqual(gelesen.ergebnis, l.erwartet.ergebnis, `Lesung ${l.nr}: ergebnis`);
          assert.strictEqual(gelesen.grund, l.erwartet.grund, `Lesung ${l.nr}: grund`);
          if (l.erwartet.ergebnis === 'erkannt') {
            assert.deepStrictEqual(gelesen.kopf, l.erwartet.kopf, `Lesung ${l.nr}: Kopf`);
          }
          assert.strictEqual(gelesen.karten.length, l.erwartet.karten.length,
            `Lesung ${l.nr}: Kartenzahl im Ergebnis`);
          l.erwartet.karten.forEach((erwartet, i) => {
            Object.entries(erwartet).forEach(([feld, wert]) => {
              assert.deepStrictEqual(gelesen.karten[i][feld], wert,
                `Lesung ${l.nr}, Karte ${i + 1}: ${feld}`);
            });
          });

          const herzschlag = store.herzschlag();
          assert.strictEqual(herzschlagUrteil(herzschlag, vorher, grenze), l.herzschlag_urteil,
            `Lesung ${l.nr}: Herzschlag-Urteil zu ${vorher} → ${herzschlag}`);
          gleicheInFolge = (vorher !== null && herzschlag === vorher) ? gleicheInFolge + 1 : 1;
          if (fall.gleiche_lesungen_in_folge) {
            assert.strictEqual(gleicheInFolge, fall.gleiche_lesungen_in_folge[l.nr - 1],
              `Lesung ${l.nr}: gleiche Lesungen in Folge`);
          }
          vorher = herzschlag;
        }
      });

      if (fall.woerter_stichprobe) {
        it('die Stichprobe der Rohwörter steht an ihrer Adresse im Register', async function () {
          for (const probe of fall.woerter_stichprobe) {
            /* eslint-disable no-await-in-loop */
            const woerter = await conn.readRegisters({
              host: '127.0.0.1', port: srv.port, unitId: 1, fc: store.funktionscode,
              addr: probe.adresse, count: 1,
            });
            assert.strictEqual(woerter[0], probe.wort,
              `Adresse ${probe.adresse} (${probe.warum})`);
          }
        });
      }
    });
  });

  describe('S3: der Herzschlag steht über drei aufeinanderfolgende Lesungen', function () {
    it('nennt die Lesung, ab der die Bedingung des Vertrags §3 erfüllt ist', function () {
      const s3 = buehne.ladeFall('S3');
      assert.strictEqual(s3.stillstand_ab_lesung, 3);
      const gleich = s3.gleiche_lesungen_in_folge;
      assert.strictEqual(gleich[s3.stillstand_ab_lesung - 1], 3, 'drei gleiche Lesungen in Folge');
      // Der Store liefert die Kartenwörter unverändert weiter - stale entscheidet der Leser.
      const store = s3.store();
      const vorher = store.karte(0).woerter();
      store.schritt({ art: 'herzschlag_steht' });
      assert.deepStrictEqual(store.karte(0).woerter(), vorher);
    });
  });

  describe('S4: fremde Hauptversion - kein einziger Kartenwert, aber die Wörter stehen da', function () {
    it('der Simulator versteckt nichts; die Weigerung ist Sache des Lesers', async function () {
      const s4 = buehne.ladeFall('S4');
      assert.strictEqual(s4.kartenwoerter_stehen_trotzdem, true);
      const store = s4.store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const woerter = await lesen(store, srv.port);
        const soll = {
          kartenzahl: s4.aufbau.karten.length,
          controller_kennung: s4.aufbau.controller_kennung,
          karten: s4.aufbau.karten,
        };
        const gelesen = liesRegisterbild(woerter, { wortfolge: store.wortfolge, soll, aufbau });
        assert.strictEqual(gelesen.grund, 'hauptversion_fremd');
        assert.deepStrictEqual(gelesen.karten, [], 'kein einziger Kartenwert');
        // …und trotzdem liegt der erste Zählerstand im Register.
        const ersterMesswert = store.kopflaenge + aufbau.messwerte[0].offset;
        assert.deepStrictEqual(
          woerter.slice(ersterMesswert, ersterMesswert + 2), [56, 21232],
          '0x0038 0x52F0 = 3 691 248 steht im Register - der Leser darf es nur nicht verwenden');
      } finally {
        await srv.close();
      }
    });
  });

  describe('S5: Karte gezogen - die alten Wörter bleiben stehen', function () {
    it('Gültigkeitsbit 0 fällt, die Messwertwörter ändern sich nicht', async function () {
      const s5 = buehne.ladeFall('S5');
      const store = s5.store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        const nr = s5.alte_woerter_stehen_noch.karte;
        const vorher = await lesen(store, srv.port);
        store.karte(nr).nichtGelesen();
        const nachher = await lesen(store, srv.port);
        const start = store.kopflaenge + nr * store.kartenblocklaenge;
        const mw = aufbau.karte.messwerte;
        assert.deepStrictEqual(
          nachher.slice(start + mw.offset, start + mw.offset + mw.woerter),
          vorher.slice(start + mw.offset, start + mw.offset + mw.woerter),
          'die alten Wörter stehen unverändert im Register');
        assert.strictEqual(store.karte(nr).gueltigkeit(), 14, 'nur Bit 0 ist gefallen');
        // Was die Vektor-Datei als „alte Wörter" nennt, sind genau diese Rohwerte.
        const rohe = [];
        aufbau.messwerte.forEach((m) => rohe.push(codec.decodeValue(
          [nachher[start + m.offset], nachher[start + m.offset + 1]], 'u32', store.wortfolge)));
        assert.deepStrictEqual(rohe, s5.alte_woerter_stehen_noch.woerter);
      } finally {
        await srv.close();
      }
    });
  });

  describe('der Server vor dem Store verhält sich wie ein Modbus-Gerät', function () {
    it('fremder Funktionscode und Adresse außerhalb des Registerbilds werden Ausnahmen', async function () {
      const store = buehne.ladeFall('S1').store();
      const srv = await buehne.starteRegisterbildServer(store);
      try {
        await assert.rejects(
          conn.readRegisters({
            host: '127.0.0.1', port: srv.port, unitId: 1, fc: 4, addr: 0, count: 2 }),
          /0x01/, 'S1 liefert über FC3, nicht FC4');
        await assert.rejects(
          conn.readRegisters({
            host: '127.0.0.1', port: srv.port, unitId: 1, fc: 3, addr: 5000, count: 2 }),
          /0x02/, 'ausserhalb des Registerbilds gibt es nichts');
        assert.strictEqual(srv.state.ausnahmen, 2);
      } finally {
        await srv.close();
      }
    });
  });
});

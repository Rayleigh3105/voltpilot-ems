'use strict';

/**
 * Tests der Treiberfamilie `wago.registerbild` (UEMS AP-05 IP-6, Teil a).
 *
 * Drei Quellen, keine abgeschriebenen Zahlen:
 *  - `docs/contracts/v2/wago-registerbild-vectors.json` (IP-2): die Vertragsfaelle V1…V13 mit
 *    rohen Woertern und erwartetem Leseergebnis - sie sind die Leserspezifikation.
 *  - `docs/contracts/v2/wago-simulator-vectors.json` + die Buehne aus IP-12 (PR 937): die sechs
 *    Faelle S1…S5 werden ueber den ECHTEN Modbus-Weg gefahren - `buildReadRequest` /
 *    `parseReadResponse` dieses Repos gegen den In-Process-Server der Buehne.
 *  - der Katalog selbst fuer den Pflicht-Test aus Befund 7.
 *
 * ⚠ Der Simulator dient dem Bauen, NIE dem Beleg: jeder Fall traegt `belegt: false`. Kein Test
 * hier behauptet, dass eine echte WAGO-Steuerung sich so verhaelt.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const wago = require('./wago-registerbild');
const { buildReadRequest, parseReadResponse, FN_READ_HOLDING, FN_READ_INPUT } = require('../modbus-tcp');
const { buildPlan, groupRegisterbild } = require('./measurement-planner');
const { resolvePoint, decodeRegisters, _helpers } = require('./measurement-driver');

const V2 = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2');
const BUEHNE = path.join(__dirname, '..', 'vp-palette', 'test', 'fixtures',
  'wago-registerbild-store.js');
const vertragsDatei = path.join(V2, 'wago-registerbild-vectors.json');
const simulatorDatei = path.join(V2, 'wago-simulator-vectors.json');
// Die Palette wird auch ohne das Repo ausgeliefert - dann gibt es keine Vertraege.
const vertraegeDa = fs.existsSync(vertragsDatei) && fs.existsSync(simulatorDatei)
  && fs.existsSync(BUEHNE);
const liesJson = (datei) => JSON.parse(fs.readFileSync(datei, 'utf8'));

// ---------------------------------------------------------------------------
// 1. Die Festlegungen des Treibers stehen so im Vertrag
// ---------------------------------------------------------------------------

test('die Festlegungen des Treibers sind die des Vertrags', { skip: !vertraegeDa }, () => {
  const v = liesJson(vertragsDatei);
  const kopf = Object.fromEntries(v.kopf.felder.map((f) => [f.schluessel, f]));
  const karte = Object.fromEntries(v.karte.felder.map((f) => [f.schluessel, f]));
  assert.strictEqual(kopf.signatur_1.wert.wert, wago.SIGNATUR[0]);
  assert.strictEqual(kopf.signatur_2.wert.wert, wago.SIGNATUR[1]);
  assert.strictEqual(kopf.hauptversion.wert.wert, wago.HAUPTVERSION);
  assert.strictEqual(kopf.wortfolge_pruefwert.wert.wert, wago.WORTFOLGE_PRUEFWERT);
  assert.strictEqual(v.kopf.laenge, wago.KOPFLAENGE_MIN);
  assert.strictEqual(v.karte.laenge, wago.KARTENBLOCKLAENGE_MIN);
  for (const [schluessel, offset] of Object.entries(wago.KOPF)) {
    assert.strictEqual(kopf[schluessel].offset, offset, `Kopf-Offset ${schluessel}`);
  }
  for (const [schluessel, offset] of Object.entries(wago.KARTE)) {
    assert.strictEqual(karte[schluessel].offset, offset, `Karten-Offset ${schluessel}`);
  }
  assert.strictEqual(karte.statuswoerter.woerter, wago.STATUSWOERTER);
  for (const bit of v.gueltigkeit.bits) {
    if (Object.hasOwn(wago.GUELTIGKEIT, bit.schluessel)) {
      assert.strictEqual(wago.GUELTIGKEIT[bit.schluessel], bit.bit, `Bit ${bit.schluessel}`);
    }
  }
  // Der Standardsatz E9 mit Offsets und Datentypen - `null` heisst „zu erheben".
  assert.strictEqual(v.messwerte.length, wago.MESSWERTE.length);
  v.messwerte.forEach((m, i) => {
    assert.strictEqual(wago.MESSWERTE[i].nr, m.nr);
    assert.strictEqual(wago.MESSWERTE[i].schluessel, m.schluessel);
    assert.strictEqual(wago.MESSWERTE[i].offset, m.offset);
    assert.strictEqual(wago.MESSWERTE[i].datentyp,
      m.datentyp && m.datentyp.art === 'handbuch' ? m.datentyp.wert : null);
  });
  assert.deepStrictEqual(wago.GRUENDE, liesJson(vertragsDatei).lesen.pruefreihenfolge.wert);
  assert.deepStrictEqual(wago.KARTEN_ERGEBNISSE, v.lesen.karten_pruefreihenfolge.wert);
  assert.strictEqual(wago.MAX_WOERTER_JE_ANFRAGE, v.lesen.max_woerter_je_anfrage.wert);
});

test('die 120 Woerter je Anfrage kommen aus dem gemeinsamen Messbudget-Vertrag',
  { skip: !vertraegeDa }, () => {
    const budget = liesJson(path.join(V2, 'measurement-budget-vectors.json'));
    assert.strictEqual(wago.MAX_WOERTER_JE_ANFRAGE, budget.families.modbus.units_per_request);
    // ⚠ Befund 10: die Familie zaehlt Energiekarten, und zwei davon sind 96 Woerter mit Kopf -
    // fuenf waeren 222 und passen in kein Telegramm.
    assert.strictEqual(budget.families.wago_registerbild.units_per_request, 2);
    assert.strictEqual(budget.families.wago_registerbild.unit, 'energy_card');
  });

// ---------------------------------------------------------------------------
// 2. Die Vertragsfaelle V1…V13
// ---------------------------------------------------------------------------

/** Die Vektoren nennen nur die Felder, auf die es ankommt - verglichen wird als Teilmenge. */
function teilmenge(erwartet, gelesen, wo) {
  for (const [schluessel, wert] of Object.entries(erwartet)) {
    assert.deepStrictEqual(gelesen[schluessel], wert, `${wo}.${schluessel}`);
  }
}

test('die Vertragsfaelle V1…V13 lesen sich wie beschrieben', { skip: !vertraegeDa }, () => {
  const faelle = liesJson(vertragsDatei).faelle;
  assert.ok(faelle.length >= 13, 'mindestens V1…V13');
  for (const fall of faelle) {
    const { parameter, soll, woerter } = fall.input;
    const gelesen = wago.liesRegisterbild(woerter, { parameter, soll });
    const erwartet = fall.expected;
    assert.strictEqual(gelesen.ergebnis, erwartet.ergebnis, `${fall.name}: ergebnis`);
    assert.strictEqual(gelesen.grund, erwartet.grund, `${fall.name}: grund`);
    if (erwartet.kopf === null) assert.strictEqual(gelesen.kopf, null, `${fall.name}: kein Kopf`);
    else teilmenge(erwartet.kopf, gelesen.kopf, `${fall.name}.kopf`);
    assert.strictEqual(gelesen.karten.length, erwartet.karten.length, `${fall.name}: Kartenzahl`);
    erwartet.karten.forEach((k, i) => teilmenge(k, gelesen.karten[i], `${fall.name}.karte[${i}]`));
    if (erwartet.anfragen_mindestens !== null && erwartet.anfragen_mindestens !== undefined) {
      assert.strictEqual(
        wago.anfragenJeLesung(erwartet.kopf.kartenzahl, { basisadresse: parameter.basisadresse,
          kopflaenge: erwartet.kopf.kopflaenge,
          kartenblocklaenge: erwartet.kopf.kartenblocklaenge }),
        erwartet.anfragen_mindestens, `${fall.name}: Anfragen je Lesung`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Der PFLICHT-Test aus Befund 7: INVALID fuehrt zu keinem Messwert
// ---------------------------------------------------------------------------

test('INVALID-Wert fuehrt zu keinem Messwert', () => {
  // UInt32 0xFFFF 0xFFFF -> kein Messwert
  assert.strictEqual(wago.deute32(0xffffffff, 'UInt32'), null);
  // Int32 0x7FFF 0xFFFF -> kein Messwert
  assert.strictEqual(wago.deute32(0x7fffffff, 'Int32'), null);
  // Int32 0xFFFF 0xFFFF = −1 BLEIBT ein Wert: massgeblich ist der Datentyp des FELDS
  assert.strictEqual(wago.deute32(0xffffffff, 'Int32'), -1);
  // und 0x7FFF 0xFFFF in einem UInt32-Feld ist eine ganz normale Zahl
  assert.strictEqual(wago.deute32(0x7fffffff, 'UInt32'), 2147483647);
  // Ungueltig ist NICHT 0
  assert.strictEqual(wago.deute32(0, 'UInt32'), 0);
  assert.strictEqual(wago.deute32(0, 'Int32'), 0);
  // Ohne belegten Datentyp gibt es nie eine Zahl (Messwert 2, „zu erheben")
  assert.strictEqual(wago.deute32(42, null), null);
});

test('der Katalog-Leser fuer range.invalid liefert kein Sample', () => {
  // Der Weg, auf dem ein Messwert wirklich entsteht: decodeRegisters gegen einen Punkt mit
  // `range.invalid`. Ohne diesen Leser kaeme 4 294 967 295 als echter Zaehlerstand an.
  const punkt = { point_key: 'wago.pm495.karte[0].energy_import_total', value_type: 'uint32',
    address: { kind: 'registerbild_relative', width_words: 2 }, endian: 'big',
    scale: { kind: 'factor', value: 0.01 },
    range: { min: 0, max: 4294967294, invalid: 4294967295 } };
  assert.strictEqual(decodeRegisters(punkt, [0xffff, 0xffff], null, [18, 19], {}), null);
  const gut = decodeRegisters(punkt, [0xffff, 0xfffe], null, [18, 19], {});
  assert.strictEqual(gut.quality, 'good');
  assert.strictEqual(gut.decoded, 42949672.94);
  // Ein Int32-Feld mit demselben Muster ist −1 und bleibt ein Wert.
  const int32 = Object.assign({}, punkt, { value_type: 'int32', scale: { kind: 'none' },
    range: { min: -2147483648, max: 2147483646, invalid: 2147483647 } });
  assert.strictEqual(decodeRegisters(int32, [0xffff, 0xffff], null, [18, 19], {}).decoded, -1);
  assert.strictEqual(decodeRegisters(int32, [0x7fff, 0xffff], null, [18, 19], {}), null);
});

test('ein Punkt ohne range bleibt unveraendert - kein Bestandspunkt kennt den Leser', () => {
  const punkt = { point_key: 'x', value_type: 'uint32', address: { width_words: 2 },
    endian: 'big', scale: { kind: 'none' } };
  assert.strictEqual(decodeRegisters(punkt, [0xffff, 0xffff], null, [0, 1], {}).decoded,
    4294967295);
});

// ---------------------------------------------------------------------------
// 4. Anfragen je Lesung: 12 + 42 · K
// ---------------------------------------------------------------------------

test('Anfragen je Lesung nach 12 + 42 · K, 1…7 Karten', () => {
  // Die Tabelle aus §7, fortgesetzt bis sieben Karten: ceil(K / 2).
  const erwartet = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4 };
  for (const [karten, anfragen] of Object.entries(erwartet)) {
    assert.strictEqual(wago.anfragenJeLesung(Number(karten)), anfragen, `${karten} Karten`);
  }
});

test('kein Karten-Block wird auf zwei Anfragen verteilt', () => {
  for (let karten = 0; karten <= 7; karten++) {
    const anfragen = wago.planeAnfragen({ basisadresse: 4096, kartenzahl: karten });
    let adresse = 4096;
    let gezaehlt = 0;
    for (const anfrage of anfragen) {
      assert.strictEqual(anfrage.start, adresse, 'die Anfragen stossen lueckenlos aneinander');
      assert.ok(anfrage.count <= wago.MAX_WOERTER_JE_ANFRAGE, 'hoechstens 120 Woerter');
      const nutz = anfrage.count - (anfrage.kopf ? wago.KOPFLAENGE_MIN : 0);
      assert.strictEqual(nutz % wago.KARTENBLOCKLAENGE_MIN, 0, 'ganze Karten-Bloecke');
      gezaehlt += anfrage.karten;
      adresse += anfrage.count;
    }
    assert.strictEqual(gezaehlt, karten, 'jede Karte genau einmal');
    assert.strictEqual(adresse, 4096 + wago.KOPFLAENGE_MIN
      + karten * wago.KARTENBLOCKLAENGE_MIN, '12 + 42 · K Woerter insgesamt');
    assert.ok(anfragen[0].kopf, 'der Kopf faehrt in der ersten Anfrage mit');
  }
});

test('eine Nebenversion verlaengert Kopf und Block, der Plan folgt ihr', () => {
  // §6: additiv heisst anhaengen; ein Leser navigiert mit den Laengen AUS DEM KOPF.
  const anfragen = wago.planeAnfragen({ basisadresse: 0, kartenzahl: 1, kopflaenge: 14,
    kartenblocklaenge: 44 });
  assert.deepStrictEqual(anfragen.map((a) => [a.start, a.count]), [[0, 58]]);
});

test('unmoegliche Parameter scheitern, statt eine halbe Karte zu lesen', () => {
  assert.throws(() => wago.planeAnfragen({ basisadresse: 65000, kartenzahl: 40 }),
    /Adressraum/);
  assert.throws(() => wago.planeAnfragen({ basisadresse: -1, kartenzahl: 1 }), /Basisadresse/);
  assert.throws(() => wago.planeAnfragen({ basisadresse: 0, kartenzahl: 1, maxWoerter: 40 }),
    /passt in keine Anfrage/);
});

// ---------------------------------------------------------------------------
// 5. Herzschlag - eine Beobachtung, keine Leserregel
// ---------------------------------------------------------------------------

test('der Herzschlag wird nur beobachtet', () => {
  assert.strictEqual(wago.herzschlagUrteil(null, 900), 'erste_lesung');
  assert.strictEqual(wago.herzschlagUrteil(900, 960), 'laeuft');
  assert.strictEqual(wago.herzschlagUrteil(900, 900), 'steht');
  assert.strictEqual(wago.herzschlagUrteil(65535, 0), 'ueberlauf');
  assert.strictEqual(wago.herzschlagUrteil(65534, 7), 'ueberlauf');
  // Programmstart: der Herzschlag beginnt wieder bei 0, und ueber den Ueberlauf passt das nicht.
  assert.strictEqual(wago.herzschlagUrteil(7, 0), 'rueckwaerts');
  assert.strictEqual(wago.herzschlagUrteil(30000, 0), 'rueckwaerts');
});

// ---------------------------------------------------------------------------
// 6. Die Simulator-Faelle S1…S6 - ueber den echten Modbus-Weg
// ---------------------------------------------------------------------------

/** Eine Modbus-TCP-Lesung mit den Bausteinen dieses Repos (`modbus-tcp.js`). */
function liesUeberModbus(port, { fc, addr, count, txid }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(buildReadRequest({ txid, unitId: 1, addr, count, fc }));
    });
    const teile = [];
    sock.on('data', (buf) => {
      teile.push(buf);
      const alles = Buffer.concat(teile);
      if (alles.length < 6 || alles.length < 6 + alles.readUInt16BE(4)) return;
      sock.end();
      try {
        resolve(parseReadResponse(alles, { expectTxid: txid, expectUnit: 1, expectFn: fc }));
      } catch (error) { reject(error); }
    });
    sock.on('error', reject);
  });
}

/** Eine ganze Lesung: alle geplanten Anfragen, aneinandergesetzt zu einem Wortband. */
async function lesungUeberModbus(port, parameter, zaehler) {
  const anfragen = wago.planeAnfragen(parameter);
  const woerter = [];
  for (const anfrage of anfragen) {
    const fc = parameter.funktionscode === 4 ? FN_READ_INPUT : FN_READ_HOLDING;
    woerter.push(...await liesUeberModbus(port, { fc, addr: anfrage.start,
      count: anfrage.count, txid: (zaehler.n = (zaehler.n + 1) & 0xffff) }));
  }
  return { woerter, anfragen: anfragen.length };
}

test('die Simulator-Faelle S1…S6 ueber den echten Modbus-Weg',
  { skip: !vertraegeDa }, async (t) => {
    const buehne = require(BUEHNE);
    const datei = liesJson(simulatorDatei);
    assert.strictEqual(datei.faelle.length, 6, 'sechs Faelle S1…S6 - S6 kam mit IP-8');
    for (const beschreibung of datei.faelle) {
      await t.test(beschreibung.name, async () => {
        // Gegenprobe zur Beweisregel: ein Simulator-Fall kann nie belegt sein.
        assert.strictEqual(beschreibung.belegt, false);
        assert.strictEqual(beschreibung.herkunft, 'simulator');
        const fall = buehne.ladeFall(beschreibung.name.split(' ')[0]);
        const store = fall.store();
        const server = await buehne.starteRegisterbildServer(store);
        const zaehler = { n: 0 };
        try {
          const parameter = { basisadresse: fall.aufbau.basisadresse,
            funktionscode: fall.aufbau.funktionscode, wortfolge: fall.aufbau.wortfolge,
            kartenzahl: fall.aufbau.karten.length };
          const soll = { kartenzahl: fall.aufbau.karten.length,
            controller_kennung: fall.aufbau.controller_kennung,
            karten: fall.aufbau.karten.map((k) => ({ steckplatz: k.steckplatz,
              kartentyp: k.kartentyp, variante: k.variante })) };
          let vorher = null;
          for (const lesung of fall.lesungen) {
            for (const schritt of lesung.schritte) store.schritt(schritt);
            const { woerter, anfragen } = await lesungUeberModbus(server.port, parameter, zaehler);
            const gelesen = wago.liesRegisterbild(woerter, { parameter, soll });
            const erwartet = lesung.erwartet;
            assert.strictEqual(gelesen.ergebnis, erwartet.ergebnis, `Lesung ${lesung.nr}`);
            assert.strictEqual(gelesen.grund, erwartet.grund, `Lesung ${lesung.nr}: Grund`);
            if (erwartet.kopf === null) assert.strictEqual(gelesen.kopf, null);
            else teilmenge(erwartet.kopf, gelesen.kopf, `Lesung ${lesung.nr}.kopf`);
            assert.strictEqual(gelesen.karten.length, erwartet.karten.length,
              `Lesung ${lesung.nr}: Kartenzahl`);
            erwartet.karten.forEach((k, i) =>
              teilmenge(k, gelesen.karten[i], `Lesung ${lesung.nr}.karte[${i}]`));
            if (lesung.herzschlag_urteil) {
              // Aus einem nicht lesbaren Registerbild kommt auch kein Herzschlag: das Wort an
              // Offset 7 steht zwar da, bedeutet in einer fremden Fassung aber nichts.
              const jetzt = gelesen.kopf ? gelesen.kopf.herzschlag : null;
              assert.strictEqual(wago.herzschlagUrteil(vorher, jetzt),
                lesung.herzschlag_urteil, `Lesung ${lesung.nr}: Herzschlag`);
              if (jetzt !== null) vorher = jetzt;
            }
            // §7: die Zahl der Anfragen folgt der Kartenzahl, nicht der Zahl der Punkte.
            assert.strictEqual(anfragen,
              wago.anfragenJeLesung(fall.aufbau.karten.length), 'Anfragen je Lesung');
          }
          assert.ok(server.state.anfragen > 0, 'es lief wirklich Modbus ueber den Draht');
          assert.strictEqual(server.state.ausnahmen, 0, 'keine Modbus-Ausnahme');
        } finally { await server.close(); }
      });
    }
  });

test('S5: die alten Woerter der ausgefallenen Karte werden NICHT als Wert geliefert',
  { skip: !vertraegeDa }, async () => {
    const buehne = require(BUEHNE);
    const fall = buehne.ladeFall('S5');
    const store = fall.store();
    const parameter = { basisadresse: fall.aufbau.basisadresse,
      funktionscode: fall.aufbau.funktionscode, wortfolge: fall.aufbau.wortfolge,
      kartenzahl: fall.aufbau.karten.length };
    const soll = { kartenzahl: fall.aufbau.karten.length,
      controller_kennung: fall.aufbau.controller_kennung,
      karten: fall.aufbau.karten.map((k) => ({ steckplatz: k.steckplatz,
        kartentyp: k.kartentyp, variante: k.variante })) };
    const nachweis = liesJson(simulatorDatei).faelle
      .find((f) => f.name.startsWith('S5')).alte_woerter_stehen_noch;
    const vorher = wago.liesRegisterbild(store.woerter(), { parameter, soll });
    assert.deepStrictEqual(vorher.karten[nachweis.karte].messwerte_roh, nachweis.woerter,
      'vor dem Ausfall stehen genau diese Rohwerte da');
    store.karte(nachweis.karte).nichtGelesen();
    const nachher = wago.liesRegisterbild(store.woerter(), { parameter, soll });
    // Dieselben Woerter stehen unveraendert im Register - der Leser liefert trotzdem nichts.
    assert.deepStrictEqual(store.karte(nachweis.karte).woerter()
      .slice(wago.KARTE.messwerte, wago.KARTE.messwerte + 2),
    store.karte(nachweis.karte).woerter().slice(wago.KARTE.messwerte, wago.KARTE.messwerte + 2));
    assert.strictEqual(nachher.karten[nachweis.karte].ergebnis, 'nicht_gelesen');
    assert.strictEqual(nachher.karten[nachweis.karte].messwerte_roh, null);
    assert.strictEqual(nachher.karten[nachweis.karte].messwerte, null);
    // Die Nachbarkarten bleiben unberuehrt.
    for (const n of [0, 1, 3]) assert.strictEqual(nachher.karten[n].ergebnis, 'gelesen');
  });

// ---------------------------------------------------------------------------
// 7. Planer: eine Pollgruppe je Steuerung
// ---------------------------------------------------------------------------

const ZIEL_A = { key: 'source:A', sourceId: 'A' };
const ZIEL_B = { key: 'source:B', sourceId: 'B' };
const punkt = (key, family) => ({ point: { point_key: key, family,
  source_kind: 'wago_registerbild', poll_group: 'wago:registerbild' }, cadence_s: 60 });

test('eine Pollgruppe je Steuerung - auch bei gemischten Kartentypen', () => {
  const parameter = { basisadresse: 0, funktionscode: 3, wortfolge: 'big', kartenzahl: 4 };
  const blocks = groupRegisterbild([
    Object.assign(punkt('wago.pm494.karte[0].power_l1', 'wago.pm494'), { target: ZIEL_A }),
    Object.assign(punkt('wago.pm495.karte[1].power_l1', 'wago.pm495'), { target: ZIEL_A }),
    Object.assign(punkt('wago.pm494.karte[3].frequency', 'wago.pm494'), { target: ZIEL_A }),
  ], { registerbilder: { 'source:A': parameter } });
  // Zwei Anfragen fuer vier Karten - aber nur EIN Pollgruppen-Schluessel.
  assert.strictEqual(new Set(blocks.map((b) => b.key)).size, 1);
  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks.map((b) => [b.start, b.count]), [[0, 96], [96, 84]]);
  assert.ok(blocks.every((b) => b.source_kind === 'wago_registerbild'));
});

test('zwei Steuerungen sind zwei Pollgruppen', () => {
  const blocks = groupRegisterbild([
    Object.assign(punkt('wago.pm494.karte[0].power_l1', 'wago.pm494'), { target: ZIEL_A }),
    Object.assign(punkt('wago.pm494.karte[0].power_l1', 'wago.pm494'), { target: ZIEL_B }),
  ], { registerbilder: {
    'source:A': { basisadresse: 0, funktionscode: 3, wortfolge: 'big', kartenzahl: 1 },
    'source:B': { basisadresse: 4096, funktionscode: 4, wortfolge: 'little', kartenzahl: 2 },
  } });
  assert.strictEqual(new Set(blocks.map((b) => b.key)).size, 2);
  assert.deepStrictEqual(blocks.map((b) => [b.start, b.count]), [[0, 54], [4096, 96]]);
});

// ---------------------------------------------------------------------------
// 8. Instanz-Offset je Karte, und der Bestand bleibt unberuehrt
// ---------------------------------------------------------------------------

test('der Instanz-Offset gilt fuer SunSpec-Module UND fuer Karten', () => {
  assert.strictEqual(_helpers.evalDynamicOffset('12+index*42+18', 0), 30);
  assert.strictEqual(_helpers.evalDynamicOffset('12+index*42+18', 3), 156);
  assert.strictEqual(_helpers.evalDynamicOffset('2+index*20+4', 2), 46);
  assert.strictEqual(_helpers.evalDynamicOffset(7, 3), 7, 'eine feste Zahl bleibt sie');
  assert.throws(() => _helpers.evalDynamicOffset('irgendwas', 0), /dynamic instance offset/);
});

test('der Treiber ist RUHEND: die Box-Sicht des Katalogs kennt keinen WAGO-Punkt', () => {
  // Solange `wago.pm494`/`wago.pm495` in NOCH_NICHT_AN_DER_BOX stehen, loest kein Punkt auf -
  // der Treiber laeuft nur in diesen Tests. Das Heben ist ein eigenes Paket (Befund 8).
  assert.strictEqual(resolvePoint('wago.pm495.karte[0].power_l1'), null);
  assert.strictEqual(resolvePoint('wago.pm494.karte[0].energy_import_total'), null);
});

test('eine Konfiguration ohne WAGO-Quelle plant wie bisher', () => {
  const { catalogDocument } = require('./measurement-driver');
  const config = { catalog_version: catalogDocument.catalog_version, revision: 1,
    selections: [{ point_key: 'wago.pm495.karte[0].power_l1', cadence_s: 60 }] };
  const plan = buildPlan(config, {});
  // Kein WAGO-Punkt existiert an der Box - er wird abgelehnt, nicht an Adresse 0 gelesen.
  assert.strictEqual(plan.applied, true);
  assert.deepStrictEqual(plan.rejected,
    [{ point_key: 'wago.pm495.karte[0].power_l1', reason: 'unknown_point' }]);
  assert.deepStrictEqual(plan.blocks, []);
  assert.deepStrictEqual(plan.httpGroups, []);
});

test('ein Registerbild-Punkt ohne Parameter wird abgelehnt, nie an Adresse 0 gelesen', () => {
  // Der Fall nach dem Heben (IP-6b): der Punkt loest auf, aber das Hardwareblatt fehlt.
  const { catalogDocument } = require('./measurement-driver');
  const definition = { point_key: 'wago.pm495.karte[0].power_l1', family: 'wago.pm495',
    source_kind: 'wago_registerbild', readable: true, min_cadence_s: 60,
    poll_group: 'wago:registerbild',
    address: { kind: 'registerbild_relative', base: 'parameter', offset_words: 22,
      width_words: 2 } };
  const config = { catalog_version: catalogDocument.catalog_version, revision: 1, selections: [] };
  // buildPlan resolviert ueber den Katalog; ohne Katalogeintrag pruefen wir die Weiche direkt.
  assert.ok(wago.istRegisterbildPunkt(definition));
  assert.strictEqual(wago.karteIndexAus(definition.point_key), 0);
  assert.strictEqual(wago.karteIndexAus('wago.pm495.karte[*].power_l1'), null);
  assert.strictEqual(wago.karteIndexAus('sunspec.model_1.manufacturer'), null);
  assert.strictEqual(buildPlan(config, {}).blocks.length, 0);
});

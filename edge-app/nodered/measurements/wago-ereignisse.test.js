'use strict';
/**
 * UEMS AP-05 IP-8 - Ereignisse und Qualitaet aus Statuswort und Zaehlerverlauf.
 *
 * Gefahren, die diese Pruefungen abdecken:
 *  1. **Das Vokabular wird geweitet.** Die drei Arten sind Box-Arten des GEBAUTEN
 *     Ereignis-Vertrags (AP-07 IP-3/IP-8/IP-19). Jede Nachricht dieser Stufe muss durch den
 *     Einliefer-Weg passen, sonst verwirft die Datenannahme in der Cloud den GANZEN Umschlag.
 *  2. **Eine nicht belegte Bitlage wird gedeutet.** Solange die Vertragsvektoren
 *     `bitlage_bereichsbegrenzung` als „zu erheben" fuehren, darf kein Bit eines Statusworts
 *     ueber einen Wert entscheiden - sonst steht eine erfundene Zahl in der Messhistorie.
 *  3. **Ein Ereignis je Lesung statt je Zustandswechsel.** Eine stehende Bereichsbegrenzung
 *     wuerde sonst alle 60 Sekunden ein Ereignis in die Outbox legen.
 *  4. **Mischbetrieb.** Eine Box ohne WAGO-Quelle darf keines dieser Ereignisse senden.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const registerbild = require('./wago-registerbild');
const kopf = require('./wago-kopf');
const stufe = require('./wago-ereignisse');
const einlieferung = require('./device-events');
const { buildReadRequest, parseReadResponse, FN_READ_HOLDING, FN_READ_INPUT } =
  require('../modbus-tcp');

const V2 = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2');
const BUEHNE = path.join(__dirname, '..', 'vp-palette', 'test', 'fixtures',
  'wago-registerbild-store.js');
const vertragsDatei = path.join(V2, 'wago-registerbild-vectors.json');
const simulatorDatei = path.join(V2, 'wago-simulator-vectors.json');
const vokabularDatei = path.join(V2, 'mqtt-events-2.1.schema.json');
// Die Palette wird auch ohne das Repo ausgeliefert - dann gibt es keine Vertraege.
const vertraegeDa = fs.existsSync(vertragsDatei) && fs.existsSync(simulatorDatei)
  && fs.existsSync(BUEHNE);
const liesJson = (datei) => JSON.parse(fs.readFileSync(datei, 'utf8'));

// ---------------------------------------------------------------------------
// 1. Das geschlossene Vokabular bleibt geschlossen
// ---------------------------------------------------------------------------

test('die drei Arten sind Box-Arten des gebauten Vertrags - keine neue', () => {
  for (const art of stufe.ARTEN) {
    assert.ok(einlieferung.ARTEN.includes(art), `${art} ist keine Treiber-Art des Einliefer-Wegs`);
  }
  // Der Einliefer-Weg darf mehr kennen (`layout_changed` gehoert IP-7), diese Stufe nie.
  assert.deepStrictEqual(stufe.ARTEN.filter((a) => !einlieferung.ARTEN.includes(a)), []);
});

test('jede Art steht so im Cloud-Vokabular', { skip: !fs.existsSync(vokabularDatei) }, () => {
  const schema = liesJson(vokabularDatei);
  for (const art of stufe.ARTEN) {
    assert.ok(schema.$defs[`box_${art}`], `box_${art} fehlt im Vertrag`);
  }
});

// ---------------------------------------------------------------------------
// 2. Die nicht belegte Bitlage wird NICHT gedeutet
// ---------------------------------------------------------------------------

test('solange die Bitlage zu erheben ist, deutet die Stufe kein Bit',
  { skip: !vertraegeDa }, () => {
    const v = liesJson(vertragsDatei);
    assert.strictEqual(v.statuswoerter.bitlage_bereichsbegrenzung.art, 'zu erheben',
      'Ist die Bitlage belegt, gehoert sie in den Leser - und dieser Test umgeschrieben');
    // Ein Statuswort mit ALLEN Bits gesetzt: ohne belegte Lage bleibt die Antwort „unbekannt".
    const karte = { statuswoerter: Array(registerbild.STATUSWOERTER).fill(0xffff) };
    for (const m of registerbild.MESSWERTE) {
      assert.strictEqual(stufe.begrenzungLautStatuswort(karte, m.nr, null), null,
        `Messwert ${m.nr}: ohne Bitlage darf nichts gedeutet werden`);
    }
  });

test('die Form des Vertrags steht bereit - vier Bitzahlen aus Pilotschritt 2 genuegen', () => {
  // Statuswort 1 der Gruppe 2 (Wort 4) mit Bit 3 gesetzt; Messwert 5 ist Platz 1 dieser Gruppe.
  const karte = { statuswoerter: [0, 0, 0, 0, 1 << 3, 0, 0, 0, 0, 0, 0, 0] };
  assert.strictEqual(stufe.begrenzungLautStatuswort(karte, 5, [3, 4, 5, 6]), true);
  assert.strictEqual(stufe.begrenzungLautStatuswort(karte, 6, [3, 4, 5, 6]), false);
  // Nicht gelesene Statuswoerter sind unbekannt, nicht „keine Begrenzung".
  assert.strictEqual(stufe.begrenzungLautStatuswort({ statuswoerter: null }, 5, [3, 4, 5, 6]),
    null);
});

test('Gruppe und Platz sind die des Vertrags', { skip: !vertraegeDa }, () => {
  const v = liesJson(vertragsDatei);
  assert.strictEqual(v.statuswoerter.gruppe_deckt.wert,
    'Gruppe 1 = Messwert 1–4, Gruppe 2 = 5–8, Gruppe 3 = 9–12');
  assert.deepStrictEqual(registerbild.MESSWERTE.map((m) => stufe.gruppeVon(m.nr)),
    [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  assert.deepStrictEqual(registerbild.MESSWERTE.map((m) => stufe.platzInGruppe(m.nr)),
    [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  assert.strictEqual(v.statuswoerter.woerter_je_gruppe.wert * v.statuswoerter.gruppen.wert,
    registerbild.STATUSWOERTER);
});

test('der UNGUELTIG-Wert des Datentyps ist die einzige belegte Begrenzung', () => {
  const karte = { messwerte_roh: registerbild.MESSWERTE.map((m) => (m.datentyp
    ? registerbild.UNGUELTIG[m.datentyp] : 4294967295)) };
  registerbild.MESSWERTE.forEach((m, i) => {
    // Messwert 2 hat keinen belegten Datentyp - aus einer Luecke wird nie ein Ereignis.
    assert.strictEqual(stufe.liestUngueltig(karte, i), m.datentyp !== null,
      `Messwert ${m.nr} (${m.schluessel})`);
  });
});

// ---------------------------------------------------------------------------
// 3. Jede Art einmal je Zustandswechsel - an einer gebauten Lesungsfolge
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
  const woerter = [];
  for (const anfrage of registerbild.planeAnfragen(parameter)) {
    const fc = parameter.funktionscode === 4 ? FN_READ_INPUT : FN_READ_HOLDING;
    // eslint-disable-next-line no-await-in-loop
    woerter.push(...await liesUeberModbus(port, { fc, addr: anfrage.start,
      count: anfrage.count, txid: (zaehler.n = (zaehler.n + 1) & 0xffff) }));
  }
  return woerter;
}

/** Ein Fall der Buehne, ueber den echten Modbus-Weg, durch alle drei Stufen. */
async function fahre(name, { bereichsbegrenzungBits = null } = {}) {
  const buehne = require(BUEHNE);
  const fall = buehne.ladeFall(name);
  const store = fall.store();
  const server = await buehne.starteRegisterbildServer(store);
  const zaehler = { n: 0 };
  const wacht = new kopf.HerzschlagWacht();
  const werk = new stufe.WagoEreignisse({ bereichsbegrenzungBits });
  const lesungen = [];
  try {
    const parameter = { basisadresse: fall.aufbau.basisadresse,
      funktionscode: fall.aufbau.funktionscode, wortfolge: fall.aufbau.wortfolge,
      kartenzahl: fall.aufbau.karten.length };
    const soll = { kartenzahl: fall.aufbau.karten.length,
      controller_kennung: fall.aufbau.controller_kennung,
      karten: fall.aufbau.karten.map((k) => ({ steckplatz: k.steckplatz,
        kartentyp: k.kartentyp, variante: k.variante })) };
    for (const lesung of fall.lesungen) {
      for (const schritt of lesung.schritte) store.schritt(schritt);
      // eslint-disable-next-line no-await-in-loop
      const woerter = await lesungUeberModbus(server.port, parameter, zaehler);
      const gelesen = kopf.pruefeLesung(woerter, { steuerung: 'ziel-C', parameter, soll, wacht });
      const ergebnis = werk.lesung(gelesen, { datenquelle: 'quelle-c1', steuerung: 'ziel-C',
        komponente: (karte) => `karte-${karte.steckplatz}`,
        zeitpunkt: new Date(Date.UTC(2026, 8, 18, 10, lesung.nr, 0)) });
      lesungen.push({ beschreibung: lesung, gelesen, ...ergebnis });
    }
  } finally { await server.close(); }
  return { fall, lesungen, werk };
}

test('alle Buehnen-Faelle melden ueber den echten Modbus-Weg genau ihre Ereignisse',
  { skip: !vertraegeDa }, async (t) => {
    const datei = liesJson(simulatorDatei);
    assert.strictEqual(datei.faelle.length, 6, 'sechs Faelle S1…S6');
    // Jede Art muss mindestens einmal ueber die Buehne kommen, sonst prueft der Fall nichts.
    const gesehen = new Set();
    for (const beschreibung of datei.faelle) {
      // eslint-disable-next-line no-await-in-loop
      await t.test(beschreibung.name, async () => {
        assert.strictEqual(beschreibung.belegt, false, 'ein Simulator-Fall ist nie belegt');
        const { lesungen } = await fahre(beschreibung.name.split(' ')[0]);
        lesungen.forEach(({ beschreibung: l, ereignisse }) => {
          assert.ok(Array.isArray(l.ereignisse), `Lesung ${l.nr}: erwartete Ereignisse fehlen`);
          const ohneRahmen = ereignisse.map(({ payload }) => {
            assert.strictEqual(payload.zeitpunkt,
              `2026-09-18T10:0${l.nr}:00Z`, `Lesung ${l.nr}: Messzeit der Lesung`);
            assert.strictEqual(payload.datenquelle, 'quelle-c1');
            // `zeitpunkt`, `datenquelle` und `komponente` sind Kennungen des AUFRUFERS - sie
            // stehen nicht in den Vektoren (der Simulator kennt keine Entitaet des Bestands).
            // Dass `komponente` die Karte nennt, prueft der S6-Fall eigens.
            const { zeitpunkt, datenquelle, komponente, ...rest } = payload;
            gesehen.add(rest.art);
            return rest;
          });
          assert.deepStrictEqual(ohneRahmen, l.ereignisse, `Lesung ${l.nr}: Ereignisse`);
        });
      });
    }
    assert.deepStrictEqual([...gesehen].sort(), [...stufe.ARTEN].sort(),
      'jede der drei Arten kommt auf der Buehne vor');
  });

test('S2: der Ueberlauf ist kein Neustart, der Ruecksprung schon',
  { skip: !vertraegeDa }, async () => {
    const { lesungen } = await fahre('S2');
    const urteile = lesungen.map((l) => l.gelesen.herzschlag_urteil);
    assert.deepStrictEqual(urteile,
      ['erste_lesung', 'laeuft', 'ueberlauf', 'laeuft', 'rueckwaerts']);
    const arten = lesungen.map((l) => l.ereignisse.map((e) => e.payload.art));
    assert.deepStrictEqual(arten, [[], [], [], [], ['device_restart']],
      'nur der Ruecksprung meldet - der Ueberlauf (Lesung 3) nie');
    const neustart = lesungen[4].ereignisse[0].payload;
    assert.strictEqual(neustart.herzschlag_vorher, 7);
    assert.strictEqual(neustart.herzschlag_nachher, 0);
  });

test('S3: das Einfrieren meldet einmal je Episode, nicht je Lesung',
  { skip: !vertraegeDa }, async () => {
    const { lesungen, werk } = await fahre('S3');
    const arten = lesungen.map((l) => l.ereignisse.map((e) => e.payload.art));
    assert.deepStrictEqual(arten, [[], [], [], ['frozen_source']],
      'erst mit der dritten stehenden Lesung, und dann nur einmal');
    // Genau die Lesung, in der IP-7 auf `stale` umschlaegt - keine zweite Schwelle daneben.
    assert.deepStrictEqual(lesungen.map((l) => l.gelesen.qualitaet),
      ['good', 'good', 'good', kopf.QUALITAET_ALT]);
    const eingefroren = lesungen[3].ereignisse[0].payload;
    assert.strictEqual(eingefroren.lesungen, lesungen[3].gelesen.steht);
    assert.strictEqual(eingefroren.herzschlag, 900);
    // Weder `komponente` noch `messkanal`: der Herzschlag steht im Kopf und gilt je Steuerung.
    assert.ok(!('komponente' in eingefroren) && !('messkanal' in eingefroren));
    // Die Episode bleibt offen, solange der Herzschlag steht - erst ein Lauf schliesst sie.
    assert.strictEqual(werk.eingefroren.get('ziel-C'), true);
  });

test('S6: die Bereichsbegrenzung meldet beim Eintreten, nicht beim Bestehen',
  { skip: !vertraegeDa }, async () => {
    const { lesungen } = await fahre('S6');
    const arten = lesungen.map((l) => l.ereignisse.map((e) => e.payload.art));
    assert.deepStrictEqual(arten, [[], ['range_limit'], [], [], ['range_limit']],
      'Lesung 3 besteht nur - Lesung 5 ist ein neuer Eintritt nach Lesung 4');
    // Das rohe Statuswort faehrt mit, damit Pilotschritt 2 die Bitlage daran ablesen kann.
    assert.strictEqual(lesungen[1].ereignisse[0].payload.statuswort, 64);
    assert.strictEqual(lesungen[1].ereignisse[0].payload.komponente, 'karte-2');
    // Lesung 5: Gueltigkeit Bit 3 = 0, also KEIN Statuswort - und keines wird als 0 erfunden.
    assert.strictEqual(lesungen[4].gelesen.karten[0].statuswoerter, null);
    assert.ok(!('statuswort' in lesungen[4].ereignisse[0].payload),
      'ein nicht gelesenes Statuswort fehlt, es ist nicht 0');
  });

// ---------------------------------------------------------------------------
// 4. Qualitaet je Wert - die gebauten Regeln, keine neue daneben
// ---------------------------------------------------------------------------

test('die Qualitaet je Wert traegt `stale` und „kein Wert" zusammen',
  { skip: !vertraegeDa }, async () => {
    const s1 = await fahre('S1');
    const erste = s1.lesungen[0].qualitaet.filter((q) => q.steckplatz === 2);
    assert.strictEqual(erste.length, registerbild.MESSWERTE.length, 'je Wert eine Aussage');
    // Messwert 2 hat keinen belegten Datentyp: kein Wert, also auch keine Qualitaet.
    assert.strictEqual(erste.find((q) => q.nr === 2).qualitaet, null);
    assert.strictEqual(erste.find((q) => q.nr === 1).qualitaet, kopf.QUALITAET_NORMAL);

    // S3, Lesung 4: der Herzschlag steht - jeder VORHANDENE Wert ist `stale`.
    const s3 = await fahre('S3');
    const stale = s3.lesungen[3].qualitaet.filter((q) => q.steckplatz === 2);
    assert.strictEqual(stale.find((q) => q.nr === 1).qualitaet, kopf.QUALITAET_ALT);
    assert.strictEqual(stale.find((q) => q.nr === 2).qualitaet, null, 'kein Wert bleibt kein Wert');

    // S6, Lesung 2: Messwert 1 liest UNGUELTIG. Das ist eine BEOBACHTUNG (`invalid`), kein
    // Unwissen - und geliefert wird er trotzdem nicht, dafuer sorgt IP-6 (PR 942).
    const s6 = await fahre('S6');
    const begrenzt = s6.lesungen[1].qualitaet.filter((q) => q.steckplatz === 2);
    assert.strictEqual(begrenzt.find((q) => q.nr === 1).qualitaet, stufe.QUALITAET_UNGUELTIG);
    assert.strictEqual(s6.lesungen[1].gelesen.karten[0].messwerte[0], null,
      'IP-6 liefert den UNGUELTIG-Wert nicht als Zahl aus - die Stille bekommt nur ihren Grund');
    assert.strictEqual(begrenzt.find((q) => q.nr === 3).qualitaet, kopf.QUALITAET_NORMAL,
      'die anderen Werte derselben Karte bleiben gut');
    // Die zwei null-Faelle bleiben getrennt: Messwert 2 hat keinen belegten Datentyp - Unwissen.
    assert.strictEqual(begrenzt.find((q) => q.nr === 2).qualitaet, null,
      'aus Unwissen wird nie `invalid`');
  });

test('eine nicht gelesene Karte sagt nichts - und ihr Stand ueberdauert nicht',
  { skip: !vertraegeDa }, async () => {
    const { lesungen } = await fahre('S5');
    assert.strictEqual(lesungen[1].gelesen.karten[2].ergebnis, 'nicht_gelesen');
    assert.deepStrictEqual(lesungen[1].ereignisse, [],
      'eine fehlende Karte ist keine Bereichsbegrenzung');
    assert.deepStrictEqual(lesungen[1].qualitaet.filter((q) => q.steckplatz === 4), [],
      'ohne Kartenwerte gibt es keine Qualitaet zu vergeben');
  });

test('ein unlesbares Registerbild meldet hier nichts - das ist IP-7',
  { skip: !vertraegeDa }, async () => {
    const { lesungen } = await fahre('S4');
    assert.notStrictEqual(lesungen[0].gelesen.ergebnis, 'erkannt');
    assert.deepStrictEqual(lesungen[0].ereignisse, []);
    assert.deepStrictEqual(lesungen[0].qualitaet, []);
  });

// ---------------------------------------------------------------------------
// 4b. Die Faelle des Referenzdatensatzes (AP-05 IP-1)
// ---------------------------------------------------------------------------

const REFERENZ = path.join(V2, 'fixtures', 'wago-referenzdatensatz',
  'wago-referenzdatensatz.valid.vorstufe-simulator.json');

test('jedes Ereignis-Wort des Referenzdatensatzes kennt der gebaute Vertrag',
  { skip: !fs.existsSync(REFERENZ) }, () => {
    const faelle = liesJson(REFERENZ).faelle;
    const worte = new Set(faelle.flatMap((f) => f.expected.events));
    // Die drei Arten dieser Stufe muessen vorkommen, sonst prueft der Datensatz IP-8 nicht.
    for (const art of stufe.ARTEN) {
      assert.ok(worte.has(art), `der Referenzdatensatz hat keinen Fall fuer ${art}`);
    }
    // `counter_reset` bleibt drin und bleibt Sache des Writers - IP-8 fasst ihn nicht an.
    assert.ok(worte.has('counter_reset'));
    assert.ok(!stufe.ARTEN.includes('counter_reset'));
  });

test('der Bereichsbegrenzungs-Fall des Referenzdatensatzes meldet range_limit',
  { skip: !(vertraegeDa && fs.existsSync(REFERENZ)) }, async () => {
    const fall = liesJson(REFERENZ).faelle
      .find((f) => f.expected.events.includes('range_limit'));
    assert.ok(fall, 'kein range_limit-Fall im Referenzdatensatz');
    assert.strictEqual(fall.belegt, false);
    // Die zwei Woerter des Falls sind der UNGUELTIG-Wert eines UInt32-Felds.
    const [hoch, tief] = fall.input.woerter.energy_import_total;
    assert.strictEqual(hoch * 0x10000 + tief, registerbild.UNGUELTIG.UInt32);

    const buehne = require(BUEHNE);
    const basis = buehne.ladeFall('S1');
    const store = basis.store();
    const server = await buehne.starteRegisterbildServer(store);
    try {
      const parameter = { basisadresse: basis.aufbau.basisadresse,
        funktionscode: basis.aufbau.funktionscode, wortfolge: basis.aufbau.wortfolge,
        kartenzahl: basis.aufbau.karten.length };
      const soll = { kartenzahl: basis.aufbau.karten.length,
        controller_kennung: basis.aufbau.controller_kennung,
        karten: basis.aufbau.karten.map((k) => ({ steckplatz: k.steckplatz,
          kartentyp: k.kartentyp, variante: k.variante })) };
      const wacht = new kopf.HerzschlagWacht();
      const werk = new stufe.WagoEreignisse();
      const fahrLesung = async () => {
        const woerter = await lesungUeberModbus(server.port, parameter, { n: 0 });
        const gelesen = kopf.pruefeLesung(woerter, { steuerung: 'ziel-C', parameter, soll, wacht });
        return { gelesen, ...werk.lesung(gelesen, { datenquelle: 'q', steuerung: 'ziel-C' }) };
      };
      await fahrLesung();
      // Genau der Eingang des Falls: Messwert 1 liest den UNGUELTIG-Wert.
      store.karte(0).messwertSetzen(1, 'ungueltig');
      store.herzschlagTick(60);
      const zweite = await fahrLesung();
      assert.deepStrictEqual(zweite.ereignisse.map((e) => e.payload.art),
        fall.expected.events, 'die Ereignisse des Falls');
      // Und die erwartete Qualitaet des Falls steht an genau diesem Wert.
      const q = zweite.qualitaet.find((x) => x.steckplatz === 2 && x.nr === 1);
      assert.strictEqual(q.qualitaet, fall.expected.quality);
      assert.strictEqual(fall.expected.samples, 0, 'kein Sample - Stille ist eine Luecke');
      assert.strictEqual(zweite.gelesen.karten[0].messwerte[0], null);
    } finally { await server.close(); }
  });

test('der Neustart-Fall des Referenzdatensatzes meldet device_restart',
  { skip: !fs.existsSync(REFERENZ) }, () => {
    const fall = liesJson(REFERENZ).faelle
      .find((f) => f.expected.events.includes('device_restart'));
    assert.ok(fall, 'kein device_restart-Fall im Referenzdatensatz');
    const [vorher, nachher] = fall.input.heartbeat;
    // Der Ruecksprung des Falls ist `rueckwaerts` - kein Ueberlauf passt dazu.
    assert.strictEqual(registerbild.herzschlagUrteil(vorher, nachher), 'rueckwaerts');
    const wacht = new kopf.HerzschlagWacht();
    const werk = new stufe.WagoEreignisse();
    const arten = fall.input.heartbeat.map((hz) => {
      const beobachtung = wacht.beobachte('ziel-C', hz);
      const gelesen = { ergebnis: 'erkannt', karten: [], qualitaet: beobachtung.qualitaet,
        steht: beobachtung.steht, herzschlag_urteil: beobachtung.urteil,
        herzschlag_vorher: beobachtung.herzschlag_vorher,
        herzschlag_nachher: beobachtung.herzschlag_nachher };
      return werk.lesung(gelesen, { datenquelle: 'q', steuerung: 'ziel-C' })
        .ereignisse.map((e) => e.payload);
    });
    assert.deepStrictEqual(arten[0], [], 'die erste Lesung ist kein Neustart');
    assert.deepStrictEqual(arten[1].map((e) => e.art), fall.expected.events);
    assert.strictEqual(arten[1][0].herzschlag_vorher, vorher);
    assert.strictEqual(arten[1][0].herzschlag_nachher, nachher);
  });

test('BEFUND: der Einfrier-Fall des Referenzdatensatzes zaehlt eine Lesung weniger als IP-7',
  { skip: !(vertraegeDa && fs.existsSync(REFERENZ)) }, () => {
    const fall = liesJson(REFERENZ).faelle
      .find((f) => f.expected.events.includes('frozen_source'));
    assert.ok(fall, 'kein frozen_source-Fall im Referenzdatensatz');
    // Der Datensatz (IP-1) und die Buehne (IP-12) lesen Vertrag §3 als DREI GLEICHE Lesungen:
    // `heartbeat: [1731, 1731, 1731]`, und S3 nennt `stillstand_ab_lesung: 3`.
    assert.strictEqual(fall.input.heartbeat.length, 3);
    assert.strictEqual(new Set(fall.input.heartbeat).size, 1, 'drei gleiche Lesungen');
    // Die GEBAUTE Schwelle aus IP-7 zaehlt dagegen stehende UEBERGAENGE (`STEHT_AB = 3`): der
    // erste Stillstand ist erst die zweite Lesung, `stale` also erst die VIERTE. Ein Poll-Takt
    // Unterschied. Diese Stufe faellt bewusst nicht mit einer eigenen Zahl daneben, sondern
    // faehrt auf dem Urteil von IP-7 - wo die Schwelle liegt, entscheidet IP-7.
    const wacht = new kopf.HerzschlagWacht();
    const werk = new stufe.WagoEreignisse();
    const gemeldet = [];
    for (const hz of [...fall.input.heartbeat, 1731]) {
      const beobachtung = wacht.beobachte('ziel-C', hz);
      const gelesen = { ergebnis: 'erkannt', karten: [], qualitaet: beobachtung.qualitaet,
        steht: beobachtung.steht, herzschlag_urteil: beobachtung.urteil,
        herzschlag_nachher: beobachtung.herzschlag_nachher };
      gemeldet.push(werk.lesung(gelesen, { datenquelle: 'q', steuerung: 'ziel-C' })
        .ereignisse.map((e) => e.payload.art));
    }
    assert.deepStrictEqual(gemeldet, [[], [], [], ['frozen_source']],
      'nach dem gebauten Stand der Dinge meldet erst die vierte gleiche Lesung');
    assert.strictEqual(kopf.STEHT_AB, 3, 'die Schwelle von IP-7');
  });

// ---------------------------------------------------------------------------
// 5. Mischbetrieb: eine Box ohne WAGO-Quelle
// ---------------------------------------------------------------------------

test('ohne WAGO-Lesung sendet die Stufe nichts', () => {
  const werk = new stufe.WagoEreignisse();
  for (const gelesen of [{}, { ergebnis: 'nicht_lesbar', grund: 'signatur_fremd' },
    { ergebnis: 'erkannt', karten: [] }]) {
    const { ereignisse, qualitaet } = werk.lesung(gelesen,
      { datenquelle: 'quelle-x', steuerung: 'ziel-X' });
    assert.deepStrictEqual(ereignisse, []);
    assert.deepStrictEqual(qualitaet, []);
  }
});

test('keine Laufzeit der Box haengt an dieser Stufe', () => {
  // Der Weg ist gebaut, aber noch nicht verdrahtet: IP-8 ist ruhend, es gibt kein Edge-Release.
  // Faengt ein Fluss an, diese Stufe zu rufen, gehoert dieser Test angepasst - und ein
  // Mischbetriebs-Nachweis dazu, dass eine Box ohne WAGO-Quelle sich byte-gleich verhaelt.
  const flows = path.join(__dirname, '..', 'flows.json');
  if (fs.existsSync(flows)) {
    assert.ok(!fs.readFileSync(flows, 'utf8').includes('wago-ereignisse'),
      'flows.json bettet diese Stufe nicht ein');
  }
});

// ---------------------------------------------------------------------------
// 6. Der Einliefer-Weg nimmt jede Nachricht dieser Stufe an
// ---------------------------------------------------------------------------

test('jede Nachricht passt unveraendert durch den Einliefer-Weg',
  { skip: !vertraegeDa }, async () => {
    let geprueft = 0;
    for (const name of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
      // eslint-disable-next-line no-await-in-loop
      const { lesungen } = await fahre(name);
      for (const { ereignisse } of lesungen) {
        for (const { topic, payload } of ereignisse) {
          assert.strictEqual(topic, einlieferung.TOPIC, 'der eine lokale Bus-Zweig');
          // Der Briefkasten prueft das geschlossene Vokabular noch einmal: was er zu `null`
          // macht, wuerde in der Cloud den ganzen Umschlag kosten.
          assert.deepStrictEqual(einlieferung.ereignis(payload), payload,
            `${payload.art} wird vom Einliefer-Weg nicht unveraendert angenommen`);
          geprueft += 1;
        }
      }
    }
    assert.ok(geprueft >= stufe.ARTEN.length, `nur ${geprueft} Nachrichten geprueft`);
  });

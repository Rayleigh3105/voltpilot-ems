'use strict';

/**
 * Der Leser des Erzeuger-Bilds (EZ-5) gegen die Vorlage `register-vorlage-schlank.json`
 * (Kopie unter testdata/) mit dem Abgleich aus EZ-1 (A1, A2, Lesarten 1-12).
 *
 * Die Bilder baut `testdata/erzeuger-bilder.js` aus den Adressen der VORLAGE, nicht aus dem
 * Leser - so prueft hier nicht der Leser sich selbst.
 */

const test = require('node:test');
const assert = require('node:assert');

const bild = require('./erzeuger-registerbild');
const { ErzeugerStufe } = require('./erzeuger-ereignisse');
const { ErzeugerMeldung, meldeSchluessel } = require('./erzeuger-meldung');
const deviceEvents = require('./device-events');
const bilder = require('./testdata/erzeuger-bilder');
const { catalogDocument } = require('./measurement-driver');

const V = bilder.VORLAGE;
const wertVon = (gelesen, punkt) => gelesen.werte.find((w) => w.punkt === punkt);

// ---------------------------------------------------------------------------
// Der Leser und die Vorlage sagen dasselbe
// ---------------------------------------------------------------------------

test('jedes Feld der Vorlage steht mit Adresse, Breite und Typ im Leser - und nichts darueber hinaus', () => {
  const vorlage = V.felder_einheit_1.filter((f) => f.abschnitt !== 'K');
  const leser = bild.FELDER.filter((f) => f.abschnitt !== 'kopf').map((f) => ({ feld: f.feld, typ: f.typ,
    adresse: f.einheit ? bild.FESTER_TEIL + f.offset : f.offset,
    woerter: f.typ === 'U32' || f.typ === 'S32' ? 2 : 1 }));
  assert.deepStrictEqual(leser, vorlage.map((f) => ({ feld: f.feld, typ: f.typ, adresse: f.adresse,
    woerter: f.woerter })));
  const kopf = V.felder_einheit_1.filter((f) => f.abschnitt === 'K');
  assert.deepStrictEqual(Object.entries(bild.KOPF).filter(([k]) => k !== 'signatur_2')
    .map(([k, v]) => [k === 'signatur_1' ? 'signatur' : k, v]),
  kopf.map((f) => [f.feld, f.adresse]));
  // Die vier Kopf-Messpunkte stehen an ihrer Adresse der Vorlage.
  assert.deepStrictEqual(bild.FELDER.filter((f) => f.abschnitt === 'kopf').map((f) => [f.feld, f.offset, f.typ]),
    kopf.filter((f) => ['te_anzahl', 'programmstand', 'steuerung_id', 'anlagenart'].includes(f.feld))
      .map((f) => [f.feld, f.adresse, f.typ]));
  assert.deepStrictEqual(bild.SIGNATUR, kopf[0].einheit.split(' ').map(Number));
  assert.strictEqual(bild.WORTFOLGE_PRUEFWERT, Number(kopf[1].einheit));
  assert.strictEqual(bild.KOPFLAENGE, V.abschnitte[0].woerter);
  assert.strictEqual(bild.FESTER_TEIL, bilder.EINHEIT_AB);
  assert.strictEqual(bild.EINHEIT_LAENGE, bilder.EINHEIT_WOERTER);
  assert.strictEqual(bild.MAX_EINHEITEN, V.max_einheiten);
  assert.strictEqual(bild.NAME_WOERTER, V.namen.woerter_je_text);
  assert.strictEqual(bild.laengeBild(3), V.worte_gore);
  assert.strictEqual(bild.laengeBild(2), V.worte_buettner);
  for (const [typ, hex] of Object.entries(V.regeln.ungueltig)) {
    assert.strictEqual(bild.UNGUELTIG[typ], Number(hex), typ);
  }
  assert.strictEqual(V.regeln.funktionscode, 4);
});

test('die Namen stehen relativ zu beschreibung_ab - mit 140 genau die Adressen der Vorlage (Lesart 1)', () => {
  const kopf = { te_anzahl: 3, beschreibung_ab: V.namen.ab };
  const bereich = bild.namensBereich(kopf);
  assert.deepStrictEqual(bereich, { start: 140, count: 80 });
  assert.strictEqual(bereich.start + bereich.count - 1, V.namen.letzte_adresse_gore);
  assert.strictEqual(bild.namensBereich({ te_anzahl: 2, beschreibung_ab: 140 }).start
    + bild.namensBereich({ te_anzahl: 2, beschreibung_ab: 140 }).count - 1, V.namen.letzte_adresse_buettner);
  const adressen = [bild.NAMEN[0].offset, bild.NAMEN[1].offset, bild.TYP_NAME.offset]
    .map((o) => V.namen.ab + o);
  assert.deepStrictEqual(adressen, V.namen.felder_einheit_1.map((f) => f.adresse));
});

test('die Box-Sicht des Katalogs (EZ-6) fuehrt genau die Punkte des Lesers - an derselben Adresse', () => {
  const imKatalog = catalogDocument.points.filter((p) => p.family === bild.FAMILIE);
  // Einheiten stehen als Vorlage erzeuger.te[*] im Katalog, je Feld einmal.
  const vorlagen = [...new Set(bild.punkteFuer(1).map(bild.vorlageVon))].sort();
  assert.deepStrictEqual(imKatalog.map((p) => p.point_key).sort(), vorlagen);
  for (const p of imKatalog) {
    assert.strictEqual(p.source_kind, bild.QUELLENART, p.point_key);
    assert.ok(p.min_cadence_s >= bild.LESETAKT_S, p.point_key);
    const feld = bild.FELDER.find((f) => p.point_key.endsWith(`.${f.feld}`));
    // Der Katalog sagt fuer Einheit n „28 + n · 10 + Feld"; bei n = 1 ist das 38 + Feld.
    const formel = typeof p.address.offset_words === 'string'
      ? p.address.offset_words.match(/^(\d+)\+index\*(\d+)\+(\d+)$/) : null;
    const offset = formel ? Number(formel[1]) + 1 * Number(formel[2]) + Number(formel[3])
      : p.address.offset_words;
    assert.strictEqual(offset, feld.einheit ? bild.FESTER_TEIL + feld.offset : feld.offset, p.point_key);
    assert.strictEqual(p.address.width_words, feld.typ === 'U32' || feld.typ === 'S32' ? 2 : 1, p.point_key);
    // Faktor und Einheit des Katalogs sind die des Lesers.
    assert.strictEqual(p.scale.kind === 'factor' ? p.scale.value : undefined, feld.faktor, p.point_key);
  }
  assert.strictEqual(new Set(bild.punkteFuer(10)).size, 26 + 10 * 7);
});

// ---------------------------------------------------------------------------
// Anfragen
// ---------------------------------------------------------------------------

test('bis 8 Einheiten eine Anfrage, ab 9 zwei - ein Einheiten-Block wird nie geteilt (EZ-1 A1)', () => {
  for (let n = 1; n <= 8; n++) {
    assert.deepStrictEqual(bild.planeAnfragen({ basisadresse: 0, teAnzahl: n }),
      [{ start: 0, count: 38 + 10 * n, kopf: true, einheit_von: 1, einheiten: n }], `n=${n}`);
  }
  assert.deepStrictEqual(bild.planeAnfragen({ basisadresse: 100, teAnzahl: 9 }), [
    { start: 100, count: 118, kopf: true, einheit_von: 1, einheiten: 8 },
    { start: 218, count: 10, kopf: false, einheit_von: 9, einheiten: 1 }]);
  assert.deepStrictEqual(bild.planeAnfragen({ basisadresse: 0, teAnzahl: 10 }).map((a) => a.count), [118, 20]);
  for (const n of [0, 11, 0xffff]) {
    assert.throws(() => bild.planeAnfragen({ basisadresse: 0, teAnzahl: n }));
  }
  assert.throws(() => bild.planeAnfragen({ basisadresse: 65500, teAnzahl: 3 }), /Adressraum/);
});

test('Namen: hoechstens sieben je Anfrage, nie ein Name geteilt', () => {
  const bereich = bild.namensBereich({ te_anzahl: 10, beschreibung_ab: 140 });
  assert.deepStrictEqual(bereich, { start: 140, count: 192 });
  assert.deepStrictEqual(bild.planeNamen(bereich), [{ start: 140, count: 112 }, { start: 252, count: 80 }]);
  for (const a of bild.planeNamen(bereich)) assert.strictEqual(a.count % 16, 0);
  assert.deepStrictEqual(bild.planeNamen(null), []);
});

// ---------------------------------------------------------------------------
// Gore und Buettner
// ---------------------------------------------------------------------------

test('Gore: PV, drei Wechselrichter, Netzbetreiber per Fernwirktechnik, kein Direktvermarkter', () => {
  const woerter = bilder.gore();
  const g = bild.liesErzeugerbild(woerter.slice(0, 68), { soll: { te_anzahl: 3, steuerung_id: 4711 } });
  assert.strictEqual(g.ergebnis, 'erkannt');
  assert.deepStrictEqual(g.kopf, { hauptversion: 1, nebenversion: 0, te_anzahl: 3, herzschlag: 1000,
    programmstand: 2610, steuerung_id: 4711, anlagenart: 1, beschreibung_ab: 140 });
  // Vorzeichen (Lesart 11): + Bezug / − Einspeisung am Netzpunkt, + Erzeugung.
  assert.strictEqual(wertVon(g, 'erzeuger.a.p_nvp_w').wert, -1200);
  assert.strictEqual(wertVon(g, 'erzeuger.a.p_erzeugung_w').wert, 182400);
  assert.strictEqual(wertVon(g, 'erzeuger.a.anlage_zustand').wert, 3);
  assert.strictEqual(wertVon(g, 'erzeuger.a.p_installiert_kw').wert, 265);
  // PV: kein Gasspeicher - das deckende Bit (a_gueltig Bit 4) zuerst, dann das Typ-Maximum;
  // beides heisst kein Wert, nie 0.
  assert.deepStrictEqual([wertVon(g, 'erzeuger.a.speicher_fuellstand').wert,
    wertVon(g, 'erzeuger.a.speicher_fuellstand').grund], [null, 'gueltigkeit']);
  assert.strictEqual(wertVon(g, 'erzeuger.nb.n_kanal').wert, 3);
  assert.strictEqual(wertVon(g, 'erzeuger.nb.n_p_prozent').wert, 60);
  assert.strictEqual(wertVon(g, 'erzeuger.nb.n_cosphi').wert, 0.95);
  assert.strictEqual(wertVon(g, 'erzeuger.nb.n_zaehler').wert, 17);
  assert.strictEqual(wertVon(g, 'erzeuger.dv.d_kanal').wert, 0);
  // d_bits Bit 0 = 0: alles in D ausser d_kanal ist unbekannt (Lesart 5).
  for (const p of ['erzeuger.dv.d_soll_w', 'erzeuger.dv.d_seit_s', 'erzeuger.dv.d_zaehler']) {
    assert.strictEqual(wertVon(g, p).wert, null, p);
  }
  assert.strictEqual(wertVon(g, 'erzeuger.dv.d_bits').wert, 0);
  assert.strictEqual(wertVon(g, 'erzeuger.wirkung.quelle_p').wert, 1);
  assert.strictEqual(wertVon(g, 'erzeuger.wirkung.p_grenze_w').wert, 159000);
  for (const n of [1, 2, 3]) {
    assert.strictEqual(wertVon(g, `erzeuger.te[${n}].t_art`).wert, 1);
    assert.strictEqual(wertVon(g, `erzeuger.te[${n}].t_nenn_kw`).wert, 125);
    assert.strictEqual(wertVon(g, `erzeuger.te[${n}].t_p_ist_w`).wert, 60800 + n * 100);
    assert.strictEqual(wertVon(g, `erzeuger.te[${n}].t_e`).wert, (12345678 + n) / 10);
  }
  assert.ok(!g.werte.some((w) => w.punkt.startsWith('erzeuger.te[4].')));
  // Die Kopf-Messpunkte (EZ-6).
  assert.deepStrictEqual(['te_anzahl', 'programmstand', 'steuerung_id', 'anlagenart']
    .map((f) => wertVon(g, `erzeuger.kopf.${f}`).wert), [3, 2610, 4711, 1]);
  // Je Feld genau ein Eintrag.
  assert.strictEqual(g.werte.length, 26 + 3 * 7);
});

test('Buettner: BHKW, zwei Motoren, WVV ueber Relais und mA, Netzpunkt unbekannt (EW-16 C)', () => {
  const b = bild.liesErzeugerbild(bilder.buettner(), { soll: { te_anzahl: 2, anlagenart: 2 } });
  assert.strictEqual(b.ergebnis, 'erkannt');
  assert.strictEqual(b.kopf.anlagenart, 2);
  // Lesart 10: Netzpunkt unbekannt (a_gueltig Bit 0 = 0) - kein Wert, und auch kein Alter.
  assert.deepStrictEqual([wertVon(b, 'erzeuger.a.p_nvp_w').wert, wertVon(b, 'erzeuger.a.p_nvp_w').grund],
    [null, 'gueltigkeit']);
  assert.strictEqual(wertVon(b, 'erzeuger.a.a_alter_s').wert, null);
  assert.strictEqual(wertVon(b, 'erzeuger.a.speicher_fuellstand').wert, 73.4);
  assert.strictEqual(wertVon(b, 'erzeuger.nb.n_kanal').wert, 2);
  assert.strictEqual(wertVon(b, 'erzeuger.nb.n_cosphi').grund, 'ungueltig');
  // EZ-1 A2: 0xFFFF ist bei n_zaehler ein Wert.
  assert.strictEqual(wertVon(b, 'erzeuger.nb.n_zaehler').wert, 65535);
  assert.strictEqual(wertVon(b, 'erzeuger.dv.d_kanal').wert, 1);
  assert.strictEqual(wertVon(b, 'erzeuger.dv.d_soll_w').wert, 60000);
  assert.strictEqual(wertVon(b, 'erzeuger.dv.d_zaehler').wert, 4);
  assert.strictEqual(wertVon(b, 'erzeuger.wirkung.quelle_p').wert, 2);
  assert.deepStrictEqual([1, 2].map((n) => wertVon(b, `erzeuger.te[${n}].t_art`).wert), [2, 2]);
  assert.deepStrictEqual([1, 2].map((n) => wertVon(b, `erzeuger.te[${n}].t_nenn_kw`).wert), [66, 33]);
  // Motor 1 ohne Zaehlerstand („easYgen oder ungueltig"), Motor 2 mit.
  assert.strictEqual(wertVon(b, 'erzeuger.te[1].t_e').wert, null);
  assert.strictEqual(wertVon(b, 'erzeuger.te[2].t_e').wert, 98765.4);
  // p_installiert_kw ≠ Σ t_nenn_kw ist erlaubt (Lesart 12): der Leser prueft keine Summe.
  assert.strictEqual(wertVon(b, 'erzeuger.a.p_installiert_kw').wert, 99);
});

test('Namen: ISO 8859-1, hoeherwertiges Byte zuerst, leer = keiner (Lesart 2)', () => {
  const woerter = bilder.buettner();
  const b = bild.liesNamen(woerter.slice(140), 2);
  assert.deepStrictEqual(b.map((n) => [n.feld, n.einheit, n.wert]), [
    ['netzbetreiber_name', null, 'N-ERGIE Netz GmbH'],
    ['direktvermarkter_name', null, 'WVV (Stadtwerke Würzburg)'],
    ['t_typ_name', 1, 'MAN E0836LE'],
    ['t_typ_name', 2, 'KW Energie Smartblock 33']]);
  const g = bild.liesNamen(bilder.gore().slice(140), 3);
  assert.strictEqual(g.find((n) => n.feld === 'direktvermarkter_name').wert, null);
  // 32 Zeichen ohne abschliessende 0 sind erlaubt.
  const voll = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  assert.strictEqual(bild.liesName(bilder.nameWoerter(voll)), voll);
  // Der Name endet am ERSTEN 0-Byte, auch mitten im Wort.
  assert.strictEqual(bild.liesName(bilder.nameWoerter('ABC')), 'ABC');
});

test('namensBereich: 0 und 0xFFFF heissen keine Namen, ein Bereich im laufenden Bild auch', () => {
  assert.strictEqual(bild.namensBereich({ te_anzahl: 3, beschreibung_ab: 0 }), null);
  assert.strictEqual(bild.namensBereich({ te_anzahl: 3, beschreibung_ab: 0xffff }), null);
  assert.strictEqual(bild.namensBereich({ te_anzahl: 3, beschreibung_ab: 60 }), null);
  assert.deepStrictEqual(bild.namensBereich({ te_anzahl: 3, beschreibung_ab: 68 }), { start: 68, count: 80 });
  assert.strictEqual(bild.namensBereich({ te_anzahl: 3, beschreibung_ab: 140 }, 65400), null);
});

// ---------------------------------------------------------------------------
// Fehlerfaelle: jeder Grund heisst kein einziger Wert
// ---------------------------------------------------------------------------

test('Pruefreihenfolge (Lesart 4): Signatur, Hauptversion, Wortfolge, Zahl der Einheiten, Laenge', () => {
  const fall = (woerter, soll) => bild.liesErzeugerbild(woerter, { soll });
  // Ein WAGO-Bild („VP" „RB") ist nicht unser Bild.
  const wago = fall(bilder.gore({ kopf: { signatur: [0x5650, 0x5242] } }));
  assert.deepStrictEqual([wago.ergebnis, wago.grund, wago.kopf, wago.werte], ['nicht_lesbar', 'signatur_fremd', null, []]);
  // Bei fremder Version ist der Kopf kein Kopf dieses Bilds - der Leser gibt ihn nicht heraus.
  const v2 = fall(bilder.gore({ kopf: { version: 0x0201 } }));
  assert.deepStrictEqual([v2.grund, v2.kopf], ['version_fremd', null]);
  // Nebenversion ist Auskunft, kein Grund.
  assert.strictEqual(fall(bilder.gore({ kopf: { version: 0x0103 } })).kopf.nebenversion, 3);
  // Die Steuerung schreibt das niederwertige Wort zuerst, die Box liest hoeherwertig zuerst.
  assert.deepStrictEqual([fall(bilder.gore({ wortfolge: 'little' })).grund,
    fall(bilder.gore({ wortfolge: 'little' })).kopf], ['wortfolge_falsch', null]);
  const little = bild.liesErzeugerbild(bilder.gore({ wortfolge: 'little' }), { parameter: { wortfolge: 'little' } });
  assert.strictEqual(little.ergebnis, 'erkannt');
  assert.strictEqual(wertVon(little, 'erzeuger.a.p_nvp_w').wert, -1200);
  for (const n of [0, 11, 0xffff]) {
    const r = fall(bilder.gore({ kopf: { te_anzahl: n } }));
    assert.deepStrictEqual([r.grund, r.werte], ['te_anzahl_ungueltig', []], `te_anzahl=${n}`);
  }
  const kurz = fall(bilder.gore().slice(0, 67));
  assert.deepStrictEqual([kurz.grund, kurz.kopf.te_anzahl], ['zu_wenig_woerter', 3]);
  assert.strictEqual(fall(bilder.gore().slice(0, 11)).grund, 'zu_wenig_woerter');
  assert.strictEqual(bild.liesErzeugerbild(null).grund, 'zu_wenig_woerter');
});

test('Soll: eine Einheit mehr wird nie still umgehaengt, fremde Steuerung oder Anlagenart auch nicht', () => {
  const woerter = bilder.gore();
  const mehr = bild.liesErzeugerbild(woerter, { soll: { te_anzahl: 2 } });
  assert.deepStrictEqual([mehr.grund, mehr.kopf.te_anzahl, mehr.werte], ['te_anzahl_abweichend', 3, []]);
  assert.strictEqual(bild.liesErzeugerbild(woerter, { soll: { te_anzahl: 3, steuerung_id: 1 } }).grund,
    'steuerung_id_abweichend');
  assert.strictEqual(bild.liesErzeugerbild(woerter, { soll: { te_anzahl: 3, anlagenart: 2 } }).grund,
    'anlagenart_abweichend');
  // Ohne Soll-Feld wird es nicht geprueft.
  assert.strictEqual(bild.liesErzeugerbild(woerter, { soll: { te_anzahl: 3 } }).ergebnis, 'erkannt');
  for (const g of ['te_anzahl_abweichend', 'steuerung_id_abweichend', 'anlagenart_abweichend',
    'signatur_fremd', 'version_fremd', 'wortfolge_falsch', 'te_anzahl_ungueltig',
    'zu_wenig_woerter']) assert.ok(bild.GRUENDE.includes(g), g);
});

test('Ungueltig = Typ-Maximum - und nur das Maximum des FELDTYPS', () => {
  const g = (anlage) => bild.liesErzeugerbild(bilder.gore({ anlage: Object.assign({
    a_gueltig: 0b1001, n_bits: 1, s_bits: 1, d_bits: 1 }, anlage) }));
  // S32: 0xFFFFFFFF ist −1 und ein Wert; 0x7FFFFFFF ist kein Wert.
  assert.strictEqual(wertVon(g({ p_nvp_w: -1 }), 'erzeuger.a.p_nvp_w').wert, -1);
  assert.strictEqual(wertVon(g({ p_nvp_w: 0x7fffffff }), 'erzeuger.a.p_nvp_w').wert, null);
  // U32: 0xFFFFFFFF ist kein Wert, 0x7FFFFFFF schon.
  assert.strictEqual(wertVon(g({ d_soll_w: 0x7fffffff }), 'erzeuger.dv.d_soll_w').wert, 0x7fffffff);
  assert.strictEqual(wertVon(g({ d_soll_w: 0xffffffff }), 'erzeuger.dv.d_soll_w').wert, null);
  // S16: 0x7FFF kein Wert, −1 ein Wert (cos φ untererregt).
  assert.strictEqual(wertVon(g({ n_cosphi: -950 }), 'erzeuger.nb.n_cosphi').wert, -0.95);
  assert.strictEqual(wertVon(g({ n_cosphi: 0x7fff }), 'erzeuger.nb.n_cosphi').wert, null);
  // U16 mit „hoechstens 65534": 0xFFFF kein Wert.
  assert.strictEqual(wertVon(g({ n_seit_s: 0xffff }), 'erzeuger.nb.n_seit_s').wert, null);
  assert.strictEqual(wertVon(g({ n_seit_s: 65534 }), 'erzeuger.nb.n_seit_s').wert, 65534);
  // EZ-1 A2: die drei Ueberlauf-Zaehler kennen keinen Ungueltig-Wert.
  assert.strictEqual(wertVon(g({ n_zaehler: 0xffff }), 'erzeuger.nb.n_zaehler').wert, 65535);
  assert.strictEqual(wertVon(g({ d_zaehler: 0xffff }), 'erzeuger.dv.d_zaehler').wert, 65535);
  assert.strictEqual(bild.liesErzeugerbild(bilder.gore({ kopf: { herzschlag: 0xffff } })).kopf.herzschlag, 65535);
});

test('Kopf-Werte: Typ-Maximum und Anlagenart ausserhalb sind kein Wert, der Herzschlag schon', () => {
  const k = bild.liesErzeugerbild(bilder.gore({ kopf: { herzschlag: 0xffff, programmstand: 0xffff,
    steuerung_id: 0xffffffff, anlagenart: 7 } })).kopf;
  assert.deepStrictEqual([k.herzschlag, k.programmstand, k.steuerung_id, k.anlagenart],
    [65535, null, null, null]);
  // Eine Steuerung ohne Kennung passt zu keinem Soll, das eine nennt.
  assert.strictEqual(bild.liesErzeugerbild(bilder.gore({ kopf: { steuerung_id: 0xffffffff } }),
    { soll: { te_anzahl: 3, steuerung_id: 4711 } }).grund, 'steuerung_id_abweichend');
  // Im Probe-Bericht FEHLT ein Kopf-Feld ohne Wert.
  const w = bilder.gore({ kopf: { programmstand: 0xffff } });
  const bericht = bild.kopfBericht(w.slice(0, 12), { einheiten: w.slice(38, 68) });
  assert.ok(!('programmstand' in bericht) && bericht.erkannt);
});

test('Gueltigkeitsbits (Lesart 5): Bit 0 heisst unbekannt, nie 0 - und ein ungueltiges Bitfeld deckt nichts', () => {
  const lies = (anlage, einheit = {}) => bild.liesErzeugerbild(bilder.gore({
    anlage: Object.assign({ a_gueltig: 0b11001, speicher_fuellstand: 500, n_bits: 1, s_bits: 1, d_kanal: 0,
      d_bits: 1, d_soll_w: 1000, d_seit_s: 5, d_zaehler: 2, p_nvp_w: 10, p_erzeugung_w: 20,
      n_p_prozent: 1000, n_cosphi: 1000, quelle_p: 1, p_grenze_w: 1 }, anlage),
    einheiten: [Object.assign({ t_zustand: 2, t_bits: 0b11, t_art: 1, t_nenn_kw: 10, t_p_ist_w: 5,
      t_p_soll_w: 6, t_e: 7 }, einheit)] }));
  const alle = lies({});
  for (const p of ['erzeuger.a.p_nvp_w', 'erzeuger.a.p_erzeugung_w', 'erzeuger.a.speicher_fuellstand',
    'erzeuger.nb.n_p_prozent', 'erzeuger.nb.n_cosphi', 'erzeuger.dv.d_soll_w',
    'erzeuger.dv.d_seit_s', 'erzeuger.dv.d_zaehler', 'erzeuger.wirkung.quelle_p', 'erzeuger.wirkung.p_grenze_w',
    'erzeuger.te[1].t_zustand', 'erzeuger.te[1].t_p_ist_w', 'erzeuger.te[1].t_p_soll_w', 'erzeuger.te[1].t_e']) {
    assert.notStrictEqual(wertVon(alle, p).wert, null, p);
  }
  const ohne = (stelle, punkte) => {
    for (const p of punkte) {
      assert.deepStrictEqual([wertVon(stelle, p).wert, wertVon(stelle, p).grund], [null, 'gueltigkeit'], p);
    }
  };
  ohne(lies({ a_gueltig: 0b11000 }), ['erzeuger.a.p_nvp_w']);
  ohne(lies({ a_gueltig: 0b10001 }), ['erzeuger.a.p_erzeugung_w']);
  ohne(lies({ a_gueltig: 0b01001 }), ['erzeuger.a.speicher_fuellstand']);
  ohne(lies({ n_bits: 0b110 }), ['erzeuger.nb.n_p_prozent', 'erzeuger.nb.n_cosphi']);
  ohne(lies({ d_bits: 0b11110 }), ['erzeuger.dv.d_soll_w', 'erzeuger.dv.d_seit_s', 'erzeuger.dv.d_zaehler']);
  ohne(lies({ s_bits: 0b10 }), ['erzeuger.wirkung.quelle_p', 'erzeuger.wirkung.p_grenze_w']);
  ohne(lies({}, { t_bits: 0b10 }), ['erzeuger.te[1].t_zustand', 'erzeuger.te[1].t_p_ist_w', 'erzeuger.te[1].t_e']);
  ohne(lies({}, { t_bits: 0b01 }), ['erzeuger.te[1].t_p_soll_w']);
  // Ein Bitfeld mit Ungueltig-Wert deckt nichts: der Wert ist unbekannt.
  ohne(lies({ a_gueltig: 0xffff }), ['erzeuger.a.p_nvp_w', 'erzeuger.a.p_erzeugung_w']);
  // Bitfelder selbst und d_kanal stehen ohne deckendes Bit da.
  assert.strictEqual(wertVon(lies({ d_bits: 0 }), 'erzeuger.dv.d_kanal').wert, 0);
  assert.strictEqual(wertVon(lies({ d_bits: 0 }), 'erzeuger.dv.d_bits').wert, 0);
});

test('Aufzaehlung ausserhalb des Vokabulars ist kein Wert - der Rohwert reist mit (Lesart 6)', () => {
  const g = bild.liesErzeugerbild(bilder.gore({ anlage: Object.assign({}, { a_gueltig: 9, n_bits: 7,
    s_bits: 3, anlage_zustand: 9, n_kanal: 4, d_kanal: 3, quelle_p: 7 }) ,
  einheiten: [{ t_zustand: 7, t_bits: 3, t_art: 3, t_nenn_kw: 1 }] }));
  for (const [p, roh] of [['erzeuger.a.anlage_zustand', 9], ['erzeuger.nb.n_kanal', 4], ['erzeuger.dv.d_kanal', 3],
    ['erzeuger.wirkung.quelle_p', 7], ['erzeuger.te[1].t_zustand', 7], ['erzeuger.te[1].t_art', 3]]) {
    assert.deepStrictEqual([wertVon(g, p).wert, wertVon(g, p).roh, wertVon(g, p).grund],
      [null, roh, 'fremd'], p);
  }
});

test('Herzschlag: Ueberlauf 65 535 → 0 ist kein Neustart, ein Ruecksprung schon (A2)', () => {
  assert.strictEqual(bild.herzschlagUrteil(null, 5), 'erste_lesung');
  assert.strictEqual(bild.herzschlagUrteil(65533, 2), 'ueberlauf');
  assert.strictEqual(bild.herzschlagUrteil(65535, 4), 'ueberlauf');
  assert.strictEqual(bild.herzschlagUrteil(4000, 3), 'rueckwaerts');
  assert.strictEqual(bild.herzschlagUrteil(7, 7), 'steht');
});

// ---------------------------------------------------------------------------
// Kopf-Bericht der Probe-Art erzeuger_kopf
// ---------------------------------------------------------------------------

test('Kopf-Bericht: Anlagenart, Einheiten mit Art, Nennleistung und Typname, Namen, Programmstand', () => {
  const w = bilder.buettner();
  const bericht = bild.kopfBericht(w.slice(0, 12), { einheiten: w.slice(38, 58), namen: w.slice(140, 204) });
  assert.deepStrictEqual(bericht, {
    signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, te_anzahl: 2, herzschlag: 500,
    programmstand: 2611, steuerung_id: 4712, anlagenart: 2, beschreibung_ab: 140,
    einheiten: [
      { einheit: 1, art: 2, nenn_kw: 66, typ_name: 'MAN E0836LE' },
      { einheit: 2, art: 2, nenn_kw: 33, typ_name: 'KW Energie Smartblock 33' }],
    netzbetreiber_name: 'N-ERGIE Netz GmbH', direktvermarkter_name: 'WVV (Stadtwerke Würzburg)' });
  // Gore: kein Direktvermarkter = leerer Name, gelesen.
  const g = bilder.gore();
  assert.strictEqual(bild.kopfBericht(g.slice(0, 12), { einheiten: g.slice(38, 68), namen: g.slice(140, 220) })
    .direktvermarkter_name, '');
  // Namen nicht gelesen: die Felder FEHLEN, nie ein erfundener leerer Text.
  const ohne = bild.kopfBericht(g.slice(0, 12), { einheiten: g.slice(38, 68) });
  assert.ok(!('netzbetreiber_name' in ohne) && !('typ_name' in ohne.einheiten[0]));
  assert.deepStrictEqual(bild.kopfPlan(0), [{ teil: 'kopf', start: 0, count: 12 }]);
  assert.deepStrictEqual(bild.kopfPlan(0, ohne), [{ teil: 'einheiten', start: 38, count: 30 },
    { teil: 'namen', start: 140, count: 80 }]);
});

test('Kopf-Bericht: Luecke statt Null bei fremdem Kopf', () => {
  const g = bilder.gore();
  assert.deepStrictEqual(bild.kopfBericht(bilder.gore({ kopf: { signatur: [1, 2] } }).slice(0, 12)),
    { signatur_ok: false, erkannt: false, grund: 'signatur_fremd' });
  assert.deepStrictEqual(bild.kopfBericht(bilder.gore({ kopf: { version: 0x0200 } }).slice(0, 12)),
    { signatur_ok: true, erkannt: false, grund: 'version_fremd', hauptversion: 2, nebenversion: 0 });
  assert.deepStrictEqual(bild.kopfBericht(g.slice(0, 5)), { signatur_ok: false, erkannt: false,
    grund: 'zu_wenig_woerter' });
  // Die Einheiten liessen sich nicht lesen: das Bild ist nicht ganz.
  assert.strictEqual(bild.kopfBericht(g.slice(0, 12), { einheiten: null }).grund, 'zu_wenig_woerter');
  assert.strictEqual(bild.kopfBericht(bilder.gore({ kopf: { te_anzahl: 12 } }).slice(0, 12)).te_anzahl, 12);
});

// ---------------------------------------------------------------------------
// Stufe: Herzschlag, Qualitaet, Ereignisse
// ---------------------------------------------------------------------------

const DQ = 'DQ-7';
function stufeLesung(stufe, woerter, extra = {}) {
  return stufe.lesung(woerter, Object.assign({ steuerung: 'source:sps', soll: { te_anzahl: 3 },
    datenquelle: DQ, zeitpunkt: new Date('2026-10-21T20:00:00Z') }, extra));
}

test('Herzschlag dreimal gleich: ab der dritten Lesung stale und EINMAL frozen_source (Lesart 8)', () => {
  const stufe = new ErzeugerStufe();
  const w = bilder.gore();
  const r1 = stufeLesung(stufe, w);
  const r2 = stufeLesung(stufe, w);
  assert.deepStrictEqual([r1.qualitaet, r2.qualitaet], ['good', 'good']);
  assert.deepStrictEqual(r1.ereignisse.concat(r2.ereignisse), []);
  const r3 = stufeLesung(stufe, w);
  assert.strictEqual(r3.qualitaet, 'stale');
  assert.ok(r3.werte.filter((x) => x.wert !== null).every((x) => x.qualitaet === 'stale'));
  assert.deepStrictEqual(r3.ereignisse.map((e) => e.payload),
    [{ art: 'frozen_source', zeitpunkt: '2026-10-21T20:00:00Z', datenquelle: DQ, lesungen: 3, herzschlag: 1000 }]);
  // Jede Nachricht passt unveraendert durch den Briefkasten.
  for (const e of r3.ereignisse) assert.deepStrictEqual(deviceEvents.ereignis(e.payload), e.payload);
  assert.deepStrictEqual(stufeLesung(stufe, w).ereignisse, []);
  // Laeuft der Herzschlag wieder, ist die Episode zu.
  const weiter = stufeLesung(stufe, bilder.gore({ kopf: { herzschlag: 1005, steuerung_id: 4711, anlagenart: 1 } }));
  assert.strictEqual(weiter.qualitaet, 'good');
  stufeLesung(stufe, bilder.gore({ kopf: { herzschlag: 1005 } }));
  assert.strictEqual(stufeLesung(stufe, bilder.gore({ kopf: { herzschlag: 1005 } }), { komponente: '00000000-0000-0000-0000-0000000000e1' })
    .ereignisse[0].payload.komponente, '00000000-0000-0000-0000-0000000000e1');
});

test('eine nicht lesbare Lesung ist keine Herzschlag-Beobachtung - sie unterbricht die Folge nicht', () => {
  const stufe = new ErzeugerStufe();
  const w = bilder.gore();
  stufeLesung(stufe, w);
  stufeLesung(stufe, w);
  // Zu wenige Woerter: der Kopf ist lesbar, das Bild nicht - kein Stehen gezaehlt.
  assert.strictEqual(stufeLesung(stufe, w.slice(0, 50)).steht, 1);
  assert.strictEqual(stufeLesung(stufe, w).qualitaet, 'stale');
  // Ein abweichendes Soll laesst das Bild lesbar: sein Herzschlag zaehlt.
  const soll = new ErzeugerStufe();
  stufeLesung(soll, w, { soll: { te_anzahl: 2 } });
  assert.strictEqual(stufeLesung(soll, w, { soll: { te_anzahl: 2 } }).steht, 1);
});

test('Ruecksprung des Herzschlags meldet device_restart, ein Ueberlauf nicht', () => {
  const stufe = new ErzeugerStufe();
  stufeLesung(stufe, bilder.gore({ kopf: { herzschlag: 65533 } }));
  assert.deepStrictEqual(stufeLesung(stufe, bilder.gore({ kopf: { herzschlag: 2 } })).ereignisse, []);
  const neu = stufeLesung(stufe, bilder.gore({ kopf: { herzschlag: 0 } }));
  assert.deepStrictEqual(neu.ereignisse.map((e) => e.payload), [{ art: 'device_restart',
    zeitpunkt: '2026-10-21T20:00:00Z', datenquelle: DQ, herzschlag_vorher: 2, herzschlag_nachher: 0 }]);
  assert.strictEqual(neu.herzschlag_urteil, 'rueckwaerts');
});

test('a_alter_s ueber der Schwelle macht den Netzpunkt uncertain - und nur ihn', () => {
  const stufe = new ErzeugerStufe();
  const alt = stufeLesung(stufe, bilder.gore({ anlage: { a_gueltig: 0b1001, a_alter_s: 31, p_nvp_w: -500,
    p_erzeugung_w: 1000, anlage_zustand: 2 } }));
  assert.strictEqual(wertVon(alt, 'erzeuger.a.p_nvp_w').qualitaet, 'uncertain');
  assert.strictEqual(wertVon(alt, 'erzeuger.a.p_erzeugung_w').qualitaet, 'good');
  assert.strictEqual(wertVon(alt, 'erzeuger.a.a_alter_s').qualitaet, 'good');
  const grenze = new ErzeugerStufe();
  assert.strictEqual(wertVon(stufeLesung(grenze, bilder.gore({ anlage: { a_gueltig: 1, a_alter_s: 30,
    p_nvp_w: 1 } })), 'erzeuger.a.p_nvp_w').qualitaet, 'good');
  // Die Schwelle der Fassung kommt mit dem Soll.
  const eigen = new ErzeugerStufe();
  assert.strictEqual(wertVon(stufeLesung(eigen, bilder.gore({ anlage: { a_gueltig: 1, a_alter_s: 15,
    p_nvp_w: 1 } }), { soll: { te_anzahl: 3, alter_schwelle_s: 10 } }), 'erzeuger.a.p_nvp_w').qualitaet, 'uncertain');
});

test('Qualitaet je Wert: kein Wert = kein Sample, ausser Vokabular = invalid mit Rohwert', () => {
  const stufe = new ErzeugerStufe();
  const r = stufeLesung(stufe, bilder.gore({ anlage: { a_gueltig: 9, anlage_zustand: 9 } }));
  assert.strictEqual(wertVon(r, 'erzeuger.a.anlage_zustand').qualitaet, 'invalid');
  assert.strictEqual(wertVon(r, 'erzeuger.a.speicher_fuellstand').qualitaet, null);
});

test('fremdes Bild: Befund registerbild_unbekannt als layout_changed, keine Werte', () => {
  const stufe = new ErzeugerStufe();
  const r = stufeLesung(stufe, bilder.gore({ kopf: { signatur: [0x5650, 0x5242] } }));
  assert.deepStrictEqual([r.ergebnis, r.qualitaet, r.werte], ['nicht_lesbar', null, []]);
  assert.deepStrictEqual([r.befund.finding, r.befund.error_class], ['registerbild_unbekannt', 'layout_changed']);
  assert.strictEqual(stufeLesung(stufe, bilder.gore(), { soll: { te_anzahl: 2 } }).befund, null);
});

// ---------------------------------------------------------------------------
// Melde-Regel
// ---------------------------------------------------------------------------

test('Melde-Regel: schnelle Groessen mit Totband, Zustaende bei Aenderung, Zaehler im Takt', () => {
  const m = new ErzeugerMeldung();
  const k = (p) => meldeSchluessel('source:sps', null, p);
  const schnell = (wert) => ({ wert, roh: wert, qualitaet: 'good', klasse: 'schnell', totband: 500 });
  let t = 0;
  assert.strictEqual(m.soll(k('p'), schnell(1000), 60, t), true);
  assert.strictEqual(m.soll(k('p'), schnell(1400), 60, (t += 5000)), false);
  assert.strictEqual(m.soll(k('p'), schnell(1501), 60, (t += 5000)), true);
  assert.strictEqual(m.soll(k('p'), schnell(1501), 60, (t += 55000)), false);
  assert.strictEqual(m.soll(k('p'), schnell(1501), 60, (t += 5000)), true, 'spaetestens nach cadence_s');
  const zustand = (wert) => ({ wert, roh: wert, qualitaet: 'good', klasse: 'zustand', totband: null });
  assert.strictEqual(m.soll(k('z'), zustand(1), 60, 0), true);
  assert.strictEqual(m.soll(k('z'), zustand(1), 60, 5000), false);
  assert.strictEqual(m.soll(k('z'), zustand(2), 60, 10000), true);
  const zaehler = (wert) => ({ wert, roh: wert, qualitaet: 'good', klasse: 'zaehler', totband: null });
  assert.strictEqual(m.soll(k('c'), zaehler(1), 60, 0), true);
  assert.strictEqual(m.soll(k('c'), zaehler(2), 60, 5000), false);
  assert.strictEqual(m.soll(k('c'), zaehler(3), 60, 60000), true);
  // Totband 0: jede Aenderung einer Vorgabe zaehlt.
  const vorgabe = (wert) => ({ wert, roh: wert, qualitaet: 'good', klasse: 'schnell', totband: 0 });
  assert.strictEqual(m.soll(k('v'), vorgabe(60), 60, 0), true);
  assert.strictEqual(m.soll(k('v'), vorgabe(60.1), 60, 5000), true);
  // Neue Qualitaet: sofort.
  assert.strictEqual(m.soll(k('z'), Object.assign(zustand(2), { qualitaet: 'stale' }), 60, 15000), true);
  // Kein Wert loescht den Stand: der naechste ist wieder der erste.
  assert.strictEqual(m.soll(k('z'), Object.assign(zustand(2), { qualitaet: null }), 60, 20000), false);
  assert.strictEqual(m.soll(k('z'), zustand(2), 60, 25000), true);
  m.vergissZiel('source:sps');
  assert.strictEqual(m.soll(k('c'), zaehler(3), 60, 61000), true);
});

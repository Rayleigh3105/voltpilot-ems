'use strict';

/**
 * Was aus der Kopf-Pruefung FOLGT (UEMS AP-05 IP-7).
 *
 * Die Pruefung selbst hat IP-6 (`wago-registerbild.test.js`); hier steht nur die Folge: der
 * Befund `registerbild_unbekannt`, die Qualitaet `stale` nach drei stehenden Lesungen und das
 * Typenschild, das nie mitentscheidet.
 *
 * Die Woerter baut dieser Test aus den Konstanten des Treibers - er schreibt sie nicht ab.
 */

const test = require('node:test');
const assert = require('node:assert');

const rb = require('./wago-registerbild');
const kopf = require('./wago-kopf');

/** Ein v1-Kopf mit 12 Woertern, big-endian. `ueber` ueberschreibt einzelne Felder. */
function kopfWoerter(ueber = {}) {
  const feld = Object.assign({
    hauptversion: rb.HAUPTVERSION, nebenversion: 0,
    kopflaenge: rb.KOPFLAENGE_MIN, kartenblocklaenge: rb.KARTENBLOCKLAENGE_MIN,
    kartenzahl: 0, herzschlag: 1000, controller_kennung: 7,
    signatur_1: rb.SIGNATUR[0], signatur_2: rb.SIGNATUR[1],
    pruefwert: rb.WORTFOLGE_PRUEFWERT,
  }, ueber);
  const w = new Array(rb.KOPFLAENGE_MIN).fill(0);
  w[rb.KOPF.signatur_1] = feld.signatur_1;
  w[rb.KOPF.signatur_2] = feld.signatur_2;
  w[rb.KOPF.hauptversion] = feld.hauptversion;
  w[rb.KOPF.nebenversion] = feld.nebenversion;
  w[rb.KOPF.kopflaenge] = feld.kopflaenge;
  w[rb.KOPF.kartenblocklaenge] = feld.kartenblocklaenge;
  w[rb.KOPF.kartenzahl] = feld.kartenzahl;
  w[rb.KOPF.herzschlag] = feld.herzschlag;
  w[rb.KOPF.wortfolge_pruefwert] = (feld.pruefwert >>> 16) & 0xffff;
  w[rb.KOPF.wortfolge_pruefwert + 1] = feld.pruefwert & 0xffff;
  w[rb.KOPF.controller_kennung] = (feld.controller_kennung >>> 16) & 0xffff;
  w[rb.KOPF.controller_kennung + 1] = feld.controller_kennung & 0xffff;
  return w;
}

// ---------------------------------------------------------------------------
// 1. Der Befund
// ---------------------------------------------------------------------------

test('fremde Signatur und fremde Hauptversion werden zu registerbild_unbekannt', () => {
  for (const [ueber, grund] of [
    [{ signatur_1: 0x1234 }, 'signatur_fremd'],
    [{ hauptversion: 2 }, 'hauptversion_fremd'],
  ]) {
    const gelesen = kopf.pruefeLesung(kopfWoerter(ueber), { steuerung: 'wago-1' });
    assert.strictEqual(gelesen.ergebnis, 'nicht_lesbar', grund);
    assert.strictEqual(gelesen.grund, grund);
    assert.deepStrictEqual(gelesen.karten, [], 'kein einziger Kartenwert');
    assert.strictEqual(gelesen.befund.finding, 'registerbild_unbekannt');
    assert.strictEqual(gelesen.befund.grund, grund);
    assert.strictEqual(gelesen.qualitaet, null, 'ohne Werte keine Qualitaet');
  }
});

test('der Befund faehrt als layout_changed auf dem Findings-Weg der Mess-Runtime', () => {
  const sourceStatus = require('./data-source-status');
  const bef = kopf.befund(rb.liesRegisterbild(kopfWoerter({ hauptversion: 2 })));
  const beleg = kopf.quellenBeleg(bef);
  assert.deepStrictEqual(beleg, { requests: 1, failed: true, error_class: 'layout_changed' });
  // Das Wort muss im geschlossenen Vokabular des Quellenvertrags stehen, sonst verwirft die
  // Box es beim Melden - und der Kunde saehe gar nichts.
  assert.ok(sourceStatus.ERRORS.includes(beleg.error_class));
  const ereignis = sourceStatus.event(Object.assign({ id: 'DQ-4' }, beleg));
  assert.strictEqual(ereignis.error_class, 'layout_changed');
  assert.strictEqual(ereignis.samples, 0, 'ein Befund liefert keinen Messwert');
  assert.strictEqual(ereignis.failed, true);
});

test('jeder andere Grund bleibt ein Grund und wird kein Befund', () => {
  // kartenzahl_abweichend: hier steht ein v1-Registerbild, es passt nur nicht zum Hardwareblatt.
  const gelesen = rb.liesRegisterbild(kopfWoerter({ kartenzahl: 0 }), { soll: { kartenzahl: 3 } });
  assert.strictEqual(gelesen.grund, 'kartenzahl_abweichend');
  assert.strictEqual(kopf.befund(gelesen), null);
  assert.strictEqual(kopf.quellenBeleg(null), null);
  // wortfolge_abweichend ebenso.
  const falsch = rb.liesRegisterbild(kopfWoerter({ pruefwert: 0x04030201 }));
  assert.strictEqual(falsch.grund, 'wortfolge_abweichend');
  assert.strictEqual(kopf.befund(falsch), null);
});

// ---------------------------------------------------------------------------
// 2. Der Herzschlag
// ---------------------------------------------------------------------------

test('stale nach genau drei stehenden Lesungen, und die erste laufende raeumt es weg', () => {
  const wacht = new kopf.HerzschlagWacht();
  const folge = [900, 900, 900, 900, 900, 901];
  const erwartet = [
    ['erste_lesung', 0, 'good'],
    ['steht', 1, 'good'],
    ['steht', 2, 'good'],
    ['steht', 3, 'stale'],
    ['steht', 4, 'stale'],
    ['laeuft', 0, 'good'],
  ];
  folge.forEach((h, i) => {
    const b = wacht.beobachte('wago-1', h);
    assert.deepStrictEqual([b.urteil, b.steht, b.qualitaet], erwartet[i], `Lesung ${i + 1}`);
  });
});

test('Ueberlauf und Programmstart sind KEIN Stehen (Fall S2)', () => {
  const wacht = new kopf.HerzschlagWacht();
  // Erst drei stehende Lesungen, damit ein bestehendes stale sichtbar geraeumt wird.
  [65534, 65534, 65534, 65534].forEach((h) => wacht.beobachte('wago-1', h));
  assert.strictEqual(wacht.stehtSeit('wago-1'), 3);
  // 65 534 -> 0: der Zaehler ist ueber 65 535 hinweg umgelaufen, das Programm laeuft.
  const ueberlauf = wacht.beobachte('wago-1', 0);
  assert.strictEqual(ueberlauf.urteil, 'ueberlauf');
  assert.strictEqual(ueberlauf.steht, 0);
  assert.strictEqual(ueberlauf.qualitaet, 'good');
  // Programmstart: die Zahl faellt weit zurueck.
  wacht.beobachte('wago-1', 5000);
  wacht.beobachte('wago-1', 5000);
  wacht.beobachte('wago-1', 5000);
  wacht.beobachte('wago-1', 5000);
  assert.strictEqual(wacht.stehtSeit('wago-1'), 3);
  const neustart = wacht.beobachte('wago-1', 0);
  assert.strictEqual(neustart.urteil, 'rueckwaerts');
  assert.strictEqual(neustart.steht, 0);
  assert.strictEqual(neustart.qualitaet, 'good');
});

test('der Zaehler lebt je Steuerung, nicht je Karte', () => {
  const wacht = new kopf.HerzschlagWacht();
  for (let i = 0; i < 4; i++) wacht.beobachte('wago-1', 900);
  assert.strictEqual(wacht.stehtSeit('wago-1'), 3);
  // Eine zweite Steuerung faengt bei null an - ein gemeinsamer Zaehler waere hier schon stale.
  const zweite = wacht.beobachte('wago-2', 900);
  assert.strictEqual(zweite.urteil, 'erste_lesung');
  assert.strictEqual(zweite.qualitaet, 'good');
  wacht.vergiss('wago-1');
  assert.strictEqual(wacht.stehtSeit('wago-1'), 0);
});

test('eine Lesung ohne lesbaren Kopf zaehlt nicht als stehend', () => {
  const wacht = new kopf.HerzschlagWacht();
  wacht.beobachte('wago-1', 900);
  wacht.beobachte('wago-1', 900);
  // Die Steuerung antwortet mit einem fremden Registerbild: kein Kopf, kein Herzschlag.
  const ohne = kopf.pruefeLesung(kopfWoerter({ signatur_1: 0 }), { steuerung: 'wago-1', wacht });
  assert.strictEqual(ohne.herzschlag_urteil, null);
  assert.strictEqual(ohne.steht, 1, 'der Stand von vorher bleibt, er waechst aber nicht');
  // Und danach zaehlt die naechste echte Lesung ganz normal weiter.
  assert.strictEqual(wacht.beobachte('wago-1', 900).steht, 2);
});

test('die ganze Lesung traegt die Qualitaet der Steuerung', () => {
  const wacht = new kopf.HerzschlagWacht();
  let letzte = null;
  for (let i = 0; i < 4; i++) {
    letzte = kopf.pruefeLesung(kopfWoerter({ herzschlag: 900 }), { steuerung: 'wago-1', wacht });
  }
  assert.strictEqual(letzte.ergebnis, 'erkannt');
  assert.strictEqual(letzte.qualitaet, 'stale');
  assert.strictEqual(letzte.befund, null, 'alt ist kein Befund');
  const frisch = kopf.pruefeLesung(kopfWoerter({ herzschlag: 901 }), { steuerung: 'wago-1', wacht });
  assert.strictEqual(frisch.qualitaet, 'good');
});

// ---------------------------------------------------------------------------
// 3. Kopf-Bericht und Typenschild
// ---------------------------------------------------------------------------

test('der Kopf-Bericht nennt nur, was diese Lesung wirklich ergeben hat', () => {
  const gut = kopf.kopfBericht(kopfWoerter({ kartenzahl: 4, herzschlag: 1731 }));
  assert.deepStrictEqual(gut, { signatur_ok: true, erkannt: true, hauptversion: 1,
    nebenversion: 0, kopflaenge: 12, kartenblocklaenge: 42, kartenzahl: 4, herzschlag: 1731,
    controller_kennung: 7 });

  const fremd = kopf.kopfBericht(kopfWoerter({ signatur_1: 0x1234, kartenzahl: 4 }));
  assert.deepStrictEqual(fremd, { signatur_ok: false, erkannt: false, grund: 'signatur_fremd' });

  // Fremde Hauptversion: die Version selbst ist die Auskunft, der Rest waere geraten (V4).
  const v2 = kopf.kopfBericht(kopfWoerter({ hauptversion: 2, kartenzahl: 4 }));
  assert.deepStrictEqual(v2, { signatur_ok: true, erkannt: false, grund: 'hauptversion_fremd',
    hauptversion: 2 });

  const kurz = kopf.kopfBericht([0x5650, 0x5242]);
  assert.deepStrictEqual(kurz, { signatur_ok: false, erkannt: false, grund: 'laenge_ungueltig' });
});

test('der Kopf-Bericht liest die Wortfolge als Parameter', () => {
  const woerter = kopfWoerter();
  // little: die beiden 32-bit-Felder mit vertauschten Woertern.
  const l = woerter.slice();
  const tausch = (i) => { const t = l[i]; l[i] = l[i + 1]; l[i + 1] = t; };
  tausch(rb.KOPF.wortfolge_pruefwert);
  tausch(rb.KOPF.controller_kennung);
  assert.strictEqual(kopf.kopfBericht(l, { wortfolge: 'big' }).grund, 'wortfolge_abweichend');
  const gut = kopf.kopfBericht(l, { wortfolge: 'little' });
  assert.strictEqual(gut.erkannt, true);
  assert.strictEqual(gut.controller_kennung, 7);
});

test('das Typenschild wird nur angezeigt und entscheidet nie mit', () => {
  assert.deepStrictEqual(kopf.TYPENSCHILD, { adresse: 0xfa10, woerter: 8 });
  const text = 'PFC200 CS 2ETH';
  const schild = [];
  for (let i = 0; i < 16; i += 2) {
    schild.push(((text.charCodeAt(i) || 0) << 8) | (text.charCodeAt(i + 1) || 0));
  }
  assert.strictEqual(kopf.liesTypenschild(schild), text);
  // Antwortet es nicht (Beleg H2: nicht belegt, ob es ohne Laufzeitsystem antwortet), faellt
  // das Feld still weg - und das Urteil bleibt dasselbe.
  const ohne = kopf.kopfBericht(kopfWoerter({ kartenzahl: 4 }));
  const mit = kopf.kopfBericht(kopfWoerter({ kartenzahl: 4 }), { typenschild: schild });
  assert.strictEqual(mit.typenschild, text);
  delete mit.typenschild;
  assert.deepStrictEqual(mit, ohne, 'das Typenschild aendert kein einziges Urteil');
  // Eine Leerantwort ist kein Typenschild.
  assert.strictEqual(kopf.liesTypenschild([0, 0, 0, 0, 0, 0, 0, 0]), null);
  assert.strictEqual(kopf.liesTypenschild([]), null);
  const leer = kopf.kopfBericht(kopfWoerter(), { typenschild: [0, 0, 0, 0] });
  assert.ok(!Object.hasOwn(leer, 'typenschild'), 'kein erfundenes leeres Schild');
  // Selbst ein fremdes Registerbild MIT Typenschild bleibt fremd.
  const fremd = kopf.kopfBericht(kopfWoerter({ signatur_1: 1 }), { typenschild: schild });
  assert.strictEqual(fremd.erkannt, false);
  assert.strictEqual(fremd.typenschild, text);
});

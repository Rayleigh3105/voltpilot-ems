import { describe, expect, it } from 'vitest';
import type { KoppelTestAntwort } from './api';
import {
  BOX_KANN_NICHT,
  bandText,
  bereitText,
  freigabeGrundText,
  ganzeEinheiten,
  koppelKopf,
  lageSatz,
  letzterTestText,
  quittungZeile,
  stellplatzAnzeigen,
  testEingabe,
  testErgebnis,
  testWert,
  verfallenText,
  wertText,
  wirksamZeile,
  wunschZeile,
  zielText,
} from './koppelStellplaetze';
import { NBSP as NB } from './format';
import { JETZT, koppelbildBuettner, koppelPlatz, koppelStand } from './test/anlagensteuerungFixtures';

/**
 * Stellplätze einer Anlagensteuerung (PFC200 Stufe 4): Angebot, Wunsch der Box, Quittung der Steuerung und wirksam
 * getrennt; fehlend ist keine Null, ein alter Stand trägt seine Uhrzeit.
 */
const now = new Date(JETZT);
const limitW = { art: 'limit_w', ziel: 'erzeugung_gesamt', nr: 0, min: 0, max: 265000, bereit: true, gruende: [] };

describe('Werte in Kundenwörtern', () => {
  it('W als kW mit einer Stelle, geschütztem Leerzeichen und echtem Minus', () => {
    expect(wertText('limit_w', 159000)).toBe(`159,0${NB}kW`);
    expect(wertText('setpoint_w', -2500)).toBe(`−2,5${NB}kW`);
    expect(wertText('setpoint_w', -20)).toBe(`0,0${NB}kW`);
    expect(wertText('limit_w', 1234500)).toBe(`1.234,5${NB}kW`);
  });

  it('am Speicher sagt das Vorzeichen die Richtung', () => {
    expect(wertText('setpoint_w', 5000, 'speicher')).toBe(`lädt 5,0${NB}kW`);
    expect(wertText('setpoint_w', -3000, 'speicher')).toBe(`entlädt 3,0${NB}kW`);
    expect(wertText('setpoint_w', 0, 'speicher')).toBe(`0,0${NB}kW`);
  });

  it('Prozent in Zehnteln, Temperatur in Zehnteln, Ein und Aus, Betriebsart', () => {
    expect(wertText('limit_pct', 600)).toBe(`60${NB}%`);
    expect(wertText('limit_pct', 605)).toBe(`60,5${NB}%`);
    expect(wertText('setpoint_c', 215)).toBe(`21,5${NB}°C`);
    expect(wertText('setpoint_c', -50)).toBe(`−5,0${NB}°C`);
    expect(wertText('on_off', 1)).toBe('ein');
    expect(wertText('on_off', 0)).toBe('aus');
    expect(wertText('mode', 3)).toBe('Betriebsart 3');
  });

  it('Ziele: ganze Erzeugung, Einheit mit Nummer für den Weg, Speicher, Netz, Lampe am Gerät', () => {
    expect(zielText('erzeugung_gesamt', 0)).toEqual({ text: 'ganze Erzeugung', einheit: null });
    expect(zielText('erzeugungseinheit', 2)).toEqual({ text: 'Einheit 2', einheit: 2 });
    expect(zielText('speicher', 1).text).toBe('Speicher 1');
    expect(zielText('verbraucher', 4).text).toBe('Verbraucher 4');
    expect(zielText('netzbezug', 0).text).toBe('Netzbezug');
    expect(zielText('einspeisung', 0).text).toBe('Einspeisung');
    expect(zielText('probe', 0).text).toBe('Lampe am Gerät');
  });

  it('Band je Art', () => {
    expect(bandText(limitW)).toBe(`0,0 bis 265,0${NB}kW`);
    expect(bandText({ art: 'setpoint_w', min: -50000, max: 50000 })).toBe(`−50,0 bis 50,0${NB}kW`);
    expect(bandText({ art: 'limit_pct', min: 0, max: 1000 })).toBe(`0 bis 100${NB}%`);
    expect(bandText({ art: 'on_off', min: 0, max: 1 })).toBe('aus oder ein');
    expect(bandText({ art: 'mode', min: 1, max: 4 })).toBe('Betriebsart 1 bis 4');
  });

  it('bereit, bereit mit Vorrang, nicht bereit mit Grund', () => {
    expect(bereitText({ bereit: true, gruende: [] })).toEqual({ text: 'bereit', ton: 'gut' });
    expect(bereitText({ bereit: true, gruende: ['grund_vorrang'] }).text).toBe('bereit · eine Stelle mit Vorrang bestimmt');
    expect(bereitText({ bereit: false, gruende: ['grund_wartung', 'hand_ort'] }).text).toBe(
      'nicht bereit: Wartung, Anlage auf Hand oder Ort',
    );
  });
});

describe('drei getrennte Zeilen', () => {
  it('Büttner: Wunsch mit Grund, Quittung, wirksam; der leere Stellplatz begrenzt niemand, nie 0', () => {
    const [p1, p2, p3] = stellplatzAnzeigen(koppelbildBuettner());
    expect(p1.titel).toBe('Stellplatz 1');
    expect(p1.angebot).toMatchObject({ art: 'Obergrenze der Leistung', ziel: 'ganze Erzeugung', band: `0,0 bis 265,0${NB}kW` });
    expect(p1.wunsch.text).toBe(`159,0${NB}kW · Fahrplan`);
    expect(p1.quittung).toEqual({ text: 'angenommen', ton: 'gut' });
    expect(p1.wirksam.text).toBe(`159,0${NB}kW`);
    expect(p1.freigabe.text).toBe('freigegeben');

    expect(p2.angebot?.ziel).toBe('Lampe am Gerät');
    expect(p2.wunsch.text).toBe('kein Wunsch');
    expect(p2.quittung.text).toBe('kein Wunsch');
    expect(p2.wirksam.text).toBe('die Anlage regelt selbst');

    expect(p3.angebot?.bereit.text).toBe('nicht bereit: Wartung');
  });

  it('eine Grenze ohne Wunsch und ohne wirksamen Wert: „niemand begrenzt“', () => {
    const sp = koppelPlatz(1, { angebot: limitW });
    expect(wirksamZeile(sp, koppelStand()).text).toBe('niemand begrenzt');
  });

  it('mit Wunsch, aber ohne wirksamen Wert: unbekannt, nie 0', () => {
    const sp = koppelPlatz(1, { angebot: limitW, wunsch: { art: 'limit_w', wert: 1000, grund: 'netz', folge: 2 } });
    expect(wirksamZeile(sp, koppelStand()).text).toBe('unbekannt');
  });

  it('ohne lesbare Lesung: keine Quittung und wirksam unbekannt', () => {
    const sp = koppelPlatz(1, { angebot: limitW, urteil: null });
    expect(quittungZeile(sp, koppelStand({ gelesen_at: null })).text).toBe('keine lesbare Quittung');
    expect(wirksamZeile(sp, koppelStand({ gelesen_at: null })).text).toBe('unbekannt');
    expect(wirksamZeile(sp, null).text).toBe('unbekannt');
  });

  it('Quittungen: begrenzt, überstimmt, Art passt nicht, Wert ungültig, abgelaufen, nicht bereit mit Grund', () => {
    const mit = (urteil: string, gruende: string[] = []) =>
      quittungZeile(
        koppelPlatz(1, { angebot: { ...limitW, gruende }, urteil, wunsch: { art: 'limit_w', wert: 1, grund: 'regel', folge: 3 }, folge: 3 }),
        koppelStand(),
      ).text;
    expect(mit('begrenzt')).toBe('auf das Band begrenzt');
    expect(mit('ueberstimmt')).toBe('überstimmt - eine Stelle mit Vorrang bestimmt');
    expect(mit('art_fremd')).toBe('Art passt nicht zum Angebot');
    expect(mit('wert_ungueltig')).toBe('Wert ungültig');
    expect(mit('abgelaufen')).toBe('abgelaufen - die Anlage fährt mit eigenen Werten');
    expect(mit('nicht_bereit', ['grund_stoerung'])).toBe('nicht bereit: Störung');
  });

  it('nicht bereit bei gesperrter Fernsteuerung nennt die Sperre', () => {
    const sp = koppelPlatz(1, { angebot: limitW, urteil: 'nicht_bereit' });
    expect(quittungZeile(sp, koppelStand({ lage: 'gesperrt', fernsteuerung_frei: false })).text).toBe(
      'nicht bereit: Fernsteuerung an der Anlage gesperrt',
    );
  });

  it('ohne Echo der Folge (null) keine Behauptung über einen früheren Wunsch', () => {
    const sp = koppelPlatz(1, {
      angebot: limitW, wunsch: { art: 'limit_w', wert: 1000, grund: 'markt', folge: 8 }, urteil: 'angenommen', folge: null,
    });
    expect(quittungZeile(sp, koppelStand()).text).toBe('angenommen');
  });

  it('eine Quittung zu einer anderen Folge gilt einem früheren Wunsch', () => {
    const sp = koppelPlatz(1, {
      angebot: limitW, wunsch: { art: 'limit_w', wert: 1000, grund: 'markt', folge: 8 }, urteil: 'angenommen', folge: 7,
    });
    expect(quittungZeile(sp, koppelStand()).text).toBe('angenommen · zu einem früheren Wunsch');
  });

  it('der Grund des Wunschs: Netz, Regel, Handeingriff, Schalt-Test', () => {
    const grund = (g: string) => wunschZeile(koppelPlatz(1, { wunsch: { art: 'on_off', wert: 1, grund: g, folge: 1 } })).text;
    expect(grund('netz')).toBe('ein · Netz');
    expect(grund('regel')).toBe('ein · Regel');
    expect(grund('hand')).toBe('ein · Handeingriff');
    expect(grund('test')).toBe('ein · Schalt-Test');
    expect(grund('keiner')).toBe('ein');
  });
});

describe('Kopf', () => {
  it('bereit: Satz, Frist und Bibliothek', () => {
    const k = koppelKopf(koppelbildBuettner(), now);
    expect(k.satz).toBe('Die Steuerung nimmt Wünsche der Box an.');
    expect(k.frist).toBe(`gilt noch 58${NB}s`);
    expect(k.bibliothek).toBe('Bibliothek 1.0');
    expect(k.alt).toBeNull();
    expect(k.bibliothekWarnung).toBeNull();
  });

  it('ein alter Stand trägt seine Uhrzeit und keine Frist', () => {
    const bild = { ...koppelbildBuettner(), stand: koppelStand({ aktuell: false, empfangen_at: '2026-10-21T11:30:00Z' }) };
    const k = koppelKopf(bild, now);
    expect(k.alt).toBe('Stand von 13:30');
    expect(k.frist).toBeNull();
    expect(k.ton).toBe('still');
    const gestern = { ...bild, stand: koppelStand({ aktuell: false, empfangen_at: '2026-10-20T19:05:00Z' }) };
    expect(koppelKopf(gestern, now).alt).toBe('Stand vom 20.10., 21:05');
  });

  it('veraltete Bibliothek warnt', () => {
    const bild = { ...koppelbildBuettner(), stand: koppelStand({ bibliothek: '0.9', bibliothek_soll: '1.0', bibliothek_veraltet: true }) };
    expect(koppelKopf(bild, now).bibliothekWarnung).toBe('Die VoltPilot-Bibliothek in der Steuerung ist veraltet (0.9, aktuell 1.0).');
  });

  it('abgelaufene Frist', () => {
    const bild = { ...koppelbildBuettner(), stand: koppelStand({ kopf_urteil: 'abgelaufen', rest_s: 0 }) };
    expect(koppelKopf(bild, now).frist).toBe('abgelaufen - die Anlage fährt mit eigenen Werten');
  });

  it('ohne Fähigkeit und ohne Stand: ein Satz, dass die Box noch nicht wünschen kann', () => {
    expect(koppelKopf({ unterstuetzt: false, stand: null, stellplaetze: [] }, now).satz).toBe(BOX_KANN_NICHT);
    expect(koppelKopf({ unterstuetzt: true, stand: null, stellplaetze: [] }, now).satz).toBe(
      'Die Box hat zu dieser Steuerung noch keinen Stand gemeldet.',
    );
  });

  it('jede Lage hat ihren Satz; signatur_fremd heißt: kein Koppelbild', () => {
    expect(lageSatz('gesperrt', null).satz).toMatch(/^Fernsteuerung an der Anlage gesperrt/);
    expect(lageSatz('sps_steht', null).satz).toMatch(/^Steuerung steht/);
    expect(lageSatz('sps_neustart', null).satz).toMatch(/^Steuerung neu gestartet/);
    expect(lageSatz('zweiter_schreiber', null).satz).toMatch(/^Zweiter Schreiber/);
    expect(lageSatz('steuerung_fremd', null).satz).toMatch(/^Falsche Steuerung/);
    expect(lageSatz('nicht_lesbar', 'signatur_fremd').satz).toMatch(/^Diese Steuerung hat kein Koppelbild/);
    expect(lageSatz('nicht_lesbar', 'siegel_falsch').satz).toMatch(/^Quittung nicht lesbar/);
    expect(lageSatz('keine_antwort', null).satz).toMatch(/^Keine Antwort/);
    expect(lageSatz('ohne_soll', null).satz).toMatch(/^Steuerungskennung fehlt/);
  });
});

describe('Freigabe', () => {
  it('Gründe in Klartext', () => {
    expect(freigabeGrundText('kommando_belegt')).toBe('Für diese Art ist schon ein anderer Stellplatz freigegeben.');
    expect(freigabeGrundText('kein_test')).toMatch(/Schalt-Test/);
    expect(freigabeGrundText('box_kann_nicht')).toBe(BOX_KANN_NICHT);
    expect(freigabeGrundText(null)).toBeNull();
  });

  it('verfallen: der Grund in Klartext, nie ein roher Code', () => {
    expect(verfallenText('angebot_geaendert')).toMatch(/weil das Anlagenprogramm Art, Ziel oder Band dieses Stellplatzes geändert hat/);
    expect(verfallenText('unbekannt_neu')).toBe('Die Freigabe ist verfallen. Für eine neue braucht es einen neuen Schalt-Test.');
    expect(verfallenText(null)).not.toMatch(/_/);
  });

  it('der letzte Test als Zeile', () => {
    const p1 = koppelbildBuettner().stellplaetze[0];
    expect(letzterTestText(p1.freigabe, p1.angebot, now)).toBe(`200,0${NB}kW · angenommen · wirksam 200,0${NB}kW · 12:58`);
  });
});

describe('Schalt-Test', () => {
  it('ganze Einheiten exakt, halb vom Nullpunkt weg gerundet', () => {
    expect(ganzeEinheiten('200', 3)).toBe(200000);
    expect(ganzeEinheiten('12,5', 3)).toBe(12500);
    expect(ganzeEinheiten('60,05', 1)).toBe(601);
    expect(ganzeEinheiten('−60,05', 1)).toBe(-601);
    expect(ganzeEinheiten('1.234,5', 3)).toBe(1234500);
    expect(ganzeEinheiten('0,0004', 3)).toBe(0);
    expect(ganzeEinheiten('abc', 3)).toBeNull();
    expect(ganzeEinheiten('1,2,3', 3)).toBeNull();
  });

  it('Eingabe je Art: Zahl mit Einheit und Band, Ein/Aus und Betriebsart als Wahl', () => {
    expect(testEingabe(limitW)).toEqual({ art: 'zahl', einheit: 'kW', stellen: 3, label: `Testwert in kW (0,0 bis 265,0${NB}kW)` });
    expect(testEingabe({ ...limitW, art: 'on_off', min: 0, max: 1 })).toEqual({
      art: 'on_off', werte: [{ wert: 0, text: 'aus' }, { wert: 1, text: 'ein' }],
    });
    expect(testEingabe({ ...limitW, art: 'mode', min: 1, max: 3 })).toMatchObject({ art: 'mode', werte: [{ wert: 1 }, { wert: 2 }, { wert: 3 }] });
    expect(testEingabe({ ...limitW, art: 'setpoint_w', ziel: 'speicher', min: -5000, max: 5000 })).toMatchObject({
      label: `Testwert in kW (−5,0 bis 5,0${NB}kW; + lädt, − entlädt)`,
    });
  });

  it('Testwert im Band, sonst ein Fehler', () => {
    expect(testWert(limitW, '200')).toEqual({ wert: 200000 });
    expect(testWert(limitW, '300')).toEqual({ fehler: `Der Testwert muss zwischen 0,0 und 265,0${NB}kW liegen.` });
    expect(testWert(limitW, '')).toEqual({ fehler: 'Bitte geben Sie einen Testwert ein.' });
    expect(testWert(limitW, 'viel')).toEqual({ fehler: 'Bitte geben Sie eine Zahl in kW ein, zum Beispiel 12,5.' });
    const onOff = { ...limitW, art: 'on_off', min: 0, max: 1 };
    expect(testWert(onOff, '1')).toEqual({ wert: 1 });
    expect(testWert(onOff, '')).toEqual({ fehler: 'Bitte wählen Sie einen Testwert.' });
  });

  it('Ergebnis: angenommen ist nicht die Wirkung; abgelehnt nennt die Lage', () => {
    const ok: KoppelTestAntwort = {
      ok: true, satz: '', error_code: null, beleg_gespeichert: true, koppel_test: { lage: 'bereit', geschrieben: true, folge: 3, urteil: 'angenommen', wirksam: 200000 },
    };
    expect(testErgebnis(ok, limitW)).toEqual({
      angenommen: true, titel: 'Die Steuerung hat den Testwunsch angenommen.', quittung: 'angenommen', wirksam: `200,0${NB}kW`,
    });
    const gesperrt: KoppelTestAntwort = { ok: false, satz: '', error_code: null, beleg_gespeichert: false, koppel_test: { lage: 'zweiter_schreiber', geschrieben: false } };
    expect(testErgebnis(gesperrt, limitW).titel).toMatch(/^Die Box hat den Testwunsch nicht geschrieben\. Zweiter Schreiber/);
    const vorrang: KoppelTestAntwort = {
      ok: true, satz: '', error_code: null, beleg_gespeichert: true,
      koppel_test: { lage: 'bereit', geschrieben: true, folge: 4, urteil: 'ueberstimmt', wirksam: 150000 },
    };
    expect(testErgebnis(vorrang, limitW)).toMatchObject({
      angenommen: true,
      titel: 'Die Steuerung hat den Testwunsch angenommen, aber eine Stelle mit Vorrang bestimmt gerade.',
      quittung: 'überstimmt - eine Stelle mit Vorrang bestimmt',
    });
    const still: KoppelTestAntwort = { ok: false, satz: '', error_code: null, beleg_gespeichert: false, koppel_test: { lage: 'bereit', geschrieben: true, folge: 3 } };
    expect(testErgebnis(still, limitW).titel).toBe('Zu diesem Testwunsch kam keine Quittung der Steuerung.');
    const ohne: KoppelTestAntwort = {
      ok: false, satz: 'Die Box hat nicht geantwortet.', error_code: 'timeout', beleg_gespeichert: false, koppel_test: null,
    };
    expect(testErgebnis(ohne, limitW).titel).toBe('Die Box hat nicht geantwortet.');
  });
});

import { describe, expect, it } from 'vitest';
import type { NetzVermarktung, UemsDatenquellePruefergebnis } from './api';
import {
  ERZEUGER_ALARM_VORLAGEN,
  START_ANSCHLUSS,
  alarmAnfrage,
  alarmVorschlag,
  anlegenAnfrage,
  anschlussFehler,
  einheitenAusKopf,
  einheitenFehler,
  herzschlagSchritt,
  kopfUrteil,
  namenAnfrage,
  netzAusKopf,
  netzbetreiberHinweis,
  netzFehler,
  steuerungKennungText,
  type ErzeugerKopf,
} from './anlagensteuerungAssistent';
import { WERTE_KATALOG } from './werteKatalog';

/**
 * UEMS EZ-15: die Regeln des Anlege-Schritts „Steuerung verbinden“ - Kopfurteil über zwei Lesungen, Vorbelegung
 * aus dem Bild (Büttner aus dem Probe-Beispiel `mqtt-probe.valid.erzeuger-kopf-result.json`), die Anfrage an die
 * EZ-6-Route und der Alarm-Vorschlag.
 */

const BUETTNER: ErzeugerKopf = {
  signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, te_anzahl: 2, herzschlag: 500,
  programmstand: 2611, steuerung_id: 4712, anlagenart: 2, beschreibung_ab: 140,
  einheiten: [
    { einheit: 1, art: 2, nenn_kw: 66, typ_name: 'MAN E0836LE' },
    { einheit: 2, art: 2, nenn_kw: 33, typ_name: 'KW Energie Smartblock 33' },
  ],
  netzbetreiber_name: 'N-ERGIE Netz GmbH',
  direktvermarkter_name: 'WVV (Stadtwerke Würzburg)',
};

function pruefung(kopf: ErzeugerKopf | null, ergebnis = 'ok', ok = true): UemsDatenquellePruefergebnis {
  return {
    ergebnis, gewertet: ergebnis === 'ok', text: ergebnis, adresse: '192.168.4.165:502', zeitpunkt: '', dauer_ms: 40,
    antwort: kopf ? { requestId: 'r', results: [{ id: 'erreichbarkeit', ok, erzeuger_kopf: kopf }] } : null,
  } as unknown as UemsDatenquellePruefergebnis;
}

const NV_LEER: NetzVermarktung = {
  site_id: 's', netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: null, direktvermarkter_kanal: null,
  einspeisemanagement: null, einspeisemanagement_prozent: null,
  namen_aus_bild: { netzbetreiber: null, direktvermarkter: null, gelesen_am: null }, hinweise: [], revision: 0,
};

describe('Kopfprüfung über zwei Lesungen', () => {
  it('erkennt das Bild nur, wenn der Herzschlag zwischen den Lesungen läuft', () => {
    const u = kopfUrteil(pruefung(BUETTNER), pruefung({ ...BUETTNER, herzschlag: 502 }))!;
    expect(u.art).toBe('erkannt');
    expect(u.titel).toBe('Bild erkannt');
    expect(u.details).toEqual([
      'VoltPilot-Registerbild Erzeuger 1.0 · Programm 2611 · Anlagenart BHKW',
      '2 Einheiten · Herzschlag läuft (2 Lesungen, +2) · Wortfolge stimmt',
      'Kennung der Steuerung 00001268 (vom Programm gesetzt)',
    ]);
  });

  it('zählt den Überlauf 65535 → 0 als Lauf, nicht als Stillstand', () => {
    expect(herzschlagSchritt(65535, 1)).toBe(2);
    expect(kopfUrteil(pruefung({ ...BUETTNER, herzschlag: 65535 }), pruefung({ ...BUETTNER, herzschlag: 0 }))!.art)
      .toBe('erkannt');
  });

  it('meldet „Herzschlag steht“ mit Grund - und ohne zweite Lesung geht es nicht weiter', () => {
    const steht = kopfUrteil(pruefung(BUETTNER), pruefung(BUETTNER))!;
    expect(steht.art).toBe('fehler');
    expect(steht.titel).toBe('Herzschlag steht');
    expect(steht.satz).toMatch(/Läuft das SPS-Programm/);
    expect(kopfUrteil(pruefung(BUETTNER), null)!.titel).toBe('Herzschlag nicht geprüft');
  });

  it('nennt den Grund eines fremden Kopfs in Kundensprache', () => {
    const fremd = kopfUrteil(pruefung({ signatur_ok: false, erkannt: false, grund: 'signatur_fremd' }, 'invalid_response', false), null)!;
    expect(fremd.titel).toBe('Bild unbekannt: andere Signatur');
    expect(fremd.satz).toMatch(/anderes Registerbild .*Energiekarten-Bild.* Basisadresse/);
    expect(kopfUrteil(pruefung({ signatur_ok: true, erkannt: false, grund: 'wortfolge_falsch', hauptversion: 1, nebenversion: 0 },
      'invalid_response', false), null)!.titel).toBe('Wortfolge falsch');
    expect(kopfUrteil(pruefung({ signatur_ok: true, erkannt: false, grund: 'version_fremd', hauptversion: 2, nebenversion: 1 },
      'invalid_response', false), null)!.satz).toMatch(/Bildfassung 2\.1/);
  });

  it('macht aus einer Box ohne Fähigkeitswort „Box-Update nötig“, aus einer stummen Box keine Aussage über die Steuerung', () => {
    expect(kopfUrteil(pruefung(null, 'not_supported', false), null)!.titel).toBe('Box-Update nötig');
    expect(kopfUrteil(pruefung(null, 'box_meldet_sich_nicht', false), null)!.titel).toBe('Die VoltPilot-Box meldet sich nicht');
    expect(kopfUrteil(pruefung(null, 'unreachable', false), null)!.satz).toMatch(/Adresse, Port und Netzlage/);
  });

  it('prüft die Anschlussangaben vor der Box', () => {
    expect(anschlussFehler(START_ANSCHLUSS)).toBe('Geben Sie die Adresse der Steuerung ein.');
    expect(anschlussFehler({ ...START_ANSCHLUSS, host: '192.168.4.165' })).toMatch(/keine VoltPilot-Box/);
    expect(anschlussFehler({ ...START_ANSCHLUSS, host: '192.168.4.165', boxId: 'b', unitId: '300' }))
      .toBe('Unit-ID ist keine ganze Zahl von 0 bis 255.');
    expect(anschlussFehler({ ...START_ANSCHLUSS, host: '192.168.4.165', boxId: 'b' })).toBeNull();
    expect(steuerungKennungText(0xa1b2)).toBe('0000A1B2');
  });
});

describe('Vorbelegung aus dem Bild', () => {
  it('belegt je Einheit Name, Typ, Art und Nennleistung aus dem Bild vor', () => {
    const e = einheitenAusKopf(BUETTNER);
    expect(e.map((x) => [x.bezeichnung, x.typ, x.art, x.nennKw, x.artAusBild])).toEqual([
      ['Motor 1', 'MAN E0836LE', 'bhkw_motor', '66', true],
      ['Motor 2', 'KW Energie Smartblock 33', 'bhkw_motor', '33', true],
    ]);
    expect(einheitenFehler(e)).toEqual([]);
  });

  it('lässt leer, was das Bild nicht nennt - nie geraten', () => {
    const e = einheitenAusKopf({ ...BUETTNER, te_anzahl: 3, einheiten: [{ einheit: 1, art: 1 }] });
    expect(e.map((x) => [x.bezeichnung, x.typ, x.typBild, x.art, x.nennKw])).toEqual([
      ['Wechselrichter 1', '', null, 'pv_wechselrichter', ''],
      ['Einheit 2', '', null, null, ''],
      ['Einheit 3', '', null, null, ''],
    ]);
    expect(einheitenFehler(e)).toEqual(['Einheit 2: Wählen Sie die Art.', 'Einheit 3: Wählen Sie die Art.']);
  });

  it('nimmt den Direktvermarkter aus dem Bild, ein leerer Name heißt „keiner“, Gepflegtes bleibt', () => {
    expect(netzAusKopf(BUETTNER, NV_LEER)).toMatchObject({ direktvermarkter: 'WVV (Stadtwerke Würzburg)', kanal: '', gepflegt: false });
    expect(netzAusKopf({ ...BUETTNER, direktvermarkter_name: '' }, NV_LEER)).toMatchObject({ kanal: 'keiner' });
    expect(netzAusKopf(BUETTNER, { ...NV_LEER, direktvermarkter: 'Next Kraftwerke', direktvermarkter_kanal: 'modbus', revision: 3 }))
      .toMatchObject({ direktvermarkter: 'Next Kraftwerke', kanal: 'modbus', gepflegt: true });
  });

  it('meldet einen abweichenden Netzbetreiber als Hinweis - gleich bis auf Schreibweise ist keine Abweichung', () => {
    expect(netzbetreiberHinweis('N-ERGIE Netz GmbH', 'n-ergie  netz gmbh')).toBeNull();
    expect(netzbetreiberHinweis('N-ERGIE Netz GmbH', 'Bayernwerk Netz')).toMatch(/am Netzanschluss steht „Bayernwerk Netz“/);
    expect(netzbetreiberHinweis('N-ERGIE Netz GmbH', null)).toMatch(/keiner eingetragen/);
    expect(netzbetreiberHinweis('', 'Bayernwerk Netz')).toBeNull();
  });

  it('prüft feste Grenze, Stufen und MaStR-Nummer', () => {
    const netz = { ...netzAusKopf(BUETTNER, NV_LEER), einspeisemanagement: 'statisch' as const, prozent: '120' };
    const e = einheitenAusKopf(BUETTNER).map((x, i) => i === 0 ? { ...x, see: 'SEE12' } : x);
    expect(netzFehler(netz, e)).toEqual(['Die feste Grenze liegt zwischen 0 und 100 %.',
      'Einheit 1: Die MaStR-Nummer hat die Form SEE und 12 Ziffern.']);
  });
});

describe('Anfragen an die Routen', () => {
  it('baut den Körper von POST …/anlagensteuerungen aus den vier Schritten', () => {
    const einheiten = einheitenAusKopf(BUETTNER).map((x, i) => i === 0 ? { ...x, see: 'see912345678901', nennKw: '66,5' } : x);
    const netz = { ...netzAusKopf(BUETTNER, NV_LEER), kanal: 'relais_ma' as const, einspeisemanagement: 'stufen' as const };
    netz.stufen[3] = { stufe: 4, prozent: '' };
    const body = anlegenAnfrage({
      dataSourceId: 'dq-1', anschluss: { ...START_ANSCHLUSS, host: '192.168.4.165', boxId: 'b' }, kopf: BUETTNER,
      anlagenart: 'bhkw', bezeichnung: ' Anlagensteuerung Büttner ', hersteller: 'WAGO', typ: '', einheiten, netz,
    });
    expect(body).toEqual({
      data_source_id: 'dq-1', unit_id: 1, bezeichnung: 'Anlagensteuerung Büttner', hersteller: 'WAGO', typ: null,
      basisadresse: 0, funktionscode: 4, wortfolge: 'big', anlagenart: 'bhkw', steuerung_kennung: 4712,
      rse_stufen: [{ stufe: 1, prozent: 100 }, { stufe: 2, prozent: 60 }, { stufe: 3, prozent: 30 }],
      einheiten: [
        { te_nr: 1, einheit_art: 'bhkw_motor', bezeichnung: 'Motor 1', typ: 'MAN E0836LE', typ_bild: 'MAN E0836LE',
          nennleistung_kw: 66.5, registry_unit_id: 'SEE912345678901' },
        { te_nr: 2, einheit_art: 'bhkw_motor', bezeichnung: 'Motor 2', typ: 'KW Energie Smartblock 33',
          typ_bild: 'KW Energie Smartblock 33', nennleistung_kw: 33, registry_unit_id: null },
      ],
      netz_vermarktung: { direktvermarkter: 'WVV (Stadtwerke Würzburg)', direktvermarkter_kanal: 'relais_ma',
        einspeisemanagement: 'stufen', einspeisemanagement_prozent: null },
    });
  });

  it('schickt bei gepflegten Stammdaten keine Erstbelegung und ohne Namen im Bild keine Namen', () => {
    const netz = netzAusKopf(BUETTNER, { ...NV_LEER, einspeisemanagement: 'fernwirk', revision: 2 });
    const body = anlegenAnfrage({
      dataSourceId: 'dq-1', anschluss: { ...START_ANSCHLUSS, host: 'h', boxId: 'b' }, kopf: BUETTNER, anlagenart: 'bhkw',
      bezeichnung: '', hersteller: '', typ: '', einheiten: einheitenAusKopf(BUETTNER), netz,
    });
    expect(body.netz_vermarktung).toBeNull();
    expect(body.rse_stufen).toBeNull();
    expect(namenAnfrage({ signatur_ok: true, erkannt: true, te_anzahl: 1, einheiten: [{ einheit: 1, art: 1 }] })).toBeNull();
    expect(namenAnfrage(BUETTNER)).toEqual({ netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: 'WVV (Stadtwerke Würzburg)',
      einheiten: [{ te_nr: 1, typ: 'MAN E0836LE' }, { te_nr: 2, typ: 'KW Energie Smartblock 33' }] });
  });
});

describe('Alarm-Vorschlag (Vorlagen aus EZ-11/EZ-11b)', () => {
  it('nimmt die Vorlagen des Werte-Katalogs, die nur mit Anlagensteuerung gelten', () => {
    expect(ERZEUGER_ALARM_VORLAGEN.map((v) => v.wertart)).toEqual([
      'erzeuger.fernsteuerung_nicht_bereit', 'erzeuger.daten_veraltet', 'erzeuger.anlage_folgt_nicht',
      'erzeuger.netzbetreiber_abgeschaltet', 'erzeuger.fernwirk_verbindung_weg', 'erzeuger.programmstand_veraltet',
    ]);
    expect(ERZEUGER_ALARM_VORLAGEN.map((v) => v.vorlage)).toEqual(ERZEUGER_ALARM_VORLAGEN.map((v) =>
      WERTE_KATALOG.find((e) => e.wertart === v.wertart)?.vorlage));
    expect(ERZEUGER_ALARM_VORLAGEN[3].satz).toBe('Sag mir Bescheid, sobald der Netzbetreiber die Anlage abschaltet (Not-Aus). · Warnung');
  });

  it('schlägt „Fernsteuerung nicht bereit“ nur mit Direktvermarkter-Weg und „Fernwirk“ nur mit Fernwirktechnik vor', () => {
    const netz = netzAusKopf(BUETTNER, NV_LEER);
    const an = (n: typeof netz) => ERZEUGER_ALARM_VORLAGEN.filter((v) => alarmVorschlag(v, n).an).map((v) => v.name);
    expect(an(netz)).toEqual(['Daten veraltet', 'Anlage folgt nicht', 'Netzbetreiber hat abgeschaltet', 'Programmstand veraltet']);
    expect(an({ ...netz, kanal: 'relais_ma', einspeisemanagement: 'fernwirk' })).toHaveLength(6);
  });

  it('legt die Regel an der Anlage an wie das Blatt „Überwachen“, gemeldet an die Rolle Kundenadministrator', () => {
    const folgt = ERZEUGER_ALARM_VORLAGEN.find((v) => v.wertart === 'erzeuger.anlage_folgt_nicht')!;
    expect(alarmAnfrage(folgt, 'anlage-1')).toEqual({
      wertart: 'erzeuger.anlage_folgt_nicht', bezug: { anlage: 'anlage-1' }, schwere: 'warnung', name: 'Anlage folgt nicht',
      bedingung: { art: 'zustand', ziel: ['folgt_nicht'], dauer_s: 300, erholen_s: 300, toleranz_prozent: 5, toleranz_kw: 5 },
      empfaenger: [{ rolle: 'kundenadministrator' }],
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  datenstandZeile,
  direktvermarkterHinweis,
  direktvermarkterWert,
  einheitenZeilen,
  einheitZeilen,
  einspeisemanagementWert,
  erzeugerGeraetId,
  erzeugerGruppe,
  folgtSatz,
  istErzeugerZiel,
  kwText,
  netzpunktZeile,
  prozentText,
  seriesFromErzeugerVerlauf,
  steuerSatz,
  typHinweis,
  werteJe,
} from './anlagensteuerung';
import {
  buettner,
  buettnerNv,
  buettnerWerte,
  GERAET_BUETTNER,
  GERAET_GORE,
  gore,
  goreNv,
  goreVerlauf,
  goreWerte,
  JETZT,
  werte,
} from './test/anlagensteuerungFixtures';

const NB = String.fromCharCode(160);
const now = new Date(JETZT);

describe('Zahlen: de-DE, geschütztes Leerzeichen, echtes Minus, „—“ statt 0', () => {
  it('kW mit einer Stelle aus W, Prozent ohne Stelle', () => {
    expect(kwText(52800)).toBe(`52,8${NB}kW`);
    expect(kwText(-41230)).toBe(`−41,2${NB}kW`);
    expect(kwText(null)).toBe('—');
    expect(prozentText(60)).toBe(`60${NB}%`);
    expect(prozentText(null)).toBe('—');
  });
});

describe('Steuerung › Geräte: wer steuert (EZ-10 (1))', () => {
  it('Büttner: Netzbetreiber aus dem Bild (am Netzanschluss leer) und der Direktvermarkter der Stammdaten', () => {
    expect(steuerSatz(buettnerNv(), werteJe(buettnerWerte()))).toBe(
      'VoltPilot liest diese Anlage nur. Gesteuert wird sie vom Netzbetreiber N-ERGIE Netz GmbH und vom Direktvermarkter WVV.',
    );
  });

  it('Gore: kein Direktvermarkter (d_kanal 0) - der Satz nennt nur den Netzbetreiber', () => {
    expect(steuerSatz(goreNv(), werteJe(goreWerte()))).toBe(
      'VoltPilot liest diese Anlage nur. Gesteuert wird sie vom Netzbetreiber N-ERGIE Netz GmbH.',
    );
  });

  it('ohne Stammdaten und ohne Werte: kein erfundener Name', () => {
    expect(steuerSatz(null, werteJe(null))).toBe('VoltPilot liest diese Anlage nur. Gesteuert wird sie vom Netzbetreiber.');
  });

  it('Gore: Soll und Ist je Wechselrichter, die Anlage folgt; WR 3 ohne gültige Werte steht als „—“, nie 0', () => {
    const z = einheitZeilen(gore(), goreWerte(), goreNv(), now);
    expect(z.map((x) => x.teNr)).toEqual([1, 2, 3]);
    expect(z[0]).toMatchObject({ name: 'WR Dach Nord', unter: 'Wechselrichter 1 · Growatt MAX 125KTL3-X', soll: `53,0${NB}kW`, ist: `52,8${NB}kW`, folgt: 'folgt', zustand: 'läuft begrenzt', dv: null, symbol: 'sun' });
    expect(z[1]).toMatchObject({ name: 'Wechselrichter 2', folgt: 'folgt' });
    expect(z[2]).toMatchObject({ name: 'Wechselrichter 3', istW: null, ist: '—', soll: `53,0${NB}kW`, zustand: null, folgt: 'folgt' });
    expect(folgtSatz(werteJe(goreWerte()))).toBe('Die Anlage folgt der wirksamen Grenze.');
  });

  it('Büttner: Motor 1 vom Direktvermarkter abgerufen; Motor 2 nicht bereit mit Grund und über seinem Soll', () => {
    const [m1, m2] = einheitZeilen(buettner(), buettnerWerte(), buettnerNv(), now);
    expect(m1).toMatchObject({ name: 'Motor 1', symbol: 'flame', folgt: 'folgt', zustand: 'läuft', veraltet: null });
    expect(m1.dv).toMatchObject({ bereit: true, aktiv: true, text: 'vom Direktvermarkter abgerufen' });
    expect(m2).toMatchObject({ name: 'Motor 2', unter: 'KW Energie Smartblock 33', folgt: 'folgt_nicht', zustand: 'Hand/Wartung' });
    expect(m2.dv).toMatchObject({ bereit: false, gruende: ['Wartung', 'Gasspeicher leer'] });
    expect(m2.dv?.text).toBe('nicht bereit für den Direktvermarkter: Wartung, Gasspeicher leer');
    expect(m2.veraltet).toBe(`zuletzt vor 5${NB}Min.`);
    expect(folgtSatz(werteJe(buettnerWerte()))).toBe('Die Anlage folgt der wirksamen Grenze gerade nicht.');
  });

  it('nicht bereit ohne Grundbit: das sagt die Zeile, statt einen Grund zu raten', () => {
    const w = werte(GERAET_BUETTNER, { 'erzeuger.dv.d_kanal': 1, 'erzeuger.te[1].t_bits': 0b11 });
    expect(einheitZeilen(buettner(), w, buettnerNv(), now)[0].dv?.text).toBe(
      'nicht bereit für den Direktvermarkter (die Steuerung nennt keinen Grund)',
    );
  });

  it('noch keine Daten: keine Zahl, kein „folgt“, keine Bereitschaft', () => {
    const [z] = einheitZeilen(buettner(), werte(GERAET_BUETTNER, {}), buettnerNv(), now);
    expect(z).toMatchObject({ ist: '—', soll: '—', folgt: null, dv: null, ohneDaten: true });
    expect(folgtSatz(werteJe(null))).toBeNull();
  });

  it('Qualität invalid zählt nicht als Wert', () => {
    const w = werte(GERAET_GORE, { 'erzeuger.te[1].t_p_ist_w': { wert: 99999, qualitaet: 'invalid', zustand: 'veraltet' } });
    expect(einheitZeilen(gore(), w, goreNv(), now)[0].ist).toBe('—');
  });
});

describe('Geräteseite: die Steuerung als Gerät (EZ-10 (2))', () => {
  it('Einheiten wie die Energiekarten: Art, Typname, Nennleistung (Stammdaten oder laut Steuerung) und Zustand', () => {
    const z = einheitenZeilen(buettner().einheiten, buettnerWerte());
    expect(z).toEqual([
      { label: 'Motor 1', wert: 'MAN E0836LE', detail: `BHKW-Motor · 66${NB}kW · läuft` },
      { label: 'Motor 2', wert: 'KW Energie Smartblock 33', detail: `BHKW-Motor · 33${NB}kW laut Steuerung · Hand/Wartung` },
    ]);
    const g = einheitenZeilen(gore().einheiten, goreWerte());
    expect(g[0]).toEqual({ label: 'Wechselrichter 1', wert: 'WR Dach Nord', detail: `PV-Wechselrichter · Growatt MAX 125KTL3-X · 125${NB}kW · läuft begrenzt` });
    expect(g[2].detail).toBe(`PV-Wechselrichter · 125${NB}kW laut Steuerung · Zustand —`);
  });

  it('ohne Werte: „noch keine Daten“ statt eines Zustands', () => {
    expect(einheitenZeilen(gore().einheiten, null)[0].detail).toBe(`PV-Wechselrichter · Growatt MAX 125KTL3-X · 125${NB}kW · noch keine Daten`);
  });

  it('Netzpunkt: Gore gemessen mit Alter; Büttner ohne Messung „—“ (EW-16 C); berechnet und ausgefallen', () => {
    expect(netzpunktZeile(goreWerte())).toEqual({ label: 'Netzpunkt', wert: `speist 41,2${NB}kW ein`, detail: `gemessen · Messung 3${NB}s alt` });
    expect(netzpunktZeile(buettnerWerte())).toEqual({ label: 'Netzpunkt', wert: '—', detail: 'keine Messung am Netzpunkt' });
    const berechnet = werte(GERAET_BUETTNER, { 'erzeuger.a.a_gueltig': 0b011, 'erzeuger.a.p_nvp_w': 1200, 'erzeuger.a.a_alter_s': 4 });
    expect(netzpunktZeile(berechnet)).toEqual({ label: 'Netzpunkt', wert: `bezieht 1,2${NB}kW`, detail: `berechnet aus mehreren Messungen · Messung 4${NB}s alt` });
    const tot = werte(GERAET_GORE, { 'erzeuger.a.a_gueltig': 0b100, 'erzeuger.a.p_nvp_w': -41000, 'erzeuger.a.a_alter_s': 180 });
    expect(netzpunktZeile(tot)).toEqual({ label: 'Netzpunkt', wert: '—', detail: `Messung am Netzpunkt ausgefallen · Messung 3${NB}min alt` });
    expect(netzpunktZeile(null)).toEqual({ label: 'Netzpunkt', wert: '—', detail: 'noch keine Daten' });
  });

  it('Datenstand: wann die Box zuletzt einen Wert lieferte', () => {
    expect(datenstandZeile(goreWerte(), now)).toEqual({ label: 'Datenstand', wert: `vor 5${NB}Sek.` });
    expect(datenstandZeile(null, now)).toEqual({ label: 'Datenstand', wert: 'noch keine Daten' });
  });
});

describe('Strom & Geld: Stammdaten (EZ-10 (3))', () => {
  it('Direktvermarkter mit Kanal; Abweichung zum Namen im Bild als Hinweis, nie überschrieben', () => {
    expect(direktvermarkterWert(buettnerNv())).toBe('WVV · über Relais und 4–20 mA');
    expect(direktvermarkterHinweis(buettnerNv())).toBe('Die Steuerung nennt „WVV (Stadtwerke Würzburg)“ - angezeigt wird Ihr Name.');
    expect(direktvermarkterWert(goreNv())).toBe('keiner erfasst');
    expect(direktvermarkterHinweis(goreNv())).toBeNull();
  });

  it('Einspeisemanagement in Worten, die Prozentgrenze nur statisch', () => {
    expect(einspeisemanagementWert(goreNv())).toBe('Fernwirktechnik');
    expect(einspeisemanagementWert({ ...goreNv(), einspeisemanagement: 'statisch', einspeisemanagement_prozent: 70 })).toBe(`feste Grenze 70${NB}%`);
    expect(einspeisemanagementWert({ ...goreNv(), einspeisemanagement: null })).toBe('nicht erfasst');
  });

  it('Typ der Einheit weicht vom Typnamen im Bild ab: Hinweis (Groß/Klein und Leerraum zählen nicht)', () => {
    const [, wr2] = [...gore().einheiten].sort((a, b) => a.te_nr - b.te_nr);
    expect(typHinweis(wr2)).toBe('Die Steuerung nennt „Growatt MAX 125KTL3 X“.');
    expect(typHinweis(buettner().einheiten[0])).toBeNull();
  });
});

describe('Verlauf › Messwerte: Kurven je Einheit (EZ-10 (4))', () => {
  it('ein Ast je Anlagensteuerung: je Einheit Ist und Soll, dazu Anlage und Vorgaben; Gasspeicher nur ohne reine PV', () => {
    const g = erzeugerGruppe(gore());
    expect(g.label).toBe('Anlagensteuerung Gore');
    expect(g.items.map((i) => i.label)).toEqual([
      'WR Dach Nord · Ist', 'WR Dach Nord · Soll',
      'Wechselrichter 2 · Ist', 'Wechselrichter 2 · Soll',
      'Wechselrichter 3 · Ist', 'Wechselrichter 3 · Soll',
      'Erzeugung gesamt', 'Netzpunkt', 'Vorgabe Netzbetreiber', 'Direktvermarkter · Soll', 'Wirksame Grenze',
    ]);
    expect(g.items[0]).toMatchObject({ channel: 'erzeuger.te[1].t_p_ist_w', unit: 'kW' });
    expect(istErzeugerZiel(g.items[0].entityId)).toBe(true);
    expect(erzeugerGeraetId(g.items[0].entityId)).toBe(GERAET_GORE);
    expect(g.items[0].entityId).not.toContain(':');
    expect(erzeugerGruppe(buettner()).items.map((i) => i.label)).toContain('Gasspeicher');
  });

  it('W → kW, % bleibt; ohne Eimer leer (nie 0)', () => {
    const v = goreVerlauf();
    const ist = seriesFromErzeugerVerlauf(v, 'erzeuger.te[1].t_p_ist_w');
    expect(ist).toMatchObject({ unit: 'kW', isDay: true, hasBand: false, empty: false, bucketMinutes: 15 });
    expect(ist.points[1].avg).toBeCloseTo(52.8, 6);
    expect(ist.points[1].min).toBeCloseTo(52.3, 6);
    expect(ist.points[1].max).toBeCloseTo(53.3, 6);
    expect(seriesFromErzeugerVerlauf(v, 'erzeuger.nb.n_p_prozent')).toMatchObject({ unit: '%', empty: false });
    expect(seriesFromErzeugerVerlauf(v, 'erzeuger.te[1].t_p_soll_w').empty).toBe(true);
    expect(seriesFromErzeugerVerlauf(v, 'erzeuger.a.p_nvp_w').empty).toBe(true);
  });
});

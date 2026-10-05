import { describe, expect, it } from 'vitest';
import { VOKABULARE } from './energiemanagement';
import { DOK, KZ, verzeichnisDemo, wvDemo, wvLeer, wvNormal, wvR12, wvZeile } from './test/wiedervorlageFixtures';
import {
  ART_WORT,
  arbeitsliste,
  artAusAdresse,
  artFilterWort,
  buendel,
  eintragSprung,
  fristBild,
  gefiltert,
  kopfSatz,
  SCHRITT,
  wasStehtAn,
  wiedervorlageStatus,
  zuletztErledigt,
  type Wiedervorlage,
} from './wiedervorlage';

const text = (e: { aufgabe: string; grund: string }) => `${e.aufgabe} | ${e.grund}`;

describe('Wiedervorlage w1 · die Frist als Datum, nie als Tageszähler', () => {
  it('überfällig: „seit“ mit dem Tag, ohne relatives Wort', () => {
    expect(fristBild('2027-11-13', 457)).toEqual({
      wort: 'seit', tag: '13.11.', jahr: '2027', satz: 'fällig seit 13.11.2027', relativ: null, ueberfaellig: true,
    });
  });
  it('heute, morgen und in n Tagen: relativ nur nahe am Heute, kein Warnton', () => {
    expect(fristBild('2029-02-12', 0)).toMatchObject({ wort: 'heute', relativ: 'heute', ueberfaellig: false, satz: 'heute fällig, 12.02.2029' });
    expect(fristBild('2029-02-13', -1)).toMatchObject({ wort: 'bis', relativ: 'morgen', ueberfaellig: false });
    expect(fristBild('2029-02-28', -16)).toMatchObject({ wort: 'bis', tag: '28.02.', jahr: '2029', relativ: 'in 16 Tagen', satz: 'fällig bis 28.02.2029' });
  });
});

describe('Wiedervorlage w1 · Einträge: Aufgabe, Grund, Bereich, Zuständig, ein Schritt', () => {
  it('R12: acht überfällige Einträge, das älteste zuerst, und eine Frist in den nächsten 30 Tagen', () => {
    const l = arbeitsliste(wvR12());
    expect(l.stand).toBe('12.02.2029');
    expect(l.fensterBis).toBe('14.03.2029');
    expect(l.ueberfaellig.map((e) => e.kennzeichen)).toEqual(['BB-0002', 'BB-0005', 'BB-0003', 'BR-2028-0001', 'BB-0004', 'BR-2027-0001', 'D-0001', 'D-0002']);
    expect(l.bald.map((e) => e.kennzeichen)).toEqual(['M-2029-0001']);
    expect(l.spaeter).toBe(6);
    expect(l.bereiche).toEqual(['auswerten', 'verbessern', 'nachweisen']);
  });

  it('jede Art spricht als Aufgabe mit Verb und nennt ihren Grund: Titel und Herleitung getrennt, das Kennzeichen einmal', () => {
    const [bb2, , , bericht, , bewertung, d1] = arbeitsliste(wvR12()).ueberfaellig;
    expect(text(bb2)).toBe('Bezugsbasis BB-0002 überprüfen | Vergleichsgrundlage einer Kennzahl · Fassung 2 vom 13.11.2026 + 12 Monate');
    expect(text(bericht)).toBe(
      'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 neu freigeben | Korrektur K-2028-0001 hat nach der Freigabe Werte geändert. Der freigegebene Stand bleibt, bis Sie entscheiden.',
    );
    expect(bericht.grundKurz).toBe('Werte nach der Freigabe korrigiert (K-2028-0001)');
    expect(text(bewertung)).toBe('Energetische Bewertung überprüfen | Grundlage der wesentlichen Energieeinsätze (BR-2027-0001)');
    expect(text(d1)).toBe('Energiepolitik überprüfen | Vorgabe Ihres Energiemanagements (D-0001)');
    const [m] = arbeitsliste(wvR12()).bald;
    expect(text(m)).toBe('Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden | Maßnahme M-2029-0001');
    expect(m.frist.relativ).toBe('in 16 Tagen');
    expect(m.verantwortlich).toBe('Jonas Wendlinger');
    expect([bb2.bereich, bericht.bereich, bewertung.bereich, d1.bereich, m.bereich]).toEqual(['auswerten', 'nachweisen', 'auswerten', 'nachweisen', 'verbessern']);
    expect([bb2.schritt, bericht.schritt, bewertung.schritt, d1.schritt, m.schritt]).toEqual([
      'Bestätigen oder neu fassen', 'Entwurf vergleichen', 'Neuen Stand freigeben', 'Bestätigen oder neu fassen', 'Umsetzung melden',
    ]);
    // Die Route nennt am Dokument, am Bericht und an der Bewertung keine Person; das Portal erfindet keine.
    expect([bb2.verantwortlich, bericht.verantwortlich, bewertung.verantwortlich, d1.verantwortlich]).toEqual(['Ines Kaltenbach', null, null, null]);
  });

  it('„geprüft, bleibt“ als Herleitung einer Bezugsbasis', () => {
    const [e] = arbeitsliste({
      ...wvLeer(),
      faellig: [wvZeile('bezugsbasis_ueberpruefung', 'BB-0001', 'Bezugsbasis BB-0001, Fassung 2 — Überprüfung (geprüft, bleibt 30.04.2029 + 12 Monate)', '2030-04-30', 3, { kennzahl_id: 'k' })],
    }).ueberfaellig;
    expect(e.grund).toBe('Vergleichsgrundlage einer Kennzahl · „geprüft, bleibt“ am 30.04.2029 + 12 Monate');
  });

  it('der Schritt öffnet das Objekt mit offenem Entscheid, auch Audit, Managementbewertung und Messbedarf', () => {
    const l = arbeitsliste(wvR12());
    const hash = (kz: string) => [...l.ueberfaellig, ...l.bald].find((e) => e.kennzeichen === kz)!.sprung!.hash;
    expect(hash('BB-0002')).toBe(`#/portfolio/kennzahlen/${KZ.stromMontageHalle2}?entscheid=bezugsbasis_ueberpruefung`);
    expect(hash('D-0001')).toBe(`#/portfolio/energiemanagement/dokumente/${DOK.d1}?entscheid=dokument_ueberpruefung`);
    expect(hash('BR-2028-0001')).toBe('#/portfolio/berichte/BR-2028-0001?entscheid=bericht_anstoss');
    expect(hash('BR-2027-0001')).toBe('#/portfolio/bewertung?entscheid=bewertung_ueberpruefung');
    expect(hash('M-2029-0001')).toBe('#/portfolio/verbesserung/massnahmen/m-2029-0001?entscheid=massnahme_termin');
    const z = (art: Wiedervorlage['faellig'][number]['art'], kz: string, id: string | null = null) => ({ art, kennzeichen: kz, id, kennzahl_id: null });
    expect(eintragSprung(z('internes_audit', 'AU-2029-0001', 'a1'))!.hash).toBe('#/portfolio/energiemanagement/audits?entscheid=internes_audit');
    expect(eintragSprung(z('managementbewertung', 'BR-2029-0001'))!.hash).toBe('#/portfolio/energiemanagement/managementbewertung?entscheid=managementbewertung');
    expect(eintragSprung(z('messbedarf_frist', 'MB-1', 'mb-1'))!.hash).toBe('#/portfolio/bewertung?entscheid=messbedarf_frist&kennzeichen=MB-1');
    expect(eintragSprung(z('feststellung', 'F-2029-0001', 'f1'))!.hash).toBe('#/portfolio/energiemanagement/feststellungen/f1?entscheid=feststellung');
    // Ohne Kennung der Route gibt es keine Seite: dann kein Sprung (WV3).
    expect(eintragSprung(z('dokument_ueberpruefung', 'D-0009'))).toBeNull();
  });

  it('ein Gegenstand, ein Eintrag: zehn Anstöße an einem Bericht sind eine Aufgabe (Demo: 13 Zeilen, 4 Einträge)', () => {
    const l = arbeitsliste(wvDemo());
    expect(l.ueberfaellig.map((e) => [e.kennzeichen, e.zeilen])).toEqual([
      ['BR-2026-0001', 10],
      ['MB-1', 1],
      ['BB-0006', 1],
      ['BB-0007', 1],
    ]);
    const [bericht, mb] = l.ueberfaellig;
    expect(text(bericht)).toBe('Monatsbericht Standort Werk Ahrenberg Oktober 2026 neu freigeben | 10 Korrekturen nach der Freigabe. Der freigegebene Stand bleibt, bis Sie entscheiden.');
    expect(bericht.frist.satz).toBe('fällig seit 05.10.2026');
    expect(text(mb)).toBe('Messstelle für Messbedarf MB-1 einrichten | Aus der Messplanung der energetischen Bewertung');
    expect(mb.bereich).toBe('messen');
    expect(mb.schritt).toBe('Messstelle anlegen');
  });

  it('eine Art, die das Portal noch nicht kennt, steht mit dem Titel der Route und ohne Sprung', () => {
    const fremd = { ...wvZeile('massnahme_termin', 'X-1', 'Neue Frist', '2029-01-01', 5), art: 'ablesung_frist' } as unknown as Wiedervorlage['faellig'][number];
    const [e] = arbeitsliste({ ...wvLeer(), faellig: [fremd] }).ueberfaellig;
    expect(e.aufgabe).toBe('Neue Frist');
    expect(e.sprung).toBeNull();
  });

  it('Filter nach Art (aus der Übersicht) und nach Bereich; ein unbekanntes Wort in der Adresse gilt nicht', () => {
    const l = arbeitsliste(wvR12());
    expect(gefiltert(l.ueberfaellig, { art: 'bezugsbasis_ueberpruefung', bereich: null })).toHaveLength(4);
    expect(gefiltert(l.ueberfaellig, { art: null, bereich: 'nachweisen' }).map((e) => e.kennzeichen)).toEqual(['BR-2028-0001', 'D-0001', 'D-0002']);
    expect(artAusAdresse('bezugsbasis_ueberpruefung')).toBe('bezugsbasis_ueberpruefung');
    expect(artAusAdresse('irgendwas')).toBeNull();
    expect(artAusAdresse(null)).toBeNull();
    expect(artFilterWort('bezugsbasis_ueberpruefung')).toBe('Bezugsbasen');
    expect(artFilterWort('bewertung_ueberpruefung')).toBe('Energetische Bewertungen');
  });

  it('Kopf: was die Seite ist und der Stand', () => {
    expect(kopfSatz('12.02.2029')).toBe('Alle Fristen Ihres Energiemanagements, das am längsten Überfällige zuerst. Stand 12.02.2029.');
  });

  it('jede Art des Vokabulars hat Wort, Schritt und Bereich', () => {
    for (const art of VOKABULARE.wiedervorlage_art) {
      expect(ART_WORT[art as keyof typeof ART_WORT], art).toBeTruthy();
      expect(SCHRITT[art as keyof typeof SCHRITT], art).toBeTruthy();
    }
  });
});

describe('Wiedervorlage w1 · „Was steht an“ auf der Übersicht (Variante A)', () => {
  it('R12: Marken zählen Einträge; vier Zeilen gebündelt nach Aufgabe, älteste zuerst', () => {
    const b = wasStehtAn(wvR12())!;
    expect([b.ueberfaellig, b.bald, b.vorschauTage, b.weitere]).toEqual([8, 1, 30, 0]);
    expect(b.zeilen.map((z) => `${z.frist.tag}${z.frist.jahr} ${text(z)} › ${z.schritt}`)).toEqual([
      '13.11.2027 4 Bezugsbasen überprüfen | Vergleichsgrundlagen von 4 Kennzahlen › Ansehen',
      '03.04.2028 Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 neu freigeben | Werte nach der Freigabe korrigiert (K-2028-0001) › Entwurf vergleichen',
      '24.11.2028 Energetische Bewertung überprüfen | Grundlage der wesentlichen Energieeinsätze (BR-2027-0001) › Neuen Stand freigeben',
      '10.12.2028 Energiepolitik und Anwendungsbereich überprüfen | Vorgaben Ihres Energiemanagements › Ansehen',
    ]);
    // Ein Bündel öffnet die Wiedervorlage mit genau diesem Filter, ein einzelner Eintrag sein Objekt mit Entscheid.
    expect(b.zeilen[0].sprung!.hash).toBe('#/portfolio/energiemanagement/wiedervorlage?art=bezugsbasis_ueberpruefung');
    expect(b.zeilen[1].sprung!.hash).toBe('#/portfolio/berichte/BR-2028-0001?entscheid=bericht_anstoss');
  });

  it('Demo: aus 13 Zeilen werden drei Zeilen, der Bericht mit seinen zehn Korrekturen', () => {
    const b = wasStehtAn(wvDemo())!;
    expect(b.ueberfaellig).toBe(4);
    expect(b.zeilen.map(text)).toEqual([
      'Monatsbericht Standort Werk Ahrenberg Oktober 2026 neu freigeben | 10 Korrekturen nach der Freigabe',
      'Messstelle für Messbedarf MB-1 einrichten | Aus der Messplanung der energetischen Bewertung',
      '2 Bezugsbasen überprüfen | Vergleichsgrundlagen von 2 Kennzahlen',
    ]);
  });

  it('mehr als vier Aufgaben: die übrigen nennt eine Zeile, nichts verschwindet still', () => {
    const w = wvR12();
    w.faellig.push(
      wvZeile('feststellung', 'F-2029-0001', 'Feststellung — Frist', '2029-01-20', 23, { id: 'f1' }),
      wvZeile('abweichung_frist', 'AW-2029-0001', 'KZ-0004 Netzbezug je m²', '2029-01-30', 13, { id: 'aw1' }),
    );
    const b = wasStehtAn(w)!;
    expect(b.zeilen).toHaveLength(4);
    expect(b.weitere).toBe(2);
  });

  it('Normalfall: nichts überfällig, dann die nächsten zwei Fristen, oder wenn auch die fehlen, das Fenster und was danach kommt', () => {
    const nurBald = wasStehtAn({ ...wvR12(), faellig: [] })!;
    expect(nurBald.ueberfaellig).toBe(0);
    expect(nurBald.zeilen.map((z) => z.aufgabe)).toEqual(['Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden']);
    const ruhig = wasStehtAn(wvNormal())!;
    expect([ruhig.ueberfaellig, ruhig.bald, ruhig.spaeter, ruhig.zeilen.length, ruhig.fensterBis]).toEqual([0, 0, 11, 0, '30.05.2029']);
  });

  it('ohne jede Frist und ohne Antwort kein Block (AP-13 E3)', () => {
    expect(wasStehtAn(wvLeer())).toBeNull();
    expect(wasStehtAn(null)).toBeNull();
  });

  it('Bündel aus Einträgen derselben Art: zwei Dokumente beim Namen, ab drei gezählt', () => {
    const w = wvR12();
    w.faellig.push(wvZeile('dokument_ueberpruefung', 'D-0003', 'Rechtskataster — Überprüfung', '2028-12-11', 63, { id: 'd3' }));
    const [b] = buendel(arbeitsliste(w).ueberfaellig.filter((e) => e.art === 'dokument_ueberpruefung'));
    expect(text(b)).toBe('3 Dokumente überprüfen | Energiepolitik, Anwendungsbereich und Rechtskataster');
  });
});

describe('Wiedervorlage w1 · Status-Eskalation für die Statuszeile (Entscheid 9)', () => {
  it('R12: „8 Fristen überfällig“ mit der ältesten Frist und den Arten, älteste zuerst', () => {
    expect(wiedervorlageStatus(wvR12())).toEqual({
      ueberfaellig: 8,
      aeltesteSeit: '13.11.2027',
      arten: ['Bezugsbasen', 'Bericht', 'energetische Bewertung', 'Dokumente'],
      bereiche: ['auswerten', 'nachweisen'],
      titel: '8 Fristen überfällig',
      satz: 'Älteste seit 13.11.2027 · Bezugsbasen, Bericht, energetische Bewertung, Dokumente',
      sprung: { route: expect.objectContaining({ page: 'portfolio-energiemanagement', energiemanagementReiter: 'wiedervorlage' }), hash: '#/portfolio/energiemanagement/wiedervorlage' },
    });
  });
  it('Einzahl und nichts Überfälliges', () => {
    const eins = { ...wvLeer(), faellig: [wvZeile('managementbewertung', 'BR-2029-0001', 'Nächste Managementbewertung', '2030-02-12', 2)] };
    expect(wiedervorlageStatus(eins)).toMatchObject({ titel: '1 Frist überfällig', arten: ['Managementbewertung'], satz: 'Älteste seit 12.02.2030 · Managementbewertung' });
    expect(wiedervorlageStatus(wvNormal())).toBeNull();
    expect(wiedervorlageStatus({ ...wvR12(), faellig: [] })).toBeNull();
    expect(wiedervorlageStatus(null)).toBeNull();
  });
});

describe('Wiedervorlage w1 · Zuletzt erledigt aus dem Verzeichnis', () => {
  it('die Entscheidungen der letzten 90 Tage, die eine Frist beenden: die jüngste zuerst, höchstens fünf', () => {
    expect(zuletztErledigt(verzeichnisDemo()).map((e) => `${e.tag}${e.jahr} ${e.titel} · ${e.wer}`)).toEqual([
      '30.04.2029 Energetische Bewertung BR-2029-0002: Stand Nr. 1 freigegeben · eingetragen von ines',
      '15.04.2029 Feststellung F-2029-0001: Wirksamkeit festgehalten · entschieden von Ines Kaltenbach',
      '20.03.2029 Energiepolitik: Fassung 2 freigegeben · entschieden von Robert Falk',
      '12.02.2029 Managementbewertung 2028: Stand Nr. 1 freigegeben · entschieden von Robert Falk',
      '31.01.2029 Internes Audit AU-2029-0001 abgeschlossen · entschieden von Ines Kaltenbach',
    ]);
  });
  it('nicht dabei: Fassungen von Kennzahlen und Kriterien, Aufgaben, Feststellungen, Nachweise, ein erster Berichtsstand, Älteres', () => {
    const titel = zuletztErledigt(verzeichnisDemo(), '2029-04-30').map((e) => e.titel).join(' / ');
    expect(titel).not.toMatch(/KZ-0025|Kriterien|Bezugsbasen pflegen|Wer die Bezugsbasen|D-0005|BR-2028-0001|EZ-2028-0001/);
    // Am 30.01.2029 liegt der 15.01.2029 in den 90 Tagen; die Bezugsbasis vom 25.11.2027 bleibt draußen.
    expect(zuletztErledigt(verzeichnisDemo(), '2029-01-31').map((e) => e.titel)).toEqual([
      'Internes Audit AU-2029-0001 abgeschlossen',
      'Energieziel EZ-2028-0001 bewertet',
    ]);
  });
});

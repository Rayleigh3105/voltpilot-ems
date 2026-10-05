import { describe, expect, it } from 'vitest';
import { VOKABULARE } from './energiemanagement';
import { ABLESUNG, ableseRunde, DOK, herleitung, KZ, wvDemo, wvLeer, wvNormal, wvR12, wvZeile, zuletztDemo, zuletztLeer } from './test/wiedervorlageFixtures';
import {
  ABLESUNG_EINTRAGEN,
  ART_WORT,
  arbeitsliste,
  artAusAdresse,
  artFilterWort,
  aufgabeFestlegenSprung,
  buendel,
  eintragSprung,
  fristBild,
  gefiltert,
  jahresplanGruppen,
  kopfSatz,
  lautAufgabe,
  OHNE_FILTER,
  SCHRITT,
  wasStehtAn,
  wiedervorlageStatus,
  zuletztErledigt,
  type Wiedervorlage,
} from './wiedervorlage';

/** Aufgabe und Grund als ein Satz; das geschützte Leerzeichen in „+ 2 Monate“ prüft ein eigener Fall. */
const text = (e: { aufgabe: string; grund: string }) => `${e.aufgabe} | ${e.grund}`.replace(/\u00a0/g, ' ');

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
  it('ein Energieziel wird mit dem Ende seiner Zielperiode bewertbar: „ab“, nicht „bis“', () => {
    expect(fristBild('2029-12-31', -245, 'energieziel_bewertung')).toMatchObject({ wort: 'ab', satz: 'bewertbar ab 31.12.2029', ueberfaellig: false });
    expect(fristBild('2028-12-31', 3, 'energieziel_bewertung')).toMatchObject({ wort: 'seit', ueberfaellig: true });
  });
});

describe('Wiedervorlage w1 · Einträge: Aufgabe, Grund aus der Herleitung, Bereich, Zuständig, ein Schritt', () => {
  it('R12: acht überfällige Einträge, eine Frist in den nächsten 30 Tagen, sechs im Jahresplan bis 12.02.2030', () => {
    const l = arbeitsliste(wvR12());
    expect(l.stand).toBe('12.02.2029');
    expect(l.fensterBis).toBe('14.03.2029');
    expect(l.ueberfaellig.map((e) => e.kennzeichen)).toEqual(['BB-0002', 'BB-0005', 'BB-0003', 'BR-2028-0001', 'BB-0004', 'BR-2027-0001', 'D-0001', 'D-0002']);
    expect(l.bald.map((e) => e.kennzeichen)).toEqual(['M-2029-0001']);
    expect(l.jahresplan.map((e) => e.kennzeichen)).toEqual(['F-2029-0001', 'D-0003', 'M-2029-0002', 'D-0004', 'BB-0001', 'AU-2029-0001']);
    expect(l.jahresplanBis).toBe('12.02.2030');
    expect(l.bereiche).toEqual(['auswerten', 'verbessern', 'nachweisen']);
  });

  it('jede Art spricht als Aufgabe mit Verb; der Grund nennt Gegenstand und Herleitung der Route, das Kennzeichen einmal', () => {
    const [bb2, , , bericht, , bewertung, d1] = arbeitsliste(wvR12()).ueberfaellig;
    expect(text(bb2)).toBe('Bezugsbasis BB-0002 überprüfen | Grundlage für „Stromeinsatz Montage je Stück“ · Fassung 2 vom 13.11.2026 + 12 Monate');
    expect(text(bericht)).toBe(
      'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 neu freigeben | Korrektur K-2028-0001 hat nach der Freigabe Werte geändert. Der freigegebene Stand bleibt, bis Sie entscheiden.',
    );
    expect(bericht.grundKurz).toBe('Werte nach der Freigabe korrigiert (K-2028-0001)');
    expect(text(bewertung)).toBe('Energetische Bewertung überprüfen | Grundlage der wesentlichen Energieeinsätze · Stand Nr. 1 vom 24.11.2027 + 12 Monate');
    expect(text(d1)).toBe('Energiepolitik überprüfen | Vorgabe Ihres Energiemanagements (D-0001) · „geprüft, bleibt“ am 10.12.2027 + 12 Monate');
    const [m] = arbeitsliste(wvR12()).bald;
    expect(text(m)).toBe(
      'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden | Maßnahme M-2029-0001 · aus der Feststellung F-2029-0001',
    );
    expect(m.frist.relativ).toBe('in 16 Tagen');
    expect([bb2.bereich, bericht.bereich, bewertung.bereich, d1.bereich, m.bereich]).toEqual(['auswerten', 'nachweisen', 'auswerten', 'nachweisen', 'verbessern']);
    expect([bb2.schritt, bericht.schritt, bewertung.schritt, d1.schritt, m.schritt]).toEqual([
      'Bestätigen oder neu fassen', 'Entwurf vergleichen', 'Neuen Stand freigeben', 'Bestätigen oder neu fassen', 'Umsetzung melden',
    ]);
  });

  it('Zuständig: die Person am Objekt, sonst laut Aufgabe; ohne beide niemand, aber die Aufgabe ist bekannt', () => {
    const l = arbeitsliste(wvR12());
    const e = (kz: string) => [...l.ueberfaellig, ...l.bald, ...l.jahresplan].find((x) => x.kennzeichen === kz)!;
    expect(e('BB-0002').zustaendig).toEqual({ name: 'Ines Kaltenbach', herkunft: 'objekt', ich: true });
    expect(e('D-0001').zustaendig).toEqual({ name: 'Ines Kaltenbach', herkunft: 'aufgabe', ich: true });
    expect(e('D-0001').aufgabeIm).toBe('dokumente');
    expect(e('M-2029-0001').zustaendig).toEqual({ name: 'Jonas Wendlinger', herkunft: 'objekt', ich: false });
    expect([e('BR-2028-0001').zustaendig, e('BR-2028-0001').aufgabeIm]).toEqual([null, 'energiemanagement_leiten']);
    expect([e('BR-2027-0001').zustaendig, e('BR-2027-0001').aufgabeIm]).toEqual([null, 'bewertung_messplanung']);
    expect(lautAufgabe('dokumente')).toBe('laut Aufgabe „Dokumente des Energiemanagements pflegen“');
    expect(lautAufgabe(null)).toBe('laut Aufgabe');
    expect(aufgabeFestlegenSprung('energiemanagement_leiten').hash).toBe(
      '#/portfolio/energiemanagement/aufgaben?entscheid=aufgabe_festlegen&kennzeichen=energiemanagement_leiten',
    );
  });

  it('nennt eine Zeile nur „verantwortlich“ (ein Leser vor Vertrag 1.1), ist das die Person am Objekt', () => {
    const [e] = arbeitsliste({
      ...wvLeer(),
      faellig: [wvZeile('massnahme_termin', 'M-1', 'Maßnahme', '2029-01-01', 3, { verantwortlich: 'Jonas Wendlinger', id: 'm' })],
    }).ueberfaellig;
    expect(e.zustaendig).toEqual({ name: 'Jonas Wendlinger', herkunft: 'objekt', ich: false });
  });

  it('ohne Herleitung (ein älterer Server) bleibt der Grund beim Gegenstand; nichts wird erfunden', () => {
    const [bb, d] = arbeitsliste({
      ...wvLeer(),
      faellig: [
        wvZeile('bezugsbasis_ueberpruefung', 'BB-0001', 'Bezugsbasis BB-0001, Fassung 2 — Überprüfung (Freigabe 01.03.2027 + 12 Monate)', '2028-03-01', 3, { kennzahl_id: 'k' }),
        wvZeile('dokument_ueberpruefung', 'D-0001', 'Energiepolitik — Überprüfung', '2028-12-10', 64, { id: 'd' }),
      ],
    }).ueberfaellig;
    expect(bb.grund).toBe('Vergleichsgrundlage einer Kennzahl');
    expect(d.grund).toBe('Vorgabe Ihres Energiemanagements (D-0001)');
    expect([bb.zustaendig, d.zustaendig]).toEqual([null, null]);
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
    // Der Messbedarf wird an seinem Energieeinsatz eingelöst; ohne Einsatz führt der Weg über die Messplanung.
    expect(eintragSprung({ ...z('messbedarf_frist', 'MB-1', 'mb-1'), einsatz_id: 'ee-8' })!.hash).toBe('#/portfolio/bewertung/ee-8?entscheid=messbedarf_frist&kennzeichen=MB-1');
    expect(eintragSprung(z('messbedarf_frist', 'MB-1', 'mb-1'))!.hash).toBe('#/portfolio/bewertung?entscheid=messbedarf_frist&kennzeichen=MB-1');
    expect(eintragSprung(z('feststellung', 'F-2029-0001', 'f1'))!.hash).toBe('#/portfolio/energiemanagement/feststellungen/f1?entscheid=feststellung');
    // Ohne Kennung der Route gibt es keine Seite: dann kein Sprung (WV3).
    expect(eintragSprung(z('dokument_ueberpruefung', 'D-0009'))).toBeNull();
  });

  it('ein Gegenstand, ein Eintrag: die zehn Korrekturen eines Berichts sind EINE Zeile der Route und EINE Aufgabe', () => {
    const l = arbeitsliste(wvDemo());
    expect(l.ueberfaellig.map((e) => [e.kennzeichen, e.zeilen])).toEqual([
      ['BR-2026-0001', 1],
      ['G-1', 1],
      ['G-2', 1],
      ['G-3', 1],
      ['MB-1', 1],
      ['BB-0006', 1],
      ['BB-0007', 1],
    ]);
    const [bericht, , , , mb] = l.ueberfaellig;
    expect(text(bericht)).toBe(
      'Monatsbericht Standort Werk Ahrenberg Oktober 2026 neu freigeben | 10 Korrekturen nach der Freigabe, zuerst K-2026-0014. Der freigegebene Stand bleibt, bis Sie entscheiden.',
    );
    expect(bericht.grundKurz).toBe('10 Korrekturen nach der Freigabe');
    expect(bericht.frist.satz).toBe('fällig seit 05.10.2026');
    expect(text(mb)).toBe('Messstelle für Messbedarf MB-1 einrichten | Wärmemengenzähler am Trockner der Spritzgießmaschine 4');
    expect(mb.sprung!.hash).toBe('#/portfolio/bewertung/ee-8?entscheid=messbedarf_frist&kennzeichen=MB-1');
    expect(mb.bereich).toBe('messen');
    expect(mb.schritt).toBe('Messstelle anlegen');
  });

  it('ein älterer Server schickte je Korrektur eine Zeile: auch dann bleibt es ein Eintrag', () => {
    const anstoss = (k: string) => wvZeile('bericht_anstoss', 'BR-2026-0001', `Monatsbericht Oktober 2026 — Revision angestoßen (${k})`, '2026-10-05', 938);
    const [e] = arbeitsliste({ ...wvLeer(), faellig: ['K-2026-0014', 'K-2026-0015', 'K-2026-0016'].map(anstoss) }).ueberfaellig;
    expect(e.zeilen).toBe(3);
    expect(text(e)).toBe('Monatsbericht Oktober 2026 neu freigeben | 3 Korrekturen nach der Freigabe, zuerst K-2026-0014. Der freigegebene Stand bleibt, bis Sie entscheiden.');
  });

  it('der Jahresplan der Demo: Grund je Art, und nach Monaten gruppiert wie im Konzept', () => {
    const l = arbeitsliste(wvDemo());
    expect(l.jahresplanBis).toBe('30.04.2030');
    expect(l.jahresplan.map((e) => `${e.frist.wort} ${e.frist.tag}${e.frist.jahr} ${text(e)}`)).toEqual([
      'bis 30.06.2029 Bekanntmachung der Energiepolitik im Werk Lindach wiederholen | Maßnahme M-2029-0002 · aus dem internen Audit AU-2029-0001',
      'bis 30.06.2029 Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal | Maßnahme M-2029-0003 · aus der Managementbewertung BR-2029-0001 (Beschluss 2)',
      'bis 10.11.2029 Kriterien für Betrieb und Instandhaltung überprüfen | Vorgabe Ihres Energiemanagements (D-0004) · Fassung 1 vom 10.11.2028 + 12 Monate',
      'bis 05.12.2029 Rechtskataster überprüfen | Vorgabe Ihres Energiemanagements (D-0003) · Fassung 1 vom 05.12.2028 + 12 Monate',
      'ab 31.12.2029 Energieziel EZ-2029-0001 bewerten | Zielperiode bis 31.12.2029 · bewertbar, sobald Dezember endgültig ist',
      'bis 22.01.2030 Internes Audit durchführen | Zuletzt AU-2029-0001 am 22.01.2029 · alle 12 Monate',
      'bis 12.02.2030 Managementbewertung abhalten | Letzte Sitzung am 12.02.2029 (BR-2029-0001) · alle 12 Monate',
      'bis 13.02.2030 Anwendungsbereich überprüfen | Vorgabe Ihres Energiemanagements (D-0002) · „geprüft, bleibt“ am 13.02.2029 + 12 Monate',
      'bis 20.03.2030 Energiepolitik überprüfen | Vorgabe Ihres Energiemanagements (D-0001) · Fassung 2 vom 20.03.2029 + 12 Monate',
      'bis 30.04.2030 Bezugsbasis BB-0001 überprüfen | Grundlage für „Stromeinsatz Spritzguss je kg“ · „geprüft, bleibt“ am 30.04.2029 + 12 Monate',
      'bis 30.04.2030 Energetische Bewertung überprüfen | Grundlage der wesentlichen Energieeinsätze · Stand Nr. 1 vom 30.04.2029 + 12 Monate',
    ]);
    expect(jahresplanGruppen(l.jahresplan).map((g) => [g.titel, g.eintraege.length])).toEqual([
      ['Juni 2029', 2],
      ['November und Dezember 2029', 3],
      ['Januar bis April 2030', 6],
    ]);
  });

  it('Monatsgruppen: eine Lücke und ein Jahreswechsel trennen, ein Monat steht allein', () => {
    const e = (tag: string) => arbeitsliste({ ...wvLeer(), spaeter: [wvZeile('massnahme_termin', `M-${tag}`, 'M', tag, -40)] }).jahresplan[0];
    const titel = (tage: string[]) => jahresplanGruppen(tage.map(e)).map((g) => g.titel);
    expect(titel(['2029-06-01', '2029-06-30', '2029-08-01'])).toEqual(['Juni 2029', 'August 2029']);
    expect(titel(['2029-11-01', '2029-12-01', '2030-01-01'])).toEqual(['November und Dezember 2029', 'Januar 2030']);
    expect(titel(['2029-03-01', '2029-04-01', '2029-05-01'])).toEqual(['März bis Mai 2029']);
    expect(titel([])).toEqual([]);
  });

  it('eine Art, die das Portal noch nicht kennt, steht mit dem Titel der Route und ohne Sprung', () => {
    const fremd = { ...wvZeile('massnahme_termin', 'X-1', 'Neue Frist', '2029-01-01', 5), art: 'ablesung_frist' } as unknown as Wiedervorlage['faellig'][number];
    const [e] = arbeitsliste({ ...wvLeer(), faellig: [fremd] }).ueberfaellig;
    expect(e.aufgabe).toBe('Neue Frist');
    expect(e.sprung).toBeNull();
  });

  it('Filter nach Art, Bereich und Person; ein unbekanntes Wort in der Adresse gilt nicht', () => {
    const l = arbeitsliste(wvR12());
    expect(gefiltert(l.ueberfaellig, { ...OHNE_FILTER, art: 'bezugsbasis_ueberpruefung' })).toHaveLength(4);
    expect(gefiltert(l.ueberfaellig, { ...OHNE_FILTER, bereich: 'nachweisen' }).map((e) => e.kennzeichen)).toEqual(['BR-2028-0001', 'D-0001', 'D-0002']);
    // Meine: der angemeldeten Person zugeordnet, am Objekt oder laut Aufgabe; Ohne Zuständige: niemand.
    expect(gefiltert(l.ueberfaellig, { ...OHNE_FILTER, wer: 'meine' }).map((e) => e.kennzeichen)).toEqual(['BB-0002', 'BB-0005', 'BB-0003', 'BB-0004', 'D-0001', 'D-0002']);
    expect(gefiltert(l.ueberfaellig, { ...OHNE_FILTER, wer: 'ohne' }).map((e) => e.kennzeichen)).toEqual(['BR-2028-0001', 'BR-2027-0001']);
    expect(gefiltert(l.bald, { ...OHNE_FILTER, wer: 'meine' })).toEqual([]);
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
    expect([b.ueberfaellig, b.bald, b.spaeter, b.vorschauTage, b.weitere]).toEqual([8, 1, 6, 30, 0]);
    expect(b.zeilen.map((z) => `${z.frist.tag}${z.frist.jahr} ${text(z)} › ${z.schritt}`)).toEqual([
      '13.11.2027 4 Bezugsbasen überprüfen | Vergleichsgrundlagen von 4 Kennzahlen › Ansehen',
      '03.04.2028 Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 neu freigeben | Werte nach der Freigabe korrigiert (K-2028-0001) › Entwurf vergleichen',
      '24.11.2028 Energetische Bewertung überprüfen | Grundlage der wesentlichen Energieeinsätze · Stand Nr. 1 vom 24.11.2027 + 12 Monate › Neuen Stand freigeben',
      '10.12.2028 Energiepolitik und Anwendungsbereich überprüfen | Vorgaben Ihres Energiemanagements › Ansehen',
    ]);
    // Ein Bündel öffnet die Wiedervorlage mit genau diesem Filter, ein einzelner Eintrag sein Objekt mit Entscheid.
    expect(b.zeilen[0].sprung!.hash).toBe('#/portfolio/energiemanagement/wiedervorlage?art=bezugsbasis_ueberpruefung');
    expect(b.zeilen[1].sprung!.hash).toBe('#/portfolio/berichte/BR-2028-0001?entscheid=bericht_anstoss');
  });

  it('Demo: sieben Einträge in vier Zeilen, der Bericht mit seinen zehn Korrekturen, die Ablese-Runden mit ihren Zählern', () => {
    const b = wasStehtAn(wvDemo())!;
    expect(b.ueberfaellig).toBe(7);
    expect(b.zeilen.map(text)).toEqual([
      'Monatsbericht Standort Werk Ahrenberg Oktober 2026 neu freigeben | 10 Korrekturen nach der Freigabe',
      '10 Zähler ablesen | Halle 1, Halle 2 und Verwaltung',
      'Messstelle für Messbedarf MB-1 einrichten | Wärmemengenzähler am Trockner der Spritzgießmaschine 4',
      '2 Bezugsbasen überprüfen | Vergleichsgrundlagen von 2 Kennzahlen',
    ]);
    expect(b.weitere).toBe(0);
    expect(b.zeilen[1].sprung!.hash).toBe('#/portfolio/energiemanagement/wiedervorlage?art=zaehlerablesung');
  });

  it('mehr als vier Aufgaben: die übrigen nennt eine Zeile, nichts verschwindet still', () => {
    const w = wvR12();
    w.faellig.push(
      wvZeile('feststellung', 'F-2029-0002', 'Feststellung — Frist', '2029-01-20', 23, { id: 'f1' }),
      wvZeile('abweichung_frist', 'AW-2029-0001', 'KZ-0004 Netzbezug je m²', '2029-01-30', 13, { id: 'aw1' }),
    );
    const b = wasStehtAn(w)!;
    expect(b.zeilen).toHaveLength(4);
    expect(b.weitere).toBe(2);
  });

  it('Normalfall: nichts überfällig, dann die nächsten zwei Fristen, auch aus dem Jahresplan (je Monat gebündelt)', () => {
    const nurBald = wasStehtAn({ ...wvR12(), faellig: [] })!;
    expect(nurBald.ueberfaellig).toBe(0);
    expect(nurBald.zeilen.map((z) => z.aufgabe)).toEqual([
      'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden',
      'Feststellung F-2029-0001 klären',
    ]);
    const ruhig = wasStehtAn(wvNormal())!;
    expect([ruhig.ueberfaellig, ruhig.bald, ruhig.spaeter, ruhig.weitere, ruhig.fensterBis]).toEqual([0, 0, 11, 0, '30.05.2029']);
    expect(ruhig.zeilen.map((z) => `${z.frist.tag}${z.frist.jahr} ${text(z)}`)).toEqual([
      '30.06.2029 2 Maßnahmen umsetzen | Bekanntmachung der Energiepolitik im Werk Lindach wiederholen und Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal',
      '10.11.2029 Kriterien für Betrieb und Instandhaltung überprüfen | Vorgabe Ihres Energiemanagements (D-0004) · Fassung 1 vom 10.11.2028 + 12 Monate',
    ]);
  });

  it('ohne jede Frist und ohne Antwort kein Block (AP-13 E3)', () => {
    expect(wasStehtAn(wvLeer())).toBeNull();
    expect(wasStehtAn(null)).toBeNull();
  });

  it('Bündel aus Einträgen derselben Art: zwei Dokumente beim Namen, ab drei gezählt', () => {
    const w = wvR12();
    w.faellig.push(wvZeile('dokument_ueberpruefung', 'D-0009', 'Rechtskataster — Überprüfung', '2028-12-11', 63, { id: 'd3' }));
    const [b] = buendel(arbeitsliste(w).ueberfaellig.filter((e) => e.art === 'dokument_ueberpruefung'));
    expect(text(b)).toBe('3 Dokumente überprüfen | Energiepolitik, Anwendungsbereich und Rechtskataster');
  });

  it('je Monat gebündelt: dieselbe Art in zwei Monaten sind zwei Zeilen', () => {
    const plan = arbeitsliste(wvNormal()).jahresplan.filter((e) => e.art === 'dokument_ueberpruefung');
    expect(buendel(plan).map((b) => b.anzahl)).toEqual([4]);
    expect(buendel(plan, true).map((b) => [b.frist.tag + b.frist.jahr, b.anzahl])).toEqual([
      ['10.11.2029', 1],
      ['05.12.2029', 1],
      ['13.02.2030', 1],
      ['20.03.2030', 1],
    ]);
  });
});

describe('Wiedervorlage w1 · Zählerablesung (Entscheid 7, Vertrag 1.2)', () => {
  it('eine Runde je Ort: Zähler zählen, der Grund ist die letzte Ablesung + 2 Monate, der Schritt führt ins Register des Orts', () => {
    const [halle1, halle2] = arbeitsliste(wvDemo()).ueberfaellig.filter((e) => e.art === 'zaehlerablesung');
    expect(text(halle1)).toBe('8 Zähler in Halle 1 ablesen | Zuletzt abgelesen am 01.10.2026 + 2 Monate');
    // „+ 2 Monate“ bricht nur als Ganzes um (geschützte Leerzeichen), wie jeder Rhythmus der Wiedervorlage.
    expect(halle1.grund).toBe('Zuletzt abgelesen am 01.10.2026 +\u00a02\u00a0Monate');
    expect(arbeitsliste(wvR12()).ueberfaellig[0].grund).toMatch(/vom 13\.11\.2026 \+\u00a012\u00a0Monate$/);
    expect(halle1.frist.satz).toBe('fällig seit 01.12.2026');
    expect(halle1.bereich).toBe('messen');
    expect(halle1.schritt).toBe('Ablesungen eintragen');
    expect(halle1.sprung!.hash).toBe('#/portfolio/messstellen?ort=G-1&entscheid=zaehlerablesung');
    expect(halle1.zustaendig).toEqual({ name: 'Ines Kaltenbach', herkunft: 'aufgabe', ich: true });
    // Ein Zähler: genau seine Messstelle, der Schritt heißt wie ihr Knopf.
    expect(text(halle2)).toBe('Zähler MS-20 in Halle 2 ablesen | Zuletzt abgelesen am 01.10.2026 + 2 Monate');
    expect(halle2.schritt).toBe(ABLESUNG_EINTRAGEN);
    expect(halle2.sprung!.hash).toBe(`#/portfolio/messstellen/${ABLESUNG.ms20}?entscheid=zaehlerablesung`);
  });

  it('derselbe Ort an zwei Tagen sind zwei Einträge; ohne Ablesung zählt der Beginn', () => {
    const neu = wvZeile('zaehlerablesung', 'ST-2', 'Zählerablesung Werk Lindach (MS-30 Lager)', '2026-11-15', 25, {
      id: 'ms-30',
      herleitung: herleitung('ablesebeginn', '2026-11-15', { kennung: 'MS-30', anzahl: 1 }),
      bezug: 'Werk Lindach',
      aufgabe: 'bewertung_messplanung',
    });
    const l = arbeitsliste({
      ...wvLeer(),
      stichtag: '2026-12-10T09:00:00+01:00',
      faellig: [neu, ableseRunde('G-2', 'Halle 2', 2, 'g-2', 9)],
      vorschau: [ableseRunde('G-2', 'Halle 2', 'MS-25 Kühlung', 'ms-25', -10, '2026-12-20')],
    });
    expect(l.ueberfaellig.map((e) => e.key)).toEqual(['zaehlerablesung/ST-2/2026-11-15', 'zaehlerablesung/G-2/2026-12-01']);
    expect(l.bald.map((e) => e.key)).toEqual(['zaehlerablesung/G-2/2026-12-20']);
    expect(text(l.ueberfaellig[0])).toBe('Zähler MS-30 in Werk Lindach ablesen | Noch keine Ablesung, vorgesehen seit 15.11.2026');
    expect(l.ueberfaellig[0].zustaendig).toBeNull();
    expect(l.ueberfaellig[0].aufgabeIm).toBe('bewertung_messplanung');
    // Bündel derselben Runde an einem Ort: die Zähler zusammen, der Grund der ältesten.
    expect(buendel([...l.ueberfaellig.slice(1), ...l.bald]).map(text)).toEqual([
      '3 Zähler in Halle 2 ablesen | Zuletzt abgelesen am 01.10.2026 + 2 Monate',
    ]);
  });

  it('Filter, Statuszeile und eine Runde ohne Zahl (ein älterer Server) bleiben verständlich', () => {
    const l = arbeitsliste(wvDemo());
    expect(gefiltert(l.ueberfaellig, { ...OHNE_FILTER, art: 'zaehlerablesung' }).map((e) => e.kennzeichen)).toEqual(['G-1', 'G-2', 'G-3']);
    expect(gefiltert(l.ueberfaellig, { ...OHNE_FILTER, bereich: 'messen' }).map((e) => e.kennzeichen)).toEqual(['G-1', 'G-2', 'G-3', 'MB-1']);
    expect(artFilterWort('zaehlerablesung')).toBe('Zählerablesungen');
    expect(wiedervorlageStatus(wvDemo())!.satz).toBe('Älteste seit 05.10.2026 · Bericht, Zählerablesungen, Messbedarf, Bezugsbasen');
    const ohne = arbeitsliste({ ...wvLeer(), faellig: [wvZeile('zaehlerablesung', 'G-9', 'Zählerablesung Lager (MS-9 Pumpe)', '2029-01-01', 5)] });
    expect(text(ohne.ueberfaellig[0])).toBe('Zählerablesung Lager (MS-9 Pumpe) | Werte aus Ablesungen');
    expect(ohne.ueberfaellig[0].sprung!.hash).toBe('#/portfolio/messstellen?ort=G-9&entscheid=zaehlerablesung');
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
    const eins = {
      ...wvLeer(),
      faellig: [wvZeile('managementbewertung', 'BR-2029-0001', 'Nächste Managementbewertung', '2030-02-12', 2, { herleitung: herleitung('sitzung', '2029-02-12', { monate: 12 }) })],
    };
    expect(wiedervorlageStatus(eins)).toMatchObject({ titel: '1 Frist überfällig', arten: ['Managementbewertung'], satz: 'Älteste seit 12.02.2030 · Managementbewertung' });
    expect(wiedervorlageStatus(wvNormal())).toBeNull();
    expect(wiedervorlageStatus({ ...wvR12(), faellig: [] })).toBeNull();
    expect(wiedervorlageStatus(null)).toBeNull();
  });
});

describe('Wiedervorlage w1 · Zuletzt erledigt (`GET …/wiedervorlage/zuletzt`)', () => {
  it('die Entscheidungen der Route als Sätze mit Tag und Person, die jüngste zuerst; „geprüft, bleibt“ steht dabei', () => {
    expect(zuletztErledigt(zuletztDemo()).map((e) => `${e.tag}${e.jahr} ${e.titel} · ${e.wer}`)).toEqual([
      '30.04.2029 Energetische Bewertung BR-2029-0002: Stand Nr. 1 freigegeben · eingetragen von Ines Kaltenbach',
      '30.04.2029 Bezugsbasis BB-0001: geprüft, bleibt · eingetragen von Ines Kaltenbach',
      '15.04.2029 Feststellung F-2029-0001: Wirksamkeit festgehalten · entschieden von Ines Kaltenbach',
      '20.03.2029 Energiepolitik: Fassung 2 freigegeben · entschieden von Robert Falk',
      '13.02.2029 Anwendungsbereich: geprüft, bleibt · entschieden von Robert Falk',
    ]);
  });
  it('höchstens fünf, ohne Eintrag nichts; eine unbekannte Art steht mit ihrem Titel', () => {
    const z = zuletztDemo();
    z.eintraege.push({ ...z.eintraege[0], art: 'neue_art', titel: 'Etwas Neues', am: '2029-02-01' });
    expect(zuletztErledigt(z)).toHaveLength(5);
    expect(zuletztErledigt({ ...z, eintraege: [z.eintraege[5]] })[0].titel).toBe('Etwas Neues');
    expect(zuletztErledigt(zuletztLeer())).toEqual([]);
  });
});

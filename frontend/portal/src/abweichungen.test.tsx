import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as A from './abweichungen';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { AuffaelligkeitHinweis } from './components/AuffaelligkeitHinweis';
import { BezugsbasisVergleich } from './components/BezugsbasisVergleich';
import { UEMS_NORMGRENZE } from './glossar';
import { abweichungRoute, hashForRoute, parseRoute } from './nav';
import { AbweichungSeite } from './pages/AbweichungSeite';
import { VerbesserungBereich } from './pages/VerbesserungBereich';
import { setSelbstauskunft } from './rollen';
import { abweichungBuehne, AUSSAGE_R2, aw1, aw2026, AW_IDS, PRUEFSUMME_R1, vermerkDez, vermerkJuli, ZUR_KENNTNIS_R11 } from './test/abweichungFixtures';
import { BB_IDS } from './test/bezugsbasisFixtures';
import { vergleichR2 } from './test/bezugsbasisVergleichFixtures';
import { kontenAhrenberg, vergleichKz4 } from './test/massnahmeFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * UEMS AP-18 IP-18: Vermerk-Zeile in der Vergleichs-Fläche, Register „Abweichungen“ und Abweichungs-Seite gegen
 * Ahrenberg R1, R2, R8, R11. Die Zahlen und Sätze stellt die Fixture (die Route) — hier wird geprüft, dass das Portal
 * sie unverändert zeigt, ordnet und filtert, und dass eine Ursache nur als „Aussage von …“ erscheint.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HEUTE = '2028-01-15';

describe('das reine Bild (abweichungen.ts)', () => {
  it('ordnet offen-überfällig zuerst, dann offen, dann abgeschlossen; „überfällig seit“ nur aus der Route', () => {
    const offenNichtFaellig = aw1('2028-01-20', { id: 'x', kennzeichen: 'AW-2028-0002', frist: { abruf: '2028-01-20', termin: '2028-02-10', faellig: null, seit_tagen: null } });
    const faellig = aw1('2028-02-10');
    const zu = aw2026();
    expect(A.ordnen([zu, offenNichtFaellig, faellig]).map((a) => a.kennzeichen)).toEqual(['AW-2028-0001', 'AW-2028-0002', 'AW-2026-0001']);
    expect(A.ueberfaelligText(faellig)).toBe('überfällig seit 10 Tagen');
    expect(A.ueberfaelligText(offenNichtFaellig)).toBeNull();
    expect(A.ueberfaelligText({ ...faellig, zustand: 'abgeschlossen' })).toBeNull();
    expect(A.filtern([zu, faellig], { zustand: '', kennzahl: '', ueberfaellig: true }).map((a) => a.kennzeichen)).toEqual(['AW-2028-0001']);
    expect(A.filtern([zu, faellig], { zustand: 'abgeschlossen', kennzahl: '', ueberfaellig: false }).map((a) => a.kennzeichen)).toEqual(['AW-2026-0001']);
    expect(A.ergebnisText(zu)).toBe('erklärt');
  });

  it('liest die Sätze aus jeder Form der Kopie — ein Vermerk, mehrere Vermerke, von Hand — und bildet keinen neu', () => {
    const r1 = vermerkDez().anlass_inhalt;
    expect(A.anlassSaetze(r1)).toEqual([vergleichR2().monate[1].satz]);
    expect(A.anlassSaetze({ vermerke: [r1, { satz: 'zweiter' }] })).toEqual([vergleichR2().monate[1].satz, 'zweiter']);
    expect(A.anlassSaetze({ vergleich: [{ satz: 'a' }, { satz: 'b' }], zeitraum: { satz: 'z' } })).toEqual(['a', 'b', 'z']);
    expect(A.anlassSaetze({ vergleich: [{ satz: 'a' }], zeitraum: { satz: 'z' } })).toEqual(['a']);
    expect(A.anlassSaetze(null)).toEqual([]);
  });

  it('belegt „Maßnahme anlegen“ aus dem Abschluss vor: Herkunft abweichung, Kennung, Kennzahl, Monate des Anlasses', () => {
    expect(A.massnahmeVorbelegung(aw1())).toEqual({ herkunft: 'abweichung', herkunftKennung: 'AW-2028-0001', kennzahl: BB_IDS.kz4, monate: '2027-12' });
    expect(A.massnahmeVorbelegung({ ...aw1(), monate: ['2027-12', '2027-11'] }).monate).toBe('2027-11/2027-12');
  });

  it('Form-Regeln: Abschluss verlangt Ergebnis, Begründung und bei „Maßnahme“ den Verweis; Aussage nie in der Zukunft', () => {
    expect(Object.keys(A.abschlussPruefen('', '', ''))).toEqual(['ergebnis', 'begruendung']);
    expect(Object.keys(A.abschlussPruefen('massnahme', 'Aussage erklärt es plausibel.', ''))).toEqual(['massnahme']);
    expect(A.abschlussPruefen('erklaert', 'Aussage erklärt es plausibel.', '')).toEqual({});
    expect(Object.keys(A.aussagePruefen({ wortlaut: 'kurz', person: '', am: '2028-01-16', beleg: '' }, HEUTE))).toEqual(['wortlaut', 'person', 'am']);
    expect(A.aussagePruefen({ wortlaut: AUSSAGE_R2, person: 'MD', am: '2028-01-14', beleg: '' }, HEUTE)).toEqual({});
  });

  it('die Route der Seite ist stabil: #/portfolio/verbesserung/abweichungen/{id}', () => {
    const hash = hashForRoute(abweichungRoute(AW_IDS.aw1));
    expect(hash).toBe(`#/portfolio/verbesserung/abweichungen/${AW_IDS.aw1}`);
    expect(parseRoute(hash)).toMatchObject({ page: 'portfolio-verbesserung', verbesserungReiter: 'abweichungen', abweichungId: AW_IDS.aw1 });
    expect(parseRoute('#/portfolio/verbesserung/abweichungen')).toMatchObject({ verbesserungReiter: 'abweichungen' });
    expect(parseRoute('#/portfolio/verbesserung/abweichungen').abweichungId).toBeUndefined();
  });
});

const ohneNbsp = (t: string | null | undefined) => (t ?? '').replace(/ /g, ' ');

describe('Verbessern-Konzept v1 (PR3): das reine Bild von Reiter und Seite', () => {
  it('liest „Was auffiel“ aus jeder Form der Kopie — Naht, Referenzwelt, von Hand, ein übernommener Vermerk', () => {
    const naht = A.anlassZahlen(vermerkDez().anlass_inhalt)!;
    expect(naht).toMatchObject({ monat: '2027-12', gemessen: { wert: '78000', einheit: 'kWh' }, erwartet: { wert: '69098', einheit: 'kWh' }, delta: '12.9', band: '2.0' });
    expect(naht.bedingung).toEqual({ wert: '250000', einheit: 'kg', name: 'Produktionsmenge' });
    const flach = A.anlassZahlen(vermerkJuli().anlass_inhalt)!;
    expect(flach).toMatchObject({ monat: '2028-07', gemessen: { wert: '73700', einheit: 'kWh' }, erwartet: { wert: '71910' }, delta: '2.5' });
    expect(flach.bedingung).toEqual({ wert: '262000', einheit: 'kg', name: null });
    expect(A.anlassZahlen({ vergleich: [{ periode: '2027-12', bereinigt: vermerkDez().anlass_inhalt.bereinigt }] })?.delta).toBe('12.9');
    expect(A.anlassZahlen({ vermerke: [vermerkJuli().anlass_inhalt] })?.delta).toBe('2.5');
    // Über mehrere Monate gibt es keine eine Zahl — dann sprechen die Sätze der Kopie.
    expect(A.anlassZahlen({ vermerke: [vermerkJuli().anlass_inhalt, vermerkJuli().anlass_inhalt] })).toBeNull();
    expect(A.anlassZahlen({ vergleich: [{}, {}] })).toBeNull();
    expect(A.anlassZahlen(null)).toBeNull();
    expect(A.anlassZahlen({ monat: '2026-11', flaeche_m2: 3100, gemessen_kwh: 38400, delta_prozent: 4.1 })?.bedingung).toEqual({ wert: '3100', einheit: 'm²', name: null });
  });

  it('Titel sagt, was auffiel (V6) — nie das Kennzeichen; Zahlen mit Tausenderpunkt und geschütztem Leerzeichen', () => {
    expect(ohneNbsp(A.auffaelligkeitTitel(vermerkDez()))).toBe('Dezember 2027: 12,9 % mehr als erwartet');
    expect(ohneNbsp(A.kurzTitel(['2027-12'], vermerkDez().anlass_inhalt))).toBe('Dezember 2027: 12,9 % mehr');
    expect(ohneNbsp(A.kurzTitel(['2027-11', '2027-12'], vermerkDez().anlass_inhalt))).toBe('November 2027, Dezember 2027');
    expect(ohneNbsp(A.abweichungTitel(aw1()))).toBe('Dezember 2027: 12,9 % mehr als erwartet');
    expect(ohneNbsp(A.zahlenZeile(A.anlassZahlen(vermerkDez().anlass_inhalt)))).toBe('78.000 kWh statt 69.098 bei 250.000 kg');
    expect(ohneNbsp(A.wasAuffielSatz(A.anlassZahlen(vermerkDez().anlass_inhalt)))).toBe(
      '78.000 kWh gemessen, 69.098 kWh erwartet bei 250.000 kg - 12,9 % mehr; im Rahmen wären ± 2 %.',
    );
    expect(A.mengeText({ wert: '81984.5', einheit: 'kWh' })).toBe('81.985 kWh');
    expect(ohneNbsp(A.deltaWort('-2.7'))).toBe('2,7 % weniger');
  });

  it('der Reiter: zu beantworten zuerst, dann in Arbeit, dann abgeschlossen (neueste zuerst) — mit Antwortsatz', () => {
    const offen = vermerkDez({ id: 'v-jan', periode: '2028-01', vermerkt_am: '2028-02-07T05:12:00Z' });
    const bild = A.reiterBild([aw2026('2028-02-10'), aw1('2028-02-10')], [vermerkJuli(), offen], '2028-02-10');
    expect(bild.zuBeantworten.map((v) => v.id)).toEqual(['v-jan']);
    expect(bild.inArbeit.map((a) => a.kennzeichen)).toEqual(['AW-2028-0001']);
    expect(bild.abgeschlossen.map((e) => e.key)).toEqual([vermerkJuli().id, AW_IDS.aw2026]);
    expect(ohneNbsp(bild.satz)).toBe('1 Monat wartet auf Ihre Antwort: Stromeinsatz Spritzguss je kg lag im Januar 2028 12,9 % über der Erwartung.');
    expect(bild.formal).toBe('1 zu beantworten · 1 offene Abweichung · Stand 10.02.2028');
    expect(A.ergebnisKurz(bild.abgeschlossen[0])).toBe(`zur Kenntnis genommen: ${ZUR_KENNTNIS_R11}`);
    expect(A.ergebnisKurz(bild.abgeschlossen[1])).toMatch(/^erklärt: Baustellenstrom/);

    // Lädt die Liste der Auffälligkeiten nicht, sagt der Satz nur, was die Abweichungen wissen.
    const ohne = A.reiterBild([aw2026('2028-02-10'), aw1('2028-02-10')], null, '2028-02-10');
    expect(ohne.satz).toBe('Nichts wartet auf eine Antwort; 1 Abweichung ist in Arbeit, 1 davon überfällig.');
    expect(ohne.formal).toBe('1 offene Abweichung · Stand 10.02.2028');
    expect(A.reiterBild([aw2026()], [], '2028-02-10').satz).toBe('Nichts zu beantworten, keine Abweichung offen.');
    expect(A.reiterBild([], [offen, { ...offen, id: 'v-feb', periode: '2028-02' }], '2028-03-10').satz).toBe(
      '2 Monate warten auf Ihre Antwort - der älteste ist Januar 2028 (Stromeinsatz Spritzguss je kg).',
    );
    expect(bild.wer).toBeNull();
  });

  it('die Sätze passen zu den Rechten: „Ihre Antwort“ nur, wer antworten darf; „Abschließen“ nur, wer abschließen darf', () => {
    const jan = vermerkDez({ id: 'v-jan', periode: '2028-01', vermerkt_am: '2028-02-07T05:12:00Z' });
    const feb = { ...jan, id: 'v-feb', periode: '2028-02' };
    // Ohne `verbesserung.verwalten` wartet der Monat auf eine Antwort - und der Reiter sagt, wer antwortet.
    const lesend = A.reiterBild([aw1('2028-02-10')], [jan], '2028-02-10', () => false);
    expect(ohneNbsp(lesend.satz)).toBe('1 Monat wartet auf eine Antwort: Stromeinsatz Spritzguss je kg lag im Januar 2028 12,9 % über der Erwartung.');
    expect(lesend.wer).toBe('Antworten können Kundenadministratoren, Energiemanager und Bearbeiter am Standort.');
    expect(A.reiterBild([], [jan, feb], '2028-03-10', () => false).satz).toBe(
      '2 Monate warten auf eine Antwort - der älteste ist Januar 2028 (Stromeinsatz Spritzguss je kg).',
    );
    // Darf die Person einen von zwei Monaten beantworten, zählt der Satz nur ihn.
    const gemischt = A.reiterBild([], [jan, feb], '2028-03-10', (v) => v.id === 'v-feb');
    expect(ohneNbsp(gemischt.satz)).toBe('1 Monat wartet auf Ihre Antwort: Stromeinsatz Spritzguss je kg lag im Februar 2028 12,9 % über der Erwartung.');
    expect(gemischt.wer).toBeNull();
    expect(gemischt.formal).toBe('2 zu beantworten · keine offene Abweichung · Stand 10.03.2028');
    expect(A.schrittInArbeit(true)).toEqual({ wort: 'Abschließen', leise: false });
    expect(A.schrittInArbeit(false)).toEqual({ wort: 'Ansehen', leise: true });
  });

  it('der Betrag einer Abweichung steht überall mit einer Stelle - „2,0 %“, nie einmal „2 %“ und einmal „2,0 %“', () => {
    const zwei = vermerkDez({ anlass_inhalt: { ...vermerkDez().anlass_inhalt, bereinigt: { ...vermerkDez().anlass_inhalt.bereinigt, delta_prozent: '2.0' } } });
    expect(A.anlassZahlen(zwei.anlass_inhalt)?.delta).toBe('2.0');
    expect(ohneNbsp(A.reiterBild([], [zwei], '2028-01-15').satz)).toContain('lag im Dezember 2027 2,0 % über der Erwartung.');
    expect(ohneNbsp(A.deltaWort('2.0'))).toBe('2,0 % mehr');
    expect(A.deltaBetrag('-12.94')).toBe('12,9');
  });

  it('die Seite: Stufen mit Datum, Ergebnis oben, Verlauf neueste zuerst — eine Aussage immer „Aussage von …“', () => {
    expect(A.stufenDerAbweichung(aw1())).toEqual([
      { wort: 'Vermerkt', tag: '07.01.2028', zustand: 'erledigt' },
      { wort: 'Untersuchen', tag: 'seit 12.01.2028', zustand: 'jetzt' },
      { wort: 'Abschließen', tag: 'bis 31.01.2028', zustand: 'offen' },
    ]);
    expect(A.stufenDerAbweichung(aw2026()).map((s) => `${s.wort} ${s.tag}`)).toEqual(['Vermerkt null', 'Untersucht ab 09.12.2026', 'Abgeschlossen 20.12.2026']);
    expect(A.antwortDerAbweichung(aw2026())).toEqual({ satz: 'Abgeschlossen: Die Abweichung ist erklärt.', formal: 'Ergebnis von Ines Kaltenbach am 20.12.2026 · nach 11 Tagen', warn: false });
    expect(A.antwortDerAbweichung(aw1('2028-01-15'))).toMatchObject({ satz: 'In Arbeit: Ines Kaltenbach klärt bis 31.01.2028, woran es lag.', warn: false });
    expect(A.antwortDerAbweichung(aw1('2028-02-10'))).toMatchObject({
      satz: 'Die Frist ist vorbei: Ines Kaltenbach sollte bis 31.01.2028 klären, woran es lag.',
      formal: 'überfällig seit 10 Tagen · eröffnet am 12.01.2028 von Ines Kaltenbach',
      warn: true,
    });
    const verlauf = A.verlaufBild(aw2026());
    expect(verlauf.map((e) => e.titel)).toEqual(['Abgeschlossen: erklärt', 'Aussage von Jonas Wendlinger', 'Untersuchung begonnen']);
    expect(verlauf[1].text).toMatch(/^‚Der Anbau der Halle 2 .*‘ · keine Messung · eingetragen von Ines Kaltenbach$/);
    expect(A.heuteAnders(A.anlassZahlen(vermerkDez().anlass_inhalt), { delta_prozent: '12.0' })).toMatch(/^Heute liest der Vergleich 12,0.% mehr - festgehalten bleiben 12,9.% mehr\./);
    expect(A.heuteAnders(A.anlassZahlen(vermerkDez().anlass_inhalt), { delta_prozent: '12.9' })).toBeNull();
    expect(A.plusTage('2029-04-30', 30)).toBe('2029-05-30');
    expect([0, 1, 3].map(A.nachTagen)).toEqual(['am selben Tag', 'nach 1 Tag', 'nach 3 Tagen']);
  });
});

describe('Reiter „Abweichungen“', () => {
  const OFFEN = vermerkDez({ id: 'a9000000-0000-4000-8000-000000202801', periode: '2028-01', vermerkt_am: '2028-02-07T05:12:00Z' });
  function reiter(heute = '2028-02-10', person = 'IK') {
    setSelbstauskunft(rechteSeed(person).me);
    Object.assign(api, abweichungBuehne('register', heute), {
      alleAuffaelligkeiten: async () => ({ abruf: heute, offen: 1, vermerke: [OFFEN, vermerkJuli()] }),
    });
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    const oeffne = vi.fn();
    const kennzahl = vi.fn();
    render(<VerbesserungBereich reiter="abweichungen" energiezielId={null} onReiter={() => undefined} onOeffnen={() => undefined} onListe={() => undefined} onAbweichung={oeffne} onKennzahl={kennzahl} />);
    return { oeffne, kennzahl };
  }

  it('Titel des Reiters, Antwortsatz, zu beantworten zuerst, in Arbeit mit „überfällig“, abgeschlossen mit Ergebnis', async () => {
    const { oeffne, kennzahl } = reiter();
    const register = await screen.findByTestId('abweichungen-register');
    expect(within(register).getByRole('heading', { level: 1 }).textContent).toBe('Abweichungen');
    // Der Bereichstitel „Ziele und Maßnahmen“ steht nicht über diesem Reiter (Entscheid 2).
    expect(screen.queryByText('Ziele und Maßnahmen', { selector: 'h1' })).toBeNull();
    expect(ohneNbsp(screen.getByTestId('abweichungen-satz').textContent)).toBe(
      '1 Monat wartet auf Ihre Antwort: Stromeinsatz Spritzguss je kg lag im Januar 2028 12,9 % über der Erwartung.',
    );
    const zu = screen.getByTestId('abweichungen-zu-beantworten');
    expect(ohneNbsp(within(zu).getByText(/^Januar 2028:/).textContent)).toBe('Januar 2028: 12,9 % mehr als erwartet KZ-0004');
    expect(ohneNbsp(zu.textContent)).toContain('Stromeinsatz Spritzguss je kg · 78.000 kWh statt 69.098 bei 250.000 kg');
    expect(within(zu).getByTestId('auffaelligkeit-beantworten').textContent).toBe('Beantworten');

    const arbeit = screen.getByTestId('abweichungen-in-arbeit');
    expect(within(arbeit).getByTestId('frist').textContent).toBe('überfällig seit 10 Tagen');
    fireEvent.click(within(arbeit).getByText(/^Dezember 2027:/));
    expect(oeffne).toHaveBeenCalledWith(AW_IDS.aw1);

    const zeilen = within(screen.getByTestId('abweichungen-abgeschlossen')).getAllByTestId('ergebnis');
    expect(zeilen[0].textContent).toMatch(/^zur Kenntnis genommen: Kleinserien-Sonderauftrag/);
    expect(zeilen[1].textContent).toMatch(/^erklärt: Baustellenstrom/);
    fireEvent.click(within(screen.getByTestId('kenntnis-2028-07')).getByText(/^Juli 2028:/));
    expect(kennzahl).toHaveBeenCalledWith(BB_IDS.kz4);
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });

  it('wer nur liest (Claudia Berger, Leserin): der Satz wartet auf eine Antwort anderer, „Ansehen“ statt „Abschließen“', async () => {
    reiter('2028-02-10', 'CB');
    expect(ohneNbsp((await screen.findByTestId('abweichungen-satz')).textContent)).toBe(
      '1 Monat wartet auf eine Antwort: Stromeinsatz Spritzguss je kg lag im Januar 2028 12,9 % über der Erwartung.',
    );
    expect(screen.getByTestId('abweichungen-wer').textContent).toBe('Antworten können Kundenadministratoren, Energiemanager und Bearbeiter am Standort.');
    expect(screen.queryByTestId('auffaelligkeit-beantworten')).toBeNull();
    // Wer antwortet, steht einmal oben - nicht je Zeile noch einmal „Dafür fehlt Ihnen das Recht“.
    expect(screen.getByTestId('abweichungen-zu-beantworten').textContent).not.toContain('Dafür fehlt Ihnen das Recht');
    const zeile = within(screen.getByTestId('abweichungen-in-arbeit')).getByTestId('abweichung-zeile-AW-2028-0001');
    expect(zeile.querySelector('.vp-abw-schritt')!.textContent).toBe('Ansehen');
    expect(zeile.querySelector('.vp-abw-schritt')!.classList.contains('is-leise')).toBe(true);
    expect(screen.getByTestId('abweichungen-register').textContent).not.toContain('Abschließen');
    cleanup();
    // Mit beiden Rechten (Ines Kaltenbach, Energiemanagerin) bleibt alles wie gehabt.
    reiter('2028-02-10', 'IK');
    expect(within(await screen.findByTestId('abweichungen-in-arbeit')).getByTestId('abweichung-zeile-AW-2028-0001').querySelector('.vp-abw-schritt')!.textContent).toBe('Abschließen');
    expect(screen.queryByTestId('abweichungen-wer')).toBeNull();
  });

  it('das Antwort-Blatt: „Zur Kenntnis nehmen“ braucht eine Begründung, „Untersuchen“ eine Person; die Frist steht auf der Vorgabe', async () => {
    reiter();
    const antwort = vi.spyOn(api, 'auffaelligkeitAntworten').mockResolvedValue({ vermerk: { ...OFFEN, zustand: 'beantwortet' }, abweichung: { ...aw1('2028-02-10'), id: AW_IDS.neu } });
    fireEvent.click(await screen.findByTestId('auffaelligkeit-beantworten'));
    const blatt = await screen.findByTestId('auffaelligkeit-blatt');
    expect(ohneNbsp(within(blatt).getByTestId('auffaelligkeit-blatt-auffiel').textContent)).toContain('78.000 kWh gemessen, 69.098 kWh erwartet bei 250.000 kg - 12,9 % mehr; im Rahmen wären ± 2 %.');
    // Die Vorgabe der Route: Tag der Route + 30 (nie die Uhr des Browsers).
    expect(within(blatt).getByTestId('auffaelligkeit-frist-vorgabe').textContent).toBe('in 30 Tagen, 11.03.');
    fireEvent.click(screen.getByTestId('auffaelligkeit-blatt-senden'));
    expect(await within(blatt).findByText('Bitte wählen Sie, wer das klärt.')).toBeTruthy();
    expect(antwort).not.toHaveBeenCalled();

    fireEvent.click(within(blatt).getByTestId('auffaelligkeit-wahl-kenntnis').querySelector('input')!);
    fireEvent.click(screen.getByTestId('auffaelligkeit-blatt-senden'));
    expect(await within(blatt).findByText('Begründung mit 10 bis 500 Zeichen.')).toBeTruthy();

    fireEvent.click(within(blatt).getByTestId('auffaelligkeit-wahl-untersuchen').querySelector('input')!);
    fireEvent.click(screen.getByRole('combobox', { name: 'Wer klärt das?' }));
    fireEvent.click(await screen.findByRole('option', { name: /Murat Demirci/ }));
    fireEvent.click(screen.getByTestId('auffaelligkeit-blatt-senden'));
    await waitFor(() => expect(antwort).toHaveBeenCalledWith(BB_IDS.kz4, OFFEN.id, { antwort: 'abweichung', verantwortlich: 'MD', frist: '2028-03-11' }));
    await waitFor(() => expect(location.hash).toBe(hashForRoute(abweichungRoute(AW_IDS.neu))));
  });

  it('leer: kein Eintrag, ein Satz, wie eine Abweichung entsteht', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, abweichungBuehne('leer', HEUTE));
    render(<VerbesserungBereich reiter="abweichungen" energiezielId={null} onReiter={() => undefined} onOeffnen={() => undefined} onListe={() => undefined} />);
    expect((await screen.findByTestId('abweichungen-leer')).textContent).toMatch(/^Noch keine Abweichung\./);
    expect(screen.getByTestId('abweichungen-satz').textContent).toBe('Noch nichts zu beantworten.');
  });

  it('lädt die Liste der Auffälligkeiten nicht, bleiben die Abweichungen da — mit „Erneut versuchen“', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, abweichungBuehne('register', '2028-02-10'), {
      alleAuffaelligkeiten: vi.fn().mockRejectedValueOnce(new Error('weg')).mockResolvedValue({ abruf: '2028-02-10', offen: 0, vermerke: [] }),
    });
    render(<VerbesserungBereich reiter="abweichungen" energiezielId={null} onReiter={() => undefined} onOeffnen={() => undefined} onListe={() => undefined} />);
    const zu = await screen.findByTestId('abweichungen-zu-beantworten');
    expect(zu.textContent).toContain('Die offenen Auffälligkeiten ließen sich gerade nicht laden.');
    expect(screen.getByTestId('abweichung-zeile-AW-2028-0001')).toBeTruthy();
    fireEvent.click(within(zu).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(screen.getByTestId('abweichungen-zu-beantworten')).findByText(/^Nichts zu beantworten\./)).toBeTruthy();
  });
});

describe('Hinweis am Energieziel (Entscheid 4)', () => {
  const ZIEL = { kennzahl: BB_IDS.kz4, zielperiode: '2028-01/2028-12' };

  it('zählt nur offene Auffälligkeiten derselben Kennzahl in der Zielperiode', () => {
    const jan = vermerkDez({ id: 'jan', periode: '2028-01' });
    expect(A.offenAmEnergieziel([vermerkDez(), jan, vermerkJuli()], [ZIEL]).map((v) => v.id)).toEqual(['jan']);
    expect(A.offenAmEnergieziel([jan], [{ ...ZIEL, kennzahl: 'andere' }])).toEqual([]);
  });

  it('nennt Monat und Kennzahl und öffnet das Antwort-Blatt an Ort und Stelle', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const jan = vermerkDez({ id: 'a9000000-0000-4000-8000-000000202801', periode: '2028-01' });
    Object.assign(api, abweichungBuehne('leer', '2028-02-10'), {
      alleAuffaelligkeiten: async () => ({ abruf: '2028-02-10', offen: 2, vermerke: [vermerkDez(), jan] }),
    });
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    render(<AuffaelligkeitHinweis ziele={[ZIEL]} art="reiter" />);
    const hinweis = await screen.findByTestId('auffaelligkeit-hinweis-reiter');
    expect(ohneNbsp(hinweis.textContent)).toBe(
      'Auffälligkeit zu Januar 2028 · offen. Stromeinsatz Spritzguss je kg lag 12,9 % über der Erwartung. Klären Sie zuerst, woran es lag - dann wissen Sie, welche Maßnahme hilft. Beantworten',
    );
    fireEvent.click(within(hinweis).getByTestId('auffaelligkeit-hinweis-beantworten'));
    expect(within(await screen.findByTestId('auffaelligkeit-blatt')).getByTestId('auffaelligkeit-frist-vorgabe').textContent).toBe('in 30 Tagen, 11.03.');
  });
});

describe('Seite einer Abweichung', () => {
  function seite(lage: 'offen' | 'register', id: string = AW_IDS.aw1, heute = HEUTE, person = 'IK') {
    setSelbstauskunft(rechteSeed(person).me);
    Object.assign(api, abweichungBuehne(lage, heute), { bezugsbasisVergleich: async (_id: string, w: { von?: string; bis?: string } = {}) => vergleichKz4(w.von ?? '2027-12', w.bis ?? '2027-12') });
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    const kennzahl = vi.fn();
    render(<AbweichungSeite id={id} onListe={() => undefined} onKennzahl={kennzahl} />);
    return { kennzahl };
  }

  it('offen: Titel was auffiel, Stufen, wer bis wann klärt, Abschließen im Block der Wiedervorlage, Was auffiel in Zahlen', async () => {
    const { kennzahl } = seite('offen');
    expect(ohneNbsp((await screen.findByTestId('abweichung-titel')).textContent)).toBe('Dezember 2027: 12,9 % mehr als erwartet AW-2028-0001');
    expect(screen.getByTestId('abweichung-meta').textContent).toBe('Stromeinsatz Spritzguss je kg · verantwortlich Ines Kaltenbach · Frist 31.01.2028');
    const stufen = screen.getByTestId('abweichung-stufen');
    expect([...stufen.querySelectorAll('li')].map((li) => `${li.className}:${li.textContent}`)).toEqual([
      'is-erledigt:Vermerkt07.01.2028',
      'is-jetzt:Untersuchenseit 12.01.2028',
      'is-offen:Abschließenbis 31.01.2028',
    ]);
    expect(screen.getByTestId('abweichung-satz').textContent).toBe('In Arbeit: Ines Kaltenbach klärt bis 31.01.2028, woran es lag.');
    // Die Marke der Wiedervorlage trägt der Block mit dem nächsten Schritt.
    const block = document.querySelector('[data-entscheid="abweichung_frist"]')!;
    expect(within(block as HTMLElement).getByTestId('abweichung-abschliessen-knopf').hasAttribute('data-entscheid-schritt')).toBe(true);
    expect(within(block as HTMLElement).getByTestId('abweichung-aussage-knopf').textContent).toBe('Aussage festhalten');
    const auffiel = screen.getByTestId('abweichung-was-auffiel');
    expect(ohneNbsp(auffiel.textContent)).toContain('gemessen78.000 kWherwartet69.098 kWhProduktionsmenge250.000 kg');
    expect(ohneNbsp(screen.getByTestId('abweichung-delta').textContent)).toBe('12,9 % mehr als erwartet; im Rahmen wären ± 2 %.');
    expect(screen.getByTestId('abweichung-herkunft').textContent).toBe('aus der Auffälligkeit vom 07.01.2028');
    const verlauf = screen.getAllByTestId('verlauf-eintrag').map((e) => e.textContent);
    expect(verlauf[0]).toContain('Kommentar von Ines Kaltenbach');
    expect(verlauf[1]).toContain('Untersuchung begonnen');
    fireEvent.click(screen.getByTestId('abweichung-sprung-kennzahl'));
    expect(kennzahl).toHaveBeenCalledWith(BB_IDS.kz4);
    fireEvent.click(screen.getByTestId('abweichung-kopie-knopf'));
    expect((await screen.findByTestId('abweichung-pruefsumme')).textContent).toBe(`Prüfsumme ${PRUEFSUMME_R1}`);
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });

  it('ohne das Recht zum Abschließen sagt die Seite, wer abschließt - einmal, ohne „Dafür fehlt Ihnen das Recht“', async () => {
    seite('offen', AW_IDS.aw1, HEUTE, 'CB');
    expect((await screen.findByTestId('abweichung-wer-schliesst')).textContent).toBe('Abschließen können Kundenadministratoren und Energiemanager.');
    expect(screen.queryByTestId('abweichung-abschliessen-knopf')).toBeNull();
    expect(screen.queryByTestId('abweichung-aussage-knopf')).toBeNull();
    expect(screen.getByTestId('abweichung-seite').textContent).not.toContain('Dafür fehlt Ihnen das Recht');
    expect(screen.getByTestId('abweichung-seite').textContent).toContain('Noch offen. Wird die Abweichung mit einer Maßnahme abgeschlossen, steht sie hier.');
    expect(screen.getByTestId('abweichung-seite').textContent).not.toContain('Schließen Sie');
    cleanup();
    seite('offen');
    expect(await screen.findByTestId('abweichung-abschliessen-knopf')).toBeTruthy();
    expect(screen.queryByTestId('abweichung-wer-schliesst')).toBeNull();
  });

  it('abgeschlossen „erklärt“: Ergebnis oben, der geerbte Vorbehalt, die Aussage mit Person — ohne Knöpfe und Menü', async () => {
    seite('register', AW_IDS.aw2026);
    expect((await screen.findByTestId('abweichung-satz')).textContent).toBe('Abgeschlossen: Die Abweichung ist erklärt.');
    expect(screen.getByTestId('abweichung-vorbehalte').textContent).toContain('Bezugsbasis vorläufig (1 von 12 Monaten)');
    expect(screen.getAllByTestId('verlauf-eintrag')[1].textContent).toMatch(/^10\.12\.2026Aussage von Jonas Wendlinger‚/);
    expect(screen.getByTestId('abschluss-satz').textContent).toMatch(/^Keine Maßnahme - erklärt: ‚Baustellenstrom/);
    expect(screen.queryByTestId('abweichung-abschliessen-knopf')).toBeNull();
    expect(screen.queryByTestId('abweichung-aussage-knopf')).toBeNull();
    expect(screen.queryByTestId('abweichung-menue')).toBeNull();
  });

  it('Abschluss „Maßnahme“ ohne Verweis wird nicht geschickt; „erklärt“ mit Begründung schließt ab', async () => {
    seite('offen');
    const massnahmen = vi.spyOn(api, 'massnahmen').mockResolvedValue({ abruf: HEUTE, massnahmen: [] });
    fireEvent.click(await screen.findByTestId('abweichung-abschliessen-knopf'));
    const dialog = await screen.findByTestId('abweichung-abschliessen');
    fireEvent.click(within(dialog).getByTestId('abschluss-massnahme'));
    await waitFor(() => expect(massnahmen).toHaveBeenCalled());
    expect(within(dialog).getByTestId('abschluss-massnahme-anlegen')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Aussage erklärt die Ursache plausibel.' } });
    fireEvent.click(screen.getByTestId('abweichung-abschliessen-senden'));
    expect(await within(dialog).findByText(A.abschlussPruefen('massnahme', 'x'.repeat(20), '').massnahme!)).toBeTruthy();

    fireEvent.click(within(dialog).getByTestId('abschluss-erklaert'));
    fireEvent.click(screen.getByTestId('abweichung-abschliessen-senden'));
    expect((await screen.findByTestId('abweichung-satz')).textContent).toBe('Abgeschlossen: Die Abweichung ist erklärt.');
    expect(screen.getByTestId('abschluss-satz').textContent).toBe('Keine Maßnahme - erklärt: ‚Aussage erklärt die Ursache plausibel.‘Ines Kaltenbach · 15.01.2028');
  });

  it('Kommentar schreiben (Menü): steht danach im Verlauf, neueste zuerst', async () => {
    seite('offen');
    fireEvent.click(await screen.findByRole('button', { name: 'Weitere Aktionen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Kommentar schreiben/ }));
    const dialog = await screen.findByTestId('abweichung-kommentar');
    fireEvent.change(within(dialog).getByLabelText('Kommentar'), { target: { value: 'Murat fragt die Schicht.' } });
    fireEvent.click(screen.getByTestId('abweichung-kommentar-senden'));
    await waitFor(() => expect(screen.getAllByTestId('verlauf-eintrag')[0].textContent).toContain('‚Murat fragt die Schicht.‘'));
  });
});

describe('Vermerk-Zeile in der Vergleichs-Fläche (§5.2)', () => {
  function flaeche(lage: 'vermerk' | 'offen') {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, abweichungBuehne(lage, HEUTE));
    vi.spyOn(api, 'bezugsbasisVergleich').mockResolvedValue(vergleichKz4('2027-11', '2028-02'));
    vi.spyOn(api, 'kennzahlBezugsbasen').mockResolvedValue({ bezugsbasen: [] });
    render(<BezugsbasisVergleich kennzahlId={BB_IDS.kz4} standort={null} />);
  }

  it('R1: am Dezember „Auffälligkeit — vermerkt am 07.01.2028“ mit zwei Knöpfen; „Abweichung eröffnen“ an jeder Zeile mit Vergleich', async () => {
    flaeche('vermerk');
    const dez = await screen.findByTestId('monat-2027-12');
    const vermerk = await within(dez).findByTestId('vermerk-2027-12');
    expect(vermerk.textContent).toContain('Auffälligkeit — vermerkt am 07.01.2028');
    expect(within(vermerk).getByTestId('vermerk-eroeffnen').textContent).toBe('Abweichung eröffnen');
    expect(within(vermerk).getByTestId('vermerk-zur-kenntnis').textContent).toBe('zur Kenntnis nehmen');
    for (const p of ['2027-11', '2027-12', '2028-01', '2028-02']) expect(within(screen.getByTestId(`monat-${p}`)).getByTestId(`von-hand-${p}`)).toBeTruthy();
    expect(within(screen.getByTestId('monat-2027-11')).queryByTestId('vermerk-zeile')).toBeNull();
  });

  it('R11: „zur Kenntnis nehmen“ verlangt die Begründung; danach steht der Satz der Route', async () => {
    flaeche('vermerk');
    fireEvent.click(await screen.findByTestId('vermerk-zur-kenntnis'));
    const dialog = await screen.findByTestId('auffaelligkeit-antwort-zur_kenntnis');
    fireEvent.click(screen.getByTestId('auffaelligkeit-antwort-senden'));
    expect(await within(dialog).findByText('Begründung mit 10 bis 500 Zeichen.', { selector: '.vp-ez-fehler' })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Kleinserien-Sonderauftrag, dokumentiert.' } });
    fireEvent.click(screen.getByTestId('auffaelligkeit-antwort-senden'));
    const antwort = await screen.findByTestId('vermerk-antwort');
    expect(antwort.textContent).toBe(
      'Auffälligkeit Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten lässt (schlechter, Band ± 2 %) — zur Kenntnis genommen von Ines Kaltenbach am 15.01.2028: ‚Kleinserien-Sonderauftrag, dokumentiert.‘',
    );
    expect(screen.queryByTestId('vermerk-eroeffnen')).toBeNull();
  });

  it('beantwortet mit Abweichung: der Sprung zur Abweichung statt der Knöpfe', async () => {
    flaeche('offen');
    const sprung = await screen.findByTestId('vermerk-sprung-abweichung');
    expect(sprung.getAttribute('href')).toBe(hashForRoute(abweichungRoute(AW_IDS.aw1)));
    expect(screen.queryByTestId('vermerk-eroeffnen')).toBeNull();
  });

  it('ohne `verbesserung.ansehen` bleibt die Fläche, wie sie war — kein Aufruf, keine Zeile', async () => {
    setSelbstauskunft(null);
    const vermerke = vi.spyOn(api, 'auffaelligkeiten');
    vi.spyOn(api, 'bezugsbasisVergleich').mockResolvedValue(vergleichKz4('2027-11', '2028-02'));
    vi.spyOn(api, 'kennzahlBezugsbasen').mockResolvedValue({ bezugsbasen: [] });
    render(<BezugsbasisVergleich kennzahlId={BB_IDS.kz4} />);
    await screen.findByTestId('monat-2027-12');
    expect(vermerke).not.toHaveBeenCalled();
    expect(screen.queryByTestId('vermerk-spalte')).toBeNull();
  });
});

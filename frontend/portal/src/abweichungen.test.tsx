import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as A from './abweichungen';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { BezugsbasisVergleich } from './components/BezugsbasisVergleich';
import { UEMS_NORMGRENZE } from './glossar';
import { abweichungRoute, hashForRoute, parseRoute } from './nav';
import { AbweichungSeite } from './pages/AbweichungSeite';
import { VerbesserungBereich } from './pages/VerbesserungBereich';
import { setSelbstauskunft } from './rollen';
import { abweichungBuehne, AUSSAGE_R2, aw1, aw2026, AW_IDS, KOPF_R2, PRUEFSUMME_R1, vermerkDez } from './test/abweichungFixtures';
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

describe('Register „Abweichungen“', () => {
  it('R2/R8: offen und überfällig zuerst mit „überfällig seit n Tagen“, abgeschlossen mit Ergebnis; Grenz-Satz', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, abweichungBuehne('register', '2028-02-10'));
    const oeffne = vi.fn();
    render(<VerbesserungBereich reiter="abweichungen" energiezielId={null} onReiter={() => undefined} onOeffnen={() => undefined} onListe={() => undefined} onAbweichung={oeffne} />);
    const tafel = await screen.findByTestId('abweichungen-tafel');
    const zeilen = within(tafel).getAllByRole('row').slice(1);
    expect(zeilen.map((z) => z.getAttribute('data-testid'))).toEqual(['abweichung-zeile-AW-2028-0001', 'abweichung-zeile-AW-2026-0001']);
    expect(within(zeilen[0]).getByTestId('frist').textContent).toBe('31.01.2028überfällig seit 10 Tagen');
    expect(within(zeilen[1]).getByTestId('ergebnis').textContent).toBe('erklärt');
    expect(within(zeilen[1]).getByTestId('frist').textContent).toBe('08.01.2027');
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
    fireEvent.click(within(zeilen[0]).getByRole('button', { name: 'AW-2028-0001' }));
    expect(oeffne).toHaveBeenCalledWith(AW_IDS.aw1);
  });
});

describe('Abweichungs-Seite', () => {
  function seite(lage: 'offen' | 'register', id: string = AW_IDS.aw1) {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, abweichungBuehne(lage, HEUTE), { bezugsbasisVergleich: async (_id: string, w: { von?: string; bis?: string } = {}) => vergleichKz4(w.von ?? '2027-12', w.bis ?? '2027-12') });
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    render(<AbweichungSeite id={id} onListe={() => undefined} />);
  }

  it('R2: Kopf-Satz, Anlass als Kopie mit Prüfsumme, Vergleichszeilen aus dem Leser, Verlauf mit Kommentar', async () => {
    seite('offen');
    expect((await screen.findByTestId('abweichung-kopf')).textContent).toBe(KOPF_R2);
    expect(screen.getByTestId('anlass-satz').textContent).toBe(vergleichR2().monate[1].satz);
    expect(screen.getByTestId('abweichung-pruefsumme').textContent).toBe(`Prüfsumme ${PRUEFSUMME_R1}`);
    expect(await within(screen.getByTestId('abweichung-vergleich')).findByTestId('monat-2027-12')).toBeTruthy();
    expect(screen.getByTestId('verlauf-kommentar').textContent).toContain('Grundlast-Anteil');
    expect(screen.getByTestId('abweichung-abschliessen-knopf')).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });

  it('R8: der geerbte Vorbehalt, die Ursache nur als „Aussage von …“ und der Abschluss „erklärt“ — ohne Knöpfe', async () => {
    seite('register', AW_IDS.aw2026);
    expect((await screen.findByTestId('abweichung-vorbehalte')).textContent).toContain('Bezugsbasis vorläufig (1 von 12 Monaten)');
    const aussage = screen.getByTestId('ursache-aussage-satz').textContent!;
    expect(aussage.startsWith('Ursache — Aussage von Jonas Wendlinger, 10.12.2026 (keine Messung): ‚')).toBe(true);
    expect(screen.getByTestId('ursache-aussage-kennzeichen').textContent).toBe('Aussage von Jonas Wendlinger, 10.12.2026 — keine Messung');
    expect(screen.getByTestId('abschluss-satz').textContent).toMatch(/^Abgeschlossen am 20\.12\.2026 von Ines Kaltenbach: erklärt — ‚/);
    expect(screen.queryByTestId('abweichung-abschliessen-knopf')).toBeNull();
    expect(screen.queryByTestId('abweichung-aussage-knopf')).toBeNull();
    expect(screen.queryByTestId('abweichung-frist-knopf')).toBeNull();
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
    expect((await screen.findByTestId('abschluss-satz')).textContent).toBe(
      `Abgeschlossen am 15.01.2028 von Ines Kaltenbach: erklärt — ‚Aussage erklärt die Ursache plausibel.‘`,
    );
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

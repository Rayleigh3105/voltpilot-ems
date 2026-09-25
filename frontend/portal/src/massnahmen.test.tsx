import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { MassnahmeAnlegenDialog, MassnahmeUmgesetztDialog } from './components/MassnahmeDialoge';
import { UEMS_NORMGRENZE, UEMS_OHNE_MESSGRUNDLAGE_SATZ, UEMS_VERBESSERUNG_SAETZE } from './glossar';
import * as M from './massnahmen';
import { hashForRoute, massnahmeRoute, parseRoute } from './nav';
import { MassnahmeSeite } from './pages/MassnahmeSeite';
import { VerbesserungBereich } from './pages/VerbesserungBereich';
import { setSelbstauskunft } from './rollen';
import { bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { energiezielBuehne } from './test/energiezielFixtures';
import {
  KOPF_R3,
  kontenAhrenberg,
  m1,
  m1Umgesetzt,
  m2,
  M_IDS,
  massnahmeBuehne,
  PRUEFSUMME_R3,
  SATZ_MESSGRUNDLAGE_R3,
  SATZ_OHNE_R7,
  UEBERFAELLIG_R9,
} from './test/massnahmeFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * UEMS AP-18 IP-13: Reiter „Maßnahmen“ — Register, „Maßnahme anlegen“ und die Maßnahmen-Seite. Die Dialog-Regeln
 * (M4: Zahl gesperrt ohne Messgrundlage; Wortlaut Pflicht; M6: Tag nie in der Zukunft) und das reine Bild (das Portal
 * rechnet nichts: Frist, Ausgangslage, Prüfsumme und Sätze kommen von der Route) gegen R3, R7, R9.
 */
beforeEach(() => {
  setSelbstauskunft(rechteSeed('IK').me);
  Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
  Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne('juli'), massnahmeBuehne('r9', '2028-03-15'), {
    standorte: async () => ({ stichtag: '2028-03-15', standorte: [] }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ZIEL_ALLEIN = /(?<![\p{L}])Ziel(?![\p{L}])/u;

describe('Kundenwörter (SP1)', () => {
  it('Knöpfe und Zustände in Kundenwörtern; nie „Ziel“ allein', () => {
    expect(M.KNOPF_ANLEGEN).toBe('Maßnahme anlegen');
    expect(M.KNOPF_UMGESETZT).toBe('umgesetzt melden');
    expect(M.ZUSTAND_WORT).toEqual({ geplant: 'geplant', umgesetzt: 'umgesetzt', bewertet: 'bewertet', verworfen: 'verworfen' });
    expect(M.OHNE_HINWEIS.startsWith(UEMS_OHNE_MESSGRUNDLAGE_SATZ)).toBe(true);
    const texte = Object.values(M).filter((v): v is string => typeof v === 'string');
    expect(texte.filter((t) => ZIEL_ALLEIN.test(t))).toEqual([]);
  });
});

describe('Register: überfällig zuerst, Filter — Zahl und Satz von der Route (E5 = A, R9)', () => {
  it('„überfällig seit 15 Tagen“ aus `frist`; nichts ohne `faellig`', () => {
    expect(M.ueberfaelligText(m2('2028-03-15'))).toBe('überfällig seit 15 Tagen');
    expect(M.ueberfaelligText(m2('2028-02-20'))).toBeNull();
    expect(M.ueberfaelligText(m1Umgesetzt())).toBeNull();
  });
  it('überfällige zuerst, dann nach Termin', () => {
    const r = M.ordnen([m1Umgesetzt(), m2('2028-03-15')]);
    expect(r.map((m) => m.kennzeichen)).toEqual(['M-2028-0002', 'M-2028-0001']);
    expect(M.ordnen([m2('2028-02-20'), m1()]).map((m) => m.kennzeichen)).toEqual(['M-2028-0001', 'M-2028-0002']);
  });
  it('Filter Zustand, Kennzahl, überfällig', () => {
    const liste = [m1Umgesetzt(), m2('2028-03-15')];
    expect(M.filtern(liste, { ...M.FILTER_LEER, zustand: 'geplant' }).map((m) => m.kennzeichen)).toEqual(['M-2028-0002']);
    expect(M.filtern(liste, { ...M.FILTER_LEER, kennzahl: m1().messgrundlage!.kennzahl.id }).map((m) => m.kennzeichen)).toEqual(['M-2028-0001']);
    expect(M.filtern(liste, { ...M.FILTER_LEER, ueberfaellig: true }).map((m) => m.kennzeichen)).toEqual(['M-2028-0002']);
    expect(M.kennzahlOptionen(liste)).toEqual([{ value: m1().messgrundlage!.kennzahl.id, label: 'KZ-0004 Stromeinsatz Spritzguss je kg' }]);
  });
  it('die Zeile trägt „ohne Messgrundlage — Wirkung nicht messbar“ und die Frist (R7, R9)', async () => {
    render(<VerbesserungBereich reiter="massnahmen" energiezielId={null} onReiter={() => {}} onOeffnen={() => {}} onListe={() => {}} />);
    const tafel = await screen.findByTestId('massnahmen-tafel');
    const zeilen = within(tafel).getAllByRole('row').slice(1);
    expect(zeilen.map((z) => z.getAttribute('data-testid'))).toEqual(['massnahme-zeile-M-2028-0002', 'massnahme-zeile-M-2028-0001']);
    expect(within(zeilen[0]).getByText(UEMS_OHNE_MESSGRUNDLAGE_SATZ)).toBeTruthy();
    expect(within(zeilen[0]).getByText('überfällig seit 15 Tagen')).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('leer: der Satz aus §5.9, „Maßnahme anlegen“ und der Grenz-Satz (R13)', async () => {
    Object.assign(api, massnahmeBuehne('leer', '2028-03-15'));
    render(<VerbesserungBereich reiter="massnahmen" energiezielId={null} onReiter={() => {}} onOeffnen={() => {}} onListe={() => {}} />);
    expect(await screen.findByText(UEMS_VERBESSERUNG_SAETZE.leer())).toBeTruthy();
    expect(screen.getByTestId('massnahme-anlegen-knopf')).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
});

describe('Dialog-Regeln (M4, E2 = A) — nur Form, entschieden wird an der Route', () => {
  const entwurf = (over: Partial<M.MassnahmeEntwurf> = {}): M.MassnahmeEntwurf => ({
    ...M.entwurfAus({ herkunft: 'von_hand' }, '2028-01-15'),
    titel: 'Werkzeugheizungen in Betriebspausen abschalten',
    verantwortlich: 'MD',
    termin: '2028-01-31',
    kennzahl: 'kz',
    wirkungZahl: '3',
    wirkungWortlaut: 'Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.',
    ...over,
  });
  it('die Zahl der erwarteten Wirkung ist ohne Messgrundlage gesperrt und wird nie gesendet', () => {
    expect(M.zahlErlaubt(entwurf())).toBe(true);
    expect(M.zahlErlaubt(entwurf({ wahl: 'ohne' }))).toBe(false);
    expect(M.zahlErlaubt(entwurf({ kennzahl: '' }))).toBe(false);
    const ohne = M.anfrage(entwurf({ wahl: 'ohne', standort: 'st', einsatz: 'ee3' }), { herkunft: 'einsatz', einsatz: 'ee3' }, 2);
    expect(ohne).not.toHaveProperty('erwartete_wirkung_prozent');
    expect(ohne).not.toHaveProperty('kennzahl');
    expect(ohne).not.toHaveProperty('monate');
    expect(ohne).toMatchObject({ herkunft: 'einsatz', einsatz: 'ee3', einstufung_fassung: 2, standort: 'st' });
  });
  it('mit Messgrundlage: Kennzahl, Monate der Ausgangslage, Zahl wie im Vertrag (weniger negativ), nie ein Standort', () => {
    const mit = M.anfrage(entwurf({ von: '2027-12', bis: '2027-12', standort: 'st' }), { herkunft: 'abweichung', herkunftKennung: 'AW-2028-0001' });
    expect(mit).toEqual({
      titel: 'Werkzeugheizungen in Betriebspausen abschalten',
      verantwortlich: 'MD',
      termin: '2028-01-31',
      herkunft: 'abweichung',
      herkunft_kennung: 'AW-2028-0001',
      kennzahl: 'kz',
      monate: '2027-12',
      erwartete_wirkung_prozent: -3,
      erwartete_wirkung_wortlaut: 'Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.',
    });
    expect(M.anfrage(entwurf({ von: '2027-11', bis: '2027-12' }), { herkunft: 'von_hand' }).monate).toBe('2027-11/2027-12');
  });
  it('Herkunft aus dem Energiemanagement (AP-19 IP-17): die Kennung geht mit, das Wort ist das Kundenwort (SP5)', () => {
    const f = M.anfrage(entwurf({ wahl: 'ohne', kennzahl: '', wirkungZahl: '' }), { herkunft: 'nichtkonformitaet', herkunftKennung: 'F-2029-0001' });
    expect(f).toMatchObject({ herkunft: 'nichtkonformitaet', herkunft_kennung: 'F-2029-0001' });
    expect(M.anfrage(entwurf(), { herkunft: 'audit', herkunftKennung: 'AU-2029-0001' }).herkunft_kennung).toBe('AU-2029-0001');
    expect(M.anfrage(entwurf(), { herkunft: 'managementbewertung', herkunftKennung: 'BR-2029-0001/B2' }).herkunft_kennung)
      .toBe('BR-2029-0001/B2');
    // Energieziel und Einsatz folgen ihrem Verweis — eine mitgegebene Kennung geht nicht an die Route.
    expect(M.anfrage(entwurf(), { herkunft: 'energieziel', herkunftKennung: 'EZ-2028-0001' })).not.toHaveProperty('herkunft_kennung');
    expect(M.HERKUNFT_WORT.nichtkonformitaet).toBe('aus der Feststellung');
    expect(M.HERKUNFT_WORT.audit).toBe('aus dem internen Audit');
    expect(M.HERKUNFT_WORT.managementbewertung).toBe('aus der Managementbewertung');
    expect(Object.values(M.HERKUNFT_WORT).join(' ')).not.toMatch(/[Nn]ichtkonformit/);
  });
  it('der Wortlaut der erwarteten Wirkung ist Pflicht, die Zahl nicht', () => {
    expect(M.pruefen(entwurf({ wirkungWortlaut: '   ' }))).toHaveProperty('wirkungWortlaut');
    expect(M.pruefen(entwurf({ wirkungZahl: '' }))).toEqual({});
    expect(M.pruefen(entwurf({ wirkungZahl: 'drei' }))).toHaveProperty('wirkungZahl');
    expect(M.pruefen(entwurf({ wahl: 'ohne', kennzahl: '', wirkungZahl: 'drei' }))).toEqual({});
    expect(M.pruefen(entwurf({ kennzahl: '' }))).toHaveProperty('kennzahl');
  });
  it('vorbelegt öffnen (IP-18): Herkunft, Kennzahl und Monate aus dem Anlass; ohne Monate der letzte abgeschlossene', () => {
    const e = M.entwurfAus({ herkunft: 'abweichung', herkunftKennung: 'AW-2028-0001', kennzahl: 'kz', monate: '2027-11/2027-12' }, '2028-01-15');
    expect(e).toMatchObject({ wahl: 'mit', kennzahl: 'kz', von: '2027-11', bis: '2027-12' });
    expect(M.entwurfAus({ herkunft: 'von_hand' }, '2028-01-15')).toMatchObject({ wahl: 'mit', von: '2027-12', bis: '2027-12' });
    expect(M.entwurfAus({ herkunft: 'einsatz', einsatz: 'ee3' }, '2028-01-15')).toMatchObject({ wahl: 'ohne', einsatz: 'ee3' });
  });
  it('umgesetzt am: nie in der Zukunft (M6)', () => {
    expect(M.tagNichtInZukunft('2028-01-22', '2028-01-22')).toBe(true);
    expect(M.tagNichtInZukunft('2028-01-23', '2028-01-22')).toBe(false);
    expect(M.tagNichtInZukunft('', '2028-01-22')).toBe(false);
  });

  it('Dialog: „ohne Messgrundlage“ ist sichtbar wählbar, sperrt das Zahlenfeld und zeigt den Satz', async () => {
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'von_hand' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2028-01-15" />);
    const zahl = screen.getByTestId('massnahme-wirkung-zahl') as HTMLInputElement;
    expect(zahl.disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-wahl-ohne')));
    expect((screen.getByTestId('massnahme-wirkung-zahl') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('massnahme-ohne-satz').textContent).toBe(M.OHNE_HINWEIS);
    expect(screen.getAllByText(M.ZAHL_GESPERRT).length).toBeGreaterThan(0);
  });
  it('Dialog: mit Kennzahl steht die Vorschau der Ausgangslage aus dem Leser und die Zahl ist frei', async () => {
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'energieziel', kennzahl: m1().messgrundlage!.kennzahl.id, energieziel: 'ez' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2028-01-15" />);
    const vorschau = await screen.findByTestId('massnahme-ausgangslage-vorschau');
    expect(vorschau.textContent).toContain('Dezember 2027: 78 000 kWh gemessen, 69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr');
    expect(within(vorschau).getByTestId('massnahme-methode').textContent).toContain('keine Wahl');
    expect((screen.getByTestId('massnahme-wirkung-zahl') as HTMLInputElement).disabled).toBe(false);
  });
  it('Dialog: ohne Wortlaut geht nichts an die Route', async () => {
    const anlegen = vi.spyOn(api, 'massnahmeAnlegen');
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'von_hand' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2028-01-15" />);
    fireEvent.change(screen.getByLabelText('Titel'), { target: { value: 'Druckluft-Leckagen orten' } });
    await waitFor(() => expect((screen.getByTestId('massnahme-anlegen-senden') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-anlegen-senden')));
    expect(anlegen).not.toHaveBeenCalled();
    expect(screen.getByText('Bitte beschreiben Sie die erwartete Wirkung in einem Satz.')).toBeTruthy();
  });
  it('Dialog „umgesetzt melden“: ein Tag nach heute geht nicht an die Route', async () => {
    const melden = vi.spyOn(api, 'massnahmeUmgesetzt');
    render(<MassnahmeUmgesetztDialog massnahme={m1()} onClose={() => {}} onFertig={() => {}} tagHeute="2028-01-22" />);
    expect(screen.getByText('Einmalig: danach lässt sich die Maßnahme nicht mehr ändern. Die Wirkung zählt ab dem Monat nach der Umsetzung.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Zeitschaltung aktiv, Probelauf ohne Befund.' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-umgesetzt-senden')));
    expect(melden).toHaveBeenCalledWith(M_IDS.m1, { am: '2028-01-22', begruendung: 'Zeitschaltung aktiv, Probelauf ohne Befund.' });
  });
});

describe('Maßnahmen-Seite (R3, R7) — Kopie mit Prüfsumme, Sätze von der Route', () => {
  it('R3 umgesetzt: Kopf-Satz, Messgrundlage-Satz, Prüfsumme, Verlauf mit Kommentar; keine Knöpfe mehr', async () => {
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => {}} />);
    expect((await screen.findByTestId('massnahme-kopf')).textContent).toBe(KOPF_R3);
    expect(screen.getByTestId('massnahme-messgrundlage-satz').textContent).toBe(SATZ_MESSGRUNDLAGE_R3);
    expect(screen.getByTestId('massnahme-pruefsumme').textContent).toBe(`Prüfsumme ${PRUEFSUMME_R3}`);
    expect(screen.getByTestId('verlauf-kommentar').textContent).toContain('Zeitschaltung für die Maschinen 3 bis 6 ist bestellt');
    expect(screen.queryByTestId('massnahme-umgesetzt-knopf')).toBeNull();
    expect(screen.queryByTestId('massnahme-aendern-knopf')).toBeNull();
    expect(screen.getByTestId('massnahme-kommentar')).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('R7/R9 geplant ohne Messgrundlage: der Satz aus §5.9, die Frist, „umgesetzt melden“ · „ändern“ · „verwerfen“', async () => {
    render(<MassnahmeSeite id={M_IDS.m2} onListe={() => {}} />);
    expect((await screen.findByTestId('massnahme-ohne-messgrundlage')).textContent).toBe(SATZ_OHNE_R7);
    expect(screen.getByTestId('massnahme-frist').textContent).toBe(UEBERFAELLIG_R9);
    expect(screen.queryByTestId('massnahme-pruefsumme')).toBeNull();
    for (const k of ['umgesetzt', 'aendern', 'verwerfen']) expect(screen.getByTestId(`massnahme-${k}-knopf`)).toBeTruthy();
  });
  it('ändern ohne Messgrundlage: das Zahlenfeld ist gesperrt', async () => {
    render(<MassnahmeSeite id={M_IDS.m2} onListe={() => {}} />);
    const knopf = await screen.findByTestId('massnahme-aendern-knopf');
    await act(async () => fireEvent.click(knopf));
    const feld = screen.getByLabelText('erwartete Wirkung in % weniger, als die Bezugsbasis erwarten lässt') as HTMLInputElement;
    expect(feld.disabled).toBe(true);
  });
});

describe('Route der Seite', () => {
  it('#/portfolio/verbesserung/massnahmen/{id} hin und zurück', () => {
    const hash = hashForRoute(massnahmeRoute(M_IDS.m1));
    expect(hash).toBe(`#/portfolio/verbesserung/massnahmen/${M_IDS.m1}`);
    expect(parseRoute(hash)).toMatchObject({ page: 'portfolio-verbesserung', massnahmeId: M_IDS.m1, verbesserungReiter: 'massnahmen' });
  });
});

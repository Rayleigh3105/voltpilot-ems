import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { UEMS_NORMGRENZE } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { BB_IDS, faktorenVorschlag, kz4, variablenVorschlag } from '../test/bezugsbasisFixtures';
import { anstossR5, ANSTOSS_SATZ_R5, basisMit, fassung1, fassung2, FRIST_SATZ_R13, fristR13, zustandNachBleibt } from '../test/bezugsbasisFassungenFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import type { Bezugsbasis, BezugsbasisFassung } from '../api';
import { BezugsbasisReiter } from './BezugsbasisReiter';

/**
 * UEMS AP-17 IP-18 — Fassungen, Anstoß, neue Fassung, Beenden, Bleibt, Frist und Faktoren im Reiter „Bezugsbasis“ gegen
 * R1/R5/R13 (Ines Kaltenbach, Energiemanagerin; Claudia Berger, Leserin). Routen gemockt; `anstoesse`/`frist` in der Form
 * des API-Nachtrags (Nachlese 3).
 */
const ZONE = 'Europe/Berlin';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-06T09:00:00+01:00'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSelbstauskunft(null);
});

const mitFassungen = (fassungen: BezugsbasisFassung[]) => {
  vi.spyOn(api, 'bezugsbasisFassung').mockImplementation(async (_k, _b, n) => fassungen.find((f) => f.fassung === n)!);
  vi.spyOn(api, 'bezugsbasisUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
};
const reiter = (basis: Bezugsbasis, person = 'IK') => {
  setSelbstauskunft(rechteSeed(person).me);
  const onNeu = vi.fn();
  render(<BezugsbasisReiter kennzahl={kz4()} lage={{ art: 'da', basis, fassung: null }} zone={ZONE} onNeu={onNeu} />);
  return { onNeu };
};

describe('Zeitleiste der Fassungen (§5.5)', () => {
  it('neueste oben, Zustand, Gültigkeit, Freigeber, Anpassungsgründe, Begründung und Faktoren; Fassung 1 bleibt sichtbar', async () => {
    const f1 = fassung1({ gilt_bis: '2026-12-31' });
    const f2 = fassung2('freigegeben');
    mitFassungen([f1, f2]);
    reiter(basisMit([f1, f2]));
    const eins = await screen.findByTestId('bezugsbasis-fassung-1');
    const zwei = screen.getByTestId('bezugsbasis-fassung-2');
    expect(eins.compareDocumentPosition(zwei) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await waitFor(() => expect(within(zwei).getByText('Anpassungsgründe: Struktur geändert')).toBeTruthy());
    expect(within(zwei).getByText('freigegeben')).toBeTruthy();
    expect(within(zwei).getByText(/gilt ab 01\.01\.2027/)).toBeTruthy();
    expect(within(zwei).getByText('freigegeben von Ines Kaltenbach am 05.01.2027')).toBeTruthy();
    expect(within(zwei).getByText('Begründung: Anbau Halle 2: die Fläche wächst von 3 100 auf 3 400 m².')).toBeTruthy();
    expect(within(zwei).getByText('Statischer Faktor: Fläche G-2 3 400 m² (Stand 05.01.2027)')).toBeTruthy();
    expect(within(eins).getByText('beendet')).toBeTruthy();
    expect(within(eins).getByText(/gilt vom 01\.11\.2026 bis 31\.12\.2026/)).toBeTruthy();
    expect(within(eins).getByText('Statischer Faktor: Zweischichtbetrieb, Halle 2 (Wortlaut, ohne Anstoß)')).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('ein Entwurf und ein abgelehnter Antrag tragen ihren Zustand', async () => {
    const f2 = fassung2('abgelehnt', { entscheidung: { name: 'Jonas Weber', rolle: 'kundenadministrator', am: '2027-01-06T09:00:00+01:00' }, entscheidungs_begruendung: 'Die Fläche ist noch nicht vermessen.' });
    mitFassungen([fassung1(), f2]);
    reiter(basisMit([fassung1(), f2]));
    const zwei = await screen.findByTestId('bezugsbasis-fassung-2');
    expect(within(zwei).getByText('abgelehnt')).toBeTruthy();
    await waitFor(() => expect(within(zwei).getByText('Abgelehnt, weil: Die Fläche ist noch nicht vermessen.')).toBeTruthy());
  });
});

describe('Anstoß-Kasten mit drei Antworten und Rechte-Sicht (A2–A4, R5)', () => {
  it('Ines sieht den §5.8-Satz und „Neue Fassung bilden“ · „Beenden“ · „Geprüft, bleibt“', async () => {
    mitFassungen([fassung1()]);
    reiter(basisMit([fassung1()], { anstoesse: [anstossR5()], frist: fristR13(false) }));
    const kasten = await screen.findByTestId('bezugsbasis-anstoss');
    expect(within(kasten).getByText(ANSTOSS_SATZ_R5)).toBeTruthy();
    for (const name of ['Neue Fassung bilden', 'Beenden', 'Geprüft, bleibt']) expect(within(kasten).getByRole('button', { name })).toBeTruthy();
    expect(screen.queryByTestId('bezugsbasis-frist')).toBeNull();
  });
  it('Claudia (Leserin) sieht den Kasten ohne Knöpfe', async () => {
    mitFassungen([fassung1()]);
    reiter(basisMit([fassung1()], { anstoesse: [anstossR5()] }), 'CB');
    const kasten = await screen.findByTestId('bezugsbasis-anstoss');
    expect(within(kasten).getByText(ANSTOSS_SATZ_R5)).toBeTruthy();
    expect(within(kasten).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Beenden' })).toBeNull();
  });
  it('ein beantworteter Anstoß steht nicht mehr im Kasten; die Antworten bleiben an der Basis', async () => {
    mitFassungen([fassung1()]);
    reiter(basisMit([fassung1()], { anstoesse: [anstossR5({ offen: false, antwort: { art: 'bleibt', person: 'Ines Kaltenbach', am: '2027-01-06T09:00:00+01:00', begruendung: 'x' } })] }));
    await screen.findByTestId('bezugsbasis-fassung-1');
    expect(screen.queryByTestId('bezugsbasis-anstoss')).toBeNull();
    expect(screen.getByRole('button', { name: 'Geprüft, bleibt' })).toBeTruthy();
  });
  it('Rückfall ohne Feld: die Übersicht sagt „Anstoß liegt vor“ — Kasten ohne Anlass', async () => {
    vi.spyOn(api, 'bezugsbasisFassung').mockResolvedValue(fassung1());
    vi.spyOn(api, 'bezugsbasisUebersicht').mockResolvedValue({
      stichtag: '2027-01-06', laufend: 1, freigegeben: 1, vorlaeufig: 1, mit_anstoss: 1, ueberpruefung_faellig: 0,
      faellig: [{ ...zustandNachBleibt(), anstoss_liegt_vor: true }],
    });
    reiter(basisMit([fassung1()]));
    expect(await screen.findByText('Bezugsbasis BB-0001: Anstoß liegt vor — Fassung 1 prüfen.')).toBeTruthy();
  });
});

describe('Frist (F5, R13)', () => {
  it('„Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.“ aus dem Feld der Route', async () => {
    mitFassungen([fassung1()]);
    reiter(basisMit([fassung1()], { anstoesse: [], frist: fristR13(true) }));
    expect((await screen.findByTestId('bezugsbasis-frist')).textContent).toBe(FRIST_SATZ_R13);
  });
});

describe('Neue Fassung bilden (A1, F4): Pflicht, sonstiger, Vorbelegung, Vorschau alt/neu', () => {
  it('verlangt Grund und Begründung, sonstiger mit Wortlaut, und öffnet den Assistenten vorbelegt aus Fassung 1', async () => {
    mitFassungen([fassung1()]);
    const entwurf = vi.spyOn(api, 'bezugsbasisEntwurf').mockImplementation(async (_k, _b, body) =>
      fassung2('entwurf', { referenzperiode: body.referenzperiode, anpassungsgruende: body.anpassungsgruende ?? [] }),
    );
    vi.spyOn(api, 'kennzahlVariablenVorschlag').mockResolvedValue(variablenVorschlag());
    vi.spyOn(api, 'kennzahlFaktorenVorschlag').mockResolvedValue(faktorenVorschlag());
    reiter(basisMit([fassung1()], { anstoesse: [anstossR5()] }));
    await waitFor(() => expect(api.bezugsbasisFassung).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Neue Fassung bilden' }));
    const dialog = await screen.findByTestId('bezugsbasis-neue-fassung');
    fireEvent.click(screen.getByTestId('bezugsbasis-anpassung-weiter'));
    expect(within(dialog).getByText('Bitte wählen Sie mindestens einen Anpassungsgrund.')).toBeTruthy();
    expect(within(dialog).getByText('Bitte begründen Sie mit mindestens 10 Zeichen.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'sonstiger Grund' }));
    fireEvent.click(screen.getByTestId('bezugsbasis-anpassung-weiter'));
    expect(within(dialog).getByText('Bitte nennen Sie den sonstigen Grund.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'sonstiger Grund' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Struktur geändert' }));
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Anbau Halle 2: die Fläche wächst.' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Gilt ab (wahlfrei)' }));
    fireEvent.click(screen.getAllByRole('gridcell', { name: '1' })[0]);
    fireEvent.click(screen.getByTestId('bezugsbasis-anpassung-weiter'));

    const assistent = await screen.findByTestId('bezugsbasis-assistent');
    expect(screen.getByRole('dialog', { name: 'Neue Fassung bilden' })).toBeTruthy();
    // Vorbelegung aus Fassung 1: Oktober 2026 in beiden Pickern.
    expect(within(assistent).getAllByText('Oktober 2026').length).toBeGreaterThanOrEqual(2);
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf')));
    expect(entwurf).toHaveBeenLastCalledWith(BB_IDS.kz4, BB_IDS.bb1, {
      referenzperiode: '2026-10/2026-10',
      methode: 'verhaeltnis',
      anpassungsgruende: ['struktur_geaendert'],
      anpassung_wortlaut: null,
      begruendung: 'Anbau Halle 2: die Fläche wächst.',
      gilt_ab: '2027-01-01',
    });
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-entwurf-knopf')));
    const letzter = entwurf.mock.calls.at(-1)![2];
    expect(letzter.anpassungsgruende).toEqual(['struktur_geaendert']);
    expect(letzter.faktoren).toEqual([
      { art: 'wortlaut', wortlaut: 'Zweischichtbetrieb, Halle 2' },
    ]);
    const altNeu = await screen.findByTestId('bezugsbasis-alt-neu');
    expect(within(altNeu).getByText('Verhältnis 0,2837 kWh je kg')).toBeTruthy();
    expect(within(altNeu).getByText('Verhältnis 0,2811 kWh je kg')).toBeTruthy();
  });
  it('„Neue Fassung bilden“ ist gesperrt, solange Fassung 2 als Entwurf offen ist', async () => {
    mitFassungen([fassung1(), fassung2()]);
    reiter(basisMit([fassung1(), fassung2()]));
    await screen.findByTestId('bezugsbasis-fassung-2');
    expect((screen.getByRole('button', { name: 'Neue Fassung bilden' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Fassung 2 ist noch Entwurf — eine neue Fassung entsteht erst nach ihrer Entscheidung.')).toBeTruthy();
  });
});

describe('Beenden und Bleibt (F4, F5; IP-17-Routen)', () => {
  it('Beenden: Pflichtfelder, rückwirkend vor heute, danach der Satz für Vergleiche', async () => {
    mitFassungen([fassung1()]);
    const beenden = vi.spyOn(api, 'bezugsbasisBeenden').mockResolvedValue({ ...zustandNachBleibt(), zustand: 'beendet', beendet_zum: '2026-12-31', beendet_grund: 'struktur_geaendert' });
    const { onNeu } = reiter(basisMit([fassung1()], { anstoesse: [anstossR5()] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Beenden' }));
    const dialog = await screen.findByTestId('bezugsbasis-beenden');
    fireEvent.click(screen.getByTestId('bezugsbasis-beenden-senden'));
    expect(within(dialog).getByText('Bitte wählen Sie einen Grund.')).toBeTruthy();
    expect(beenden).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Letzter Tag' }));
    fireEvent.click(screen.getByRole('button', { name: 'Voriger Monat' }));
    fireEvent.click(screen.getAllByRole('gridcell', { name: '31' }).at(-1)!);
    expect(within(dialog).getByText('Der Tag liegt vor heute — die Bezugsbasis endet rückwirkend.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Grund' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Struktur geändert' }));
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Anbau Halle 2 ab Januar.' } });
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-beenden-senden')));
    expect(beenden).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, { tag: '2026-12-31', grund: 'struktur_geaendert', begruendung: 'Anbau Halle 2 ab Januar.', rueckwirkend: true });
    expect(screen.getByTestId('bezugsbasis-beendet').textContent).toBe(
      'Vergleiche danach: Nicht bewertbar: Bezugsbasis beendet am 31.12.2026 (Struktur geändert).',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onNeu).toHaveBeenCalled();
  });
  it('Bleibt: Begründung Pflicht; Ablehnung der Route als Satz; danach die neue Frist', async () => {
    mitFassungen([fassung1()]);
    const bleibt = vi
      .spyOn(api, 'bezugsbasisBleibt')
      .mockRejectedValueOnce(new ApiError(409, 'Konflikt', { code: 'bezugsbasis_beendet' }))
      .mockResolvedValue(zustandNachBleibt());
    reiter(basisMit([fassung1()], { anstoesse: [], frist: fristR13(true) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Geprüft, bleibt' }));
    const dialog = await screen.findByTestId('bezugsbasis-bleibt');
    fireEvent.click(screen.getByTestId('bezugsbasis-bleibt-senden'));
    expect(within(dialog).getByText('Bitte begründen Sie mit mindestens 10 Zeichen.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Keine Änderung an Halle und Produktion.' } });
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-bleibt-senden')));
    expect(within(dialog).getByText('Die Bezugsbasis ist bereits beendet.')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-bleibt-senden')));
    expect(bleibt).toHaveBeenLastCalledWith(BB_IDS.kz4, BB_IDS.bb1, 'Keine Änderung an Halle und Produktion.');
    expect(screen.getByTestId('bezugsbasis-geprueft').textContent).toBe('Geprüft: Fassung 1 bleibt · nächste Überprüfung am 13.11.2028.');
    expect(within(dialog).getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
});

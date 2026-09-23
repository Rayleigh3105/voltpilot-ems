import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Kennzahl } from '../api';
import { LEER_SATZ } from '../bezugsbasisAnlegen';
import { UEMS_NORMGRENZE } from '../glossar';
import { KennzahlenPage } from '../pages/KennzahlenPage';
import { KennzahlSeite } from '../pages/KennzahlSeite';
import { setSelbstauskunft } from '../rollen';
import { bb1, bb1Fassung, BB_IDS, faktorenVorschlag, kz4, variablenVorschlag } from '../test/bezugsbasisFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { BezugsbasisReiter, type BezugsbasisLage } from './BezugsbasisReiter';

/**
 * UEMS AP-17 IP-9 — der Reiter „Bezugsbasis“ an der Kennzahl, sein Assistent, die Basis-Zeile und das Register-
 * Kennzeichen, gegen die Antworten von R1 (Ines Kaltenbach, KZ-0004, BB-0001 Oktober 2026 vorläufig). Die Routen von
 * IP-7 (Anlegen, Entwurf) und IP-8 (Liste der Basen, beantragen · freigeben · ablehnen, Register-Feld) sind
 * gemockt.
 */
const ZONE = 'Europe/Berlin';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T09:00:00+01:00'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSelbstauskunft(null);
});

const reiter = (lage: BezugsbasisLage, k: Kennzahl = kz4()) => {
  const onNeu = vi.fn();
  render(<BezugsbasisReiter kennzahl={k} lage={lage} zone={ZONE} onNeu={onNeu} />);
  return { onNeu };
};

describe('leerer Zustand und Rechte-Sicht (§5.8 „Leer“, R10)', () => {
  it('Ines Kaltenbach (Energiemanager) liest den Satz und den Knopf „Bezugsbasis anlegen“ — und den Grenz-Satz', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    reiter({ art: 'keine' });
    expect(screen.getByText(LEER_SATZ)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bezugsbasis anlegen' })).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('Claudia Berger (Leserin) liest nur den Satz, keinen Knopf', () => {
    setSelbstauskunft(rechteSeed('CB').me);
    reiter({ art: 'keine' });
    expect(screen.getByText(LEER_SATZ)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bezugsbasis anlegen' })).toBeNull();
  });
  it('eine archivierte Kennzahl bekommt keine neue Bezugsbasis', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    reiter({ art: 'keine' }, kz4({ archiviert_am: '2026-11-01T00:00:00+01:00' }));
    expect(screen.queryByRole('button', { name: 'Bezugsbasis anlegen' })).toBeNull();
  });
});

describe('der Assistent in fünf Schritten (R1: Oktober 2026, Verhältnis, vorläufig)', () => {
  it('bildet den Entwurf, zeigt die Monate, graut die Modelle aus, schlägt Einflussgrößen und Faktoren vor und gibt mit Begründung frei', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const anlegen = vi.spyOn(api, 'bezugsbasisAnlegen').mockResolvedValue(bb1(null));
    const entwurf = vi.spyOn(api, 'bezugsbasisEntwurf').mockImplementation(async (_k, _b, body) =>
      bb1Fassung('entwurf', { referenzperiode: body.referenzperiode }),
    );
    const variablen = vi.spyOn(api, 'kennzahlVariablenVorschlag').mockResolvedValue(variablenVorschlag());
    const faktoren = vi.spyOn(api, 'kennzahlFaktorenVorschlag').mockResolvedValue(faktorenVorschlag());
    const freigabe = vi.spyOn(api, 'bezugsbasisFreigabe').mockResolvedValue(bb1Fassung('freigegeben'));
    reiter({ art: 'keine' });
    fireEvent.click(screen.getByRole('button', { name: 'Bezugsbasis anlegen' }));
    const dialog = await screen.findByTestId('bezugsbasis-assistent');
    const weiter = () => screen.getByTestId('bezugsbasis-weiter');

    // (1) Referenzperiode: Vorschlag die letzten zwölf vollen Monate; erst „Monate prüfen“ öffnet den Weg.
    expect(within(dialog).getByText('November 2025')).toBeTruthy();
    expect(within(dialog).getByText('Oktober 2026')).toBeTruthy();
    expect((weiter() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf')));
    expect(anlegen).toHaveBeenCalledWith(BB_IDS.kz4);
    expect(entwurf).toHaveBeenLastCalledWith(BB_IDS.kz4, BB_IDS.bb1, { referenzperiode: '2025-11/2026-10', methode: 'verhaeltnis' });
    const monate = screen.getByTestId('bezugsbasis-monate');
    expect(within(monate).getByText('vorhanden')).toBeTruthy();
    expect(screen.getByTestId('bezugsbasis-vorlaeufig').textContent).toBe('vorläufig (1 von 12 Monaten)');

    // (2) Methode: bei einem Monat trägt nur das Verhältnis — die Modelle mit dem §5.8-Satz „Modell nicht möglich …“ (G1).
    fireEvent.click(weiter());
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked, r.disabled])).toEqual([
      ['verhaeltnis', true, false],
      ['regression_eine_variable', false, true],
      ['regression_zwei_variablen', false, true],
      ['gradtage', false, true],
    ]);
    expect(within(dialog).getAllByText('Modell nicht möglich: 1 von 12 Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.')).toHaveLength(3);
    expect(within(dialog).queryByText('kommt')).toBeNull();

    // (3) Einflussgrößen: Variable 1 = Bezugsgröße der Kennzahl; BZ-3 hängt an BZ-1, die Leckagerate hat keine Zahl.
    fireEvent.click(weiter());
    await screen.findByText(/Produktionsmenge \(BZ-1, kg\) — die Bezugsgröße der Kennzahl/);
    expect(variablen).toHaveBeenCalledWith(BB_IDS.kz4, '2025-11/2026-10');
    const kandidaten = screen.getByTestId('bezugsbasis-kandidaten');
    expect(within(kandidaten).getByText(/hängt an Produktionsmenge \(r = 0,997\)/)).toBeTruthy();
    expect(within(kandidaten).getByText('ohne Zahl — erst als Bezugsgröße erfassen')).toBeTruthy();
    expect((within(kandidaten).getAllByRole('checkbox') as HTMLInputElement[]).every((c) => c.disabled)).toBe(true);

    // (4) Statische Faktoren: Vorschlag der Struktur am gilt_ab, ankreuzbar, dazu ein Wortlaut.
    fireEvent.click(weiter());
    await screen.findByText(/Fläche Halle 1 \(G-1\): 4 200 m²/);
    expect(faktoren).toHaveBeenCalledWith(BB_IDS.kz4, '2026-11-01');
    fireEvent.click(within(screen.getByTestId('bezugsbasis-faktoren')).getAllByRole('checkbox')[0]);

    // (5) Vorschau → „Als Entwurf speichern“ → ohne Vier-Augen (Ahrenberg) „Freigeben“ mit Begründung 10–500.
    fireEvent.click(weiter());
    expect(screen.getByTestId('bezugsbasis-basiswert').textContent).toBe('0,2837 kWh je kg');
    expect(screen.getByTestId('bezugsbasis-faktoren-zahl').textContent).toBe('1 gewählt');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-entwurf-knopf')));
    expect(entwurf).toHaveBeenLastCalledWith(BB_IDS.kz4, BB_IDS.bb1, {
      referenzperiode: '2025-11/2026-10', methode: 'verhaeltnis', variablen: [BB_IDS.bz1], toleranz_prozent: '2', wiedervorlage_monate: 12,
      faktoren: [{ art: 'flaeche', objekt_id: 'g1000000-0000-4000-8000-000000000001' }],
    });
    const text = screen.getByLabelText('Begründung');
    fireEvent.change(text, { target: { value: 'zu kurz' } });
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-freigeben-knopf')));
    expect(freigabe).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Bitte begründen Sie mit mindestens 10 Zeichen.');
    fireEvent.change(text, { target: { value: 'Oktober 2026 ist der erste volle Monat mit Produktionsmenge.' } });
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-freigeben-knopf')));
    expect(freigabe).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, 1, 'freigeben', 'Oktober 2026 ist der erste volle Monat mit Produktionsmenge.');
    expect(screen.getByTestId('bezugsbasis-nach-antrag').textContent).toBe('Fassung 1 ist freigegeben und gilt ab 01.11.2026.');
    expect(within(dialog).getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });

  it('eine Ablehnung der Route steht als ihr Satz; `methode_noch_nicht_gebaut` graut die Methode weiter aus', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'bezugsbasisAnlegen').mockRejectedValue(
      new ApiError(409, 'Diese Kennzahl hat schon eine laufende Bezugsbasis; bilden Sie dort eine neue Fassung.', {
        code: 'bezugsbasis_laeuft', bezugsbasis_id: BB_IDS.bb1, bezugsbasis: 'BB-0001',
      }),
    );
    const entwurf = vi.spyOn(api, 'bezugsbasisEntwurf').mockRejectedValue(
      new ApiError(422, 'In der Referenzperiode hat die Kennzahl keinen gespeicherten Monatswert.', { code: 'keine_werte' }),
    );
    reiter({ art: 'keine' });
    fireEvent.click(screen.getByRole('button', { name: 'Bezugsbasis anlegen' }));
    await screen.findByTestId('bezugsbasis-assistent');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf')));
    // B1 als Wettlauf: der Entwurf geht an die laufende Basis, die die Route nennt.
    expect(entwurf).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, expect.anything());
    expect(screen.getByTestId('bezugsbasis-fehler').textContent).toBe('In der Referenzperiode hat die Kennzahl keinen gespeicherten Monatswert.');
    expect((screen.getByTestId('bezugsbasis-weiter') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Freigabe einer beantragten Fassung (F1/F2, Vier-Augen)', () => {
  it('wer `bezugsbasis.freigeben` hat, sieht „Freigeben“ und „Ablehnen“ mit Vier-Augen-Hinweis; eine Leserin nicht', async () => {
    const lage: BezugsbasisLage = { art: 'da', basis: bb1('beantragt'), fassung: bb1Fassung('beantragt') };
    setSelbstauskunft(rechteSeed('JW').me);
    const freigabe = vi.spyOn(api, 'bezugsbasisFreigabe').mockResolvedValue(bb1Fassung('freigegeben'));
    const { onNeu } = reiter(lage);
    const eintrag = screen.getByTestId('bezugsbasis-fassung-1');
    expect(within(eintrag).getByText('zur Freigabe beantragt')).toBeTruthy();
    expect(within(eintrag).getByText(/Vier-Augen-Prinzip/)).toBeTruthy();
    fireEvent.change(within(eintrag).getByLabelText('Begründung'), { target: { value: 'Geprüft: Grundlage und Basiswert stimmen.' } });
    await act(async () => fireEvent.click(within(eintrag).getByRole('button', { name: 'Ablehnen' })));
    expect(freigabe).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, 1, 'ablehnen', 'Geprüft: Grundlage und Basiswert stimmen.');
    expect(onNeu).toHaveBeenCalled();
  });
  it('die Leserin sieht die Fassung, aber keinen Hebel', () => {
    setSelbstauskunft(rechteSeed('CB').me);
    reiter({ art: 'da', basis: bb1('beantragt'), fassung: bb1Fassung('beantragt') });
    expect(screen.getByTestId('bezugsbasis-fassung-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull();
    expect(screen.queryByLabelText('Begründung')).toBeNull();
  });
  it('ein Entwurf wird bearbeitet und ohne Vier-Augen freigegeben, mit Vier-Augen beantragt', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    reiter({ art: 'da', basis: bb1('entwurf'), fassung: bb1Fassung('entwurf') });
    expect(screen.getByRole('button', { name: 'Entwurf bearbeiten' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Freigeben' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Zur Freigabe beantragen' })).toBeNull();
  });
  it('kennt die Fläche die Einstellung nicht, folgt sie der Route: 409 `vieraugen_beantragen` → beantragen', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const freigabe = vi
      .spyOn(api, 'bezugsbasisFreigabe')
      .mockRejectedValueOnce(new ApiError(409, 'Mit Vier-Augen wird die Fassung beantragt.', { code: 'vieraugen_beantragen' }))
      .mockResolvedValueOnce(bb1Fassung('beantragt', { vieraugen: true }));
    const { onNeu } = reiter({ art: 'da', basis: bb1('entwurf'), fassung: null });
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Oktober 2026 als erste Bezugsbasis.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Freigeben' })));
    expect(freigabe.mock.calls.map((c) => c[3])).toEqual(['freigeben', 'beantragen']);
    expect(onNeu).toHaveBeenCalled();
  });
});

describe('an der Kennzahl-Seite: Reiter und Basis-Zeile', () => {
  const seite = (k: Kennzahl, basen: ReturnType<typeof bb1>[]) => {
    vi.spyOn(api, 'kennzahl').mockResolvedValue(k);
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [k] });
    vi.spyOn(api, 'kennzahlFassungen').mockResolvedValue({ kennzahl_id: k.id, kennzeichen: k.kennzeichen, fassungen: [] });
    vi.spyOn(api, 'kennzahlWerte').mockRejectedValue(new ApiError(500, 'x'));
    const liste = vi.spyOn(api, 'kennzahlBezugsbasen').mockResolvedValue({ bezugsbasen: basen });
    vi.spyOn(api, 'bezugsbasisFassung').mockResolvedValue(bb1Fassung('freigegeben'));
    render(<KennzahlSeite id={k.id} zone={ZONE} onListe={() => undefined} />);
    return { liste };
  };
  it('KZ-0004 mit BB-0001: die Basis-Zeile von R1 im Kopf, der Reiter „Bezugsbasis“ daneben', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    seite(kz4(), [bb1('freigegeben')]);
    expect((await screen.findByTestId('bezugsbasis-zeile')).textContent).toBe(
      'Bezugsbasis BB-0001 · Oktober 2026 · Verhältnis 0,2837 kWh je kg · vorläufig (1 von 12 Monaten) · freigegeben von Ines Kaltenbach am 12.11.2026.',
    );
    const tabs = within(screen.getByRole('tablist', { name: 'Reiter der Kennzahl KZ-0004' })).getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Kennzahl', 'true'],
      ['Bezugsbasis', 'false'],
      ['Vergleich mit Bezugsbasis', 'false'],
    ]);
    fireEvent.click(tabs[1]);
    expect(screen.getByTestId('bezugsbasis-reiter')).toBeTruthy();
    expect(screen.queryByTestId('kennzahl-stammdaten')).toBeNull();
  });
  it('Nachprüfung PR 1173 (`e2e/kennzahlen.spec.ts` K1 1440): der neue Reiter ist der einzige Unterschied — Überschriften und Abschnitte des Vorgabe-Reiters bleiben', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    // Die Messung der Bestands-Spec: jeder gewählte Reiter der Seite außer dem Perioden-Umschalter.
    const gewaehlt = (ohneKennzahlReiter: boolean) =>
      [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"][aria-selected="true"]')]
        .filter((t) => !t.closest('.vp-kz-perioden') && !(ohneKennzahlReiter && t.closest('.vp-kz-reiter')))
        .map((t) => t.textContent);
    const bau = () => ({
      ueberschriften: [...document.querySelectorAll('h1, h2, h3')].map((h) => `${h.tagName} ${h.textContent}`),
      abschnitte: [...document.querySelectorAll('section[aria-label]')].map((x) => x.getAttribute('aria-label')),
    });
    // Ein Anteil hat keinen Reiter (B2) — seine Seite ist der Bestand.
    seite(kz4({ rechenform: 'anteil' }), []);
    await screen.findByTestId('kennzahl-stammdaten');
    const vorher = bau();
    expect(gewaehlt(false)).toEqual([]);
    cleanup();
    vi.restoreAllMocks();
    seite(kz4(), []);
    await screen.findByTestId('kennzahl-stammdaten');
    await screen.findByRole('tablist', { name: 'Reiter der Kennzahl KZ-0004' });
    expect(gewaehlt(false)).toEqual(['Kennzahl']);
    expect(gewaehlt(true)).toEqual([]);
    expect(bau()).toEqual(vorher);
  });
  it('ein Anteil hat weder Reiter noch Basis-Zeile und fragt nichts ab (B2)', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const { liste } = seite(kz4({ rechenform: 'anteil' }), []);
    await screen.findByTestId('kennzahl-stammdaten');
    expect(screen.queryByRole('tablist', { name: 'Reiter der Kennzahl KZ-0004' })).toBeNull();
    expect(screen.queryByTestId('bezugsbasis-zeile')).toBeNull();
    expect(liste).not.toHaveBeenCalled();
  });
});

describe('Register: Kennzeichen „Energieleistungskennzahl“ und Filter (B3, R10)', () => {
  const register = (kennzahlen: Kennzahl[]) => {
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen });
    vi.spyOn(api, 'kennzahlWerte').mockRejectedValue(new ApiError(500, 'x'));
    render(<KennzahlenPage onOeffnen={() => undefined} onListe={() => undefined} zone={ZONE} />);
  };
  it('ohne freigegebene Basis kein Kennzeichen und kein Filter — Bestandskunden merken nichts', async () => {
    register([kz4(), kz4({ id: 'x2', kennzeichen: 'KZ-0005', bezugsbasis: { kennzeichen: 'BB-0002', fassung: 1, freigabe_status: 'entwurf', vorlaeufig: true } })]);
    await waitFor(() => expect(screen.getAllByTestId('kennzahl-karte')).toHaveLength(2));
    expect(screen.queryByTestId('kennzahl-energieleistung')).toBeNull();
    expect(screen.queryByTestId('kennzahl-filter-elk')).toBeNull();
  });
  it('mit freigegebener Basis steht das Kennzeichen; der Filter zeigt nur Energieleistungskennzahlen', async () => {
    register([
      kz4({ bezugsbasis: { kennzeichen: 'BB-0001', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: true } }),
      kz4({ id: 'x3', kennzeichen: 'KZ-0003', name: 'Unternehmen je Stück' }),
    ]);
    await waitFor(() => expect(screen.getAllByTestId('kennzahl-karte')).toHaveLength(2));
    expect(screen.getByTestId('kennzahl-energieleistung').textContent).toBe('Energieleistungskennzahl — Bezugsbasis BB-0001 · vorläufig.');
    fireEvent.click(screen.getByLabelText('nur Energieleistungskennzahlen'));
    expect(screen.getAllByTestId('kennzahl-karte')).toHaveLength(1);
    expect(screen.getByText('Spritzguss je kg')).toBeTruthy();
  });
});

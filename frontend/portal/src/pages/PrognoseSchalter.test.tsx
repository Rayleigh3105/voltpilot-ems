import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ForecastQuality } from '../api';
import type { ModellWahlZustand } from '../prognose';

/**
 * Der Prognose-Schalter auf RENDER-Ebene (Captain-Auftrag 18.08.2026, revidiert
 * am 19.08.2026: die Wahl gilt JE ANLAGE, und jeder Kunde trifft sie für seine
 * eigenen Anlagen selbst). Die Ableitungen sind in `prognose.test.ts`
 * erschöpfend geprüft - hier geht es um die fünf Dinge, die nur die Fläche
 * beantworten kann:
 *
 *  1. ein KUNDE sieht den Knopf auf seiner eigenen Anlage (das Rollen-Gate ist
 *     für diesen Knopf gefallen),
 *  2. der Dialog nennt die Folgen - inklusive „nur für diese Anlage" und dem
 *     Rückweg -, und NIE „alle Anlagen der Plattform",
 *  3. der Klick ruft genau EINEN Endpunkt, mit der ANLAGE + Art + Modell,
 *  4. ein sammelnder Kandidat bekommt einen gesperrten Knopf MIT Grund - und
 *     eine Ablehnung des Servers erscheint als deutscher Satz, nicht als Stille,
 *  5. ein Portal-Admin sieht zusätzlich die Plattform-Vorgabe.
 */

vi.mock('../ForecastQualityChart', () => ({
  ForecastQualityChart: () => <div data-testid="prognose-chart" />,
}));

const forecastQualityMock = vi.fn();
const forecastModelsMock = vi.fn();
const promoteMock = vi.fn();
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      forecastQuality: (...a: unknown[]) => forecastQualityMock(...a),
      siteForecastModels: (...a: unknown[]) => forecastModelsMock(...a),
      promoteSiteForecastModel: (...a: unknown[]) => promoteMock(...a),
    },
  };
});

const technicalLayer = vi.fn();
vi.mock('../rollen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rollen')>();
  return { ...actual, showTechnicalLayer: () => technicalLayer() };
});

const { PrognosePage } = await import('./PrognosePage');

function punkt(day: string, model: string, kind: 'load' | 'pv', maeKw: number, skill: number | null) {
  return { day, model, kind, maeKw, nmaePct: null, biasKw: null, skillVsBaseline: skill, nSlots: 96 } as never;
}

const QUALITY: ForecastQuality = {
  activeLoadModel: 'load-persistence',
  activePvModel: 'pv-physical',
  models: [
    {
      model: 'load-xgb',
      kind: 'load',
      status: 'ready',
      active: false,
      daysCollected: null,
      daysRequired: null,
      trainedAt: null,
      trainRows: null,
      featureImportance: [],
      updatedAt: null,
    },
    {
      model: 'pv-residual-xgb',
      kind: 'pv',
      status: 'collecting',
      active: false,
      daysCollected: 14,
      daysRequired: 21,
      trainedAt: null,
      trainRows: null,
      featureImportance: [],
      updatedAt: null,
    },
  ],
  accuracy: [
    punkt('2026-08-18', 'load-persistence', 'load', 0.8, null),
    punkt('2026-08-18', 'load-xgb', 'load', 0.4, 0.5),
    punkt('2026-08-17', 'load-persistence', 'load', 0.8, null),
    punkt('2026-08-17', 'load-xgb', 'load', 0.9, -0.125),
  ],
  planAccuracy: [],
};

const WAHL: ModellWahlZustand = {
  siteId: 'site-1',
  kinds: [
    {
      kind: 'load',
      activeModel: 'load-persistence',
      source: 'env',
      platformDefault: 'load-persistence',
      envDefault: 'load-persistence',
      setByName: null,
      setAt: null,
      selectable: ['load-persistence', 'load-xgb'],
    },
    {
      kind: 'pv',
      activeModel: 'pv-physical',
      source: 'env',
      platformDefault: 'pv-physical',
      envDefault: 'pv-physical',
      setByName: null,
      setAt: null,
      selectable: ['pv-physical', 'pv-residual-xgb'],
    },
  ],
  history: [],
};

const SITE = { id: 'site-1', name: 'Sonnenhof Weber' } as never;

function desktop() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function rendere() {
  return render(<PrognosePage sites={[SITE]} selectedSite="site-1" onSelectSite={() => {}} />);
}

describe('Prognosequalität - der Schalter', () => {
  beforeEach(() => {
    desktop();
    forecastQualityMock.mockResolvedValue(QUALITY);
    forecastModelsMock.mockResolvedValue(WAHL);
    promoteMock.mockResolvedValue(WAHL);
    // Der Normalfall dieser Datei ist ein KUNDE - der Knopf hängt nicht mehr
    // an der Rolle.
    technicalLayer.mockReturnValue(false);
  });
  afterEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - die Stellvertreter-Breite wieder abräumen
    delete window.matchMedia;
  });

  it('erklärt den Schattenbetrieb in zwei Sätzen und belegt „X von Y"', async () => {
    rendere();
    await screen.findByText('Lernende Kandidaten');

    expect(screen.getByText(/beeinflusst dabei keinen einzigen Fahrplan/)).toBeInTheDocument();
    expect(screen.getByText(/Jede Nacht wird nachgerechnet/)).toBeInTheDocument();

    // Der Beleg: die zwei bewerteten Tage mit BEIDEN Fehlerwerten.
    fireEvent.click(screen.getByText(/Die letzten 2 Bewertungen ansehen/));
    expect(
      screen.getByText('In 1 von 2 Bewertungen war der Kandidat genauer.'),
    ).toBeInTheDocument();
    expect(screen.getByText('18.08.2026')).toBeInTheDocument();
    expect(screen.getByText('17.08.2026')).toBeInTheDocument();
    // Die Metrik ist ehrlich benannt - keine erfundene „Genauigkeit in %".
    expect(screen.getByText(/Ø Abweichung je Tag \(kW\)/)).toBeInTheDocument();
  });

  it('zeigt einem KUNDEN den Knopf auf SEINER Anlage', async () => {
    technicalLayer.mockReturnValue(false);
    rendere();
    await screen.findByText('Lernende Kandidaten');

    // Das Gate ist für DIESEN Knopf gefallen - die Wahl gilt nur für diese
    // Anlage, und die gehört ihm.
    expect(screen.getAllByRole('button', { name: 'Kandidat übernehmen' })).toHaveLength(2);
    expect(forecastModelsMock).toHaveBeenCalledWith('site-1');
    // Die Erklärung und der Beleg bleiben ihm ebenfalls.
    expect(screen.getByText(/beeinflusst dabei keinen einzigen Fahrplan/)).toBeInTheDocument();
    expect(screen.getByText(/Die letzten 2 Bewertungen ansehen/)).toBeInTheDocument();
  });

  it('nennt vor dem Klick die Folgen - „nur für diese Anlage" und den Rückweg', async () => {
    rendere();
    await screen.findByText('Lernende Kandidaten');

    fireEvent.click(screen.getAllByRole('button', { name: 'Kandidat übernehmen' })[0]);

    expect(await screen.findByText('Kandidat übernehmen?')).toBeInTheDocument();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/nächsten Planungslauf/)).toBeInTheDocument();
    expect(dialog.getByText(/lernt im Schatten weiter/)).toBeInTheDocument();
    expect(dialog.getByText(/jederzeit zurücktauschen/)).toBeInTheDocument();
    expect(dialog.getByText(/NUR für diese Anlage/)).toBeInTheDocument();
    // ⚠ Die alte, plattformweite Zusage darf nirgends stehengeblieben sein.
    expect(dialog.queryByText(/alle Anlagen der Plattform/)).not.toBeInTheDocument();
    // Die Anlage wird beim Namen genannt - in der Einleitung UND in der Folge.
    expect(dialog.getAllByText(/Sonnenhof Weber/).length).toBeGreaterThan(0);
    // Nichts passiert, solange nicht bestätigt wurde.
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('stellt auf Bestätigung genau DIESE Anlage auf genau EIN Modell um', async () => {
    rendere();
    await screen.findByText('Lernende Kandidaten');
    fireEvent.click(screen.getAllByRole('button', { name: 'Kandidat übernehmen' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Übernehmen' }));

    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith('site-1', 'load', 'load-xgb'));
    expect(promoteMock).toHaveBeenCalledTimes(1);
  });

  it('sperrt den sammelnden Kandidaten MIT Grund statt ihn zu verstecken', async () => {
    rendere();
    await screen.findByText('Lernende Kandidaten');

    const knoepfe = screen.getAllByRole('button', { name: 'Kandidat übernehmen' });
    expect(knoepfe).toHaveLength(2);
    expect(knoepfe[1]).toBeDisabled();
    expect(
      screen.getByText('Noch keine Prognosen - der Kandidat sammelt Daten (Tag 14 von 21).'),
    ).toBeInTheDocument();
  });

  it('zeigt die Ablehnung des Servers als deutschen Satz, nie als Stille', async () => {
    const { ApiError } = await import('../api');
    promoteMock.mockRejectedValue(new ApiError(409, 'Dieses Modell plant bereits - nichts zu tun.'));
    rendere();
    await screen.findByText('Lernende Kandidaten');
    fireEvent.click(screen.getAllByRole('button', { name: 'Kandidat übernehmen' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Übernehmen' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('plant bereits');
  });

  const UMGESTELLT: ModellWahlZustand = {
    siteId: 'site-1',
    kinds: [
      {
        kind: 'load',
        activeModel: 'load-xgb',
        source: 'anlage',
        platformDefault: 'load-persistence',
        envDefault: 'load-persistence',
        setByName: 'max',
        setAt: '2026-08-18T09:30:00Z',
        selectable: ['load-persistence', 'load-xgb'],
      },
      WAHL.kinds[1],
    ],
    history: [
      {
        kind: 'load',
        model: 'load-xgb',
        previousModel: 'load-persistence',
        setByName: 'max',
        setAt: '2026-08-18T09:30:00Z',
      },
    ],
  };

  it('sagt am aktiven Modell, seit wann es FÜR DIESE ANLAGE plant und wer umgestellt hat', async () => {
    forecastModelsMock.mockResolvedValue(UMGESTELLT);
    rendere();
    await screen.findByText('Aktive Modelle');

    expect(
      await screen.findByText('Aktiv für diese Anlage seit 18.08.2026, umgestellt von max.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '18.08.2026: Vergleichsmodell (Vortageswert) → Lernendes Verbrauchsmodell (max)',
      ),
    ).toBeInTheDocument();
    // Die ANDERE Art bleibt ehrlich beim Standardmodell.
    expect(
      screen.getByText('Aktiv - das ausgelieferte Standardmodell dieser Prognoseart.'),
    ).toBeInTheDocument();
  });

  it('zeigt die Plattform-Vorgabe nur dem Betreiber, und nur bei Abweichung', async () => {
    forecastModelsMock.mockResolvedValue(UMGESTELLT);
    rendere();
    await screen.findByText('Aktive Modelle');
    // Der Kunde braucht sie nicht - sie ist eine Betreiber-Auskunft.
    expect(
      screen.queryByText(/Plattform-Vorgabe wäre/),
    ).not.toBeInTheDocument();

    technicalLayer.mockReturnValue(true);
    rendere();
    expect(
      await screen.findByText('Plattform-Vorgabe wäre: Vergleichsmodell (Vortageswert).'),
    ).toBeInTheDocument();
  });
});

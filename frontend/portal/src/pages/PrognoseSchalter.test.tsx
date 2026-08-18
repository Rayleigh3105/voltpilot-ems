import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ForecastQuality } from '../api';
import type { ModellWahlZustand } from '../prognose';

/**
 * Der Prognose-Schalter auf RENDER-Ebene (Captain-Auftrag 18.08.2026). Die
 * Ableitungen sind in `prognose.test.ts` erschöpfend geprüft - hier geht es um
 * die vier Dinge, die nur die Fläche beantworten kann:
 *
 *  1. ein Kunde sieht die Erklärung und die Belege, aber KEINEN Knopf,
 *  2. ein Admin sieht ihn, und der Dialog nennt die Folgen (inkl. „alle
 *     Anlagen" und dem Rückweg),
 *  3. der Klick ruft genau EINEN Endpunkt mit Art + Modell,
 *  4. ein sammelnder Kandidat bekommt einen gesperrten Knopf MIT Grund - und
 *     eine Ablehnung des Servers erscheint als deutscher Satz, nicht als Stille.
 */

vi.mock('../ForecastQualityChart', () => ({
  ForecastQualityChart: () => <div data-testid="prognose-chart" />,
}));

const forecastQualityMock = vi.fn();
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { ...actual.api, forecastQuality: (...a: unknown[]) => forecastQualityMock(...a) },
  };
});

const forecastModelsMock = vi.fn();
const promoteMock = vi.fn();
vi.mock('../admin/adminApi', () => ({
  adminApi: {
    forecastModels: () => forecastModelsMock(),
    promoteForecastModel: (...a: unknown[]) => promoteMock(...a),
  },
}));

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
  kinds: [
    {
      kind: 'load',
      activeModel: 'load-persistence',
      source: 'env',
      envDefault: 'load-persistence',
      setByName: null,
      setAt: null,
      selectable: ['load-persistence', 'load-xgb'],
    },
    {
      kind: 'pv',
      activeModel: 'pv-physical',
      source: 'env',
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
    technicalLayer.mockReturnValue(true);
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

  it('zeigt einem KUNDEN keinen Knopf - der Server verweigerte ihn ohnehin', async () => {
    technicalLayer.mockReturnValue(false);
    rendere();
    await screen.findByText('Lernende Kandidaten');

    expect(screen.queryByRole('button', { name: 'Kandidat übernehmen' })).not.toBeInTheDocument();
    expect(forecastModelsMock).not.toHaveBeenCalled();
    // Die Erklärung und der Beleg bleiben ihm.
    expect(screen.getByText(/beeinflusst dabei keinen einzigen Fahrplan/)).toBeInTheDocument();
    expect(screen.getByText(/Die letzten 2 Bewertungen ansehen/)).toBeInTheDocument();
  });

  it('nennt vor dem Klick die Folgen - inklusive „alle Anlagen" und Rückweg', async () => {
    rendere();
    await screen.findByText('Lernende Kandidaten');

    fireEvent.click(screen.getAllByRole('button', { name: 'Kandidat übernehmen' })[0]);

    expect(await screen.findByText('Kandidat übernehmen?')).toBeInTheDocument();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/nächsten Planungslauf/)).toBeInTheDocument();
    expect(dialog.getByText(/lernt im Schatten weiter/)).toBeInTheDocument();
    expect(dialog.getByText(/jederzeit zurücktauschen/)).toBeInTheDocument();
    expect(dialog.getByText(/alle Anlagen der Plattform/)).toBeInTheDocument();
    // Nichts passiert, solange nicht bestätigt wurde.
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('stellt auf Bestätigung genau EINE Art auf genau EIN Modell um', async () => {
    rendere();
    await screen.findByText('Lernende Kandidaten');
    fireEvent.click(screen.getAllByRole('button', { name: 'Kandidat übernehmen' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Übernehmen' }));

    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith('load', 'load-xgb'));
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

  it('sagt am aktiven Modell, seit wann es plant und wer umgestellt hat', async () => {
    forecastModelsMock.mockResolvedValue({
      kinds: [
        {
          kind: 'load',
          activeModel: 'load-xgb',
          source: 'portal',
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
    } satisfies ModellWahlZustand);
    rendere();
    await screen.findByText('Aktive Modelle');

    expect(
      await screen.findByText('Aktiv seit 18.08.2026, umgestellt von max.'),
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
});

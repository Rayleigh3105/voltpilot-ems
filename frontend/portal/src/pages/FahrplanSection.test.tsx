import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FahrplanSection } from './DataPages';
import type { ControlStatus, SchedulePlan, ScheduleSlot, Site, TelemetryPoint } from '../api';

/**
 * Das SEITENGERÜST der Fahrplan-Seite: vier Blöcke in der Reihenfolge der
 * Kundenfragen (Jetzt-Held → Film → Euro-Zeile → Diagramm-Aufklappebene).
 * Die Zustands-Vollständigkeit liegt in den reinen Modul-Tests; hier wird
 * geprüft, dass die Blöcke wirklich in dieser Ordnung stehen und dass ein Plan
 * OHNE die persistierten Warum-Fakten sauber degradiert (kein Film, kein
 * erfundener Grund).
 */

vi.mock('../ScheduleChart', () => ({
  ScheduleChart: () => <div data-testid="chart" />,
}));

const controlStatus = vi.fn();
const schedule = vi.fn();
const telemetry = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      schedule: (...a: unknown[]) => schedule(...a),
      controlStatus: (...a: unknown[]) => controlStatus(...a),
      telemetry: (...a: unknown[]) => telemetry(...a),
    },
  };
});

const SITE = { id: 's1', name: 'Sonnenhof', plantKind: 'eigenverbrauch' } as unknown as Site;

/** „jetzt" liegt im ersten Slot, wie bei einem echten MPC-Lauf. */
function slot(over: Partial<ScheduleSlot> & { start: string }): ScheduleSlot {
  return {
    batteryKw: -4.3,
    gridKw: 0,
    socPct: 78,
    priceEurMwh: 212,
    costEur: 0.1,
    baselineCostEur: 0.4,
    curtailKw: null,
    pvKw: null,
    loadKw: null,
    slotRole: 'eigenverbrauch',
    slotFlags: null,
    storedValueCtKwh: 21.5,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    importPriceCtKwh: 32.5,
    importPriceSource: 'preisblatt',
    ...over,
  } as ScheduleSlot;
}

function plan(over: Partial<SchedulePlan> = {}): SchedulePlan {
  const t0 = Date.now() - 5 * 60_000;
  return {
    planId: 'p1',
    deviceId: 'dev-1',
    generatedAt: new Date(t0).toISOString(),
    slotMinutes: 15,
    savingsEur: 3.42,
    bankedValueEur: null,
    socStartPct: null,
    socEndPct: null,
    peakTargetKw: null,
    fallback14a: null,
    slots: Array.from({ length: 8 }, (_, i) =>
      slot({ start: new Date(t0 + i * 15 * 60_000).toISOString() }),
    ),
    ...over,
  };
}

const CONTROL: ControlStatus = {
  deviceId: 'dev-1',
  commandedKw: -6.1,
  confirmedKw: -6.1,
  allMatch: true,
  controlEnabled: true,
  certified: true,
  mismatchRoles: null,
  slotStart: null,
  checkedAt: new Date().toISOString(),
};

const POINTS: TelemetryPoint[] = [
  {
    ts: new Date().toISOString(),
    powerKw: 0,
    socPct: 78,
    pvPowerKw: 1,
    loadKw: 7.1,
    gridLimitKw: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  schedule.mockResolvedValue(plan());
  controlStatus.mockResolvedValue(CONTROL);
  telemetry.mockResolvedValue(POINTS);
});

describe('FahrplanSection · die vier Blöcke', () => {
  it('beantwortet „was macht meine Batterie gerade" ganz oben - mit den drei Wahrheiten', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    // Der Held steht VOR allem anderen.
    const blocks = [...container.querySelectorAll('.vp-jetzt, .vp-film, .vp-fp-euro')];
    expect(blocks[0]?.classList.contains('vp-jetzt')).toBe(true);
    // Ausführung (Rücklesen) statt Plan-Watt, und der Plan bleibt sichtbar.
    await waitFor(() => expect(screen.getByText(/6,1/)).toBeInTheDocument());
    expect(screen.getByText(/Fahrplan sah/)).toBeInTheDocument();
    // Der Warum-Satz des laufenden Slots, mit dem echten Bezugspreis.
    expect(screen.getByText(/32,5 ct\/kWh/)).toBeInTheDocument();
    // Der Film mit seiner ersten, laufenden Phase.
    expect(container.querySelector('.vp-film-now')?.textContent).toBe('Jetzt');
    expect(screen.getAllByText('Verbrauch decken').length).toBeGreaterThan(0);
    // Die Euro-Zeile ersetzt die alte KPI-Reihe.
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
    expect(container.querySelector('.vp-kpis')).toBeNull();
  });

  it('hält das Diagramm als Aufklapp-Ebene bereit und zeigt die kWh-Summen erst darin', async () => {
    render(<FahrplanSection site={SITE} />);
    const toggle = await screen.findByRole('button', { name: /Diagramm im Detail/ });
    // jsdom kennt kein matchMedia -> Startwert „offen" (Desktop).
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.getByText(/geplantes Laden/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.queryByText(/geplantes Laden/)).toBeNull();
  });

  it('degradiert ohne persistierte Warum-Fakten: kein Film, kein erfundener Grund', async () => {
    schedule.mockResolvedValue(
      plan({
        slots: plan().slots.map((s) => ({ ...s, slotRole: null, storedValueCtKwh: null })),
      }),
    );
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    expect(container.querySelector('.vp-film')).toBeNull();
    expect(screen.queryByText(/32,5 ct\/kWh/)).toBeNull();
    // ...die Euro-Zeile und das Diagramm bleiben.
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('bleibt ohne Rücklesen ehrlich: „—" mit Grund statt einer erfundenen Zahl', async () => {
    controlStatus.mockResolvedValue(null);
    render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
    expect(screen.getByText(/Rückmeldung/)).toBeInTheDocument();
    expect(screen.queryByText(/6,1/)).toBeNull();
  });

  it('überlebt einen Ausfall der beiden Live-Abrufe (fail-soft)', async () => {
    controlStatus.mockRejectedValue(new Error('down'));
    telemetry.mockRejectedValue(new Error('down'));
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
  });
});

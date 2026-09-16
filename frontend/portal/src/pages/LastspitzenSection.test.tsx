import { bestandSnapshot, bestandsZeit } from '../test/bestandsschutzSnapshot';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LastspitzenSection } from './LastspitzenSection';
import type { Earnings, PeakShaving, SchedulePlan, Site } from '../api';

/**
 * **Paket P6 — der Reiter „Lastspitzen" in den C-Bausteinen** (Konzept
 * `vp-verlauf-sprache-konzept-v5` §4.4; Captain-Entscheide E7 = a und E8 = a).
 *
 * Geprüft wird die FORM der drei Karten (Statement statt KPI-Karten, Bild vor
 * Legende, Layer-Chips unter dem Bild, Legende im Aufklapper, Insight als
 * Sekundärzeile) und die EHRLICHKEIT der Sonderzustände — nie eine 0, wo
 * nichts gemessen wurde.
 *
 * ⚠ `ScheduleChart` wird hier NICHT gefälscht: seine Reihenfolge im
 *   Verlauf-Rahmen IST der Gegenstand dieses Pakets (die Fahrplan-Seite prüft
 *   ihre eigene, unveränderte Reihenfolge in `FahrplanSection.test.tsx`).
 *   ECharts rendert in jsdom ohne Maße nichts — der Container steht trotzdem
 *   im Baum, und um ihn herum liegt alles, was hier zählt.
 */

// jsdom hat kein Canvas — der ECharts-Aufhänger wird gestubbt, der REF-Knoten
// bleibt im Baum. Genau um ihn herum liegt alles, was P6 prüft (Reihenfolge,
// Schalter, Aufklapper); die Achsen/Serien prüft `ScheduleChart.test.tsx`.
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

const earnings = vi.fn();
const schedule = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      earnings: (...a: unknown[]) => earnings(...a),
      schedule: (...a: unknown[]) => schedule(...a),
    },
  };
});

const SITE = { id: 's1', name: 'Hof Lindenberg' } as unknown as Site;

function peakShaving(over: Partial<PeakShaving> = {}): PeakShaving {
  return {
    leistungspreisEurKw: 120,
    abrechnung: 'jahr',
    periodStart: '2026-01-01',
    peakKw: 8.7,
    baselinePeakKw: 12.4,
    avoidedKw: 3.7,
    avoidedEur: 444,
    history: [
      {
        periodStart: '2025-01-01',
        peakKw: 9.9,
        baselinePeakKw: 11.2,
        avoidedKw: 1.3,
        avoidedEur: 156,
      },
      {
        periodStart: '2026-01-01',
        peakKw: 8.7,
        baselinePeakKw: 12.4,
        avoidedKw: 3.7,
        avoidedEur: 444,
      },
    ],
    ...over,
  } as PeakShaving;
}

function earningsDoc(peak: PeakShaving | null): Earnings {
  return {
    sites: [{ id: 's1', peakShaving: peak }],
  } as unknown as Earnings;
}

function plan(over: Partial<SchedulePlan> = {}): SchedulePlan {
  return {
    planId: 'p1',
    generatedAt: '2026-09-03T06:00:00Z',
    slotMinutes: 15,
    deviceId: 'd1',
    peakTargetKw: 9,
    savingsEur: 1.2,
    slots: [
      {
        start: '2026-09-03T06:00:00Z',
        batteryKw: -4,
        gridKw: 2,
        socPct: 70,
        priceEurMwh: 210,
        costEur: 0.1,
        baselineCostEur: 0.4,
        curtailKw: null,
        pvKw: 1,
        loadKw: 3,
      },
      {
        start: '2026-09-03T06:15:00Z',
        batteryKw: 3,
        gridKw: 4,
        socPct: 74,
        priceEurMwh: 30,
        costEur: 0.05,
        baselineCostEur: 0.2,
        curtailKw: null,
        pvKw: 2,
        loadKw: 3,
      },
    ],
    ...over,
  } as unknown as SchedulePlan;
}

beforeEach(() => {
  earnings.mockReset();
  schedule.mockReset();
  earnings.mockResolvedValue(earningsDoc(peakShaving()));
  schedule.mockResolvedValue(plan());
});

it('AP-13 Bestandsschutz · Verlauf Lastspitzen ohne Messfunktion', async () => {
  bestandsZeit();
  const view = render(<LastspitzenSection site={SITE} />);
  await screen.findByText('8,7 kW', { selector: '.vp-c-stm-zahl' });
  await bestandSnapshot('verlauf-lastspitzen', view);
});

describe('P6 · Karte 1 — das Statement (E8 = a)', () => {
  it('trägt die EINE Zahl als Statement und die zwei anderen als Ledger-Zeilen', async () => {
    const { container } = render(<LastspitzenSection site={SITE} />);

    const zahl = await screen.findByText('8,7 kW', { selector: '.vp-c-stm-zahl' });
    expect(zahl).toBeInTheDocument();
    expect(
      screen.getByText('Gehaltene Spitze in diesem Abrechnungsjahr', {
        selector: '.vp-c-stm-satz',
      }),
    ).toBeInTheDocument();

    // Die zwei anderen Zahlen sind ZEILEN — mit Vorzeichen aus dem Wert.
    expect(screen.getByText('Vermiedene Spitze')).toBeInTheDocument();
    expect(screen.getByText('+3,7 kW')).toBeInTheDocument();
    expect(screen.getByText('Ersparte Leistungskosten')).toBeInTheDocument();
    expect(screen.getByText(/^\+444,00\s*€$/)).toBeInTheDocument();

    // ⚠ Und KEINE KPI-Karte mehr: die Karte in der Karte ist der Befund B6.
    expect(container.querySelector('.vp-kpis')).toBeNull();
    expect(container.querySelector('.vp-kpi')).toBeNull();
  });

  it('der Erklärtext des InfoTips ist jetzt die Sekundärzeile der Zeile', async () => {
    render(<LastspitzenSection site={SITE} />);
    await screen.findByText('8,7 kW', { selector: '.vp-c-stm-zahl' });

    const sek = document.querySelectorAll('.vp-c-led-sek');
    const texte = [...sek].map((n) => n.textContent ?? '');
    expect(texte.some((t) => t.includes('ohne Speichereinsatz'))).toBe(true);
    expect(texte.some((t) => t.includes('Leistungspreis'))).toBe(true);
  });

  it('ohne Messwerte steht „—" und der GRUND — nie eine 0', async () => {
    earnings.mockResolvedValue(
      earningsDoc(
        peakShaving({
          peakKw: null,
          avoidedKw: null,
          avoidedEur: null,
          periodStart: '2026-01-01',
          history: [],
        }),
      ),
    );
    render(<LastspitzenSection site={SITE} />);

    expect(await screen.findByText('—', { selector: '.vp-c-stm-zahl' })).toBeInTheDocument();
    expect(
      screen.getByText(/liegen noch keine Messwerte vor/, { selector: '.vp-c-stm-satz' }),
    ).toBeInTheDocument();
    // Kein erfundenes „+ 0,0 kW" daneben.
    expect(screen.queryByText('Vermiedene Spitze')).toBeNull();
  });
});

describe('P6 · Karte 2 — Bezugsspitzen im Verlauf (V6)', () => {
  it('das BILD steht vor der Legende, und die Legende ist ein Schalter', async () => {
    const { container } = render(<LastspitzenSection site={SITE} />);
    await screen.findByText('8,7 kW', { selector: '.vp-c-stm-zahl' });

    const bild = container.querySelector('.vp-c-bild');
    const legende = container.querySelector('.vp-c-bild-legende');
    expect(bild).not.toBeNull();
    expect(legende).not.toBeNull();
    // `compareDocumentPosition`: das Bild steht VOR der Legende im Baum.
    expect(bild!.compareDocumentPosition(legende!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // E7 = a · die Legende ist ein echter Schalter, kein Etikett.
    const schalter = screen.getByRole('button', { name: /Bezugsspitze ohne Speicher/ });
    expect(schalter).toHaveAttribute('aria-pressed', 'true');
  });

  it('der Insight-Satz ist der KERNSATZ über dem Bild, kein Kasten darunter', async () => {
    const { container } = render(<LastspitzenSection site={SITE} />);
    await screen.findByText('8,7 kW', { selector: '.vp-c-stm-zahl' });

    const kern = [...container.querySelectorAll('.vp-chart-kern')].map((n) => n.textContent ?? '');
    expect(kern.some((t) => t.includes('an Leistungskosten vermieden'))).toBe(true);
    expect(container.querySelector('.vp-insight')).toBeNull();
  });

  it('ohne Verlauf steht der V10-Leerzustand mit seinem Satz', async () => {
    earnings.mockResolvedValue(earningsDoc(peakShaving({ history: [] })));
    render(<LastspitzenSection site={SITE} />);
    await screen.findByText('8,7 kW', { selector: '.vp-c-stm-zahl' });

    expect(await screen.findByText(/Sobald zwei Abrechnungsperioden gemessen sind/)).toBeInTheDocument();
  });
});

describe('P6 · Karte 3 — Fahrplan & Ziel-Netzbezug (V6 + V8 + V11)', () => {
  it('Kernsatz mit Ziel, Bild zuerst, Schicht-Chips darunter, Legende im Aufklapper', async () => {
    const { container } = render(<LastspitzenSection site={SITE} />);
    await screen.findByText(/Der Speicher hält Ihren Netzbezug unter 9 kW \(rote Linie\)/);

    const bild = container.querySelector('.vp-chart.panels, .vp-chart.tall');
    const schichten = container.querySelector('.vp-c-bild-schichten');
    expect(bild).not.toBeNull();
    expect(schichten).not.toBeNull();
    expect(
      bild!.compareDocumentPosition(schichten!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // V8 · die neun Legenden-Zeilen wohnen im Aufklapper, nicht über dem Bild.
    expect(screen.getByText('Was die Linien zeigen')).toBeInTheDocument();
  });

  it('V11 · der frühere vp-insight-Kasten ist die Sekundärzeile des Kernsatzes', async () => {
    const { container } = render(<LastspitzenSection site={SITE} />);
    await screen.findByText(/Der Speicher hält Ihren Netzbezug unter 9 kW/);

    // Kein Kasten in Kategoriefarbe mehr …
    expect(container.querySelector('.vp-insight')).toBeNull();
    // … sondern die ruhige Zeile am Kernsatz.
    expect(container.querySelector('.vp-chart-kern-anker')).not.toBeNull();
  });

  it('kein Fahrplan → V10 Leer mit dem Weg, nie ein leeres Bild', async () => {
    schedule.mockResolvedValue(plan({ slots: [] }));
    render(<LastspitzenSection site={SITE} />);

    expect(
      await screen.findByText(/Sobald Börsenpreise und Prognosen vorliegen/),
    ).toBeInTheDocument();
  });

  it('E7 = a · KEIN Zoom durch Ziehen — auf diesem Reiter gibt es keinen dataZoom', async () => {
    const { container } = render(<LastspitzenSection site={SITE} />);
    await screen.findByText(/Der Speicher hält Ihren Netzbezug unter 9 kW/);
    expect(container.querySelectorAll('[class*="dataZoom"]').length).toBe(0);
  });
});

describe('P6 · die Zustände der Fläche (V10)', () => {
  it('Ladefehler steht IN der Karte, unter ihrer Überschrift', async () => {
    earnings.mockRejectedValue(new Error('kaputt'));
    const { container } = render(<LastspitzenSection site={SITE} />);

    await waitFor(() => expect(container.querySelector('.vp-c-zst-fehler')).not.toBeNull());
    expect(container.querySelector('.vp-c-card')).not.toBeNull();
  });

  it('ohne Lastspitzen-Vertrag bleibt der ehrliche „nicht aktiv"-Zustand', async () => {
    earnings.mockResolvedValue(earningsDoc(null));
    render(<LastspitzenSection site={SITE} />);

    expect(
      await screen.findByText(/Lastspitzenkappung ist für diese Anlage nicht aktiv/),
    ).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { StrompreisStrip } from './StrompreisStrip';
import { api, type PricePoint, type ScheduleSlot } from '../api';
import { PROVENIENZ } from '../historieWelten';
import { LEER_TEXT } from '../strompreis';

/**
 * Dünner Render-Beweis des Börsenpreis-Streifens (die pure Abdeckung liegt in
 * `strompreis.test.ts`): Wert + Urteil + Kopplung erscheinen, der ehrliche
 * Leerzustand erscheint, ein Fehlschlag rendert NICHTS (ein Fehler ist keine
 * Datenlage), der Geplant-Pill trägt den einen Provenienz-Satz und der
 * Marktpreise-Absprung feuert.
 */

const NOW = new Date();

function pricePoints(): PricePoint[] {
  // Ein 2-h-Fenster um jetzt; die Preise ALTERNIEREN (0,5 ↔ 14 ct), damit
  // jede Berliner-Tag-Teilmenge des Fensters die volle Spanne trägt — der
  // Test bleibt damit auch um Mitternacht herum deterministisch.
  const base = new Date(NOW.getTime() - 60 * 60 * 1000);
  const out: PricePoint[] = [];
  for (let i = 0; i < 8; i++) {
    const ts = new Date(base.getTime() + i * 15 * 60_000);
    out.push({
      ts: ts.toISOString(),
      end: new Date(ts.getTime() + 15 * 60_000).toISOString(),
      priceEurMwh: i % 2 === 0 ? 5 : 140,
    });
  }
  return out;
}

function planSlots(): ScheduleSlot[] {
  const base = new Date(NOW.getTime() - 30 * 60_000);
  return Array.from({ length: 6 }, (_, i) => ({
    start: new Date(base.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: -4,
    gridKw: null,
    socPct: null,
    priceEurMwh: 140,
    costEur: 0,
    baselineCostEur: 0,
    curtailKw: null,
    pvKw: null,
    loadKw: null,
    slotRole: 'verkaufen',
    slotFlags: null,
    storedValueCtKwh: null,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    importPriceCtKwh: 32.5,
    exportValueCtKwh: null,
    importPriceSource: null,
    coverLoadFromBattery: null,
    chargeFromSurplusOnly: null,
  }));
}

function renderStrip(over: Partial<Parameters<typeof StrompreisStrip>[0]> = {}) {
  return render(
    <StrompreisStrip
      siteId="s-1"
      isDv
      tarifArt="dynamisch"
      kind="direktvermarktung"
      slots={planSlots()}
      slotMinutes={15}
      activeSlot={planSlots()[2]}
      onOpenMarktpreise={() => {}}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('StrompreisStrip', () => {
  it('rendert Wert, Urteil, Anker, Bezugspreis und die Plan-Kopplung', async () => {
    vi.spyOn(api, 'prices').mockResolvedValue({
      biddingZone: 'DE-LU',
      resolution: 'PT15M',
      currency: 'EUR',
      points: pricePoints(),
    });
    const { getByText, container } = renderStrip();
    await waitFor(() => expect(getByText('Börsenpreis')).toBeInTheDocument());
    expect(container.textContent).toContain('ct/kWh');
    expect(container.textContent).toMatch(/gerade (teuer|günstig)|im Mittelfeld/);
    expect(container.textContent).toContain('Tagestief');
    expect(container.textContent).toContain('Ihr Bezugspreis jetzt:');
    expect(container.textContent).toContain('Ihr Fahrplan:');
    expect(getByText('Zum Spitzenpreis verkaufen')).toBeInTheDocument();
    const pill = getByText(PROVENIENZ.geplant.label);
    expect(pill).toHaveAttribute('title', PROVENIENZ.geplant.satz);
  });

  it('zeigt ohne heutige Preise den ehrlichen Leerzustand', async () => {
    vi.spyOn(api, 'prices').mockResolvedValue({
      biddingZone: 'DE-LU',
      resolution: null,
      currency: 'EUR',
      points: [],
    });
    const { getByText } = renderStrip();
    await waitFor(() => expect(getByText(LEER_TEXT)).toBeInTheDocument());
  });

  it('rendert bei einem Abruf-Fehler NICHTS — ein Fehler ist keine Datenlage', async () => {
    vi.spyOn(api, 'prices').mockRejectedValue(new Error('down'));
    const { container, queryByText } = renderStrip();
    await waitFor(() => expect(api.prices).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(queryByText('Börsenpreis')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('der Marktpreise-Absprung feuert', async () => {
    vi.spyOn(api, 'prices').mockResolvedValue({
      biddingZone: 'DE-LU',
      resolution: 'PT15M',
      currency: 'EUR',
      points: pricePoints(),
    });
    const onOpen = vi.fn();
    const { getByRole } = renderStrip({ onOpenMarktpreise: onOpen });
    await waitFor(() => expect(getByRole('button', { name: /Marktpreise/ })).toBeInTheDocument());
    fireEvent.click(getByRole('button', { name: /Marktpreise/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

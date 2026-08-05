import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { FahrplanBand, KEIN_PLAN_TEXT } from './FahrplanBand';
import type { SchedulePlan, ScheduleSlot } from '../api';
import { PROVENIENZ } from '../historieWelten';

/**
 * Die kurze Speicher-Fahrplan-Karte (PR 4, Konzept §4b): Erzählzeile aus dem
 * Film + Geplant-Abzeichen, der 24-Stunden-Ministreifen auf allen Breiten mit
 * UMRANDETEM Jetzt-Balken + Stunden-Achse, die Vorteil-Zeile, und dass der
 * volle Chart die Karte verlassen hat (D7). Die reine Abdeckung der
 * Erzählzeile liegt in `fahrplanFilm.test.ts` (`speicherKurzzeile`).
 */

const NOW = new Date(2026, 7, 5, 12, 20);

function slot(hoursFromMidnight: number, over: Partial<ScheduleSlot>): ScheduleSlot {
  const start = new Date(2026, 7, 5, 0, 0);
  return {
    start: new Date(start.getTime() + hoursFromMidnight * 3600_000).toISOString(),
    batteryKw: 0,
    gridKw: null,
    socPct: null,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    curtailKw: null,
    pvKw: null,
    loadKw: null,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: null,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    importPriceCtKwh: null,
    exportValueCtKwh: null,
    importPriceSource: null,
    coverLoadFromBattery: null,
    chargeFromSurplusOnly: null,
    ...over,
  };
}

/** 12:00–20:00 in Viertelstunden: laden bis 14 Uhr, Ruhe, ab 18 Uhr verkaufen. */
function plan(): SchedulePlan {
  const slots: ScheduleSlot[] = [];
  for (let q = 0; q < 32; q++) {
    const h = 12 + q / 4;
    slots.push(
      slot(h, {
        slotRole: h < 14 ? 'pv_speichern' : h < 18 ? 'warten' : 'verkaufen',
        batteryKw: h < 14 ? 4 : h < 18 ? 0 : -4,
        costEur: 0,
        baselineCostEur: 0.05,
      }),
    );
  }
  return {
    planId: 'p1',
    deviceId: null,
    generatedAt: NOW.toISOString(),
    slotMinutes: 15,
    savingsEur: null,
    bankedValueEur: null,
    socStartPct: null,
    socEndPct: null,
    peakTargetKw: null,
    slots,
  };
}

function renderBand(over: Partial<Parameters<typeof FahrplanBand>[0]> = {}) {
  return render(
    <FahrplanBand
      plan={plan()}
      plantKind="direktvermarktung"
      now={NOW}
      loading={false}
      failed={false}
      onOpen={() => {}}
      {...over}
    />,
  );
}

describe('FahrplanBand — die kurze Speicher-Fahrplan-Karte', () => {
  it('erzählt den Tag mit der Film-Kurzfassung und dem Geplant-Abzeichen', () => {
    const { container, getByText } = renderBand();
    expect(container.textContent).toContain('Speicher-Fahrplan');
    // Die Erzählzeile ist die Film-Kurzfassung wörtlich (12:20 läuft laden).
    expect(container.textContent).toMatch(
      /Jetzt Sonne speichern bis \d{2}:\d{2} Uhr · danach Ruhe · dann Zum Spitzenpreis verkaufen\./,
    );
    const pill = getByText(PROVENIENZ.geplant.label);
    expect(pill).toHaveAttribute('title', PROVENIENZ.geplant.satz);
    // Geld: der geplante Vorteil (32 Slots × 0,05 € Baseline-Delta = 1,60 €).
    expect(container.textContent).toContain('Geplanter Vorteil heute:');
    expect(container.textContent).toContain('+1,60');
  });

  it('zeigt den Ministreifen auf allen Breiten — Jetzt-Balken umrandet, Stunden-Achse', () => {
    const { container } = renderBand();
    const bars = container.querySelectorAll('.vp-plan-mini i');
    expect(bars).toHaveLength(24);
    // Genau der Balken der laufenden Stunde (12) trägt die Umrandung.
    const now = container.querySelectorAll('.vp-plan-mini i.now');
    expect(now).toHaveLength(1);
    expect([...bars].indexOf(now[0])).toBe(12);
    // Die Achse macht den Streifen ohne Legende lesbar.
    expect(container.querySelector('.vp-fpk-hours')?.textContent).toBe('061218' + '24');
  });

  it('D7: der volle Chart hat die Karte verlassen — kein Chart-Container mehr', () => {
    const { container } = renderBand();
    expect(container.querySelector('.vp-chart')).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('kein Plan: die ruhige Leere, wortgleich mit der Fahrplan-Seite', () => {
    const { container } = renderBand({ plan: null });
    expect(container.textContent).toContain(KEIN_PLAN_TEXT);
    expect(container.querySelector('.vp-plan-mini')).toBeNull();
  });

  it('lädt → Skeleton · Fehler → Hinweis (Zustände unverändert)', () => {
    const a = renderBand({ plan: null, loading: true });
    expect(a.container.querySelector('.vp-skeleton')).not.toBeNull();
    a.unmount();
    const b = renderBand({ plan: null, failed: true });
    expect(b.container.textContent).toContain('konnte gerade nicht geladen werden');
  });

  it('„Fahrplan ›" öffnet die Fahrplan-Seite', () => {
    const onOpen = vi.fn();
    const { getByRole } = renderBand({ onOpen });
    fireEvent.click(getByRole('button', { name: /Fahrplan/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

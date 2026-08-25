import { describe, expect, it } from 'vitest';
import type { ControlStatus, OverviewSite, SchedulePlan, ScheduleSlot } from './api';
import { VORSCHAU_ABSPRUNG, vorschauZeilen } from './portfolioVorschau';

/**
 * Die Vorschau-Zeile der Anlagen-Tabelle (Portfolio Revision 2, §5.2 / E1).
 *
 * Der Kern dieser Datei ist, dass sie KEINE eigene Aussage erfindet: jede
 * Zeile ist eine Komposition bestehender, anderswo geprüfter Ableitungen. Die
 * Tests prüfen deshalb die KOMPOSITION und die Auslassungen — nicht die
 * Formulierungen, die ihren eigenen Wächter schon haben.
 */

const JETZT = new Date('2026-08-24T12:07:00Z');

function anlage(over: Partial<OverviewSite> = {}): OverviewSite {
  return {
    id: 'a',
    name: 'Filiale Nord',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: JETZT.toISOString(),
    live: null,
    plannedSavingsTodayEur: null,
    ...over,
  } as OverviewSite;
}

/** Ein Tag mit Mittags-Ladung, Abend-Entladung und einem billigen Mittag. */
function slots(): ScheduleSlot[] {
  const tagStart = new Date('2026-08-24T00:00:00Z');
  return Array.from({ length: 96 }, (_, i) => {
    const start = new Date(tagStart.getTime() + i * 15 * 60 * 1000);
    const stunde = start.getUTCHours();
    const laedt = stunde >= 10 && stunde < 15;
    const entlaedt = stunde >= 17 && stunde < 21;
    return {
      start: start.toISOString(),
      batteryKw: laedt ? 8 : entlaedt ? -6 : 0,
      gridKw: laedt ? 4 : entlaedt ? -3 : 1,
      socPct: 50,
      priceEurMwh: laedt ? 12 : entlaedt ? 240 : 90,
      costEur: null,
      baselineCostEur: null,
      curtailKw: null,
      pvKw: laedt ? 20 : 0,
      loadKw: 4,
    } as ScheduleSlot;
  });
}

function plan(over: Partial<SchedulePlan> = {}): SchedulePlan {
  return {
    generatedAt: JETZT.toISOString(),
    deviceId: 'dev-1',
    slots: slots(),
    savingsEur: 1.5,
    ...over,
  } as SchedulePlan;
}

function control(over: Partial<ControlStatus> = {}): ControlStatus {
  return {
    deviceId: 'dev-1',
    commandedKw: 8,
    confirmedKw: 8,
    allMatch: true,
    controlEnabled: true,
    certified: true,
    mismatchRoles: null,
    slotStart: null,
    checkedAt: JETZT.toISOString(),
    ...over,
  } as ControlStatus;
}

function zeilen(over: {
  site?: OverviewSite;
  plan?: SchedulePlan | null;
  control?: ControlStatus | null;
} = {}) {
  return vorschauZeilen({
    site: over.site ?? anlage(),
    plan: over.plan === undefined ? plan() : over.plan,
    control: over.control === undefined ? control() : over.control,
    plantKind: 'eigenverbrauch',
    now: JETZT,
  });
}

describe('vorschauZeilen — vier Antworten, in Lese-Reihenfolge', () => {
  it('nennt Plan, Preis, Steuerung und Zustand', () => {
    expect(zeilen().map((z) => z.key)).toEqual(['plan', 'preis', 'steuerung', 'zustand']);
  });

  it('reicht den Plan-Satz des Hauses DURCH, statt ihn neu zu formulieren', () => {
    // Es gibt genau EINE Plan-Ableitung (`schedule.planSentence`); ein
    // zweiter Satz über denselben Plan wären zwei Wahrheiten.
    const plan = zeilen().find((z) => z.key === 'plan')!;
    expect(plan.text).toContain('laden');
    expect(plan.tag).toBe('Geplant');
  });

  it('markiert den Plan als GEPLANT - er ist keine Messung', () => {
    expect(zeilen().find((z) => z.key === 'plan')!.tag).toBe('Geplant');
  });

  it('sagt ohne Fahrplan, dass keiner vorliegt - statt zu schweigen', () => {
    const plan = zeilen({ plan: null }).find((z) => z.key === 'plan')!;
    expect(plan.text).toBe('Für heute liegt noch kein Fahrplan vor.');
    expect(plan.tag).toBeNull();
  });

  it('lässt die PREIS-Zeile GANZ weg, wenn kein Preis vorliegt', () => {
    // „—" wäre hier eine Zeile ohne Aussage; die Frage stellt sich dann nicht.
    const ohnePreis = plan({
      slots: slots().map((s) => ({ ...s, priceEurMwh: null })),
    });
    expect(zeilen({ plan: ohnePreis }).map((z) => z.key)).not.toContain('preis');
  });

  it('nennt den Preis in ct/kWh - der Einheit auf der Rechnung', () => {
    const preis = zeilen().find((z) => z.key === 'preis')!;
    expect(preis.text).toContain('ct/kWh');
    expect(preis.text).not.toContain('MWh');
  });

  it('unterscheidet „wird vorbereitet" von „meldet gar nichts"', () => {
    // Der Betreiber muss wissen, ob er nichts SIEHT oder ob nichts PASSIERT.
    // Mit einem Plan UND einem Gerät ist das Rücklesen unterwegs - das ist der
    // Haus-Satz aus `control.controlStrip`, nicht eine zweite Formulierung.
    const wartet = zeilen({ control: null }).find((z) => z.key === 'steuerung')!;
    expect(wartet.text).toContain('wird vorbereitet');
    // Ohne Plan und ohne Rücklesen gibt es nichts zu erwarten - und die Zeile
    // sagt genau das, statt zu schweigen.
    const nichts = zeilen({ plan: null, control: null }).find((z) => z.key === 'steuerung')!;
    expect(nichts.text).toContain('meldet keinen Sollwert');
  });

  it('trägt den Steuerungs-Satz des Hauses, inklusive seines Tons', () => {
    const st = zeilen({
      control: control({ allMatch: false, confirmedKw: 0, mismatchRoles: 'battery_power' }),
    }).find((z) => z.key === 'steuerung')!;
    expect(st.ton).toBe('warn');
  });

  it('fasst den Zustand zusammen - und sagt bei Ordnung, dass Ordnung ist', () => {
    const z = zeilen().find((v) => v.key === 'zustand')!;
    expect(z.text).toBe('Gerät und Fahrplan: in Ordnung.');
    expect(z.ton).toBeUndefined();
  });

  it('NENNT einen Befund, statt ihn zu verschweigen', () => {
    const z = zeilen({
      site: anlage({ onlineCount: 0, worstStatus: 'stale' }),
    }).find((v) => v.key === 'zustand')!;
    expect(z.ton).toBe('warn');
    expect(z.text).toContain('Gerät');
  });

  it('der Absprung heisst überall gleich', () => {
    expect(VORSCHAU_ABSPRUNG).toBe('Cockpit öffnen');
  });
});

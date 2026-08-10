import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// jsdom has no ResizeObserver (some design-system pieces measure themselves).
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
import { FahrplanWhyPanel, roleColor, roleDotStyle, roleMark } from './FahrplanWhy';
import { chartTheme } from '../chartTheme';
import { phases, type WhySlot } from '../fahrplanWhy';

/** A small why-carrying plan: 8 warten · 8 pv_speichern · 8 eigenverbrauch. */
function mkSlots(): WhySlot[] {
  const roles = [
    ...Array.from({ length: 8 }, () => 'warten'),
    ...Array.from({ length: 8 }, () => 'pv_speichern'),
    ...Array.from({ length: 8 }, () => 'eigenverbrauch'),
  ];
  const base = new Date(2026, 6, 23, 10, 0).getTime();
  return roles.map((role, i) => ({
    start: new Date(base + i * 15 * 60_000).toISOString(),
    batteryKw: role === 'pv_speichern' ? 3 : role === 'eigenverbrauch' ? -3 : 0,
    priceEurMwh: 250,
    costEur: 0.1,
    baselineCostEur: 0.3,
    socPct: 60,
    pvKw: 4,
    slotRole: role,
    slotFlags: role === 'pv_speichern' ? ['solar_only'] : null,
    storedValueCtKwh: 28.3,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
  }));
}

describe('roleMark (the ONE colour language, Konzept §6.6 + K5)', () => {
  const t = chartTheme();

  it('gibt jeder Abgabe-Rolle die SPEICHER-Farbe als Umriss, nie Rot', () => {
    for (const role of ['eigenverbrauch', 'verkaufen', 'spitze_kappen'] as const) {
      // K5: EINE Farbe für den Speicher - die Richtung trägt die FORM.
      expect(roleMark(role, t)).toEqual({ color: t.charge, form: 'outline' });
      // Red is reserved for costs/warnings - a discharge must never wear it.
      expect(roleColor(role, t)).not.toBe(t.discharge);
    }
  });

  it('macht aus der Umriss-Form einen HOHLEN Punkt, aus gefüllt einen vollen', () => {
    const laden = roleDotStyle(roleMark('pv_speichern', t));
    const abgeben = roleDotStyle(roleMark('eigenverbrauch', t));
    expect(laden.background).toBe(t.charge);
    expect(laden.boxShadow).toBeUndefined();
    expect(abgeben.background).toBe('transparent');
    expect(abgeben.boxShadow).toContain(t.charge);
  });

  it('keeps the remaining roles on their shipped hues', () => {
    expect(roleColor('pv_speichern', t)).toBe(t.charge);
    expect(roleColor('guenstig_laden', t)).toBe(t.gridCharge);
    expect(roleColor('abregeln', t)).toBe(t.pv);
    // Idle roles are the neutral grey, not a chart hue.
    expect(roleColor('warten', t)).not.toBe(t.discharge);
    expect(roleColor('reserve_halten', t)).toBe(roleColor('warten', t));
  });
});

describe('FahrplanWhyPanel', () => {
  it('renders the phase card for a selected phase (range, why, phase-€)', () => {
    const slots = mkSlots();
    const ph = phases(slots);
    render(
      <FahrplanWhyPanel
        phases={ph}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={2}
        selectedSlot={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Verbrauch aus dem Speicher decken')).toBeInTheDocument();
    expect(screen.getByText(/deckt den Verbrauch und vermeidet teuren Netzbezug/)).toBeInTheDocument();
    // 8 slots × (0.3 − 0.1) = +1,60 €
    expect(screen.getByText(/\+1,60/)).toBeInTheDocument();
    expect(screen.getByText(/8 Viertelstunden/)).toBeInTheDocument();
  });

  it('renders the slot panel for a tapped slot (why, context, chips, phase line)', () => {
    const slots = mkSlots();
    const ph = phases(slots);
    render(
      <FahrplanWhyPanel
        phases={ph}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={null}
        selectedSlot={10}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('PV-Überschuss speichern')).toBeInTheDocument();
    expect(screen.getByText(/gespeicherte Energie ist später/)).toBeInTheDocument();
    expect(screen.getByText('Wert gespeicherter Energie')).toBeInTheDocument();
    expect(screen.getByText('Nur Solarladen (EEG)')).toBeInTheDocument();
    expect(screen.getByText(/Teil der Phase/)).toBeInTheDocument();
  });

  it('close button fires onClose', () => {
    const slots = mkSlots();
    const ph = phases(slots);
    const onClose = vi.fn();
    render(
      <FahrplanWhyPanel
        phases={ph}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={0}
        selectedSlot={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing without a selection', () => {
    const slots = mkSlots();
    const { container } = render(
      <FahrplanWhyPanel
        phases={phases(slots)}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={null}
        selectedSlot={null}
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

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

/**
 * ERKLÄRBARKEIT STUFE 3 („Grenzen als Gründe"): der Block „Grenzen am
 * Netzanschluss" am Warum-Ort - Ursache MIT Urheber, die fremde Wahrheit im
 * Gerät und der Querverweis auf die Befehle-Seite.
 */
describe('Grenzen am Netzanschluss (Erklärbarkeit Stufe 3)', () => {
  /** Ein Plan, dessen mittlere Phase an der Einspeisegrenze abregelt. */
  function grenzSlots(): WhySlot[] {
    const slots = mkSlots();
    for (let i = 8; i < 16; i++) {
      slots[i] = {
        ...slots[i],
        slotRole: 'abregeln',
        batteryKw: 0,
        curtailKw: 12,
        slotFlags: ['feed_in_cap', 'curtailing'],
      };
    }
    return slots;
  }

  const herzogau = {
    deviceId: 'd1',
    units: 2,
    certifiedUnits: 2,
    controlEnabled: true,
    active: false,
    appliedCapKw: null,
    allMatch: null,
    possibleOverride: false,
    checkedAt: '2026-08-18T10:00:00Z',
    exportGuard: {
      limitKw: 70,
      state: 'ueberwacht' as const,
      reason: null,
      capKw: null,
      limiting: false,
      blind: false,
      effective: true,
      reach: null,
    },
    deviceExportLimit: { limitKw: 33, register: '0x00e7', readAt: '2026-08-18T04:00:00Z' },
  };

  const panel = (extra: Record<string, unknown>) => {
    const slots = grenzSlots();
    return render(
      <FahrplanWhyPanel
        phases={phases(slots)}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={null}
        selectedSlot={10}
        onClose={() => {}}
        {...extra}
      />,
    );
  };

  it('nennt die Grenze als GRUND und daneben die fremde Wahrheit im Gerät', () => {
    panel({ grenzen: { maxFeedInKw: 70, curtailment: herzogau }, siteId: 's1' });
    // Die Ursache steht im Warum-Satz - MIT der gepflegten Zahl.
    expect(screen.getByText(/höchstens 70,0 kW einspeisen/)).toBeInTheDocument();
    // … und GENAU EINMAL: der Block wiederholt den Leitgrund nicht.
    expect(screen.queryAllByText(/höchstens 70,0/)).toHaveLength(1);
    expect(screen.getByText('Grenzen am Netzanschluss')).toBeInTheDocument();
    // Der Herzogau-Satz, wörtlich aus `curtailment.deviceLimitLine`.
    expect(screen.getByText('Ihr Gerät')).toBeInTheDocument();
    expect(screen.getByText(/begrenzt die Einspeisung am Netzpunkt auf 33,0/)).toBeInTheDocument();
  });

  it('nennt die Grenze MIT Urheber, wo der Satz sie nicht trägt', () => {
    // Ein VERKAUFENDER Slot am Einspeise-Cap: seine Rolle erklärt die Grenze
    // nicht, also ist der Block die einzige Erklärung - rollen-unabhängig.
    const slots = mkSlots();
    slots[20] = { ...slots[20], slotRole: 'verkaufen', slotFlags: ['feed_in_cap'] };
    render(
      <FahrplanWhyPanel
        phases={phases(slots)}
        slots={slots}
        plantKind="direktvermarktung"
        slotMinutes={15}
        selectedPhase={null}
        selectedSlot={20}
        grenzen={{ maxFeedInKw: 70 }}
        siteId="s1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Ihre Anmeldung')).toBeInTheDocument();
    expect(screen.getByText(/höchstens 70,0/)).toBeInTheDocument();
  });

  it('nennt die Phase in der Fuß-Zeile mit DERSELBEN Ursache wie die Überschrift', () => {
    // Im Browser aufgefallen: „Teil der Phase «Einspeisung pausieren
    // (Negativpreis)»" stand unter der Überschrift „(Einspeisegrenze)".
    panel({ grenzen: { maxFeedInKw: 70, curtailment: herzogau }, siteId: 's1' });
    expect(screen.queryByText(/\(Negativpreis\)/)).toBeNull();
    expect(screen.getAllByText(/Einspeisung pausieren \(Einspeisegrenze\)/).length).toBe(2);
  });

  it('verweist auf die Befehle-Seite dieser Anlage', () => {
    panel({ grenzen: { maxFeedInKw: 70, curtailment: herzogau }, siteId: 's1' });
    const link = screen.getByRole('link', { name: /Befehle ansehen/ });
    expect(link).toHaveAttribute('href', '#/anlage/s1/befehle');
  });

  it('zeigt ohne Anlage keinen Link (nie ein Verweis ins Leere)', () => {
    panel({ grenzen: { maxFeedInKw: 70, curtailment: herzogau } });
    expect(screen.getByText('Grenzen am Netzanschluss')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Befehle ansehen/ })).toBeNull();
  });

  it('rendert auf einem älteren Lauf OHNE Flags zeichengleich wie vor Stufe 3', () => {
    const slots = grenzSlots().map((s) =>
      s.slotRole === 'abregeln' ? { ...s, slotFlags: null } : s,
    );
    render(
      <FahrplanWhyPanel
        phases={phases(slots)}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={null}
        selectedSlot={10}
        grenzen={{ maxFeedInKw: 70, curtailment: herzogau }}
        siteId="s1"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('Grenzen am Netzanschluss')).toBeNull();
    // Der Satz bleibt dann beobachtend - er behauptet keine der drei Ursachen.
    expect(
      screen.getByText('Der Plan sieht vor, die Einspeisung in dieser Viertelstunde zu drosseln.'),
    ).toBeInTheDocument();
  });

  it('trägt den Block auch an der PHASE - dieselbe Grenze, derselbe Wortlaut', () => {
    const slots = grenzSlots();
    render(
      <FahrplanWhyPanel
        phases={phases(slots)}
        slots={slots}
        plantKind="eigenverbrauch"
        slotMinutes={15}
        selectedPhase={1}
        selectedSlot={null}
        grenzen={{ maxFeedInKw: 70, curtailment: herzogau }}
        siteId="s1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Grenzen am Netzanschluss')).toBeInTheDocument();
    expect(screen.getByText(/höchstens 70,0/)).toBeInTheDocument();
    expect(screen.getByText(/begrenzt die Einspeisung am Netzpunkt auf 33,0/)).toBeInTheDocument();
    // Und der Rollen-Titel folgt der belegten Ursache, statt „(Negativpreis)"
    // über einem Satz zu behaupten, der die Einspeisegrenze nennt.
    expect(screen.getByText(/Einspeisung pausieren \(Einspeisegrenze\)/)).toBeInTheDocument();
  });
});

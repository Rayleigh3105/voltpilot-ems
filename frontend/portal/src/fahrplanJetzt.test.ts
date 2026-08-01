import { describe, expect, it } from 'vitest';
import { actionPhrase, jetztHeld, measurementChips, type JetztInput } from './fahrplanJetzt';
import type { ControlStatus } from './api';
import type { LiveSnapshot } from './live';
import type { WhySlot } from './fahrplanWhy';

/**
 * Der JETZT-Held ist die Antwort auf den Captain-Auftrag „genau das
 * darstellen, was wirklich gerade gemacht wird" — also müssen genau die drei
 * Wahrheiten (Plan · Ausführung · Messung) getrennt und ehrlich herauskommen.
 * Die beiden Regeln, die hier am meisten wert sind:
 *
 *  - eine BEWUSSTE Nachführung ist NIE ein Fehler (grün, „wie vorgesehen"),
 *  - ein ECHTER Bruch wird NIE beschönigt (bernstein, beide Zahlen),
 *
 * dazu die „—"-Disziplin: ohne Rücklesen keine Zahl, ohne aufgezeichneten
 * Grund kein Warum-Satz, und über einem toten Plan nie „läuft wie vorgesehen".
 */

const NOW = new Date('2026-08-01T19:20:00Z');
const NBSP = ' ';

function slot(over: Partial<WhySlot> = {}): WhySlot {
  return {
    start: '2026-08-01T19:15:00Z',
    batteryKw: -4.3,
    socPct: 78,
    priceEurMwh: 212,
    costEur: 0.1,
    baselineCostEur: 0.4,
    slotRole: 'eigenverbrauch',
    slotFlags: null,
    storedValueCtKwh: 21.5,
    importPriceCtKwh: 32.5,
    importPriceSource: 'preisblatt',
    ...over,
  };
}

function status(over: Partial<ControlStatus> = {}): ControlStatus {
  return {
    deviceId: 'd1',
    commandedKw: -6.1,
    confirmedKw: -6.1,
    allMatch: true,
    controlEnabled: true,
    certified: true,
    mismatchRoles: null,
    slotStart: null,
    checkedAt: new Date(NOW.getTime() - 8000).toISOString(),
    ...over,
  };
}

function snap(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return { pvKw: 1, loadKw: 7.1, gridKw: 0, battKw: -6.1, socPct: 78, socAt: null, ...over };
}

function input(over: Partial<JetztInput> = {}): JetztInput {
  return {
    slot: slot(),
    control: status(),
    expectControl: true,
    snapshot: snap(),
    snapshotFresh: true,
    planStale: false,
    plantKind: 'eigenverbrauch',
    now: NOW,
    ...over,
  };
}

describe('jetztHeld · die drei Wahrheiten im Jetzt', () => {
  it('nennt Ausführung, Plan und Messung nebeneinander - und die Nachführung ist GRÜN', () => {
    const v = jetztHeld(input());
    expect(v.state).toBe('angepasst');
    expect(v.tone).toBe('ok');
    // F5 steht wörtlich da.
    expect(v.status).toContain('nichts zu tun');
    // Die Aussage kommt aus der AUSFÜHRUNG, nicht aus dem Plan.
    expect(v.lead).toBe('Ihre Batterie deckt gerade den Verbrauch');
    expect(v.value).toBe(`6,1${NBSP}kW`);
    expect(v.valueNote).toBe('aus dem Speicher');
    // ...und der Plan-Wert bleibt SICHTBAR (nichts wird versteckt).
    expect(v.adjust).toContain(`4,3${NBSP}kW`);
    expect(v.adjust).toContain('angepasst');
    // Ohne die Ausführungs-Daten aus dem Heartbeat: KEINE Richtungs-Behauptung.
    expect(v.adjust).not.toMatch(/angehoben|begrenzt/);
    expect(v.confirm).toContain('bestätigt');
    // Die Messung, die die Nachführung begründet.
    expect(v.chips).toEqual([
      { label: 'Speicher', value: `78${NBSP}%` },
      { label: 'Haus', value: `7,1${NBSP}kW` },
      { label: 'Netz', value: `0,0${NBSP}kW` },
    ]);
    expect(v.badge).toBe('Gemessen');
  });

  it('gibt den Warum-Satz des laufenden Slots wörtlich weiter (P0-Preiswahrheit)', () => {
    const v = jetztHeld(input());
    expect(v.why).toContain('32,5 ct/kWh');
    expect(v.why).toContain('Börsenpreis 21,2 + Netzentgelte/Abgaben 11,3');
  });

  it('ist planmäßig, wenn Ausführung und Plan übereinstimmen', () => {
    const v = jetztHeld(input({ control: status({ commandedKw: -4.3, confirmedKw: -4.3 }) }));
    expect(v.state).toBe('planmaessig');
    expect(v.tone).toBe('ok');
    expect(v.adjust).toBeNull();
  });

  it('beschönigt einen ECHTEN Bruch nie und nennt beide Zahlen', () => {
    const v = jetztHeld(
      input({ control: status({ allMatch: false, confirmedKw: -2.0 }) }),
    );
    expect(v.state).toBe('abweichung');
    expect(v.tone).toBe('warn');
    expect(v.status).toContain(`2,0${NBSP}kW`);
    expect(v.status).toContain(`6,1${NBSP}kW`);
    expect(v.status).not.toContain('nichts zu tun');
    expect(v.confirm).toBeNull();
  });

  it('sagt bei geplanter Ruhe, wann es weitergeht', () => {
    const v = jetztHeld(
      input({
        slot: slot({ slotRole: 'warten', batteryKw: 0 }),
        control: status({ commandedKw: 0, confirmedKw: 0 }),
        nextPhase: { label: 'Verbrauch decken', at: '2026-08-01T21:30:00Z' },
      }),
    );
    expect(v.state).toBe('ruhe');
    expect(v.tone).toBe('ok');
    expect(v.lead).toBe('Ihre Batterie ruht gerade');
    expect(v.next).toContain('Verbrauch decken');
  });

  it('sagt NIE „läuft wie vorgesehen" über einem toten Plan', () => {
    const v = jetztHeld(input({ planStale: true }));
    expect(v.state).toBe('veraltet');
    expect(v.tone).toBe('warn');
    expect(v.status).not.toContain('nichts zu tun');
    expect(v.lead).toContain('eigenständig');
    // Ein toter Plan erklärt über das Jetzt nichts mehr.
    expect(v.why).toBeNull();
    expect(v.value).toBeNull();
    expect(v.valueMissing).not.toBeNull();
  });
});

describe('jetztHeld · die „—"-Disziplin', () => {
  it('erfindet ohne Rücklesen keinen Ausführungs-Wert, sondern nennt den Grund', () => {
    const v = jetztHeld(input({ control: null }));
    expect(v.state).toBe('wird_vorbereitet');
    expect(v.value).toBeNull();
    expect(v.valueMissing).toContain('Rückmeldung');
    // Der Plan wird dann als PLAN benannt, nie als Tatsache.
    expect(v.lead).toContain('Geplant ist gerade');
  });

  it('behauptet ohne Steuerung keine Handlung und keinen Grund', () => {
    for (const control of [
      status({ controlEnabled: false }),
      status({ certified: false }),
    ]) {
      const v = jetztHeld(input({ control }));
      expect(v.lead).toBe('VoltPilot steuert Ihre Batterie gerade nicht');
      expect(v.value).toBeNull();
      expect(v.why).toBeNull();
      expect(v.tone).toBe('off');
    }
  });

  it('nennt einen Plan ohne Steuerungs-Zustand ehrlich „nur Plan"', () => {
    const v = jetztHeld(input({ control: null, expectControl: false }));
    expect(v.state).toBe('nur_plan');
    expect(v.value).toBeNull();
    // ...der aufgezeichnete Grund gilt trotzdem - er erklärt den Plan.
    expect(v.why).not.toBeNull();
    expect(v.badge).toBe('Gemessen'); // die Telemetrie-Chips tragen die Karte
  });

  it('trägt ohne jede Messung das Abzeichen „Geplant"', () => {
    const v = jetztHeld(input({ control: null, expectControl: false, snapshotFresh: false }));
    expect(v.chips).toEqual([]);
    expect(v.badge).toBe('Geplant');
    expect(v.badgeNote).toBeNull();
  });

  it('behauptet ohne aufgezeichnete Rolle keinen Grund', () => {
    const v = jetztHeld(input({ slot: slot({ slotRole: null }) }));
    expect(v.why).toBeNull();
  });

  it('lässt eine veraltete Bestätigung nicht als Jetzt-Wert durchgehen', () => {
    const alt = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    const v = jetztHeld(input({ control: status({ checkedAt: alt }) }));
    expect(v.state).toBe('unbestaetigt');
    expect(v.value).toBeNull();
    expect(v.confirm).toBeNull();
  });
});

describe('actionPhrase · die Ausführung schlägt eine widersprechende Rolle', () => {
  it('benennt die Rolle, solange sie zur ausgeführten Richtung passt', () => {
    expect(actionPhrase('pv_speichern', 3.2, 'eigenverbrauch')).toBe(
      'speichert gerade Solarstrom',
    );
    expect(actionPhrase('verkaufen', -5, 'direktvermarktung')).toBe(
      'verkauft gerade zum Spitzenpreis',
    );
    expect(actionPhrase('verkaufen', -5, 'eigenverbrauch')).toBe('speist gerade ein');
  });

  it('fällt auf die gemessene Richtung zurück, wenn die Rolle ihr widerspricht', () => {
    // Der Plan wollte laden, das Gerät entlädt - was PASSIERT, gewinnt.
    expect(actionPhrase('pv_speichern', -4, 'eigenverbrauch')).toBe('entlädt gerade');
    expect(actionPhrase('eigenverbrauch', 4, 'eigenverbrauch')).toBe('lädt gerade');
  });

  it('behauptet ohne Rolle und ohne Zahl keine Handlung außer Ruhe', () => {
    expect(actionPhrase(null, null, 'eigenverbrauch')).toBe('ruht gerade');
  });
});

describe('measurementChips · Vorzeichen als Wort, nie eine erfundene 0', () => {
  it('benennt Bezug und Einspeisung, statt ein Minus zu zeigen', () => {
    expect(measurementChips(snap({ gridKw: 3.2 }))[2]).toEqual({
      label: 'Netzbezug',
      value: `3,2${NBSP}kW`,
    });
    expect(measurementChips(snap({ gridKw: -3.2 }))[2]).toEqual({
      label: 'Einspeisung',
      value: `3,2${NBSP}kW`,
    });
  });

  it('lässt einen fehlenden Messwert weg statt ihn als 0 zu zeigen', () => {
    const chips = measurementChips(snap({ socPct: null, loadKw: null }));
    expect(chips.map((c) => c.label)).toEqual(['Netz']);
    expect(measurementChips(null)).toEqual([]);
  });
});

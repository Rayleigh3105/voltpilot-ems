import { describe, expect, it } from 'vitest';
import {
  actionPhrase,
  einspeiseRuhe,
  jetztHeld,
  measurementChips,
  type JetztInput,
} from './fahrplanJetzt';
import type { ControlStatus, CurtailmentStatus } from './api';
import { curtailTruth } from './curtailment';
import { FLOW_CONFLICT_MIN_STREAK } from './flowConflict';
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

describe('jetztHeld · unerwarteter Verbrauch in geplanter Ruhe', () => {
  const idle = (over: Partial<WhySlot> = {}) => slot({
    batteryKw: 0,
    slotRole: 'warten',
    unplannedLoadDischarge: true,
    ...over,
  });

  it('nennt live-Follower, Wirtschaftsdaten, Reserve, Frische und Rücklesen', () => {
    const v = jetztHeld(input({
      slot: idle(),
      slots: [idle()],
      planFacts: { generatedAt: '2026-08-01T19:15:00Z', effectiveFloorSocPct: 35 },
      snapshot: snap({ pvKw: 22.1, loadKw: 36.8, gridKw: 0, battKw: -14.7, socPct: 95 }),
      control: status({
        commandedKw: -14.7,
        confirmedKw: -14.7,
        executionMode: 'idle_follow',
        executionPlannedKw: 0,
        executionTargetKw: 14.7,
        executionFloorSocPct: 35,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.tone).toBe('warn');
    expect(v.status).toBe('Unerwarteter Verbrauch · Speicher deckt live bis 35 % Reserve');
    expect(v.chips).toEqual(expect.arrayContaining([
      { label: 'Netzbezug', value: `32,5${NBSP}ct/kWh` },
      { label: 'Speicherwert', value: `21,5${NBSP}ct/kWh` },
      { label: 'Reserveboden', value: `35${NBSP}%` },
      { label: 'Ausführung', value: '10-Sekunden-Nachführung' },
      { label: 'Messung', value: 'frisch' },
      { label: 'Rücklesen', value: 'bestätigt' },
    ]));
    expect(v.next).toBe('Neuplanung bei anhaltender Abweichung automatisch, sonst spätestens 21:30');
  });

  it('erklärt einen wirtschaftlich wertvolleren späteren Einsatz ausdrücklich', () => {
    const v = jetztHeld(input({
      slot: idle({ unplannedLoadDischarge: false }),
      snapshot: snap({ pvKw: 22.1, loadKw: 36.8, gridKw: 14.7, battKw: 0, socPct: 95 }),
      control: status({ commandedKw: 0, confirmedKw: 0, executionMode: 'plan' }),
    }));
    expect(v.status).toBe('Speicher hält zurück, weil Energie später mehr wert ist');
    expect(v.tone).toBe('warn');
  });

  it('zeigt beim 94%-Fall die Vollakku-Entlastung samt enger 90%-Grenze', () => {
    const v = jetztHeld(input({
      slot: idle({ unplannedLoadDischarge: false }),
      snapshot: snap({ pvKw: .9, loadKw: 5, gridKw: 0, battKw: -4.1, socPct: 94 }),
      control: status({
        commandedKw: -4.1,
        confirmedKw: -4.1,
        executionMode: 'high_soc_follow',
        executionPlannedKw: 0,
        executionTargetKw: 4.1,
        executionFloorSocPct: 90,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.state).toBe('angepasst');
    expect(v.status).toBe('Fast voller Speicher · deckt Verbrauch live bis 90 %');
    expect(v.adjust).toContain('nahezu voll');
    expect(v.chips).toEqual(expect.arrayContaining([
      { label: 'Reserveboden', value: `90${NBSP}%` },
      { label: 'Ausführung', value: 'Vollakku-Entlastung' },
    ]));
  });

  it('zeigt beim 91%-Überschussfall die obere PV-Puffer-Nachladung als Ausführung', () => {
    const v = jetztHeld(input({
      slot: idle({ batteryKw: -4.3, slotRole: 'eigenverbrauch', coverLoadFromBattery: true }),
      snapshot: snap({ pvKw: 11.4, loadKw: 2.9, gridKw: 0, battKw: 8.5, socPct: 91 }),
      control: status({
        commandedKw: 8.5,
        confirmedKw: 8.5,
        executionMode: 'high_soc_charge',
        executionPlannedKw: -4.3,
        executionTargetKw: 8.5,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.state).toBe('angepasst');
    expect(v.lead).toContain('lädt gerade');
    expect(v.adjust).toContain('oberen PV-Puffer');
    expect(v.adjust).toContain('statt in diesem Verbrauchs-Slot einzuspeisen');
  });

  it('nennt Reserve oder Gerätezustand bei bindender Grenze und bei verlorener Frische', () => {
    const reserve = jetztHeld(input({
      slot: idle({ slotFlags: ['reserve_backup'] }),
      planFacts: { effectiveFloorSocPct: 35 },
      snapshot: snap({ gridKw: 14.7, battKw: 0, socPct: 35 }),
      control: status({ commandedKw: 0, confirmedKw: 0, executionMode: 'plan' }),
    }));
    expect(reserve.status).toBe('Entladung durch Reserve/Gerätezustand begrenzt');

    const staleReadback = jetztHeld(input({
      slot: idle(),
      snapshot: snap({ gridKw: 14.7, battKw: 0 }),
      control: status({ executionMode: 'idle_follow', executionMeasurementsFresh: false, allMatch: false }),
    }));
    expect(staleReadback.status).toBe('Entladung durch Reserve/Gerätezustand begrenzt');
  });

  it('meldet Screenshot B bei PV-Überschuss neutral und nie als Live-Deckung', () => {
    const v = jetztHeld(input({
      slot: idle(),
      snapshot: snap({ pvKw: 22.6, loadKw: 16.6, gridKw: -6, battKw: 0, socPct: 95 }),
      control: status({ commandedKw: 0, confirmedKw: 0, executionMode: 'plan' }),
    }));
    expect(v.state).toBe('ruhe');
    expect(v.status).not.toMatch(/Unerwarteter Verbrauch|deckt live/);
    expect(v.chips.find((chip) => chip.label === 'Ausführung')).toBeUndefined();
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

describe('Abregeln · Plan-Wortlaut + der ehrliche Widerspruch (Pilsting 02.08.)', () => {
  /** Der laufende Slot plant Abregeln, die Batterie steht still (0,0 kW). */
  const abregelnInput = (over: Partial<JetztInput> = {}) =>
    input({
      slot: slot({ slotRole: 'abregeln', batteryKw: 0, priceEurMwh: -1 }),
      control: status({ commandedKw: 0, confirmedKw: 0 }),
      ...over,
    });

  it('sagt „soll", nicht „pausiert" - die Ausführung ist nicht belegt', () => {
    expect(actionPhrase('abregeln', 0, 'eigenverbrauch')).toBe(
      'soll gerade die Einspeisung pausieren',
    );
    expect(jetztHeld(abregelnInput()).lead).toBe(
      'Ihre Batterie soll gerade die Einspeisung pausieren',
    );
  });

  it('nennt den Widerspruch, wenn die Anlage messbar einspeist - bernstein, kein Fehler', () => {
    // Die Konstellation des Captains: Abregeln geplant, 16,6 kW Einspeisung.
    const v = jetztHeld(abregelnInput({ snapshot: snap({ gridKw: -16.6 }) }));
    expect(v.conflict).toBe(
      `Ihre Anlage speist gerade 16,6${NBSP}kW ein – die Drosselung ist auf dieser Anlage ` +
        'noch nicht freigegeben oder nicht bestätigt.',
    );
    // Es ist kein Gerätefehler: der Zustand bleibt, was die Batterie tut.
    expect(v.state).not.toBe('abweichung');
    // Und der Mess-Chip daneben zeigt dieselbe Zahl - eine Wahrheit.
    expect(v.chips).toContainEqual({ label: 'Einspeisung', value: `16,6${NBSP}kW` });
  });

  it('behauptet keinen Widerspruch ohne Beleg', () => {
    // Netz im Rauschband / Bezug statt Einspeisung.
    expect(jetztHeld(abregelnInput({ snapshot: snap({ gridKw: -0.2 }) })).conflict).toBeNull();
    expect(jetztHeld(abregelnInput({ snapshot: snap({ gridKw: 4 }) })).conflict).toBeNull();
    // Kein Netzwert gemessen.
    expect(jetztHeld(abregelnInput({ snapshot: snap({ gridKw: null }) })).conflict).toBeNull();
    // Schnappschuss veraltet - eine alte Messung widerlegt das Jetzt nicht.
    expect(
      jetztHeld(abregelnInput({ snapshot: snap({ gridKw: -16.6 }), snapshotFresh: false })).conflict,
    ).toBeNull();
    // Andere Rolle: die Einspeisung ist dann genau das, was geplant war.
    expect(
      jetztHeld(input({ slot: slot({ slotRole: 'verkaufen' }), snapshot: snap({ gridKw: -16.6 }) }))
        .conflict,
    ).toBeNull();
    // Toter Plan: er sagt über das Jetzt nichts mehr, also auch keinen Bruch.
    expect(
      jetztHeld(abregelnInput({ snapshot: snap({ gridKw: -16.6 }), planStale: true })).conflict,
    ).toBeNull();
  });

  it('formuliert auch die reine Plan-Leitzeile als Plan - und sagt „geplant" nur einmal', () => {
    const v = jetztHeld(abregelnInput({ control: null, expectControl: false }));
    expect(v.state).toBe('nur_plan');
    expect(v.lead).toBe('Geplant ist gerade: Einspeisung pausieren (Negativpreis)');
  });

  // ---- PR 3: die zwei weiteren Stufen, sobald der Beleg da ist ------------

  const truth = (over: Partial<CurtailmentStatus> = {}) =>
    curtailTruth(
      {
        deviceId: 'd1',
        units: 2,
        certifiedUnits: 2,
        controlEnabled: true,
        active: true,
        appliedCapKw: 12.5,
        allMatch: true,
        possibleOverride: false,
        checkedAt: new Date(NOW.getTime() - 9000).toISOString(),
        ...over,
      },
      NOW,
    );

  it('Stufe 2: nennt statt der Vermutung die ECHTE Ursache', () => {
    const v = jetztHeld(
      abregelnInput({
        snapshot: snap({ gridKw: -16.6 }),
        curtail: truth({ certifiedUnits: 0, active: false, allMatch: null, appliedCapKw: null }),
      }),
    );
    expect(v.conflict).toBe(
      `Ihre Anlage speist gerade 16,6${NBSP}kW ein – sie setzt die Drosselung noch nicht um ` +
        '(0 von 2 Wechselrichtern freigegeben).',
    );
    // Es bleibt bei „soll" - Stufe 2 ist keine Ausführung.
    expect(v.lead).toBe('Ihre Batterie soll gerade die Einspeisung pausieren');
    // Und die gute Nachricht gibt es hier nicht.
    expect(v.curtailment).toBeNull();
  });

  it('Stufe 3: erst mit Bestätigung Gegenwart - und die Warnung schweigt', () => {
    const v = jetztHeld(
      abregelnInput({ snapshot: snap({ gridKw: -4.2 }), curtail: truth() }),
    );
    expect(v.lead).toBe('Ihre Batterie pausiert gerade die Einspeisung');
    expect(v.curtailment).toBe(
      `Die Einspeisung ist auf 12,5${NBSP}kW begrenzt — vom Wechselrichter bestätigt.`,
    );
    // Eine Begrenzung ist ein Deckel, keine Null: die Rest-Einspeisung ist
    // kein Widerspruch mehr.
    expect(v.conflict).toBeNull();
    expect(v.why).toContain('die PV wird deshalb gedrosselt');
  });

  it('Übersteuerung: benennt sie, statt sie als Bestätigung zu verkaufen', () => {
    const v = jetztHeld(
      abregelnInput({
        snapshot: snap({ gridKw: -16.6 }),
        curtail: truth({ possibleOverride: true }),
      }),
    );
    expect(v.conflict).toContain('hält die Begrenzung aber nicht');
    expect(v.curtailment).toBeNull();
    expect(v.lead).toBe('Ihre Batterie soll gerade die Einspeisung pausieren');
  });

  it('lässt einen Beleg NICHT auf eine andere Rolle oder einen toten Plan abfärben', () => {
    // Andere Rolle: der Beleg gilt für die Abregelung, nicht für den Verkauf.
    const other = jetztHeld(
      input({ slot: slot({ slotRole: 'verkaufen' }), curtail: truth() }),
    );
    expect(other.curtailment).toBeNull();
    expect(other.lead).not.toContain('Einspeisung pausiert');
    // Toter Plan: er sagt über das Jetzt nichts - auch keine Bestätigung.
    expect(jetztHeld(abregelnInput({ curtail: truth(), planStale: true })).curtailment).toBeNull();
  });

  it('bleibt mit einem VERALTETEN Beleg exakt bei Stufe 1', () => {
    const v = jetztHeld(
      abregelnInput({
        snapshot: snap({ gridKw: -16.6 }),
        curtail: truth({ checkedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() }),
      }),
    );
    expect(v.lead).toBe('Ihre Batterie soll gerade die Einspeisung pausieren');
    expect(v.conflict).toBe(
      `Ihre Anlage speist gerade 16,6${NBSP}kW ein – die Drosselung ist auf dieser Anlage ` +
        'noch nicht freigegeben oder nicht bestätigt.',
    );
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

/**
 * PR 3 des Konzepts: die Ausführungs-Daten reisen jetzt im Heartbeat, also
 * BENENNT der Held die Nachführung statt sie zu umschreiben. Der Vertrag
 * daneben ist die Kompatibilität — eine ältere Edge-Version sendet die Felder
 * nicht, und dann muss alles exakt beim Stufe-2-Verhalten bleiben.
 */
describe('jetztHeld · die echte Richtung der Nachführung (PR 3)', () => {
  const deepened = {
    commandedKw: -7.087,
    confirmedKw: -7.087,
    executionMode: 'follow' as const,
    executionDirection: 'deepen' as const,
    executionPlannedKw: -4.332,
    executionTargetKw: 7.087,
  };

  it('sagt ANGEHOBEN statt „irgendwie angepasst" - und bleibt grün', () => {
    // Die Live-Konstellation vom 30.07., 21:22 (Anlage Pilsting).
    const v = jetztHeld(input({ control: status(deepened) }));
    expect(v.state).toBe('angepasst');
    expect(v.tone).toBe('ok');
    expect(v.status).toContain('nichts zu tun');
    expect(v.adjust).toContain('angehoben');
    expect(v.adjust).toContain(`4,3${NBSP}kW`); // der Plan bleibt sichtbar
    expect(v.adjust).toContain(`7,1${NBSP}kW`); // der gemessene Hausbedarf
    // Die generische Stufe-2-Formulierung ist damit ersetzt, nicht ergänzt.
    expect(v.adjust).not.toContain('bzw. eine Schutzgrenze');
  });

  it('sagt BEGRENZT auf der anderen Seite derselben Pflicht', () => {
    const v = jetztHeld(
      input({
        slot: slot({ batteryKw: -6.7 }),
        control: status({
          commandedKw: -5.1,
          confirmedKw: -5.1,
          executionMode: 'follow',
          executionDirection: 'reduce',
          executionPlannedKw: -6.7,
          executionTargetKw: 5.1,
        }),
      }),
    );
    expect(v.state).toBe('angepasst');
    expect(v.adjust).toContain('begrenzt');
    expect(v.adjust).not.toContain('angehoben');
  });

  it('nennt die preisbewusste Begrenzung als Lade-Fall', () => {
    const v = jetztHeld(
      input({
        slot: slot({ batteryKw: 11.1, slotRole: 'pv_speichern' }),
        control: status({
          commandedKw: 3.1,
          confirmedKw: 3.1,
          executionMode: 'trim',
          executionPlannedKw: 11.1,
          executionTargetKw: 3.1,
        }),
      }),
    );
    expect(v.state).toBe('angepasst');
    expect(v.valueNote).toBe('in den Speicher');
    expect(v.adjust).toContain('Solar-Überschuss');
  });

  it('erkennt eine Nachführung auch INNERHALB des Totbands', () => {
    // Der Wert deckt sich zufällig fast mit dem Plan - gemeldet ist sie
    // trotzdem, also wird sie auch so benannt (das Gerät weiß es besser als
    // eine Differenz-Heuristik).
    const v = jetztHeld(
      input({
        slot: slot({ batteryKw: -6.15 }),
        control: status({
          executionMode: 'follow',
          executionDirection: 'deepen',
          executionPlannedKw: -6.15,
          executionTargetKw: 6.1,
        }),
      }),
    );
    expect(v.state).toBe('angepasst');
    expect(v.adjust).toContain('angehoben');
  });

  it('nennt die eingebaute Sicherung, wenn kein Fahrplan das Gerät steuert', () => {
    const v = jetztHeld(
      input({
        control: status({ controlSource: 'default', executionMode: 'fallback' }),
      }),
    );
    expect(v.state).toBe('sicherung');
    expect(v.tone).toBe('warn');
    expect(v.status).toContain('ohne Fahrplan');
    expect(v.adjust).toContain('Sicherung');
    // Der Wert ist echt und wird gezeigt - aber die Rolle des Plans wird NICHT
    // ausgeliehen (das Gerät folgt ihm ja gerade nicht).
    expect(v.value).toBe(`6,1${NBSP}kW`);
    expect(v.lead).toBe('Ihre Batterie entlädt gerade');
    expect(v.lead).not.toContain('deckt gerade den Verbrauch');
    // Und der Grund des Plans erklärt einen Fallback nicht.
    expect(v.why).toBeNull();
  });

  it('behauptet ohne präzisen Modus nur, DASS kein Fahrplan steuert', () => {
    // Eine ältere Edge-Version sendet nur das grobe `control_source`. Das
    // reicht, um „läuft wie vorgesehen" nicht zu behaupten - aber nicht, um
    // die Ursache zu benennen (`default` fasst Sicherung, einen v2-Wunsch auf
    // der Batterie und Kalibrierung zusammen).
    const v = jetztHeld(input({ control: status({ controlSource: 'default' }) }));
    expect(v.state).toBe('sicherung');
    expect(v.status).toContain('ohne Fahrplan');
    expect(v.adjust).toBeNull();
    expect(v.why).toBeNull();
    // Ein Gerät, das den Fahrplan ausführt, ist davon unberührt.
    expect(jetztHeld(input({ control: status({ controlSource: 'schedule' }) })).state).toBe(
      'angepasst',
    );
  });

  it('lässt einen echten Bruch schwerer wiegen als jede Nachführung', () => {
    const v = jetztHeld(
      input({ control: status({ ...deepened, allMatch: false, confirmedKw: -2 }) }),
    );
    expect(v.state).toBe('abweichung');
    expect(v.tone).toBe('warn');
  });

  it('behauptet über einem toten Plan weiterhin nichts', () => {
    const v = jetztHeld(input({ control: status(deepened), planStale: true }));
    expect(v.state).toBe('veraltet');
    expect(v.adjust).toBeNull();
  });

  it('bleibt bei einer ÄLTEREN Edge-Version exakt beim Stufe-2-Verhalten', () => {
    // Kein execution-Block, kein control_source: dieselbe generische Aussage
    // wie vor PR 3 - und keine erfundene Richtung.
    const v = jetztHeld(input());
    expect(v.state).toBe('angepasst');
    expect(v.adjust).toContain('angepasst');
    expect(v.adjust).not.toMatch(/angehoben|begrenzt|Sicherung|Solar-Überschuss/);
  });

  it('erfindet ohne gemessenen Wert keine 0', () => {
    const v = jetztHeld(
      input({
        control: status({
          executionMode: 'follow',
          executionDirection: 'deepen',
          executionPlannedKw: -4.332,
        }),
      }),
    );
    expect(v.adjust).toContain('angehoben');
    expect(v.adjust).not.toContain(`0,0${NBSP}kW`);
  });
});

/**
 * Der Flussabgleich im Held (Scout `vp-verkauf-praemisse-s8` §3, Pilsting): eine
 * register-bestätigte, aber nicht fließende Verkaufs-Order. Der ANKER ist der
 * echte 10.08.-Fall - commanded −30 (entladen), gemessener Batteriefluss +3,3
 * (laden), Einspeisung 30,0 an einer gepflegten 30-kW-Grenze.
 */
describe('jetztHeld · Flussabgleich (bestätigt, aber fließt nicht)', () => {
  // Der Pilsting-Held: eine „verkaufen"-Order, register-bestätigt, während die
  // Physik lädt. `batteryKw = grid − load + pv = −30 − 6,3 + 39,6 = +3,3`.
  const pilstingHeld = (over: Partial<JetztInput> = {}): JetztInput =>
    input({
      slot: slot({ slotRole: 'verkaufen', batteryKw: -30, socPct: 12 }),
      control: status({ commandedKw: -30, confirmedKw: -30, allMatch: true }),
      snapshot: snap({ pvKw: 39.6, loadKw: 6.3, gridKw: -30, battKw: 3.3, socPct: 12 }),
      plantKind: 'direktvermarktung',
      ...over,
    });

  it('OHNE entprellte Serie ist die Karte zeichengleich - der Haken bleibt', () => {
    const v = jetztHeld(pilstingHeld({ maxFeedInKw: 30, conflictStreak: 0 }));
    expect(v.flowConflict).toBeNull();
    expect(v.confirm).toContain('bestätigt'); // die Bestätigungszeile steht noch
    expect(v.tone).toBe('ok');
  });

  it('mit entprellter Serie ersetzt der Konflikt die Bestätigung (Grenze 30 → Netzanschluss-voll-Zusatz)', () => {
    const v = jetztHeld(pilstingHeld({ maxFeedInKw: 30, conflictStreak: 3 }));
    expect(v.flowConflict).toContain(`Entladung angewiesen (30,0${NBSP}kW)`);
    expect(v.flowConflict).toContain('der Speicher entlädt aber nicht');
    expect(v.flowConflict).toContain(`Messung: lädt 3,3${NBSP}kW`);
    expect(v.flowConflict).toContain(`Einspeisegrenze 30${NBSP}kW erreicht`);
    expect(v.flowConflict).toContain('Bitte im Blick behalten.');
    // „vom Wechselrichter bestätigt" ENTFÄLLT - register-, nicht flussseitig.
    expect(v.confirm).toBeNull();
    // Nicht mehr „grün, planmäßig".
    expect(v.tone).toBe('warn');
    expect(v.status).not.toContain('nichts zu tun');
  });

  it('dieselben Zahlen mit Grenze 75 melden den Konflikt OHNE Ursachen-Zusatz', () => {
    const v = jetztHeld(pilstingHeld({ maxFeedInKw: 75, conflictStreak: 3 }));
    expect(v.flowConflict).toContain('der Speicher entlädt aber nicht');
    expect(v.flowConflict).not.toContain('Netzanschluss');
    expect(v.confirm).toBeNull();
  });

  it('ohne gepflegte Grenze bleibt der Satz ursachenfrei', () => {
    const v = jetztHeld(pilstingHeld({ maxFeedInKw: null, conflictStreak: 3 }));
    expect(v.flowConflict).not.toContain('Netzanschluss');
    expect(v.flowConflict).toContain('Bitte im Blick behalten.');
  });

  it('eine gemeldete Nachführung (follow) ist kein Konflikt - der Haken bleibt', () => {
    const v = jetztHeld(pilstingHeld({ maxFeedInKw: 30, conflictStreak: 3, control: status({ commandedKw: -30, executionMode: 'follow' }) }));
    expect(v.flowConflict).toBeNull();
  });

  it('ein fehlender Kanal (unbekannt ≠ 0) erzeugt keine Behauptung', () => {
    const v = jetztHeld(
      pilstingHeld({ maxFeedInKw: 30, conflictStreak: 3, snapshot: snap({ pvKw: null, loadKw: 6.3, gridKw: -30 }) }),
    );
    expect(v.flowConflict).toBeNull();
    expect(v.confirm).toContain('bestätigt');
  });

  it('eine gewöhnliche, wirklich fließende Order bleibt byte-identisch (kein flowConflict)', () => {
    // Der Standard-Held: commanded −6,1, gemessen −6,1 (deckungsgleich).
    const v = jetztHeld(input({ conflictStreak: 3, maxFeedInKw: 30 }));
    expect(v.flowConflict).toBeNull();
    expect(v.confirm).toContain('bestätigt');
  });

  // Der PAUSEN-Fall (Live-Lage Pilsting/Herzogau 24.08.2026): commanded ≈ 0,
  // gemessen +10,0 kW LADEN an der vollen 30-kW-Grenze.
  const pauseHeld = (over: Partial<JetztInput> = {}): JetztInput =>
    input({
      slot: slot({ slotRole: 'warten', batteryKw: 0, socPct: 55 }),
      control: status({ commandedKw: 0, confirmedKw: 0, allMatch: true }),
      snapshot: snap({ pvKw: 46.3, loadKw: 5.1, gridKw: -31.2, battKw: 10, socPct: 55 }),
      maxFeedInKw: 30,
      conflictStreak: FLOW_CONFLICT_MIN_STREAK,
      ...over,
    });

  it('Pause + an der Kappe ladend → INFO: grün, Bestätigung BLEIBT, freundlicher Satz', () => {
    const v = jetztHeld(pauseHeld());
    expect(v.flowConflictSeverity).toBe('info');
    expect(v.tone).toBe('ok');
    expect(v.flowConflict).toContain(`nimmt aber gerade 10,0${NBSP}kW Überschuss auf`);
    expect(v.flowConflict).toContain(`Einspeisegrenze (30${NBSP}kW)`);
    expect(v.flowConflict).not.toContain('Bitte im Blick behalten');
    expect(v.confirm).toContain('bestätigt');
    expect(v.status).not.toContain('fließt gerade nicht');
  });

  it('Pause + ladend OHNE Grenze → WARN: bernstein, Bestätigung entfällt, Status „fließt nicht"', () => {
    const v = jetztHeld(pauseHeld({ maxFeedInKw: null }));
    expect(v.flowConflictSeverity).toBe('warn');
    expect(v.tone).toBe('warn');
    expect(v.flowConflict).toContain('Pause angewiesen');
    expect(v.confirm).toBeNull();
    expect(v.status).toContain('fließt gerade nicht');
  });

  it('Pause + ENTLADEN → WARN, auch mit gepflegter Grenze', () => {
    const v = jetztHeld(pauseHeld({ snapshot: snap({ pvKw: 0, loadKw: 8, gridKw: 0 }) }));
    expect(v.flowConflictSeverity).toBe('warn');
    expect(v.tone).toBe('warn');
    expect(v.flowConflict).toContain(`entlädt aber 8,0${NBSP}kW`);
  });

  it('Pause unter der Serien-Schwelle → grüne Ruhe, Bestätigung, kein Konflikt', () => {
    const v = jetztHeld(pauseHeld({ conflictStreak: FLOW_CONFLICT_MIN_STREAK - 1 }));
    expect(v.flowConflict).toBeNull();
    expect(v.flowConflictSeverity).toBeNull();
    expect(v.tone).toBe('ok');
    expect(v.confirm).toContain('bestätigt');
  });
});


/**
 * Der LADE-SPIEGEL des Entlade-Satzes (Captain-Entscheid 31.08.2026).
 *
 * Der belegte Fall - Anlage Herzogau/Pilsting, 31.08.2026, 11:00: der
 * Börsenpreis steht bei +0,08 EUR/MWh, das Portal zeigt „0,0 ct", der Speicher
 * ist auf 6 % und trotzdem gehen ~30 kW ins Netz statt in die Batterie. Das
 * SIEHT falsch aus und ist richtig: die exportierte kWh bringt in dieser
 * Viertelstunde noch 3,1 ct, ab 12:00 wird der Preis negativ, und genau dorthin
 * hat der Fahrplan das Speichern gelegt.
 *
 * Die zwei Regeln, die hier am meisten wert sind:
 *  - der Satz erscheint NUR mit allen Belegen (Einspeisewert jetzt, ein
 *    späteres Ladefenster, das weniger bringt, und eine gemessene Einspeisung),
 *  - und wo einer fehlt, bleibt die Karte ZEICHENGLEICH zu heute.
 */
describe('jetztHeld · Ruhe bei Einspeisung (der Lade-Spiegel)', () => {
  const T = (iso: string) =>
    new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const HERZOGAU_NOW = new Date('2026-08-31T09:05:00Z');
  const LADEN_AB = '2026-08-31T10:00:00Z';

  /** Der Plan des Vormittags: vier ruhende Viertelstunden, dann das Laden. */
  const herzogauSlots = (over: Partial<WhySlot> = {}): WhySlot[] => [
    slot({ start: '2026-08-31T09:00:00Z', batteryKw: 0, socPct: 6, slotRole: 'warten', exportValueCtKwh: 3.1, ...over }),
    slot({ start: '2026-08-31T09:15:00Z', batteryKw: 0, socPct: 6, slotRole: 'warten', exportValueCtKwh: 2.9 }),
    slot({ start: '2026-08-31T09:30:00Z', batteryKw: 0, socPct: 6, slotRole: 'warten', exportValueCtKwh: 2.6 }),
    slot({ start: '2026-08-31T09:45:00Z', batteryKw: 0, socPct: 6, slotRole: 'warten', exportValueCtKwh: 2.2 }),
    slot({ start: LADEN_AB, batteryKw: 21, socPct: 14, slotRole: 'pv_speichern', exportValueCtKwh: -0.4 }),
  ];

  const herzogau = (over: Partial<JetztInput> = {}): JetztInput => {
    const slots = over.slots ?? herzogauSlots();
    return input({
      slot: slots[0],
      slots,
      control: status({
        commandedKw: 0,
        confirmedKw: 0,
        allMatch: true,
        checkedAt: new Date(HERZOGAU_NOW.getTime() - 8000).toISOString(),
      }),
      // PV 44 kW, Haus 12 kW, ~30 kW an der Einspeisegrenze ins Netz.
      snapshot: snap({ pvKw: 44, loadKw: 12, gridKw: -30, battKw: 0, socPct: 6 }),
      snapshotFresh: true,
      maxFeedInKw: 30,
      plantKind: 'direktvermarktung',
      now: HERZOGAU_NOW,
      ...over,
    });
  };

  it('löst den Widerspruch auf: „wird gerade noch vergütet" + wann gespeichert wird', () => {
    const v = jetztHeld(herzogau());
    // Es IST geplante Ruhe - der Zustand wird nicht umgedeutet.
    expect(v.state).toBe('ruhe');
    // ... und sie bleibt GRÜN: das ist kein Fehler, sondern der Plan.
    expect(v.tone).toBe('ok');
    expect(v.status).toBe(
      `Einspeisung wird gerade noch vergütet (3,1${NBSP}ct/kWh) · ` +
        `Speichern ab ${T(LADEN_AB)} Uhr, wenn der Preis negativ wird`,
    );
    // Die Zahl steht auch als Chip neben der GEMESSENEN Einspeisung - genau
    // die Paarung, die den Widerspruch auflöst.
    expect(v.chips).toContainEqual({ label: 'Einspeisung', value: `30,0${NBSP}kW` });
    expect(v.chips).toContainEqual({ label: 'Einspeisewert', value: `3,1${NBSP}ct/kWh` });
    // Kein internes Vokabular im Kundensatz.
    expect(v.status).not.toMatch(/Marktprämie|§\s*51|Slot|λ/);
  });

  it('nennt bei nur NIEDRIGEREM Einspeisewert die ehrliche Variante', () => {
    const slots = herzogauSlots();
    // Das Ladefenster bringt weiter Geld, nur deutlich weniger als jetzt.
    slots[4] = slot({ start: LADEN_AB, batteryKw: 21, slotRole: 'pv_speichern', exportValueCtKwh: 1.2 });
    const v = jetztHeld(herzogau({ slots }));
    expect(v.status).toBe(
      `Einspeisung wird gerade noch vergütet (3,1${NBSP}ct/kWh) · ` +
        `Speichern ab ${T(LADEN_AB)} Uhr, wenn Einspeisen weniger bringt`,
    );
  });

  it('OHNE Direktvermarktung bleibt der heutige Text unverändert', () => {
    const v = jetztHeld(herzogau({ plantKind: 'eigenverbrauch' }));
    expect(v.status).toBe('Warten — so geplant, nichts zu tun');
    expect(v.chips.map((c) => c.label)).not.toContain('Einspeisewert');
  });

  it('OHNE positiven Einspeisewert JETZT wird nichts behauptet', () => {
    // Kein Wert geliefert (älterer Lauf) - und die zwei Fälle, in denen
    // „wird gerade noch vergütet" schlicht unwahr wäre.
    for (const exportValueCtKwh of [null, 0, -0.4]) {
      const v = jetztHeld(herzogau({ slots: herzogauSlots({ exportValueCtKwh }) }));
      expect(v.status, String(exportValueCtKwh)).toBe('Warten — so geplant, nichts zu tun');
    }
  });

  it('OHNE späteren Lade-Slot wird nichts behauptet', () => {
    const v = jetztHeld(herzogau({ slots: herzogauSlots().slice(0, 4) }));
    expect(v.status).toBe('Warten — so geplant, nichts zu tun');
  });

  it('ein Ladefenster, das kaum weniger bringt, ist KEINE Auskunft', () => {
    const slots = herzogauSlots();
    slots[4] = slot({ start: LADEN_AB, batteryKw: 21, slotRole: 'pv_speichern', exportValueCtKwh: 2.9 });
    expect(jetztHeld(herzogau({ slots })).status).toBe('Warten — so geplant, nichts zu tun');
  });

  it('eine BELEGTE andere Ursache gewinnt: Reserve-Boden und voller Speicher', () => {
    for (const flag of ['soc_floor', 'reserve_backup', 'reserve_peak', 'soc_max', 'charge_cap']) {
      const v = jetztHeld(herzogau({ slots: herzogauSlots({ slotFlags: [flag] }) }));
      expect(v.status, flag).toBe('Warten — so geplant, nichts zu tun');
    }
  });

  it('eine geplante Abregelung erklärt sich selbst - kein zweiter Satz', () => {
    const v = jetztHeld(herzogau({ slots: herzogauSlots({ slotRole: 'abregeln', curtailKw: 12 }) }));
    expect(v.status).toBe('Warten — so geplant, nichts zu tun');
  });

  it('ohne messbare Einspeisung (oder ohne frische Messung) wird nichts behauptet', () => {
    expect(jetztHeld(herzogau({ snapshot: snap({ pvKw: 12, loadKw: 12, gridKw: 0, battKw: 0, socPct: 6 }) })).status)
      .toBe('Warten — so geplant, nichts zu tun');
    expect(jetztHeld(herzogau({ snapshotFresh: false })).status).toBe('Warten — so geplant, nichts zu tun');
  });

  it('ein Speicher, der laut Plan gar nicht ruht, bekommt den Satz nie', () => {
    const slots = herzogauSlots();
    slots[0] = slot({ start: '2026-08-31T09:00:00Z', batteryKw: 8, slotRole: 'pv_speichern', exportValueCtKwh: 3.1 });
    // Die reine Regel urteilt hier direkt - der Held wäre in diesem Fall gar
    // nicht mehr im Ruhe-Zustand, die Erkennung muss es trotzdem selbst wissen.
    expect(einspeiseRuhe(herzogau({ slots }))).toBeNull();
  });

  it('der ENTLADE-Spiegel bleibt byte-gleich - Bezug schlägt Einspeisung', () => {
    const slots = herzogauSlots({ unplannedLoadDischarge: false });
    const v = jetztHeld(
      herzogau({
        slots,
        // Dieselbe Anlage, nur zieht sie gerade 8 kW aus dem Netz.
        snapshot: snap({ pvKw: 2, loadKw: 10, gridKw: 8, battKw: 0, socPct: 6 }),
      }),
    );
    expect(v.status).toBe('Speicher hält zurück, weil Energie später mehr wert ist');
    expect(v.chips.map((c) => c.label)).not.toContain('Einspeisewert');
  });
});

describe('jetztHeld · Wechselrichter-Eigenregelung (Lade- und Eigenverbrauchs-Automatik)', () => {
  // Die rohen Wörter erscheinen nie in der Oberfläche - an keiner Zeile der Karte.
  const RAW = /autonomous_(charge|selfconsumption|discharge)/;

  it('E/E~: der geplante Normalfall bleibt ruhig und nennt den Wechselrichter als Regler', () => {
    // Die Eigenverbrauchs-Automatik regelt in BEIDE Richtungen: hier lädt sie
    // gerade Überschuss. Kein Bernstein, kein „Unerwarteter Verbrauch".
    const v = jetztHeld(input({
      slot: slot({ batteryKw: 0, slotRole: 'warten', unplannedLoadDischarge: true }),
      planFacts: { generatedAt: '2026-08-01T19:15:00Z', effectiveFloorSocPct: 35 },
      snapshot: snap({ pvKw: 14, loadKw: 4, gridKw: 0, battKw: 10, socPct: 60 }),
      control: status({
        commandedKw: 0,
        confirmedKw: 0,
        executionMode: 'autonomous_selfconsumption',
        executionPlannedKw: 0,
        executionFloorSocPct: 35,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.state).toBe('angepasst');
    expect(v.tone).toBe('ok');
    expect(v.status).toBe('Läuft wie vorgesehen — nichts zu tun');
    expect(v.adjust).toContain('Ihr Wechselrichter regelt gerade selbst auf Eigenverbrauch');
    expect(JSON.stringify(v)).not.toMatch(/Unerwarteter Verbrauch|Neuplanung/);
    expect(JSON.stringify(v)).not.toMatch(RAW);
  });

  it('E/E~: deutlicher Bezug heißt Grenze, nie „Speicher hält zurück"', () => {
    const v = jetztHeld(input({
      slot: slot({ batteryKw: 0, slotRole: 'warten', unplannedLoadDischarge: false }),
      snapshot: snap({ pvKw: 0, loadKw: 17, gridKw: 5, battKw: -12, socPct: 60 }),
      control: status({
        commandedKw: 0,
        confirmedKw: 0,
        executionMode: 'autonomous_selfconsumption',
        executionPlannedKw: 0,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.status).toBe('Entladung durch Reserve/Gerätezustand begrenzt');
    expect(v.chips).toEqual(expect.arrayContaining([
      { label: 'Ausführung', value: 'Wechselrichter-Automatik' },
    ]));
    expect(JSON.stringify(v)).not.toMatch(RAW);
  });

  it('K4b-Wirklichkeit: ohne Sollwert (null) heißt es „regelt selbst", nie „wird vorbereitet"', () => {
    for (const mode of ['autonomous_discharge', 'autonomous_charge', 'autonomous_selfconsumption'] as const) {
      const v = jetztHeld(input({
        slot: slot({ batteryKw: -3, slotRole: 'eigenverbrauch', coverLoadFromBattery: true }),
        snapshot: snap({ pvKw: 0, loadKw: 3, gridKw: 0, battKw: -3, socPct: 60 }),
        control: status({
          commandedKw: null,
          confirmedKw: null,
          executionMode: mode,
          executionPlannedKw: -3,
          executionMeasurementsFresh: true,
        }),
      }));
      expect(v.state).toBe('angepasst');
      expect(v.tone).toBe('ok');
      expect(v.status).toBe('Läuft wie vorgesehen — nichts zu tun');
      expect(JSON.stringify(v)).not.toMatch(/vorbereitet|pausiert|0,0 kW/);
      expect(JSON.stringify(v)).not.toMatch(RAW);
    }
  });

  it('E↓: die geplante Deckung (cover_load_from_battery) bleibt ruhig - kein „Unerwarteter Verbrauch"', () => {
    const v = jetztHeld(input({
      slot: slot({ batteryKw: -4, slotRole: 'eigenverbrauch', coverLoadFromBattery: true }),
      planFacts: { generatedAt: '2026-08-01T19:15:00Z', effectiveFloorSocPct: 20 },
      snapshot: snap({ pvKw: 0, loadKw: 5, gridKw: 0.2, battKw: -4.8, socPct: 55 }),
      control: status({
        commandedKw: null,
        confirmedKw: null,
        executionMode: 'autonomous_discharge',
        executionPlannedKw: -4,
        executionFloorSocPct: 20,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.tone).toBe('ok');
    expect(v.status).toBe('Läuft wie vorgesehen — nichts zu tun');
    expect(v.adjust).toBe('Ihr Wechselrichter deckt Ihren Verbrauch gerade selbst aus dem Speicher.');
    expect(JSON.stringify(v)).not.toMatch(/Unerwarteter Verbrauch|Der Fahrplan sah|Neuplanung/);
    expect(JSON.stringify(v)).not.toMatch(RAW);
  });

  it('E↓: deutlicher Bezug in geplanter Ruhe heißt Grenze, nie „Speicher hält zurück"', () => {
    const v = jetztHeld(input({
      slot: slot({ batteryKw: 0, slotRole: 'warten', unplannedLoadDischarge: false }),
      snapshot: snap({ pvKw: 0, loadKw: 17, gridKw: 5, battKw: -12, socPct: 60 }),
      control: status({
        commandedKw: null,
        confirmedKw: null,
        executionMode: 'autonomous_discharge',
        executionPlannedKw: 0,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.status).toBe('Entladung durch Reserve/Gerätezustand begrenzt');
    expect(v.chips).toEqual(expect.arrayContaining([
      { label: 'Ausführung', value: 'Wechselrichter-Automatik' },
    ]));
    expect(JSON.stringify(v)).not.toMatch(RAW);
  });

  it('E↑: lädt den Überschuss selbst, meldet keine Verbrauchsdeckung und keine Nachführung der Box', () => {
    const v = jetztHeld(input({
      slot: slot({ batteryKw: 12, slotRole: 'laden' }),
      snapshot: snap({ pvKw: 20, loadKw: 4, gridKw: 0, battKw: 16, socPct: 40 }),
      control: status({
        commandedKw: 12,
        confirmedKw: 12,
        executionMode: 'autonomous_charge',
        executionPlannedKw: 12,
        executionTargetKw: 16,
        executionMeasurementsFresh: true,
      }),
    }));
    expect(v.state).toBe('angepasst');
    // Die reine Lade-Automatik deckt keinen Verbrauch: der Entlade-Spiegel schweigt.
    expect(v.status).toBe('Läuft wie vorgesehen — nichts zu tun');
    expect(v.chips.map((c) => c.label)).not.toContain('Ausführung');
    expect(v.adjust).toContain('Ihr Wechselrichter lädt den Solar-Überschuss gerade selbst in den Speicher');
    expect(v.adjust).not.toMatch(/nachgeführt|Nachführung|regelt auf den gemessenen Verbrauch/);
    expect(JSON.stringify(v)).not.toMatch(RAW);
  });
});

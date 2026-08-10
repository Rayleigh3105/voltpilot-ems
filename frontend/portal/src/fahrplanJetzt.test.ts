import { describe, expect, it } from 'vitest';
import { actionPhrase, jetztHeld, measurementChips, type JetztInput } from './fahrplanJetzt';
import type { ControlStatus, CurtailmentStatus } from './api';
import { curtailTruth } from './curtailment';
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
});

import { describe, expect, it } from 'vitest';
import type { ControlStatus } from './api';
import {
  EXECUTION_MODE_LABEL,
  OHNE_LADESTAND_SATZ,
  PV_CLARIFICATION,
  batteryDirection,
  controlReasonSlot,
  controlStrip,
  directionLabel,
  executionNote,
  nextChargeStart,
  nextEngagement,
  planOutlook,
} from './control';
import { CURTAIL_PLAN, curtailTruth } from './curtailment';
import { slotWhy } from './fahrplanWhy';
import { NBSP } from './format';

const NOW = new Date('2026-07-08T12:00:10Z');

function status(over: Partial<ControlStatus>): ControlStatus {
  return {
    deviceId: 'd1',
    commandedKw: -4,
    confirmedKw: -4,
    allMatch: true,
    controlEnabled: true,
    certified: true,
    mismatchRoles: null,
    slotStart: '2026-07-08T12:00:00Z',
    checkedAt: '2026-07-08T12:00:07Z',
    ...over,
  };
}

describe('controlStrip', () => {
  it('returns null when there is no status yet (default)', () => {
    expect(controlStrip(null, NOW)).toBeNull();
  });

  it('stays honest for a controllable plant with no readback yet (report N4)', () => {
    const v = controlStrip(null, NOW, true)!;
    expect(v.state).toBe('preparing');
    expect(v.tone).toBe('off');
    expect(v.sentence).toContain('vorbereitet');
    // No register/Modbus jargon reaches the customer.
    expect(v.sentence.toLowerCase()).not.toContain('modbus');
  });

  it('is healthy when the inverter confirms the commanded setpoint', () => {
    const v = controlStrip(status({}), NOW)!;
    expect(v.state).toBe('healthy');
    expect(v.tone).toBe('ok');
    expect(v.sentence).toContain('bestätigt');
    expect(v.sentence).toContain('4,0');
    expect(v.agoNote).toContain('geprüft');
  });

  it('nennt den Wert das, was er ist - was das GERÄT regelt, nie „Fahrplan-Sollwert"', () => {
    // Der gemeldete Widerspruch (Konzept vp-fahrplan-kunde-konzept K2): seit den
    // Nachführungs-Pflichten weicht `commandedKw` bewusst vom Plan-Watt ab, stand
    // aber unter demselben Wort wie der Fahrplan-Balken - zwei verschiedene Zahlen
    // unter „Fahrplan" auf EINEM Bildschirm. Variante B: nie mehr „regelt auf".
    for (const v of [
      controlStrip(status({}), NOW)!,
      controlStrip(status({ allMatch: false, confirmedKw: -1.2 }), NOW)!,
      controlStrip(
        status({ checkedAt: new Date(NOW.getTime() - 6 * 60 * 1000).toISOString() }),
        NOW,
      )!,
    ]) {
      expect(v.sentence).not.toContain('Fahrplan-Sollwert');
      expect(v.sentence).not.toContain('regelt gerade auf');
    }
    // The direction is a WORD (default cmd -4 = discharge), never a sign.
    const healthy = controlStrip(status({}), NOW)!;
    expect(healthy.sentence).toContain('entlädt gerade mit 4,0');
    expect(healthy.sentence).not.toContain('-4');
    expect(healthy.sentence).not.toContain('−4');
  });

  it('flags a mismatch when the read-back differs from the command', () => {
    const v = controlStrip(status({ allMatch: false, confirmedKw: -1.2, mismatchRoles: 'battery_power' }), NOW)!;
    expect(v.state).toBe('mismatch');
    expect(v.tone).toBe('warn');
    expect(v.sentence).toContain('meldet');
    expect(v.sentence).toContain('1,2');
    expect(v.agoNote).toContain('Abweichung');
  });

  it('goes stale when the last confirmation is older than the window', () => {
    const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    const v = controlStrip(status({ checkedAt: old }), NOW)!;
    expect(v.state).toBe('stale');
    expect(v.tone).toBe('off');
    expect(v.agoNote).toContain('zuletzt geprüft');
  });

  it('reads as off (Not-Aus) when control is disabled - calm, no euro/register jargon', () => {
    const v = controlStrip(status({ controlEnabled: false }), NOW)!;
    expect(v.state).toBe('off');
    expect(v.sentence).toContain('ausgeschaltet');
    expect(v.sentence).not.toMatch(/register|modbus|kill/i);
  });

  it('reads as pending when the model is not yet certified for control', () => {
    const v = controlStrip(status({ certified: false, controlEnabled: true }), NOW)!;
    expect(v.state).toBe('pending');
    expect(v.sentence).toContain('noch nicht freigegeben');
  });

  // Bis zum Plattform-Register verschluckte dieser EINE Satz drei verschiedene
  // Situationen: „ein Prüfstandslauf fehlt", „ein Klick fehlt" und „wir wissen
  // es noch nicht". Genau die Unterscheidung war der Auftrag.
  it('says „one click is missing" when the MODEL is certified but the plant is not armed', () => {
    const v = controlStrip(
      status({ certified: false, platformCertVerdict: 'covered_not_activated' }),
      NOW,
    )!;
    expect(v.state).toBe('pending');
    expect(v.sentence).toMatch(/Modell ist für die Steuerung freigegeben/);
    expect(v.sentence).toMatch(/einschalten/);
    expect(v.sentence).not.toMatch(/Prüfstand/);
  });

  it('says „a bench run is needed" when the model is genuinely not covered', () => {
    const v = controlStrip(status({ certified: false, platformCertVerdict: 'not_covered' }), NOW)!;
    expect(v.sentence).toMatch(/Prüfstand/);
    expect(v.sentence).not.toMatch(/einschalten/);
  });

  // ⚠ Ein älteres Gerät meldet nichts - und „unbekannt" darf nie wie „Prüfstand
  // nötig" klingen, sonst schickt das Portal einen Kunden zu einem Prüfstand,
  // den er nicht braucht.
  it('keeps the old, claim-free sentence when the device reported nothing', () => {
    for (const verdict of [undefined, null, 'unknown' as const]) {
      const v = controlStrip(status({ certified: false, platformCertVerdict: verdict }), NOW)!;
      expect(v.sentence).toBe(
        'Die Steuerung ist für dieses Modell noch nicht freigegeben - die Anlage wird nur ausgelesen.',
      );
    }
  });

  it('never leaks internal vocabulary into any state', () => {
    for (const over of [{}, { allMatch: false }, { controlEnabled: false }, { certified: false }]) {
      const v = controlStrip(status(over), NOW)!;
      expect(v.sentence).not.toMatch(/register|modbus|kill-switch|readback/i);
    }
  });
});

// --- Variante B: die Richtung ist ein Wort, nie ein Vorzeichen ---------------
//
// „Ihr Gerät regelt gerade auf 0,0 kW" liest sich wie eine Abregelung von
// außen. Der Speicher „pausiert / lädt / entlädt" - eine konsistente
// Satz-Familie in jedem Zustand, die Bestätigung wird zum Halbsatz.
describe('controlStrip · Variante B (Richtung als Wort)', () => {
  it('reads „pausiert" when the battery rests (the screenshot case)', () => {
    const v = controlStrip(status({ commandedKw: 0, confirmedKw: 0 }), NOW)!;
    expect(v.state).toBe('healthy');
    expect(v.sentence).toBe('Der Speicher pausiert gerade – vom Wechselrichter bestätigt');
    // A pausing battery can never read as an external curtailment.
    expect(v.sentence).not.toContain('regelt');
    expect(v.sentence).not.toContain('0,0');
  });

  it('reads „lädt/entlädt mit X kW" and never a sign', () => {
    expect(controlStrip(status({ commandedKw: 4, confirmedKw: 4 }), NOW)!.sentence).toBe(
      `Der Speicher lädt gerade mit 4,0${NBSP}kW – vom Wechselrichter bestätigt`,
    );
    expect(controlStrip(status({ commandedKw: -6.1, confirmedKw: -6.1 }), NOW)!.sentence).toBe(
      `Der Speicher entlädt gerade mit 6,1${NBSP}kW – vom Wechselrichter bestätigt`,
    );
  });

  it('a tiny setpoint inside the 0,05-kW deadband still reads as pausiert', () => {
    expect(controlStrip(status({ commandedKw: 0.03, confirmedKw: 0.03 }), NOW)!.sentence).toContain(
      'pausiert',
    );
  });

  it('mismatch names the direction as a word on both sides, incl. „soll pausieren"', () => {
    // soll laden, meldet weniger (gleiche Richtung) - der Mockup-Fall.
    expect(
      controlStrip(status({ commandedKw: 4, confirmedKw: 2.1, allMatch: false }), NOW)!.sentence,
    ).toBe(`Der Speicher soll mit 4,0${NBSP}kW laden – der Wechselrichter meldet 2,1${NBSP}kW`);
    // soll pausieren, meldet eine echte Bewegung - benennt das Verhalten.
    expect(
      controlStrip(status({ commandedKw: 0, confirmedKw: 4, allMatch: false }), NOW)!.sentence,
    ).toBe(`Der Speicher soll pausieren – der Wechselrichter meldet 4,0${NBSP}kW Ladung`);
    // Gegenrichtung - nie verborgen.
    expect(
      controlStrip(status({ commandedKw: 4, confirmedKw: -2, allMatch: false }), NOW)!.sentence,
    ).toBe(`Der Speicher soll mit 4,0${NBSP}kW laden – der Wechselrichter meldet 2,0${NBSP}kW Entladung`);
    // soll etwas, meldet Stillstand (Entladen = negativer Befehl).
    expect(
      controlStrip(status({ commandedKw: -6.1, confirmedKw: 0, allMatch: false }), NOW)!.sentence,
    ).toBe(`Der Speicher soll mit 6,1${NBSP}kW entladen – der Wechselrichter meldet Stillstand`);
    // Kein Minuszeichen, egal welche Richtung.
    const s = controlStrip(
      status({ commandedKw: -4, confirmedKw: -1.2, allMatch: false }),
      NOW,
    )!.sentence;
    expect(s).not.toContain('-');
    expect(s).not.toContain('−');
  });

  it('stale reads richtungs-wortbasiert', () => {
    const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    expect(
      controlStrip(status({ commandedKw: 4, confirmedKw: 4, checkedAt: old }), NOW)!.sentence,
    ).toBe(`Zuletzt: Speicher lud mit 4,0${NBSP}kW – bestätigt`);
    expect(
      controlStrip(status({ commandedKw: -6.1, confirmedKw: -6.1, checkedAt: old }), NOW)!.sentence,
    ).toBe(`Zuletzt: Speicher entlud mit 6,1${NBSP}kW – bestätigt`);
    expect(
      controlStrip(status({ commandedKw: 0, confirmedKw: 0, checkedAt: old }), NOW)!.sentence,
    ).toBe('Zuletzt: Speicher pausierte – bestätigt');
  });

  it('batteryDirection maps the sign convention (+ = laden)', () => {
    expect(batteryDirection(4)).toBe('laden');
    expect(batteryDirection(-6.1)).toBe('entladen');
    expect(batteryDirection(0)).toBe('pausieren');
    expect(batteryDirection(0.04)).toBe('pausieren');
    expect(batteryDirection(null)).toBe('pausieren');
  });
});

// --- Ruhefall: Klarstellungs-Halbsatz (Teil 2) + Ausblick (Teil 3) ----------
describe('controlStrip · Ruhe additions', () => {
  const REST = { commandedKw: 0, confirmedKw: 0 };
  const OUTLOOK = '→ Weiter laut Fahrplan: Laden ab ca. 11:15 Uhr.';

  it('appends the PV clarification to the reason ONLY in Ruhe with a reason', () => {
    expect(
      controlStrip(status(REST), NOW, false, 'Grund.', CURTAIL_PLAN, null, false)!.reason,
    ).toBe(`Grund. ${PV_CLARIFICATION}`);
    // Not on laden/entladen.
    expect(
      controlStrip(status({ commandedKw: 4, confirmedKw: 4 }), NOW, false, 'Grund.')!.reason,
    ).toBe('Grund.');
    // Not without a reason.
    expect(controlStrip(status(REST), NOW, false, null)!.reason).toBeNull();
  });

  it('carries the outlook line ONLY in Ruhe', () => {
    expect(
      controlStrip(status(REST), NOW, false, 'Grund.', CURTAIL_PLAN, OUTLOOK)!.outlook,
    ).toBe(OUTLOOK);
    // Not while charging/discharging (the battery is already engaged).
    expect(
      controlStrip(status({ commandedKw: 4, confirmedKw: 4 }), NOW, false, null, CURTAIL_PLAN, OUTLOOK)!
        .outlook,
    ).toBeNull();
    // Not when stale / off / pending.
    const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    expect(
      controlStrip(status({ ...REST, checkedAt: old }), NOW, false, null, CURTAIL_PLAN, OUTLOOK)!
        .outlook,
    ).toBeNull();
    expect(
      controlStrip(status({ ...REST, controlEnabled: false }), NOW, false, null, CURTAIL_PLAN, OUTLOOK)!
        .outlook,
    ).toBeNull();
  });

  it('a surplus reason suppresses BOTH the clarification and the generic outlook', () => {
    const v = controlStrip(
      status(REST),
      NOW,
      false,
      'Ihr Solar-Überschuss wird gerade verkauft statt gespeichert.',
      CURTAIL_PLAN,
      OUTLOOK,
      true,
    )!;
    // The surplus reason is self-contained: kept verbatim, no clarification.
    expect(v.reason).toBe('Ihr Solar-Überschuss wird gerade verkauft statt gespeichert.');
    expect(v.reason).not.toContain(PV_CLARIFICATION);
    expect(v.outlook).toBeNull();
  });
});

// --- planOutlook / nextEngagement / nextChargeStart -------------------------
describe('planOutlook / nextEngagement / nextChargeStart', () => {
  const slots = [
    { start: '2026-07-30T09:00:00Z', batteryKw: 0 },
    { start: '2026-07-30T09:15:00Z', batteryKw: 0.02 }, // inside deadband → pausiert
    { start: '2026-07-30T11:15:00Z', batteryKw: 4 }, // next charge
    { start: '2026-07-30T18:00:00Z', batteryKw: -5 }, // later discharge
  ];
  const NOWP = new Date('2026-07-30T09:05:00Z');

  it('nextEngagement finds the next engaged slot after now (skips the current + deadband slots)', () => {
    expect(nextEngagement(slots, NOWP)).toEqual({ kind: 'laden', start: '2026-07-30T11:15:00Z' });
  });

  it('planOutlook formats the outlook line (TZ-robust)', () => {
    expect(planOutlook(slots, NOWP)).toMatch(
      /^→ Weiter laut Fahrplan: Laden ab ca\. \d{2}:\d{2} Uhr\.$/,
    );
  });

  it('is null when no engagement remains or there are no slots', () => {
    expect(planOutlook([], NOWP)).toBeNull();
    expect(planOutlook([{ start: '2026-07-30T09:00:00Z', batteryKw: 0 }], NOWP)).toBeNull();
    expect(planOutlook(slots, new Date('2026-07-30T20:00:00Z'))).toBeNull();
  });

  it('nextChargeStart returns the next charge, skipping an intervening discharge', () => {
    const s = [
      { start: '2026-07-30T10:00:00Z', batteryKw: -3 },
      { start: '2026-07-30T12:00:00Z', batteryKw: 5 },
    ];
    expect(nextChargeStart(s, new Date('2026-07-30T09:00:00Z'))).toBe('2026-07-30T12:00:00Z');
    expect(
      nextChargeStart([{ start: '2026-07-30T10:00:00Z', batteryKw: -3 }], new Date('2026-07-30T09:00:00Z')),
    ).toBeNull();
  });
});

// --- the REASON line (owner's Pilsting question, 2026-07-30) ------------------
//
// "Fahrplan-Sollwert 10,8 kW → Wechselrichter bestätigt 10,8 kW" states a
// command and its confirmation and reads like a stubborn order. The strip now
// carries the plan's OWN reason for that setpoint - taken from the optimizer's
// per-slot why-layer, never invented here.
describe('controlStrip reason', () => {
  const REASON =
    'Lädt günstig aus dem Netz: Börsenpreis 3,3 ct/kWh liegt unter dem Wert gespeicherter Energie (≈ 28,0 ct/kWh).';

  it('carries the reason on the states that show a setpoint', () => {
    const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    expect(controlStrip(status({}), NOW, false, REASON)!.reason).toBe(REASON);
    expect(controlStrip(status({ allMatch: false }), NOW, false, REASON)!.reason).toBe(REASON);
    expect(controlStrip(status({ checkedAt: old }), NOW, false, REASON)!.reason).toBe(REASON);
  });

  it('never explains a setpoint that is not being executed', () => {
    // Off / not released / no readback yet: naming a plan reason there would
    // claim something is happening that is not.
    expect(controlStrip(status({ controlEnabled: false }), NOW, false, REASON)!.reason).toBeNull();
    expect(controlStrip(status({ certified: false }), NOW, false, REASON)!.reason).toBeNull();
    expect(controlStrip(null, NOW, true, REASON)!.reason).toBeNull();
  });

  it('claims no cause when the plan recorded none (pre-why run)', () => {
    expect(controlStrip(status({}), NOW).reason).toBeNull();
  });

  it('is the optimizer why-layer, not a second explanation logic', () => {
    // Composed exactly like the page does it: the active slot's recorded role +
    // numbers, through the SHARED slotWhy.
    const slot = {
      start: '2026-07-30T12:30:00Z',
      batteryKw: 10.8,
      priceEurMwh: 33,
      costEur: 0,
      baselineCostEur: 0,
      slotRole: 'guenstig_laden',
      storedValueCtKwh: 28,
      // The price the optimizer decided with - the strip repeats THAT, not the
      // bare spot (P0 Textwahrheit).
      importPriceCtKwh: 13.3,
      importPriceSource: 'preisblatt',
    };
    const reason = slotWhy(slot, 'eigenverbrauch');
    const v = controlStrip(status({}), NOW, false, reason)!;
    expect(v.reason).toContain('Lädt günstig aus dem Netz');
    expect(v.reason).toContain('13,3 ct/kWh');
    // Customer voice: no internal vocabulary in the reason either.
    expect(v.reason).not.toMatch(/register|modbus|MILP|dual|lambda/i);
  });

  it('an unknown role yields no reason - the vocabulary is additive', () => {
    const slot = {
      start: '2026-07-30T12:30:00Z',
      batteryKw: 10.8,
      priceEurMwh: 33,
      costEur: 0,
      baselineCostEur: 0,
      slotRole: 'ein_neuer_modus_2027',
    };
    expect(slotWhy(slot, 'eigenverbrauch')).toBeNull();
  });
});

describe('controlReasonSlot', () => {
  const slots = [
    { start: '2026-07-30T12:15:00Z', slotRole: 'pv_speichern' },
    { start: '2026-07-30T12:30:00Z', slotRole: 'guenstig_laden' },
    { start: '2026-07-30T12:45:00Z', slotRole: 'eigenverbrauch' },
  ];

  it('picks the slot that contains now', () => {
    expect(controlReasonSlot(slots, new Date('2026-07-30T12:44:59Z'))!.slotRole).toBe(
      'guenstig_laden',
    );
    expect(controlReasonSlot(slots, new Date('2026-07-30T12:45:00Z'))!.slotRole).toBe(
      'eigenverbrauch',
    );
  });

  it('is null outside the horizon and on an empty plan', () => {
    expect(controlReasonSlot(slots, new Date('2026-07-30T14:00:00Z'))).toBeNull();
    expect(controlReasonSlot(slots, new Date('2026-07-30T11:00:00Z'))).toBeNull();
    expect(controlReasonSlot([], NOW)).toBeNull();
  });
});

// --- the EXECUTION line (PR 3 des Fahrplan-Konzepts, 2026-08-02) -------------
//
// Seit den In-Slot-Pflichten trägt `commandedKw` den KORRIGIERTEN Wert, aber
// nichts sagte warum: der Plan-Balken zeigte -4,3 kW, die Steuerungs-Karte
// -6,1 kW, beide ohne Erklärung. Der Heartbeat trägt die Richtung jetzt mit,
// und eine unbenannte Korrektur liest sich als Defekt.
describe('executionNote', () => {
  it('names the RAISED discharge with plan and measured house demand', () => {
    // Die Live-Konstellation vom 30.07., 21:22 (Anlage Pilsting).
    const note = executionNote(
      status({
        commandedKw: -7.087,
        confirmedKw: -7.087,
        executionMode: 'follow',
        executionDirection: 'deepen',
        executionPlannedKw: -4.332,
        executionTargetKw: 7.087,
      }),
    )!;
    expect(note).toContain('4,3');
    expect(note).toContain('7,1');
    expect(note).toContain('angehoben');
    // Die Richtung ist ein WORT - nie ein Minuszeichen am Betrag.
    expect(note).not.toContain('−4,3');
    expect(note).not.toContain('-4,3');
  });

  it('names the LIMITED discharge as its own deliberate correction', () => {
    // Der Spiegel (23:12): der Plan entlud tiefer, als das Haus brauchte.
    const note = executionNote(
      status({
        executionMode: 'follow',
        executionDirection: 'reduce',
        executionPlannedKw: -6.7,
        executionTargetKw: 5.1,
      }),
    )!;
    expect(note).toContain('begrenzt');
    expect(note).toContain('5,1');
    expect(note).not.toContain('angehoben');
  });

  it('names the price-aware trim on the charge side', () => {
    const note = executionNote(
      status({
        executionMode: 'trim',
        executionPlannedKw: 11.1,
        executionTargetKw: 3.1,
      }),
    )!;
    expect(note).toContain('Solar-Überschuss');
    expect(note).toContain('3,1');
    // Eine Ladung hat keine Nachführungs-Richtung - sie darf keine erfinden.
    expect(note).not.toContain('angehoben');
    expect(note).not.toContain('begrenzt');
  });

  it('names the built-in rule when no plan drives the device', () => {
    const note = executionNote(status({ executionMode: 'fallback' }))!;
    expect(note).toContain('Sicherung');
    expect(note).toContain('kein aktueller Fahrplan');
  });

  it('names the general deficit coverage without claiming a price verdict', () => {
    const note = executionNote(
      status({
        executionMode: 'deficit_cover',
        executionPlannedKw: 0,
        executionTargetKw: 1.4,
        executionFloorSocPct: 35,
      }),
    )!;
    expect(note).toContain('aus dem Speicher gedeckt');
    expect(note).toContain('1,4');
    expect(note).toContain('keine Ladung');
    // Kein Preis-Urteil: die Ökonomie bleibt beim Fahrplan, das ist eine
    // Vertrauensregel gegen sichtbaren Netzbezug.
    expect(note).not.toMatch(/teurer|billiger|lohnt|Preis/i);
    expect(EXECUTION_MODE_LABEL.deficit_cover).toBe('Live-Lastdeckung');
  });

  it('names the bounded full-battery correction instead of pretending it was an economic grant', () => {
    const note = executionNote(
      status({
        executionMode: 'high_soc_follow',
        executionPlannedKw: 0,
        executionTargetKw: 4.1,
        executionFloorSocPct: 90,
      }),
    )!;
    expect(note).toContain('nahezu voll');
    expect(note).toContain('4,1');
    expect(note).toContain('kleines oberes Pufferfenster');
    expect(EXECUTION_MODE_LABEL.high_soc_follow).toBe('Vollakku-Entlastung');
  });

  it('explains the symmetric PV refill in a cover-load slot without inventing a price verdict', () => {
    const note = executionNote(
      status({
        executionMode: 'high_soc_charge',
        executionPlannedKw: -4.3,
        executionTargetKw: 8.5,
      }),
    )!;
    expect(note).toContain('Solar-Überschuss');
    expect(note).toContain('8,5');
    expect(note).toContain('oberen PV-Puffer');
    expect(note).toContain('Verbrauchs-Slot');
    expect(note).not.toContain('mehr wert');
    expect(EXECUTION_MODE_LABEL.high_soc_charge).toBe('PV-Puffer-Nachladung');
  });

  it('names the plan under-estimate for the charge-side trust floor, not a price verdict', () => {
    // Die Live-Konstellation (Herzogau 29.08.2026 10:53): Fahrplan +9,82 kW,
    // gemessener Überschuss 27,894 kW, ~18 kW ins Netz bei negativem Preis.
    const note = executionNote(
      status({
        executionMode: 'surplus_store',
        executionPlannedKw: 9.82,
        executionTargetKw: 27.894,
      }),
    )!;
    expect(note).toContain('9,8');
    expect(note).toContain('27,9');
    expect(note).toContain('zu niedrig geschätzt');
    expect(note).toContain('Netzstrom wird dabei nie');
    // Weder die Wolken-Wertung noch der enge Vollakku-Fall dürfen hier stehen.
    expect(note).not.toContain('mehr wert');
    expect(note).not.toContain('PV-Puffer');
    expect(EXECUTION_MODE_LABEL.surplus_store).toBe('Live-Überschussladung');
  });

  it('claims nothing for an uncorrected slot or an older edge', () => {
    expect(executionNote(status({ executionMode: 'plan' }))).toBeNull();
    expect(executionNote(status({}))).toBeNull();
    expect(executionNote(null)).toBeNull();
  });

  it('drops the measured half instead of inventing a 0', () => {
    const note = executionNote(
      status({ executionMode: 'follow', executionDirection: 'deepen', executionPlannedKw: -4 }),
    )!;
    expect(note).toContain('angehoben');
    expect(note).not.toContain('0,0 kW');
  });

  it('names a correction without a reported direction, but invents none', () => {
    const note = executionNote(status({ executionMode: 'follow', executionTargetKw: 5 }))!;
    expect(note).toContain('gemessenen Verbrauch');
    expect(note).not.toContain('angehoben');
    expect(note).not.toContain('begrenzt');
  });

  it('speaks the direction as a customer word', () => {
    expect(directionLabel('deepen')).toBe('angehoben');
    expect(directionLabel('reduce')).toBe('begrenzt');
    expect(directionLabel(null)).toBeNull();
  });
});

describe('controlStrip execution', () => {
  const followed = {
    executionMode: 'follow' as const,
    executionDirection: 'deepen' as const,
    executionPlannedKw: -4.332,
    executionTargetKw: 7.087,
  };

  it('rides on the states that show a setpoint', () => {
    const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    expect(controlStrip(status(followed), NOW)!.execution).toContain('angehoben');
    expect(controlStrip(status({ ...followed, allMatch: false }), NOW)!.execution).toContain('angehoben');
    expect(controlStrip(status({ ...followed, checkedAt: old }), NOW)!.execution).toContain('angehoben');
  });

  it('never explains a correction while nothing is being executed', () => {
    expect(controlStrip(status({ ...followed, controlEnabled: false }), NOW)!.execution).toBeNull();
    expect(controlStrip(status({ ...followed, certified: false }), NOW)!.execution).toBeNull();
    expect(controlStrip(null, NOW, true)!.execution).toBeNull();
  });

  it('stays exactly as before for an older edge', () => {
    expect(controlStrip(status({}), NOW)!.execution).toBeNull();
  });

  it('keeps the customer voice (no register/Modbus vocabulary)', () => {
    const v = controlStrip(status(followed), NOW)!;
    expect(v.execution!).not.toMatch(/register|modbus|setpoint|guard|trim|follow/i);
  });
});

describe('controlStrip · die Abregel-Wahrheit (PR 3)', () => {
  /**
   * Die EINSPEISE-Begrenzung ist ein anderer Steuerpfad als der
   * Batterie-Sollwert. Genau das verbarg die Karte bis PR 3: „bestätigt
   * 0,0 kW" deckte nur die Batterie, während die Anlage sichtbar einspeiste.
   */
  const truth = (over: Partial<Parameters<typeof curtailTruth>[0] & object> = {}) =>
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
        checkedAt: '2026-07-08T12:00:05Z',
        ...over,
      },
      NOW,
    );

  it('bleibt ohne Beleg exakt wie vorher - keine Zeile, keine Behauptung', () => {
    expect(controlStrip(status({}), NOW)!.curtailment).toBeNull();
    expect(controlStrip(status({}), NOW, false, null, CURTAIL_PLAN)!.curtailment).toBeNull();
  });

  it('nennt mit Beleg die Ursache bzw. die Bestätigung', () => {
    expect(
      controlStrip(status({}), NOW, false, null, truth({ certifiedUnits: 0, active: false, allMatch: null }))!
        .curtailment,
    ).toBe('Ihre Anlage setzt das noch nicht um (0 von 2 Wechselrichtern freigegeben).');
    expect(controlStrip(status({}), NOW, false, null, truth())!.curtailment).toContain(
      'vom Wechselrichter bestätigt',
    );
  });

  it('erklärt nie eine Abregelung, während gar nicht gesteuert wird', () => {
    // Dieselbe Regel wie bei `execution`: eine Aussage über eine Ausführung,
    // die nicht stattfindet, wäre eine Behauptung.
    expect(
      controlStrip(status({ controlEnabled: false }), NOW, false, null, truth())!.curtailment,
    ).toBeNull();
    expect(controlStrip(status({ certified: false }), NOW, false, null, truth())!.curtailment).toBeNull();
    expect(controlStrip(null, NOW, true, null, truth())!.curtailment).toBeNull();
  });

  it('bleibt in der Kundensprache (kein Register-/Modbus-Vokabular)', () => {
    const v = controlStrip(status({}), NOW, false, null, truth())!;
    expect(v.curtailment!).not.toMatch(/register|modbus|setpoint|guard|sunspec|curtail/i);
  });
});

// --- Die Anlage OHNE Ladestand (Live-Fall Mühlfeldweg 2, 21.08.2026) --------

describe('controlStrip: eine Anlage ohne Ladestand sagt es beim Namen', () => {
  const basis = {
    deviceId: 'd1',
    commandedKw: null,
    confirmedKw: null,
    allMatch: false,
    controlEnabled: true,
    certified: false,
    mismatchRoles: null,
    slotStart: null,
    checkedAt: new Date('2026-08-21T12:00:00Z').toISOString(),
  };
  const jetzt = new Date('2026-08-21T12:00:10Z');

  it('nennt den fehlenden Ladestand statt „VoltPilot prüft es am Prüfstand"', () => {
    const v = controlStrip(
      { ...basis, platformCertVerdict: 'not_covered' },
      jetzt,
      true,
      null,
      undefined,
      null,
      false,
      true,
    );
    expect(v?.state).toBe('pending');
    expect(v?.sentence).toBe(OHNE_LADESTAND_SATZ);
    expect(v?.sentence).toContain('Sobald das BMS gekoppelt ist');
    expect(v?.sentence).not.toContain('Prüfstand');
  });

  it('sagt ohne die Ausnahme byte-gleich dasselbe wie vorher', () => {
    const status = { ...basis, platformCertVerdict: 'not_covered' };
    expect(controlStrip(status, jetzt, true, null, undefined, null, false, false)).toEqual(
      controlStrip(status, jetzt, true),
    );
  });

  it('behauptet auf einer TROTZDEM steuernden Anlage nichts - sie läuft ja', () => {
    const v = controlStrip(
      { ...basis, certified: true, allMatch: true, commandedKw: -4, confirmedKw: -4 },
      jetzt,
      true,
      null,
      undefined,
      null,
      false,
      true,
    );
    expect(v?.state).toBe('healthy');
    expect(v?.sentence).not.toContain('nicht möglich');
  });
});

// --- Der Flussabgleich in der Steuerzeile (Pause, fließt aber; Pilsting) -----

describe('controlStrip: der Flussabgleich versöhnt „pausiert" mit dem Flussbild', () => {
  // Bestätigte Pause (commanded ≈ 0) - genau die Lage, in der die Steuerzeile
  // „Der Speicher pausiert gerade" sagte, während das Flussbild „lädt 10,0 kW"
  // zeigte.
  const pause = status({ commandedKw: 0, confirmedKw: 0 });

  it('info: ersetzt den gesunden Satz, bleibt GRÜN und behält den Grund', () => {
    const v = controlStrip(pause, NOW, true, 'GRUND', CURTAIL_PLAN, null, true, false, {
      severity: 'info',
      text: 'INFO-TEXT',
    })!;
    expect(v.state).toBe('healthy');
    expect(v.tone).toBe('ok');
    expect(v.sentence).toBe('INFO-TEXT');
    // surplusActive true → keine PV_CLARIFICATION angehängt, der Grund bleibt.
    expect(v.reason).toBe('GRUND');
  });

  it('warn: bernstein, der Plan-Grund tritt zurück (er würde die Warnung überlagern)', () => {
    const v = controlStrip(pause, NOW, true, 'GRUND', CURTAIL_PLAN, '→ AUSBLICK', true, false, {
      severity: 'warn',
      text: 'WARN-TEXT',
    })!;
    expect(v.state).toBe('healthy');
    expect(v.tone).toBe('warn');
    expect(v.sentence).toBe('WARN-TEXT');
    expect(v.reason).toBeNull();
    expect(v.execution).toBeNull();
    expect(v.curtailment).toBeNull();
    expect(v.outlook).toBeNull();
  });

  it('ohne Flussabgleich unverändert der gesunde Pausen-Satz', () => {
    const v = controlStrip(pause, NOW)!;
    expect(v.tone).toBe('ok');
    expect(v.sentence).toContain('pausiert');
    expect(v.sentence).not.toBe('WARN-TEXT');
  });

  it('greift nur im bestätigten Zustand - ein Not-Aus bleibt aus', () => {
    const v = controlStrip(
      status({ controlEnabled: false }),
      NOW,
      true,
      null,
      CURTAIL_PLAN,
      null,
      false,
      false,
      { severity: 'warn', text: 'WARN-TEXT' },
    )!;
    expect(v.state).toBe('off');
    expect(v.sentence).not.toBe('WARN-TEXT');
  });
});

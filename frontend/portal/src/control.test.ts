import { describe, expect, it } from 'vitest';
import type { ControlStatus } from './api';
import { controlReasonSlot, controlStrip, directionLabel, executionNote } from './control';
import { slotWhy } from './fahrplanWhy';

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
    // unter „Fahrplan" auf EINEM Bildschirm.
    for (const v of [
      controlStrip(status({}), NOW)!,
      controlStrip(status({ allMatch: false, confirmedKw: -1.2 }), NOW)!,
      controlStrip(
        status({ checkedAt: new Date(NOW.getTime() - 6 * 60 * 1000).toISOString() }),
        NOW,
      )!,
    ]) {
      expect(v.sentence).not.toContain('Fahrplan-Sollwert');
    }
    expect(controlStrip(status({}), NOW)!.sentence).toContain('regelt gerade auf');
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

  it('never leaks internal vocabulary into any state', () => {
    for (const over of [{}, { allMatch: false }, { controlEnabled: false }, { certified: false }]) {
      const v = controlStrip(status(over), NOW)!;
      expect(v.sentence).not.toMatch(/register|modbus|kill-switch|readback/i);
    }
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

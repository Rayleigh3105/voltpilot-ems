import { describe, expect, it } from 'vitest';
import {
  ANBINDEN_SCHRITTE,
  aktivierenFolgen,
  ausfallSchutz,
  budgetBand,
  chargerName,
  chargerView,
  connectorName,
  failsafeSum,
  grenzeFehler,
  idleLine,
  ladevorgangRows,
  PV_UEBERSCHUSS_OHNE_PV,
  turnIn,
  type ChargePoint,
  type ChargingBudget,
} from './ladepunkte';

/**
 * Das Beispiel-Szenario der abgenommenen Mockups, 13:24 Uhr: 277 kW Anschluss,
 * 10 % Sicherheitsabstand, 167 kW Gebäude → 82,3 kW Ladebudget, drei Säulen à
 * zwei Steckern, zwei laden, einer wartet.
 */
const budget: ChargingBudget = {
  deviceId: 'd1',
  enabled: true,
  controlEnabled: true,
  gridLimitKw: 277,
  effLimitKw: 277,
  marginPct: 10,
  minPowerKw: 30,
  budgetKw: 82.3,
  allocatedKw: 82,
  measuredKw: 79,
  siteLoadKw: 167,
  siteGridKw: 246,
  budgetMode: 'gemessen',
  budgetNote: 'Das Budget folgt der Messung am Netzanschluss.',
  budgetBlind: false,
  safeDefaultKw: 15,
  safeDefaultHolds: true,
  safeWorstCaseKw: 270,
  maxHouseLoadKw: 180,
  connectorCount: 6,
};

const saeule = (over: Partial<ChargePoint> = {}): ChargePoint => ({
  deviceId: 'd1',
  chargePointId: 'saeule-1',
  label: 'Hof Nord',
  priority: false,
  connected: true,
  ready: true,
  connectors: [],
  ...over,
});

describe('budgetBand', () => {
  it('zeigt die Bühne der Mockups mit Grenze, Segmenten und Kernaussage', () => {
    const band = budgetBand(budget)!;
    expect(band.limitKw).toBe(277);
    expect(band.headline).toBe('246 kW von 277 kW');
    expect(band.segments.map((s) => s.id)).toEqual(['gebaeude', 'laden', 'abstand', 'frei']);
    // Der Sicherheitsabstand ist schraffiert UND beschriftet (K10).
    expect(band.segments.find((s) => s.id === 'abstand')).toMatchObject({
      hatched: true,
      label: 'Sicherheitsabstand',
    });
    expect(band.line).toContain('Ihr Anschluss ist geschützt');
    // ⚠ Der Satz der BOX wird durchgereicht, nie neu formuliert.
    expect(band.sourceLine).toBe('Das Budget folgt der Messung am Netzanschluss.');
  });

  it('behauptet ohne Anschlussgrenze KEIN Band, sondern nennt die Lücke', () => {
    const band = budgetBand({ ...budget, gridLimitKw: null, effLimitKw: null })!;
    expect(band.limitKw).toBeNull();
    expect(band.headline).toBeNull();
    expect(band.line).toContain('Anschlussgrenze ist noch nicht hinterlegt');
  });

  it('erfindet ohne gemessene Gebäudelast kein Gebäude-Segment', () => {
    const band = budgetBand({ ...budget, siteLoadKw: null })!;
    expect(band.segments.some((s) => s.id === 'gebaeude')).toBe(false);
    expect(band.line).toContain('misst diese Anlage noch nicht');
  });

  it('ohne Budget-Block gibt es gar kein Band', () => {
    expect(budgetBand(null)).toBeNull();
  });
});

describe('ladevorgangRows', () => {
  const laden = saeule({
    connectors: [
      {
        connectorId: 1,
        status: 'Charging',
        charging: true,
        allocatedKw: 41,
        powerKw: 40,
        socPct: 62,
        reasonText: 'lädt',
        sessionSince: '2026-08-20T08:41:00Z',
      },
      {
        connectorId: 2,
        status: 'Preparing',
        charging: false,
        allocatedKw: 0,
        reasonText: 'wartet - Budget vergeben',
        nextTurn: '2026-08-20T11:26:00Z',
        sessionSince: '2026-08-20T09:10:00Z',
      },
    ],
  });

  it('trägt Wort, Grund und Zahlen - und nennt den Stecker beim Namen', () => {
    const rows = ladevorgangRows([laden], Date.parse('2026-08-20T11:24:00Z'));
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Hof Nord · Stecker A');
    expect(rows[0].word).toBe('lädt');
    expect(rows[0].tone).toBe('laedt');
    // Der Grund wiederholt das Wort NICHT - zweimal „lädt" ist Rauschen.
    expect(rows[0].reason).toBeNull();
    expect(rows[0].powerKw).toBe(40);
    expect(rows[0].socPct).toBe(62);
    // Warten ist kein Fehler: grau, aber IMMER mit Grund und Termin.
    expect(rows[1].word).toBe('wartet');
    expect(rows[1].tone).toBe('ruhig');
    expect(rows[1].reason).toBe('wartet - Budget vergeben');
    expect(rows[1].nextTurn).toBe('dran in ca. 2 Min.');
  });

  it('behauptet für eine getrennte Säule GAR NICHTS', () => {
    expect(ladevorgangRows([{ ...laden, connected: false }])).toEqual([]);
  });

  it('macht aus einem fehlenden Messwert keine 0', () => {
    const rows = ladevorgangRows([
      saeule({ connectors: [{ connectorId: 1, status: 'Available', charging: false }] }),
    ]);
    expect(rows[0].powerKw).toBeNull();
    expect(rows[0].allocatedKw).toBeNull();
    expect(rows[0].socPct).toBeNull();
  });

  it('sagt den Leerlauf ehrlich statt Nullzeilen zu erfinden', () => {
    const line = idleLine({
      budget,
      chargers: [saeule({ connectors: [{ connectorId: 1, status: 'Available', charging: false }] })],
    });
    expect(line).toBe('Gerade lädt niemand - alle 6 Stecker sind frei.');
    // Sobald einer lädt, gibt es keinen Leerlauf-Satz mehr.
    expect(idleLine({ budget, chargers: [laden] })).toBeNull();
  });
});

describe('turnIn', () => {
  it('nennt einen Termin nur, wenn einer gemeldet wurde', () => {
    expect(turnIn(null)).toBeNull();
    expect(turnIn('keine zeit')).toBeNull();
    expect(turnIn('2026-08-20T11:26:00Z', Date.parse('2026-08-20T11:24:00Z'))).toBe(
      'dran in ca. 2 Min.',
    );
    expect(turnIn('2026-08-20T11:24:00Z', Date.parse('2026-08-20T11:26:00Z'))).toBe(
      'dran in Kürze',
    );
  });
});

describe('chargerView', () => {
  it('nennt bei einer getrennten Säule die FOLGE, nicht nur die Tatsache', () => {
    const view = chargerView(saeule({ connected: false, lastSeen: '2026-08-20T10:00:00Z' }));
    expect(view.state).toBe('getrennt');
    expect(view.detail).toContain('Sicherheitsprofil');
  });

  it('nennt eine nie gesehene Säule normal - das ist die Einrichtung', () => {
    const view = chargerView(saeule({ connected: false, ready: false }));
    expect(view.state).toBe('nie_gesehen');
    expect(view.detail).toContain('normal');
  });

  it('nimmt den Namen des Betreibers, sonst die Kennung - nie einen erfundenen', () => {
    expect(chargerName(saeule())).toBe('Hof Nord');
    expect(chargerName(saeule({ label: '  ' }))).toBe('saeule-1');
    expect(connectorName(2)).toBe('Stecker B');
  });
});

describe('Ausfall-Schutz', () => {
  it('zeigt die RECHNUNG statt einer nackten Zahl', () => {
    expect(failsafeSum(budget)).toBe(
      '6 Stecker × 15 kW + höchste Gebäudelast 180 kW = 270 kW < Grenze 277 kW ✓',
    );
    const steps = ausfallSchutz(budget);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toContain('läuft nach 2 Minuten von selbst ab');
    expect(steps[2]).toContain('270 kW');
  });

  it('rechnet NICHT, wenn eine Zahl fehlt - und behauptet dann keine Summe', () => {
    expect(failsafeSum({ ...budget, maxHouseLoadKw: null })).toBeNull();
    const steps = ausfallSchutz({ ...budget, maxHouseLoadKw: null });
    expect(steps).toHaveLength(2);
  });

  it('sagt es, wenn die Rechnung NICHT aufgeht - „hält" wäre eine Lüge', () => {
    const sum = failsafeSum({ ...budget, safeDefaultHolds: false, safeWorstCaseKw: 300 })!;
    expect(sum).toContain('>');
    expect(sum).not.toContain('✓');
  });
});

describe('Aktivieren-Dialog', () => {
  it('nennt die Grenze und sagt, was GLEICH bleibt', () => {
    const folgen = aktivierenFolgen(277);
    expect(folgen[0]).toContain('277 kW');
    expect(folgen.some((f) => f.includes('Ausfall-Schutz'))).toBe(true);
  });

  it('lehnt eine unplausible Eingabe VOR dem Speichern ab', () => {
    expect(grenzeFehler('277')).toBeNull();
    expect(grenzeFehler('277,5')).toBeNull();
    expect(grenzeFehler('0')).toContain('größer 0');
    expect(grenzeFehler('-5')).toContain('größer 0');
    expect(grenzeFehler('abc')).toContain('größer 0');
    expect(grenzeFehler('250000')).toContain('unplausibel');
  });
});

describe('Anbinden', () => {
  it('dreht die Richtung im ERSTEN Satz um und behauptet keine Adresse', () => {
    expect(ANBINDEN_SCHRITTE[0]).toContain('verbinden sich selbst');
    // ⚠ Die Box kennt ihren LAN-Namen nicht - das Portal nennt den WEG, nie
    // eine erfundene Adresse auf einem Kopier-Feld.
    expect(ANBINDEN_SCHRITTE.join(' ')).not.toMatch(/ws:\/\//);
    expect(ANBINDEN_SCHRITTE[1]).toContain('Geräteseite');
  });

  it('graut die Überschuss-Karte MIT Grund aus, statt sie zu verstecken', () => {
    expect(PV_UEBERSCHUSS_OHNE_PV).toContain('nicht verfügbar');
    expect(PV_UEBERSCHUSS_OHNE_PV).toContain('keine PV');
  });
});

/* --- Der Ladepunkt im Anlagen-Modell ------------------------------------- */

import { plantModel } from './komponenten';

describe('Anlagen-Modell', () => {
  it('nennt einen Ladepunkt nicht „schaltbar per Regel" - das wäre falsch', () => {
    const model = plantModel(
      [
        {
          id: 'e1',
          entityType: 'ev-charger',
          typeLabel: 'Ladepunkt',
          label: 'Hof Nord',
          control: false,
          capabilities: { measure: [{ channel: 'power_kw' }], actuate: [] },
        } as never,
      ],
      null,
      [],
      null,
    );
    const charger = model.components.find((c) => c.entityId === 'e1')!;
    expect(charger.label).toBe('Hof Nord');
    // Seine Leistung verteilt das Lastmanagement auf der Box - nicht eine Regel.
    expect(charger.summary).toContain('das Lastmanagement');
    expect(charger.summary).not.toContain('Regel');
  });
});

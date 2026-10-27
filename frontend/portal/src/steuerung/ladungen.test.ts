import { describe, expect, it } from 'vitest';
import { letzteLadungen, transaktionsKwh } from './ladungen';
import type { OcppTransaction } from '../api';

function tx(overrides: Partial<OcppTransaction>): OcppTransaction {
  return {
    deviceId: 'd1',
    chargePointId: 'cp-1',
    transactionId: 1,
    connectorId: 1,
    startedAt: '2026-10-20T08:00:00Z',
    stoppedAt: '2026-10-20T10:00:00Z',
    meterStart: 1000,
    meterStop: 8400,
    stopReason: null,
    startIdTagRef: null,
    stopIdTagRef: null,
    reservationId: null,
    chargingProfileId: null,
    chargingProfilePurpose: null,
    startAuthStatus: null,
    stopAuthStatus: null,
    parentIdTagRef: null,
    transactionData: null,
    transactionDataPurgedAt: null,
    ...overrides,
  };
}

describe('transaktionsKwh', () => {
  it('rechnet die Menge aus Start- und Endzählerstand (Wh zu kWh)', () => {
    expect(transaktionsKwh(tx({ meterStart: 1000, meterStop: 8400 }))).toBeCloseTo(7.4);
  });

  it('ist null ohne Endzählerstand (laufende Sitzung)', () => {
    expect(transaktionsKwh(tx({ meterStop: null }))).toBeNull();
  });

  it('ist null bei einem negativen Delta (kaputter Zählerstand) statt einer falschen Zahl', () => {
    expect(transaktionsKwh(tx({ meterStart: 9000, meterStop: 1000 }))).toBeNull();
  });
});

describe('letzteLadungen', () => {
  it('nimmt nur beendete Ladungen desselben Ladepunkts, neueste zuerst', () => {
    const laufend = tx({ transactionId: 1, chargePointId: 'cp-1', startedAt: '2026-10-21T09:00:00Z', stoppedAt: null });
    const alt = tx({ transactionId: 2, chargePointId: 'cp-1', startedAt: '2026-10-19T09:00:00Z', stoppedAt: '2026-10-19T11:00:00Z', meterStart: 0, meterStop: 10_000 });
    const neu = tx({ transactionId: 3, chargePointId: 'cp-1', startedAt: '2026-10-20T08:00:00Z', stoppedAt: '2026-10-20T10:00:00Z', meterStart: 1000, meterStop: 8400 });
    const andererLadepunkt = tx({ transactionId: 4, chargePointId: 'cp-2', startedAt: '2026-10-20T12:00:00Z', stoppedAt: '2026-10-20T13:00:00Z' });

    const zeilen = letzteLadungen([laufend, alt, neu, andererLadepunkt], 'cp-1');

    expect(zeilen.map((z) => z.key)).toEqual(['cp-1-3', 'cp-1-2']);
    expect(zeilen[0].kwh).toBeCloseTo(7.4);
  });

  it('begrenzt auf n Zeilen', () => {
    const txs = [1, 2, 3, 4].map((id) => tx({ transactionId: id, startedAt: `2026-10-${10 + id}T08:00:00Z`, stoppedAt: `2026-10-${10 + id}T10:00:00Z` }));
    expect(letzteLadungen(txs, 'cp-1', 2)).toHaveLength(2);
  });

  it('ist leer ohne Daten', () => {
    expect(letzteLadungen(null, 'cp-1')).toEqual([]);
    expect(letzteLadungen(undefined, 'cp-1')).toEqual([]);
  });
});

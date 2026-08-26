import { describe, expect, it } from 'vitest';
import type { OcppAction, OcppActionIntent, OcppMeterSample, OcppStation, OcppTransaction } from './api';
import {
  OCPP_ACTIONS,
  actionFingerprint,
  actionHandoffCode,
  actionNeedsIntent,
  actionNeedsPolling,
  actionRequest,
  actionState,
  maskReference,
  parseActionHandoff,
  redactSensitiveText,
  safeActionError,
  safeJson,
  stationConnection,
  wallboxHero,
  wallboxState,
} from './ocppWallbox';

const action = (overrides: Partial<OcppAction>): OcppAction => ({
  id: 'a', deviceId: 'd', chargePointId: 'CP-1', action: 'SetChargingProfile',
  state: 'effect_observed', correlationId: 'c', idempotencyKey: 'i', actor: 'demo',
  connectorId: 1, transactionId: 42, request: {}, response: {}, responseStatus: 'Accepted',
  effect: {}, reason: null, preparedAt: '2026-08-25T08:00:00Z', sentAt: null,
  responseAt: null, effectAt: null, deadlineAt: '2026-08-25T08:01:00Z',
  updatedAt: '2026-08-25T08:00:00Z', ...overrides,
});

describe('OCPP wallbox view model', () => {
  it('contains every OCPP 1.6 action exactly once in the three progressive groups', () => {
    expect(OCPP_ACTIONS).toHaveLength(20);
    expect(new Set(OCPP_ACTIONS.map((item) => item.action)).size).toBe(20);
    expect(new Set(OCPP_ACTIONS.map((item) => item.group))).toEqual(new Set(['alltag', 'betrieb', 'protokoll']));
    expect(OCPP_ACTIONS.filter((item) => item.role === 'platform-admin').map((item) => item.action))
      .toEqual(expect.arrayContaining(['HardReset', 'GetDiagnostics', 'UpdateFirmware', 'DataTransfer']));
  });

  it('builds schema-bound payloads and never accepts free DataTransfer JSON', () => {
    expect(actionRequest('DataTransfer', { nonce: 'probe-7' })).toEqual({
      schemaId: 'voltpilot.health-check.v1', vendorId: 'de.voltpilot',
      messageId: 'HealthCheck', data: { nonce: 'probe-7' },
    });
    expect(actionRequest('GetConfiguration', { keys: 'HeartbeatInterval, MeterValueSampleInterval' }))
      .toEqual({ key: ['HeartbeatInterval', 'MeterValueSampleInterval'] });
    const limitedStart = { connectorId: '1', idTag: 'TAG-1', profileLimit: '11' };
    expect(actionRequest('RemoteStartTransaction', limitedStart, 'same-operation'))
      .toEqual(actionRequest('RemoteStartTransaction', limitedStart, 'same-operation'));
    expect(actionRequest('RemoteStartTransaction', limitedStart, 'same-operation'))
      .not.toEqual(actionRequest('RemoteStartTransaction', limitedStart, 'new-operation'));
  });

  it('requires a server intent for hard reset, firmware and full LocalAuth replacement', () => {
    expect(actionNeedsIntent('HardReset', {})).toBe(true);
    expect(actionNeedsIntent('UpdateFirmware', {})).toBe(true);
    expect(actionNeedsIntent('SendLocalList', { updateType: 'Full' })).toBe(true);
    expect(actionNeedsIntent('SendLocalList', { updateType: 'Differential' })).toBe(false);
  });

  it('makes a live transaction the hero and derives session energy from the register delta', () => {
    const tx: OcppTransaction = {
      deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1,
      startedAt: '2026-08-25T08:00:00Z', stoppedAt: null, meterStart: 1000,
      meterStop: null, stopReason: null, startIdTagRef: 'secret-ref', stopIdTagRef: null,
      reservationId: null, chargingProfileId: null, chargingProfilePurpose: null,
      startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
      transactionData: null, transactionDataPurgedAt: null,
    };
    const sample = (measurand: string, numericValue: number, unit: string): OcppMeterSample => ({
      sampledAt: '2026-08-25T08:42:00Z', eventId: measurand, meterValueIndex: 0,
      sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1,
      transactionId: 42, source: 'MeterValues', pointKey: measurand, measurand,
      context: 'Sample.Periodic', format: 'Raw', phase: null, location: 'Outlet',
      unit, value: String(numericValue), numericValue,
    });
    const hero = wallboxHero([tx], [sample('Power.Active.Import', 11000, 'W'), sample('Energy.Active.Import.Register', 7400, 'Wh')], [
      action({ updatedAt: '2026-08-25T08:42:00Z', request: { csChargingProfiles: { chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 11000 }] } } } }),
      action({ id: 'b', action: 'GetCompositeSchedule', state: 'completed', updatedAt: '2026-08-25T08:42:00Z', response: { chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 11000 }] } }, effect: null }),
    ], Date.parse('2026-08-25T08:42:00Z'));
    expect(hero.power).toBe('11 kW');
    expect(hero.energy).toBe('6,4 kWh');
    expect(hero.duration).toBe('42 min');
    expect(hero.release).toBe('11 kW');
    expect(hero.applied).toBe('11 kW');
  });

  it('does not present a cumulative register or foreign evidence as session energy', () => {
    const tx = {
      deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1,
      startedAt: '2026-08-25T08:00:00Z', stoppedAt: null, meterStart: 8000,
      meterStop: null, stopReason: null, startIdTagRef: null, stopIdTagRef: null,
      reservationId: null, chargingProfileId: null, chargingProfilePurpose: null,
      startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
      transactionData: null, transactionDataPurgedAt: null,
    } satisfies OcppTransaction;
    const sample = {
      sampledAt: '2026-08-25T08:01:00Z', eventId: 'energy', meterValueIndex: 0,
      sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1,
      transactionId: 42, source: 'MeterValues', pointKey: 'Energy.Active.Import.Register',
      measurand: 'Energy.Active.Import.Register', context: null, format: 'Raw', phase: null,
      location: null, unit: 'Wh', value: '7400', numericValue: 7400,
    } satisfies OcppMeterSample;
    expect(wallboxHero([tx], [sample], [], Date.parse('2026-08-25T08:01:00Z')).energy)
      .toBeNull();
    expect(wallboxHero([tx], [{ ...sample, transactionId: 99 }], [], Date.parse('2026-08-25T08:01:00Z')).energy)
      .toBeNull();
  });

  it('maps charging, waiting, available, offline and faulted into customer language', () => {
    const now = Date.parse('2026-08-25T08:42:00Z');
    const base = {
      connected: true, lastSeen: '2026-08-25T08:42:00Z', connectors: [],
    } as unknown as OcppStation;
    const emptyHero = wallboxHero([], [], [], now);
    expect(wallboxState({ ...base, connectors: [{ connectorId: 1, status: 'Available', errorCode: 'NoError' }] } as OcppStation, emptyHero, now))
      .toMatchObject({ kind: 'available', badge: 'Verfügbar', action: 'RemoteStartTransaction' });
    expect(wallboxState({ ...base, connectors: [{ connectorId: 1, status: 'SuspendedEVSE', errorCode: 'NoError' }] } as OcppStation, emptyHero, now))
      .toMatchObject({ kind: 'waiting', badge: 'Wartet', actionLabel: 'Jetzt laden' });
    const activeTransaction = {
      deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1,
      startedAt: '2026-08-25T08:00:00Z', stoppedAt: null, meterStart: 0, meterStop: null,
      stopReason: null, startIdTagRef: null, stopIdTagRef: null, reservationId: null,
      chargingProfileId: null, chargingProfilePurpose: null, startAuthStatus: 'Accepted',
      stopAuthStatus: null, parentIdTagRef: null, transactionData: null, transactionDataPurgedAt: null,
    } satisfies OcppTransaction;
    expect(wallboxState(
      { ...base, connectors: [{ connectorId: 1, status: 'SuspendedEVSE', errorCode: 'NoError' }] } as OcppStation,
      { ...emptyHero, transaction: activeTransaction },
      now,
    )).toMatchObject({ kind: 'waiting', action: 'service', actionLabel: 'Ladevorgang prüfen' });
    expect(wallboxState({ ...base, connectors: [{ connectorId: 1, status: 'Faulted', errorCode: 'GroundFailure' }] } as OcppStation, emptyHero, now))
      .toMatchObject({ kind: 'faulted', badge: 'Störung', action: 'service' });
    expect(wallboxState({ ...base, connected: false } as OcppStation, emptyHero, now))
      .toMatchObject({ kind: 'offline', badge: 'Offline', actionLabel: 'Verbindung prüfen' });
  });

  it('rejects stale or foreign hero evidence and keeps the actual charging-rate unit', () => {
    const now = Date.parse('2026-08-25T09:00:00Z');
    const tx: OcppTransaction = { deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1,
      startedAt: '2026-08-25T08:00:00Z', stoppedAt: null, meterStart: 0, meterStop: null, stopReason: null,
      startIdTagRef: null, stopIdTagRef: null, reservationId: null, chargingProfileId: null,
      chargingProfilePurpose: null, startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
      transactionData: null, transactionDataPurgedAt: null };
    const meter: OcppMeterSample[] = [{ sampledAt: '2026-08-25T08:54:59Z', eventId: 'old', meterValueIndex: 0,
      sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42,
      source: 'MeterValues', pointKey: 'Power.Active.Import', measurand: 'Power.Active.Import', context: null,
      format: 'Raw', phase: null, location: null, unit: 'W', value: '22000', numericValue: 22000 }];
    const actions = [
      action({ id: 'wrong-rejected', state: 'rejected', connectorId: 1, updatedAt: '2026-08-25T08:59:59Z', request: { csChargingProfiles: { chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 22000 }] } } } }),
      action({ id: 'wrong-connector', connectorId: 2, updatedAt: '2026-08-25T08:59:58Z', request: { csChargingProfiles: { chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ limit: 32 }] } } } }),
      action({ id: 'right', connectorId: 1, updatedAt: '2026-08-25T08:59:57Z', request: { csChargingProfiles: { chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ limit: 16 }] } } } }),
      action({ id: 'read-wrong', action: 'GetCompositeSchedule', connectorId: 2, state: 'completed', updatedAt: '2026-08-25T08:59:59Z', response: { chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 22000 }] } } }),
      action({ id: 'read-right', action: 'GetCompositeSchedule', connectorId: 1, state: 'completed', updatedAt: '2026-08-25T08:59:57Z', response: { chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ limit: 16 }] } } }),
    ];
    const hero = wallboxHero([tx], meter, actions, now);
    expect(hero.power).toBeNull();
    expect(hero.release).toBe('16 A');
    expect(hero.applied).toBe('16 A');
  });

  it('rejects fresh successful hero actions without the exact running transaction id', () => {
    const now = Date.parse('2026-08-25T09:00:00Z');
    const tx: OcppTransaction = { deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1,
      startedAt: '2026-08-25T08:00:00Z', stoppedAt: null, meterStart: 0, meterStop: null, stopReason: null,
      startIdTagRef: null, stopIdTagRef: null, reservationId: null, chargingProfileId: null,
      chargingProfilePurpose: null, startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
      transactionData: null, transactionDataPurgedAt: null };
    const schedule = { chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ limit: 32 }] } };
    const hero = wallboxHero([tx], [], [
      action({ state: 'completed', connectorId: 1, transactionId: null, updatedAt: '2026-08-25T08:59:59Z', request: { csChargingProfiles: schedule } }),
      action({ action: 'GetCompositeSchedule', state: 'completed', connectorId: 1, transactionId: null,
        updatedAt: '2026-08-25T08:59:59Z', response: schedule }),
    ], now);
    expect(hero.release).toBe('keine bestätigte Freigabe gemeldet');
    expect(hero.applied).toBe('noch nicht erfolgreich zurückgelesen');
  });

  it('separates OCPP response, observed effect, timeout and late evidence', () => {
    expect(actionState('accepted_waiting_effect')).toMatchObject({ response: expect.stringContaining('angenommen'), effect: expect.stringContaining('noch nicht'), pending: true });
    expect(actionState('timed_out')).toMatchObject({ effect: expect.stringContaining('nicht innerhalb'), pending: false });
    expect(actionState('call_error')).toMatchObject({ response: expect.stringContaining('CallError'), tone: 'error' });
    expect(maskReference('abcdefghi')).toBe('abc••••ghi');
  });

  it('polls through a bounded timeout afterrun and stops after late evidence', () => {
    const timedOut = action({ state: 'timed_out', deadlineAt: '2026-08-25T08:01:00Z', effectAt: null });
    expect(actionNeedsPolling(timedOut, Date.parse('2026-08-25T08:05:00Z'))).toBe(true);
    expect(actionNeedsPolling({ ...timedOut, effectAt: '2026-08-25T08:06:00Z' }, Date.parse('2026-08-25T08:07:00Z'))).toBe(false);
    expect(actionNeedsPolling(timedOut, Date.parse('2026-08-25T08:12:00Z'))).toBe(false);
  });

  it('masks sensitive keys and value-shaped URLs recursively and never echoes raw API errors', () => {
    const text = redactSensitiveText('idTag=TAG-LEAK callback=mqtt://callback.internal/topic endpoint=coap://endpoint.internal uri=urn:private:device url=s3://secret-bucket/key open wss://socket.internal/path');
    const rendered = safeJson({ callbackUrl: 'https://secret.example/token/abc', nested: [{ neutral: text, imsi: '262011234567890' }] });
    expect(text).not.toContain('TAG-LEAK');
    expect(text).not.toContain('callback.internal');
    expect(text).not.toContain('endpoint.internal');
    expect(text).not.toContain('private:device');
    expect(text).not.toContain('secret-bucket');
    expect(text).not.toContain('socket.internal');
    expect(rendered).not.toContain('secret.example');
    expect(rendered).not.toContain('262011234567890');
    expect(safeActionError({ status: 503, message: 'java.net.SocketTimeoutException token=abc' })).not.toContain('token=abc');
  });

  it('creates a bound, expiring four-eyes handoff and stable operation fingerprints', () => {
    const intent: OcppActionIntent = { id: 'intent-1', action: 'UpdateFirmware', phrase: 'Update SAFE', fourEyes: true, expiresAt: '2099-01-01T00:00:00Z' };
    const request = { location: 'https://firmware.example/presigned', sha256: 'a'.repeat(64), signature: 'sig' };
    const code = actionHandoffCode({ version: 1, siteId: 's', chargePointId: 'CP-1', action: 'UpdateFirmware', connectorId: 1, request, intent });
    expect(parseActionHandoff(code, { siteId: 's', chargePointId: 'CP-1', action: 'UpdateFirmware', now: 0 })).toMatchObject({ request, intent });
    expect(() => parseActionHandoff(code, { siteId: 'other', chargePointId: 'CP-1', action: 'UpdateFirmware', now: 0 })).toThrow('binding');
    expect(actionFingerprint('UpdateFirmware', 1, undefined, request)).toBe(actionFingerprint('UpdateFirmware', 1, undefined, { signature: 'sig', sha256: 'a'.repeat(64), location: 'https://firmware.example/presigned' }));
  });

  it('treats connected without a fresh life proof as stale and not sendable', () => {
    const station = { connected: true, lastSeen: '2026-08-25T08:00:00Z' } as OcppStation;
    expect(stationConnection(station, Date.parse('2026-08-25T08:04:59Z'))).toMatchObject({ sendable: true, label: 'Online' });
    expect(stationConnection(station, Date.parse('2026-08-25T08:05:01Z'))).toMatchObject({ sendable: false, label: 'Keine aktuellen Daten' });
  });
});

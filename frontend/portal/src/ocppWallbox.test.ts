import { describe, expect, it } from 'vitest';
import type { OcppAction, OcppMeterSample, OcppTransaction } from './api';
import {
  OCPP_ACTIONS,
  actionNeedsIntent,
  actionRequest,
  actionState,
  maskReference,
  wallboxHero,
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
  });

  it('requires a server intent for hard reset, firmware and full LocalAuth replacement', () => {
    expect(actionNeedsIntent('HardReset', {})).toBe(true);
    expect(actionNeedsIntent('UpdateFirmware', {})).toBe(true);
    expect(actionNeedsIntent('SendLocalList', { updateType: 'Full' })).toBe(true);
    expect(actionNeedsIntent('SendLocalList', { updateType: 'Differential' })).toBe(false);
  });

  it('makes a live transaction the hero and only shows SoC when delivered', () => {
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
      action({ request: { csChargingProfiles: { chargingSchedule: { chargingSchedulePeriod: [{ limit: 11000 }] } } } }),
      action({ id: 'b', action: 'GetCompositeSchedule', state: 'completed', response: { chargingSchedule: { chargingSchedulePeriod: [{ limit: 11000 }] } }, effect: null }),
    ], Date.parse('2026-08-25T08:42:00Z'));
    expect(hero.power).toBe('11 kW');
    expect(hero.energy).toBe('7,4 kWh');
    expect(hero.duration).toBe('42 min');
    expect(hero.soc).toBeNull();
    expect(hero.release).toContain('11.000');
    expect(hero.applied).toContain('11.000');
  });

  it('separates OCPP response, observed effect, timeout and late evidence', () => {
    expect(actionState('accepted_waiting_effect')).toMatchObject({ response: expect.stringContaining('angenommen'), effect: expect.stringContaining('noch nicht'), pending: true });
    expect(actionState('timed_out')).toMatchObject({ effect: expect.stringContaining('nicht innerhalb'), pending: false });
    expect(actionState('call_error')).toMatchObject({ response: expect.stringContaining('CallError'), tone: 'error' });
    expect(maskReference('abcdefghi')).toBe('abc••••ghi');
  });
});

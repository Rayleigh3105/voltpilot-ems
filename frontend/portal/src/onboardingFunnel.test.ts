import { describe, expect, it } from 'vitest';
import type { PendingEnrollment, ProvisionedDevice } from './admin/adminApi';
import { funnelStages, pendingRows, TYPO_SUSPECT_AFTER_MS } from './onboardingFunnel';

const NOW = new Date('2026-08-03T12:00:00Z');

function device(ref: string, claimed: boolean): ProvisionedDevice {
  return {
    externalRef: ref,
    kind: 'inverter',
    note: null,
    provisionedAt: '2026-07-01T00:00:00Z',
    claimed,
    claimedByTenant: claimed ? 'Demo C&I' : null,
  };
}

function pending(ref: string, agoMs: number, everIssued = false): PendingEnrollment {
  return {
    externalRef: ref,
    deviceInfo: 'VP Edge · Raspberry Pi',
    csrUpdatedAt: new Date(NOW.getTime() - agoMs).toISOString(),
    everIssued,
    issuedAt: everIssued ? '2026-07-20T00:00:00Z' : null,
  };
}

describe('funnelStages', () => {
  it('counts the three stages from what the page already loaded', () => {
    const stages = funnelStages(
      [device('VP-DEMO-0001', true), device('VP-DEMO-0002', false), device('VP-DEMO-0003', true)],
      [pending('edge-k7m2p4x', 3 * 24 * 3600_000)],
    );
    expect(stages.map((s) => s.id)).toEqual(['registriert', 'wartet', 'verbunden']);
    expect(stages[0].count).toBe(3);
    expect(stages[1].count).toBe(1);
    expect(stages[2].count).toBe(2);
  });

  it('only the waiting stage can ask for attention', () => {
    const busy = funnelStages([device('VP-1', false)], [pending('edge-a', 0)]);
    expect(busy.map((s) => s.attention)).toEqual([false, true, false]);

    const calm = funnelStages([device('VP-1', true)], []);
    expect(calm.every((s) => !s.attention)).toBe(true);
    expect(calm[1].note).toContain('Kein Gerät wartet');
  });

  it('says so plainly when nothing is registered at all', () => {
    const empty = funnelStages([], []);
    expect(empty.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(empty[0].note).toContain('Noch keine Geräte-ID');
    expect(empty[2].note).toContain('Noch kein Gerät');
  });
});

describe('pendingRows', () => {
  it('puts the longest wait first - that is the case that needs somebody', () => {
    const rows = pendingRows(
      [
        pending('edge-frisch', 2 * 3600_000),
        pending('edge-alt', 5 * 24 * 3600_000),
        pending('edge-mittel', 25 * 3600_000),
      ],
      NOW,
    );
    expect(rows.map((r) => r.externalRef)).toEqual(['edge-alt', 'edge-mittel', 'edge-frisch']);
  });

  it('calls a long wait a typo suspicion and a fresh one normal', () => {
    const [alt, frisch] = pendingRows(
      [pending('edge-alt', TYPO_SUSPECT_AFTER_MS + 3600_000), pending('edge-frisch', 3600_000)],
      NOW,
    );
    expect(alt.suspect).toBe(true);
    expect(alt.hint).toContain('Tippfehler');
    expect(frisch.suspect).toBe(false);
    expect(frisch.hint).toContain('normal');
  });

  it('never calls a device that WAS connected a typo - that is a different state', () => {
    const [row] = pendingRows([pending('edge-getrennt', 30 * 24 * 3600_000, true)], NOW);
    expect(row.suspect).toBe(false);
    expect(row.hint).toContain('getrennt');
    expect(row.hint).not.toContain('Tippfehler');
  });

  it('keeps an absent device description absent instead of inventing one', () => {
    const raw = { ...pending('edge-stumm', 0), deviceInfo: '  ' };
    expect(pendingRows([raw], NOW)[0].deviceInfo).toBeNull();
    const none = { ...pending('edge-stumm', 0), deviceInfo: null };
    expect(pendingRows([none], NOW)[0].deviceInfo).toBeNull();
  });

  it('does not mutate the input list', () => {
    const list = [pending('edge-b', 1000), pending('edge-a', 2000)];
    pendingRows(list, NOW);
    expect(list.map((p) => p.externalRef)).toEqual(['edge-b', 'edge-a']);
  });
});

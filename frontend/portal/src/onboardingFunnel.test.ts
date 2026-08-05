import { describe, expect, it } from 'vitest';
import type { AdminDeviceRow, PendingEnrollment, ProvisionedDevice } from './admin/adminApi';
import {
  TYPO_SUSPECT_AFTER_MS,
  deviceRows,
  funnelStages,
  pendingRows,
  versionDisplay,
  versionLabel,
} from './onboardingFunnel';

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

// ── P2 Konsolidierung: vierte Stufe, Inventar, Tag+Build ───────────────────

const fleetRow = (over: Partial<AdminDeviceRow> = {}): AdminDeviceRow => ({
  deviceId: 'd1', externalRef: 'edge-a1', label: 'edge-a1', siteId: 's1',
  siteName: 'Auernheim', tenantId: 't1', tenantName: 'Kunde A', kind: null,
  ist: 'edge-2026.08.1-9b37439a02c1', soll: 'edge-2026.08.1', sollSeq: 14,
  channel: 'stable', pinned: false, state: 'bestaetigt', reason: null, blocker: null,
  lastSeenAt: null, reportedAt: null, provisioned: false, note: null, provisionedAt: null,
  trust: null, ...over,
});

const crossed = {
  rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'],
  trustSetGeneratedAt: '2026-08-04T10:00:00Z', trustSetError: null,
};
const openCrossover = {
  rootKeyIds: [], trustSetKeyIds: [], trustSetGeneratedAt: null,
  trustSetError: 'Diesem Stand ist kein Vertrauensanker eingebacken.',
};

describe('Funnel-Stufe 4 „Vertrauen gekreuzt"', () => {
  it('schließt den Funnel - „verbunden" ist nicht das Onboarding-Ende', () => {
    const stages = funnelStages([], [], [
      fleetRow({ deviceId: 'a', externalRef: 'a', trust: crossed }),
      fleetRow({ deviceId: 'b', externalRef: 'b', trust: openCrossover }),
    ]);
    const trust = stages.find((s) => s.id === 'vertrauen')!;
    expect(trust.count).toBe(1);
    expect(trust.note).toContain('1 Gerät ist noch nicht update-fähig');
    // Ein offener Crossover ist eine AUFGABE - er verdient Aufmerksamkeit.
    expect(trust.attention).toBe(true);
  });

  it('zählt ein Gerät ohne gemeldeten Anker WEDER als gekreuzt NOCH als offen', () => {
    // „unbekannt" ist keine Aufgabe - daraus lässt sich nichts ableiten.
    const stages = funnelStages([], [], [
      fleetRow({ deviceId: 'a', externalRef: 'a', trust: crossed }),
      fleetRow({ deviceId: 'b', externalRef: 'b', trust: null }),
    ]);
    const trust = stages.find((s) => s.id === 'vertrauen')!;
    expect(trust.count).toBe(1);
    expect(trust.attention).toBe(false);
  });

  it('erscheint GAR NICHT ohne Flotte - eine „0 von 0"-Kachel ist kein Befund', () => {
    expect(funnelStages([], [], []).map((s) => s.id)).toEqual([
      'registriert', 'wartet', 'verbunden',
    ]);
  });

  it('zählt „verbunden" über die ECHTE Flotte, nicht über Aufkleber', () => {
    // Der behobene Befund: die Bestandsboxen verbinden sich über selbst
    // generierte `edge-`Referenzen und kamen in dieser Zahl gar nicht vor.
    const registry = [{
      externalRef: 'VP-DEMO-0001', kind: 'inverter', note: null,
      provisionedAt: '2026-07-01T00:00:00Z', claimed: false, claimedByTenant: null,
    }];
    const stages = funnelStages(registry, [], [fleetRow(), fleetRow({
      deviceId: 'd2', externalRef: 'edge-b2',
    })]);
    expect(stages.find((s) => s.id === 'verbunden')!.count).toBe(2);
    // Ohne Inventar (älteres Backend) bleibt die alte Quelle gültig.
    expect(funnelStages(registry, [], []).find((s) => s.id === 'verbunden')!.count).toBe(0);
  });
});

describe('Das Inventar', () => {
  it('stellt die verbundene Flotte vor die gedruckten IDs', () => {
    const rows = deviceRows([
      fleetRow({ deviceId: null, externalRef: 'VP-DEMO-0002', siteName: null, label: null,
        state: null, provisioned: true }),
      fleetRow({ deviceId: 'd1', externalRef: 'edge-a1', siteName: 'Auernheim' }),
    ]);
    expect(rows.map((r) => r.lifecycle)).toEqual(['verbunden', 'gedruckt']);
    expect(rows[0].name).toBe('Auernheim');
    // Eine gedruckte ID hat noch keinen Namen - dann IST die Referenz der Name.
    expect(rows[1].name).toBe('VP-DEMO-0002');
  });

  it('sortiert innerhalb der Flotte warn-first', () => {
    const rows = deviceRows([
      fleetRow({ deviceId: 'a', externalRef: 'a', siteName: 'A', state: 'bestaetigt' }),
      fleetRow({ deviceId: 'b', externalRef: 'b', siteName: 'B', state: 'blockiert' }),
      fleetRow({ deviceId: 'c', externalRef: 'c', siteName: 'C', state: 'fehlgeschlagen' }),
      fleetRow({ deviceId: 'd', externalRef: 'd', siteName: 'D', state: 'wartet_auf_anwendung' }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['C', 'D', 'B', 'A']);
  });
});

describe('Tag + Build', () => {
  const releases = [{ version: 'edge-2026.08.1' }, { version: 'edge-2026.08.0' }];

  it('trennt Tag und Build nach der PRÄFIX-Regel', () => {
    expect(versionLabel('edge-2026.08.1-9b37439a02c1', releases))
      .toBe('edge-2026.08.1 (Build 9b37439a)');
    expect(versionLabel('edge-2026.08.1', releases)).toBe('edge-2026.08.1');
  });

  it('lässt eine nackte SHA VERBATIM - ein Release-Tag wird nie erfunden', () => {
    // Ein Bestandsbau gehört zu keinem Release; ihn zu zerlegen erfände ein
    // Tag, mit dem er nie gebaut wurde.
    expect(versionLabel('665d59b8c0de', releases)).toBe('665d59b8c0de');
    // Und ein Präfix-Treffer ohne Trenner zählt NICHT.
    expect(versionLabel('edge-2026.08.11', releases)).toBe('edge-2026.08.11');
  });

  it('sagt „–", wenn nichts gemeldet wurde - nie eine erfundene Version', () => {
    expect(versionLabel(null, releases)).toBe('–');
    expect(versionLabel('', releases)).toBe('–');
    expect(versionDisplay(null)).toBeNull();
  });
});

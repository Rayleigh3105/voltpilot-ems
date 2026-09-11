import { describe, expect, it } from 'vitest';
import { boxVersionOverview, filterBoxVersions } from './boxVersions';
import type { EdgeUpdates, EdgeUpdatesRelease, FleetRow } from './adminEdgeUpdates';

const releases = [
  { releaseSeq: 2, version: 'edge-9', signed: true },
  { releaseSeq: 3, version: 'edge-2', signed: false },
] as EdgeUpdatesRelease[];
const fleet = [
  { deviceId: 'old', label: 'Alt', externalRef: 'VP-ALT', siteName: 'Werkstatt', tenantName: 'Kunde', ist: 'edge-9-abc', state: 'bestaetigt' },
  { deviceId: 'offline', label: 'Neu', externalRef: 'VP-NEU', siteName: 'Haus', tenantName: 'Kunde', ist: 'edge-2-def', state: 'offline_holt_nach' },
  { deviceId: 'unknown', label: 'Leer', externalRef: 'VP-LEER', siteName: 'Garage', tenantName: 'Kunde', ist: null, state: 'unbekannt' },
] as FleetRow[];
const data = { releases, fleet } as EdgeUpdates;

describe('Box versions', () => {
  it('uses register order and preserves unknown, offline and confirmed older versions', () => {
    const result = boxVersionOverview(data);
    expect(result.latest).toBe(releases[1]);
    expect(result.runningLatest).toBe(1);
    expect(result.filters.find((f) => f.id === 'unknown')?.count).toBe(1);
    expect(result.filters.find((f) => f.id === 'attention')?.count).toBe(0);
    expect(result.sorted.find((r) => r.deviceId === 'old')?.state).toBe('bestaetigt');
    expect(boxVersionOverview({ ...data, releases: [] }).runningLatest).toBeNull();
  });
  it('combines a normalized search with version and state filters', () => {
    expect(filterBoxVersions(fleet, releases, { search: ' WERKSTATT ', filter: 'all', version: 'edge-9' }).map((r) => r.deviceId)).toEqual(['old']);
    expect(filterBoxVersions(fleet, releases, { search: 'Kunde', filter: 'unknown', version: 'all' }).map((r) => r.deviceId)).toEqual(['unknown']);
    expect(filterBoxVersions(fleet, releases, { search: '', filter: 'unknown', version: 'edge-9' })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { boxenDerLinie, boxVersionOverview, filterBoxVersions, linienSicht } from './boxVersions';
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
    expect(result.releases[0]).toBe(releases[1]);
    expect(result.filters.find((f) => f.id === 'unknown')?.count).toBe(1);
    expect(result.filters.find((f) => f.id === 'attention')?.count).toBe(0);
    expect(result.sorted.find((r) => r.deviceId === 'old')?.state).toBe('bestaetigt');
    expect(boxVersionOverview({ ...data, releases: [], fleet: [] }).linien).toEqual([]);
  });

  // Geräte & Updates S0: das Bild vom 05.11. - das jüngste Release ist Edge Light,
  // die Docker-Boxen laufen auf dem neuesten DOCKER-Release.
  const stand0511 = {
    releases: [
      { releaseSeq: 60, version: 'edge-light-2026.11.4', signed: true, boxArt: 'light' },
      { releaseSeq: 58, version: 'edge-2026.10.7', signed: true, boxArt: 'docker' },
    ],
    fleet: [
      { deviceId: 'herzogau', ist: 'edge-2026.10.7-c39b18d9c2a4', state: 'aktuell', boxArt: 'docker' },
      { deviceId: 'gate', ist: 'edge-light-2026.11.4', state: 'bestaetigt', boxArt: 'light',
        trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'], trustSetGeneratedAt: null, trustSetError: null } },
      { deviceId: 'zuhause', ist: 'edge-light-2026.11.0', state: 'fehlgeschlagen', boxArt: 'light',
        trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: [], trustSetGeneratedAt: null, trustSetError: 'fehlt' } },
    ],
  } as unknown as EdgeUpdates;

  it('shows one card per line from the server lines - Docker never measured against Edge Light (S0)', () => {
    const linien = linienSicht({ ...stand0511, lines: [
      { boxArt: 'docker', newestRelease: 'edge-2026.10.7', newestReleaseSeq: 58, devices: 1, known: 1, upToDate: 1 },
      { boxArt: 'light', newestRelease: 'edge-light-2026.11.4', newestReleaseSeq: 60, devices: 2, known: 2, upToDate: 1 },
    ] });
    expect(linien.map((l) => [l.label, l.release?.version, l.upToDate, l.devices, l.stufe1, l.zuweisbar])).toEqual([
      ['Docker-Box', 'edge-2026.10.7', 1, 1, 0, 1],
      // Zuhause hat Stufe 1: nur VoltPilotGATE kann das Edge-Light-Release bekommen.
      ['Edge Light', 'edge-light-2026.11.4', 1, 2, 1, 1],
    ]);
  });

  it('derives the same lines from register and fleet for an older server without lines', () => {
    const linien = linienSicht(stand0511);
    expect(linien.map((l) => [l.boxArt, l.release?.version, l.upToDate, l.devices, l.known, l.stufe1])).toEqual([
      ['docker', 'edge-2026.10.7', 1, 1, 1, 0],
      ['light', 'edge-light-2026.11.4', 1, 2, 2, 1],
    ]);
    // Eine Linie ohne Release und ohne Box erscheint nicht.
    expect(linienSicht({ ...stand0511, fleet: [], releases: [stand0511.releases[1]] })
      .map((l) => l.boxArt)).toEqual(['docker']);
  });

  it('counts an Edge Light box as stage 1 when its loader only starts the flash copy (G8)', () => {
    const mitLoader = {
      ...stand0511,
      fleet: stand0511.fleet.map((r) => r.deviceId === 'gate' ? { ...r, loader: 'flash' } : r),
    } as EdgeUpdates;
    const light = linienSicht(mitLoader).find((l) => l.boxArt === 'light')!;
    expect(light.stufe1).toBe(2);
    expect(light.zuweisbar).toBe(0);
  });

  it('names the boxes of a line with their word', () => {
    expect(boxenDerLinie('docker', 3)).toBe('3 Docker-Boxen');
    expect(boxenDerLinie('light', 1)).toBe('1 Edge-Light-Box');
  });
  it('filters by box kind and offers only kinds that occur, unknown included', () => {
    const mixed = [
      { ...fleet[0], boxArt: 'docker' },
      { ...fleet[1], deviceId: 'mango', boxArt: 'light' },
      fleet[2],
    ] as FleetRow[];
    const { boxArten, sorted } = boxVersionOverview({ releases, fleet: mixed } as EdgeUpdates);
    expect(boxArten.map((b) => b.label)).toEqual([
      'Alle Box-Arten', 'Docker-Box (1)', 'Edge Light (1)', 'Box-Art unbekannt (1)',
    ]);
    const only = (boxArt: string) => filterBoxVersions(sorted, releases,
      { search: '', filter: 'all', version: 'all', boxArt }).map((r) => r.deviceId);
    expect(only('light')).toEqual(['mango']);
    expect(only('unbekannt')).toEqual(['unknown']);
    expect(only('all')).toHaveLength(3);
    // Die Box-Art ist auch suchbar.
    expect(filterBoxVersions(sorted, releases, { search: 'edge light', filter: 'all', version: 'all' })
      .map((r) => r.deviceId)).toEqual(['mango']);
  });
  it('combines a normalized search with version and state filters', () => {
    expect(filterBoxVersions(fleet, releases, { search: ' WERKSTATT ', filter: 'all', version: 'edge-9' }).map((r) => r.deviceId)).toEqual(['old']);
    expect(filterBoxVersions(fleet, releases, { search: 'Kunde', filter: 'unknown', version: 'all' }).map((r) => r.deviceId)).toEqual(['unknown']);
    expect(filterBoxVersions(fleet, releases, { search: '', filter: 'unknown', version: 'edge-9' })).toEqual([]);
  });
});

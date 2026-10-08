import { releaseIsRunning } from './adminFleet';
import {
  BOX_ART_UNBEKANNT, boxArtLabel, deviceBoxArt, sortFleet, stateLabel,
  type EdgeUpdates, type EdgeUpdatesRelease, type FleetRow,
} from './adminEdgeUpdates';
import { versionDisplay } from './edgeVersionLabel';

const FILTERS = [
  { id: 'all', label: 'Alle Boxen', matches: (_r: FleetRow) => true },
  { id: 'busy', label: 'Update läuft', matches: (r: FleetRow) => stateLabel(r.state).cls === 'busy' },
  { id: 'attention', label: 'Prüfen', matches: (r: FleetRow) => ['incident', 'blocked'].includes(stateLabel(r.state).cls) },
  { id: 'unknown', label: 'Ohne Versionsmeldung', matches: (r: FleetRow) => !versionDisplay(r.ist) },
];

/** Box-Art filter values: the two kinds plus an honest „unknown" (never folded into Docker). */
const BOX_ART_FILTER: { value: string; label: string; matches: (r: FleetRow) => boolean }[] = [
  { value: 'docker', label: 'Docker-Box', matches: (r) => deviceBoxArt(r.boxArt) === 'docker' },
  { value: 'light', label: 'Edge Light', matches: (r) => deviceBoxArt(r.boxArt) === 'light' },
  { value: 'unbekannt', label: BOX_ART_UNBEKANNT, matches: (r) => deviceBoxArt(r.boxArt) == null },
];

/** The register orders releases; a version string or commit hash never does. */
export function boxVersionOverview(data: EdgeUpdates) {
  const releases = [...data.releases].sort((a, b) => b.releaseSeq - a.releaseSeq);
  const latest = releases[0] ?? null;
  const sorted = sortFleet(data.fleet);
  const versions = [...new Set(sorted.map((r) => versionDisplay(r.ist, releases)?.tag).filter((v): v is string => !!v))];
  // Count last-reported versions, including offline boxes; this is not a
  // reachability claim and does not reinterpret the server's update status.
  const runningLatest = latest ? sorted.filter((r) => r.ist && releaseIsRunning(latest.version, r.ist)).length : null;
  const filters = FILTERS.map((f) => ({ id: f.id, label: f.label, count: sorted.filter(f.matches).length }));
  // Only kinds that occur in the fleet become options; an empty kind would be a dead end.
  const boxArten = [
    { value: 'all', label: 'Alle Box-Arten' },
    ...BOX_ART_FILTER
      .map((b) => ({ value: b.value, count: sorted.filter(b.matches).length, label: b.label }))
      .filter((b) => b.count > 0)
      .map((b) => ({ value: b.value, label: `${b.label} (${b.count})` })),
  ];
  return { releases, latest, sorted, versions, runningLatest, filters, boxArten };
}

export function filterBoxVersions(
  sorted: FleetRow[], releases: EdgeUpdatesRelease[],
  { search, filter, version, boxArt = 'all' }:
    { search: string; filter: string; version: string; boxArt?: string },
): FleetRow[] {
  const match = (FILTERS.find((f) => f.id === filter) ?? FILTERS[0]).matches;
  const art = BOX_ART_FILTER.find((b) => b.value === boxArt)?.matches ?? (() => true);
  const query = search.trim().toLocaleLowerCase('de');
  return sorted.filter((r) => match(r) && art(r)
    && (version === 'all' || versionDisplay(r.ist, releases)?.tag === version)
    && [r.label, r.externalRef, r.siteName, r.tenantName, r.ist, r.soll, boxArtLabel(r.boxArt).label]
      .some((v) => v?.toLocaleLowerCase('de').includes(query)));
}

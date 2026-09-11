import { releaseIsRunning } from './adminFleet';
import { sortFleet, stateLabel, type EdgeUpdates, type EdgeUpdatesRelease, type FleetRow } from './adminEdgeUpdates';
import { versionDisplay } from './edgeVersionLabel';

const FILTERS = [
  { id: 'all', label: 'Alle Boxen', matches: (_r: FleetRow) => true },
  { id: 'busy', label: 'Update läuft', matches: (r: FleetRow) => stateLabel(r.state).cls === 'busy' },
  { id: 'attention', label: 'Prüfen', matches: (r: FleetRow) => ['incident', 'blocked'].includes(stateLabel(r.state).cls) },
  { id: 'unknown', label: 'Ohne Versionsmeldung', matches: (r: FleetRow) => !versionDisplay(r.ist) },
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
  return { releases, latest, sorted, versions, runningLatest, filters };
}

export function filterBoxVersions(
  sorted: FleetRow[], releases: EdgeUpdatesRelease[],
  { search, filter, version }: { search: string; filter: string; version: string },
): FleetRow[] {
  const match = (FILTERS.find((f) => f.id === filter) ?? FILTERS[0]).matches;
  const query = search.trim().toLocaleLowerCase('de');
  return sorted.filter((r) => match(r)
    && (version === 'all' || versionDisplay(r.ist, releases)?.tag === version)
    && [r.label, r.externalRef, r.siteName, r.tenantName, r.ist, r.soll]
      .some((v) => v?.toLocaleLowerCase('de').includes(query)));
}

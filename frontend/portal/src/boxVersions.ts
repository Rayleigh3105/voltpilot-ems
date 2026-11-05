import { releaseIsRunning } from './adminFleet';
import {
  BOX_ART_LABELS, BOX_ART_UNBEKANNT, boxArtLabel, deviceBoxArt, releaseBoxArt, releaseSperre, sortFleet,
  stateLabel, stufe1 as istStufe1, type BoxArt, type EdgeUpdates, type EdgeUpdatesRelease, type FleetRow,
} from './adminEdgeUpdates';
import { versionDisplay } from './edgeVersionLabel';

/**
 * Eine Software-Linie, so wie die Seite sie zeigt (Geräte & Updates S0): ihr
 * neuestes Release und wie viele ihrer Boxen es melden. Docker-Box und Edge
 * Light stehen nebeneinander - ein Edge-Light-Release verdrängt das
 * Docker-Release nicht mehr.
 */
export interface LinienSicht {
  boxArt: BoxArt;
  /** „Docker-Box" oder „Edge Light". */
  label: string;
  /** Das neueste Release dieser Linie (mit Signatur) - `null` = noch keines. */
  release: EdgeUpdatesRelease | null;
  /** Boxen dieser Linie; eine Box unbekannter Art zählt in keiner. */
  devices: number;
  /** Davon mit gemeldetem Stand. */
  known: number;
  /** Davon auf dem neuesten Release der Linie. */
  upToDate: number;
  /**
   * Edge-Light-Boxen mit Stufe 1 (kein gekreuztes Vertrauen oder ein Loader, der
   * nur die Flash-Fassung startet): sie nehmen kein Release aus dem Portal an
   * (`releaseSperre`) - benannt, nie still mitgezählt.
   */
  stufe1: number;
  /**
   * Boxen, denen das neueste Release dieser Linie zugewiesen werden KANN
   * (`releaseSperre` = null; bei Docker auch Boxen unbekannter Art). Ohne eine
   * solche Box hat „Update verteilen" kein Ziel.
   */
  zuweisbar: number;
}

const LINIEN: BoxArt[] = ['docker', 'light'];

/**
 * Die Linien aus dem Server-Aggregat (`lines`, dieselbe Regel wie die
 * Kunden-Box-Seite). Fehlt das Feld (älterer Server), entsteht dieselbe Sicht
 * aus Register und Flotte: neuestes Release je Box-Art des Releases, Boxen je
 * Box-Art des Geräts.
 */
export function linienSicht(data: Pick<EdgeUpdates, 'releases' | 'fleet' | 'lines'>): LinienSicht[] {
  const releases = [...data.releases].sort((a, b) => b.releaseSeq - a.releaseSeq);
  const stufe1 = (art: BoxArt) => art !== 'light' ? 0
    : data.fleet.filter((r) => istStufe1(r.boxArt, r.trust, r.loader)).length;
  const zuweisbar = (release: EdgeUpdatesRelease | null) => !release ? 0
    : data.fleet.filter((r) => releaseSperre(release, r.boxArt, r.trust, r.loader) == null).length;
  if (data.lines) {
    return data.lines.map((l) => {
      const release = l.newestReleaseSeq == null ? null
        : releases.find((r) => r.releaseSeq === l.newestReleaseSeq) ?? null;
      return {
        boxArt: l.boxArt,
        label: BOX_ART_LABELS[l.boxArt] ?? l.boxArt,
        release,
        devices: l.devices,
        known: l.known,
        upToDate: l.upToDate,
        stufe1: stufe1(l.boxArt),
        zuweisbar: zuweisbar(release),
      };
    });
  }
  return LINIEN.flatMap((art) => {
    const release = releases.find((r) => releaseBoxArt(r) === art) ?? null;
    const boxen = data.fleet.filter((r) => deviceBoxArt(r.boxArt) === art);
    if (!release && boxen.length === 0) return [];
    return [{
      boxArt: art,
      label: BOX_ART_LABELS[art],
      release,
      devices: boxen.length,
      known: boxen.filter((r) => r.state !== 'unbekannt').length,
      upToDate: release ? boxen.filter((r) => !!r.ist && releaseIsRunning(release.version, r.ist)).length : 0,
      stufe1: stufe1(art),
      zuweisbar: zuweisbar(release),
    }];
  });
}

/** „3 Docker-Boxen", „1 Edge-Light-Box" - das Wort der Linie mit Zahl. */
export function boxenDerLinie(art: BoxArt, n: number): string {
  if (art === 'light') return `${n} Edge-Light-${n === 1 ? 'Box' : 'Boxen'}`;
  return `${n} Docker-${n === 1 ? 'Box' : 'Boxen'}`;
}

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
  const sorted = sortFleet(data.fleet);
  const versions = [...new Set(sorted.map((r) => versionDisplay(r.ist, releases)?.tag).filter((v): v is string => !!v))];
  // One card per software line (S0): the newest release of THAT line and how
  // many of its boxes report it - counted from last-reported versions,
  // including offline boxes; not a reachability claim.
  const linien = linienSicht(data);
  const filters = FILTERS.map((f) => ({ id: f.id, label: f.label, count: sorted.filter(f.matches).length }));
  // Only kinds that occur in the fleet become options; an empty kind would be a dead end.
  const boxArten = [
    { value: 'all', label: 'Alle Box-Arten' },
    ...BOX_ART_FILTER
      .map((b) => ({ value: b.value, count: sorted.filter(b.matches).length, label: b.label }))
      .filter((b) => b.count > 0)
      .map((b) => ({ value: b.value, label: `${b.label} (${b.count})` })),
  ];
  return { releases, linien, sorted, versions, filters, boxArten };
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

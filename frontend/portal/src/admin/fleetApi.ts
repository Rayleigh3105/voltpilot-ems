import { request, type ControlStatus, type CurtailmentStatus } from '../api';

/**
 * Die Datenquelle der Plattform-Übersicht: der EINE Flotten-Endpunkt
 * `GET /api/v1/admin/fleet` (Admin-Umbau Stufe 2).
 *
 * **Stufe 1 hat den Puls client-seitig aggregiert** - je Mandant `/overview` +
 * Anlagen + `/edge-versions`, dazu je Anlage die Quellen und beim Aufklappen
 * zwei Steuerungs-Belege. Das war ein bewusster Zwischenstand (Captain-Entscheid
 * Q3: erprobter Mechanismus, kleine Flotte), skalierte aber mit Mandanten ×
 * Anlagen. Jetzt ist es EINE Antwort - die Oberfläche bleibt, wie sie ist.
 *
 * Die Route liegt unter `/api/v1/admin/**` und ist server-seitig an die
 * `platform-admin`-Rolle gebunden; ein Kunden-Token bekommt 403. Die
 * RLS-Umgehung lebt ausschließlich dort (dieselbe dedizierte BYPASSRLS-Rolle
 * wie die übrigen Admin-Reads) - die Kunden-Endpunkte bleiben unberührt auf dem
 * RLS-Pfad, und deshalb trägt dieser Aufruf auch KEINEN `X-Tenant-Id`-Header
 * mehr: es gibt nichts mehr umzuschalten.
 *
 * Ehrlichkeit reist im Vertrag mit: ein Block, den niemand gemessen hat, ist
 * `null` und trägt seinen Grund - nie eine erfundene Null.
 */

/** Die vom Gerät gemeldeten Quellen, nach Gesundheit gezählt. */
export interface AdminFleetSources {
  total: number;
  ok: number;
  stale: number;
  never: number;
}

/** Der gemeldete Software-Stand der Edge. `null` an der Anlage = unbekannt. */
export interface AdminFleetEdge {
  coreVersion: string | null;
  paletteVersion: string | null;
  reportedAt: string;
}

/**
 * Der gemeldete OTA-Stand (Stufe 0). `null` an der Anlage = UNBEKANNT, nie
 * „veraltet".
 *
 * Er steht NEBEN `edge`, nicht darin: `version` reist TOP-LEVEL im Herzschlag
 * und damit unabhängig vom `flows`-Block, den eine Edge erst nach ihrem ersten
 * Flow-Deployment baut - genau deshalb füllt dieser Block auch die Geräte,
 * über die `edge` nichts weiß. Beide tragen ihren EIGENEN `reportedAt`.
 *
 * `version` ist der Stempel VERBATIM: eine Bestands-Edge meldet eine nackte
 * Commit-SHA, die im Register schlicht nicht steht.
 */
export interface AdminFleetUpdate {
  version: string | null;
  backend: string | null;
  current: string | null;
  /** In Stufe 0 immer leer - es gibt keine Soll-Zuweisung auf dem Gerät. */
  target: string | null;
  state: string | null;
  reason: string | null;
  lastKnownGood: string | null;
  reportedAt: string;
}

/**
 * Ein Eintrag des Release-Registers. `releaseSeq` ist DIE Ordnung - eine
 * monotone Ganzzahl, nie ein String- oder SHA-Vergleich (Entscheid D5).
 */
export interface AdminFleetRelease {
  releaseSeq: number;
  version: string;
}

/** Die kWp-Plausibilität (B4a) - `unbekannt` ist ein vollwertiges Urteil. */
export interface AdminFleetKwp {
  configuredKwp: number | null;
  observedPeakKw: number | null;
  buckets: number;
  verdict: 'ok' | 'zu_hoch' | 'zu_niedrig' | 'unbekannt';
  reason: string;
}

/**
 * Die Plausibilität der gepflegten Einspeisegrenze (B4c) - gemessene Export-Decke
 * gegen `max_feed_in_kw`. `unbekannt` ist ein vollwertiges Urteil; der offene
 * Pflege-Punkt reist zusätzlich als Chip in `pflege`.
 */
export interface AdminFleetFeedIn {
  configuredKw: number | null;
  observedCeilingKw: number | null;
  exportDays: number;
  clingDays: number;
  verdict: 'ok' | 'zu_hoch' | 'nicht_gehalten' | 'unbekannt';
  reason: string;
}

/** Die Prognosequalität einer Anlage für EINE Prognoseart (B4b). */
export interface AdminFleetForecast {
  kind: string;
  nmaePct: number;
  days: number;
  /** `null` = kein Flotten-Maßstab; dann wird auch kein Ausreißer behauptet. */
  fleetMedianPct: number | null;
  outlier: boolean;
  reason: string;
}

/** Ein offener Pflege-Punkt, server-abgeleitet (eine Wahrheit). */
export interface AdminFleetPflege {
  code: string;
  label: string;
  detail: string | null;
}

/** Eine Zeile des Pulses = eine Anlage, über alle Mandanten. */
export interface AdminFleetSite {
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  plantKind: string;
  netzladenErlaubt: boolean;
  tarifArt: string | null;
  deviceCount: number;
  onlineCount: number;
  waitingCount: number;
  worstStatus: 'online' | 'stale' | 'waiting' | null;
  lastSeenAt: string | null;
  lastPlanGeneratedAt: string | null;
  hasStorage: boolean;
  batteryWithoutDevice: boolean;
  sources: AdminFleetSources | null;
  edge: AdminFleetEdge | null;
  update: AdminFleetUpdate | null;
  control: ControlStatus | null;
  curtailment: CurtailmentStatus | null;
  kwp: AdminFleetKwp;
  /** B4c - additiv; ältere Backends senden es nicht. Der Chip lebt in `pflege`. */
  feedIn?: AdminFleetFeedIn;
  forecast: AdminFleetForecast[];
  pflege: AdminFleetPflege[];
}

export interface AdminFleet {
  sites: AdminFleetSite[];
  /**
   * Das Release-Register, NEUESTE zuerst - der erste Eintrag ist der
   * flottenweite SOLL-Stand. Es reist mit, weil „veraltet" nur gegen diese
   * Ordnung eine Aussage ist: ein gemeldeter Stand wird DARIN gesucht, und was
   * das Register nicht kennt, ist „nicht registriert" - ausdrücklich nicht
   * „veraltet". Leer = kein Maßstab, also wird nichts behauptet.
   */
  releases: AdminFleetRelease[];
}

export const fleetApi = {
  fleet: () => request<AdminFleet>('/api/v1/admin/fleet'),
};

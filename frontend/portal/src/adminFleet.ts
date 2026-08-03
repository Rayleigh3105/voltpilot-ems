import type {
  ControlStatus,
  CurtailmentStatus,
  EdgeVersion,
  Overview,
  OverviewSite,
  Site,
  SiteSource,
} from './api';
import { ONLINE_WINDOW_MS } from './api';
import { CONTROL_STALE_MS, EXECUTION_MODE_LABEL } from './control';
import { curtailTruth, releaseNote, type CurtailTruth } from './curtailment';

/**
 * Der Flotten-Puls der Plattform-Übersicht (Admin-Umbau Stufe 1, Baustein B1) -
 * die Antwort auf die tägliche erste Frage eines EMS-Betreibers: **welche
 * Anlage braucht heute meine Aufmerksamkeit?**
 *
 * Bis hierher beantwortete das keine Fläche: alles Operative lag hinter dem
 * Mandanten-Umschalter, ein Mandant nach dem anderen. Es fehlten keine Daten,
 * es fehlte die Sichtachse.
 *
 * Dieses Modul ist REIN: es rechnet aus dem, was die Seite je Mandant lädt
 * (`/overview`, die Anlagen-Liste, `/edge-versions`, optional die Quellen je
 * Anlage) eine Zeile je Anlage - und sortiert Aufmerksamkeit nach oben.
 *
 * Drei Ehrlichkeitsregeln gelten überall:
 *
 * 1. **Was nicht gemessen ist, bleibt leer** ({@link DASH}) und nennt seinen
 *    Grund - nie eine erfundene Null, nie ein geratener Zustand.
 * 2. **Ein FEHLGESCHLAGENER Abruf ist keine Datenlage.** Ein toter Mandant
 *    leert den Puls nicht, er steht als Teilausfall daneben
 *    ({@link fleetLoadNote}).
 * 3. **Zustand und Bezugszeit gehören zusammen** (die Lebendigkeits-Lehre aus
 *    `liveness.ts`): jedes Alter wird gegen die Zeit gerechnet, zu der der
 *    Server geantwortet hat - nie gegen eine Uhr über einem stehenden
 *    Schnappschuss.
 */

/** Das eine Zeichen für „liegt nicht vor" (die `nodata.ts`-Disziplin). */
export const DASH = '—';

/**
 * Ab hier ist ein Plan alt genug, um es zu sagen. Der Optimierer plant alle 15
 * Minuten neu; zwei Stunden sind also acht ausgefallene Läufe und keine
 * Interpretationsfrage mehr.
 */
export const PLAN_STALE_MS = 2 * 60 * 60 * 1000;

export type Tone = 'ok' | 'warn' | 'off';

/** Ein Mandant, wie ihn der Puls braucht (Name + Id, mehr nicht). */
export interface FleetTenant {
  id: string;
  name: string;
}

/**
 * Was für EINEN Mandanten geladen wurde. Jedes Feld ist einzeln optional, weil
 * jeder Abruf einzeln scheitern darf - `null` heißt „nicht geladen", nie
 * „leer".
 */
export interface FleetTenantData {
  tenant: FleetTenant;
  overview: Overview | null;
  /** Die Anlagen-Stammdaten (für den Pflege-Check); null = nicht geladen. */
  sites: Site[] | null;
  /** Der gemeldete Edge-Stand je Gerät; null = nicht geladen. */
  edgeVersions: EdgeVersion[] | null;
}

/** Ein Signal-Chip einer Zeile. */
export interface FleetSignal {
  id: string;
  label: string;
  tone: Tone;
}

/** Ein offener Pflege-Punkt (Existenz-Check über vorhandene Stammdaten). */
export interface PflegeItem {
  id: 'tarif' | 'speicher-ohne-geraet';
  label: string;
}

/** Der Edge-Stand einer Zeile. */
export interface EdgeStand {
  /** Die Kernversion, oder null wenn nichts gemeldet wurde. */
  coreVersion: string | null;
  paletteVersion: string | null;
  text: string;
  tone: Tone;
  /** True nur, wenn eine GEMELDETE Version hinter der neuesten bekannten liegt. */
  outdated: boolean;
}

/** Eine Zeile des Pulses = eine Anlage. */
export interface FleetRow {
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  /** „1/1 online" · „1 verbunden" · „kein Gerät". */
  deviceText: string;
  deviceTone: Tone;
  /** Alter der jüngsten Messung, oder DASH. */
  liveText: string;
  liveTone: Tone;
  /** Alter des jüngsten Optimierer-Laufs, oder „kein aktueller Plan". */
  planText: string;
  planTone: Tone;
  /** Quellen-Gesundheit; `null` = noch nicht geprüft (nie „alles gesund"). */
  sources: SourceHealth | null;
  edge: EdgeStand;
  /** Offene Pflege-Punkte; `null` = Stammdaten nicht geladen. */
  pflege: PflegeItem[] | null;
  signals: FleetSignal[];
  /** Höher = braucht eher Aufmerksamkeit (die Sortierung, nie eine Anzeige). */
  attention: number;
  /** Hat die Anlage einen Speicher? Nur diese Zeilen tragen die B2-Matrix. */
  hasStorage: boolean;
}

/** Die Quellen-Gesundheit einer Anlage. */
export interface SourceHealth {
  total: number;
  ok: number;
  /** Gemeldet, aber ohne aktuelle Werte. */
  stale: number;
  /** Hat noch nie geliefert. */
  never: number;
  text: string;
  tone: Tone;
}

/**
 * Die Quellen-Gesundheit aus der vom Gerät gemeldeten Quellen-Liste. Ein Gerät,
 * das die Liste (noch) nicht sendet, liefert eine LEERE Liste - daraus wird
 * bewusst „keine Meldung" und nicht „0 gesund".
 */
export function sourceHealth(sources: SiteSource[]): SourceHealth | null {
  if (sources.length === 0) return null;
  let ok = 0;
  let stale = 0;
  let never = 0;
  for (const s of sources) {
    if (s.health === 'ok') ok += 1;
    else if (s.health === 'stale') stale += 1;
    else never += 1;
  }
  const total = sources.length;
  if (stale === 0 && never === 0) {
    return { total, ok, stale, never, text: `${ok}/${total} liefern`, tone: 'ok' };
  }
  return {
    total,
    ok,
    stale,
    never,
    text: `${ok}/${total} liefern`,
    tone: stale > 0 ? 'warn' : 'off',
  };
}

/**
 * Der Edge-Stand einer Anlage aus den gemeldeten Geräte-Versionen.
 *
 * **Kein Eintrag heißt „unbekannt", nie „veraltet".** Die Edge baut den
 * Herzschlag-Block, in dem die Versionen reisen, erst nach ihrem ersten
 * Flow-Deployment - ein Gerät ohne ausgerollte Automation meldet also gar
 * nichts, und daraus eine Alters-Aussage zu machen wäre eine Behauptung.
 *
 * `newest` ist die neueste ÜBER DIE FLOTTE bekannte Version - der einzige
 * Vergleichsmaßstab, den die Cloud hat (es gibt kein Release-Register).
 */
export function edgeStand(
  versions: EdgeVersion[] | null,
  siteId: string,
  newest: string | null,
): EdgeStand {
  if (versions == null) {
    return {
      coreVersion: null,
      paletteVersion: null,
      text: DASH,
      tone: 'off',
      outdated: false,
    };
  }
  // Mehrere Geräte an einer Anlage: das ZULETZT gemeldete gewinnt (die Liste
  // kommt bereits nach reportedAt absteigend).
  const mine = versions.find((v) => v.siteId === siteId) ?? null;
  if (!mine || !mine.coreVersion) {
    return {
      coreVersion: null,
      paletteVersion: mine?.paletteVersion ?? null,
      text: 'unbekannt',
      tone: 'off',
      outdated: false,
    };
  }
  const outdated = newest != null && compareVersions(mine.coreVersion, newest) < 0;
  return {
    coreVersion: mine.coreVersion,
    paletteVersion: mine.paletteVersion,
    text: outdated ? `${mine.coreVersion} · veraltet` : mine.coreVersion,
    tone: outdated ? 'warn' : 'ok',
    outdated,
  };
}

/**
 * Die neueste über die ganze Flotte GEMELDETE Kernversion - der Maßstab für
 * „veraltet". Null, solange nichts gemeldet wurde: ohne Maßstab wird nie eine
 * Anlage als veraltet markiert.
 */
export function newestCoreVersion(data: FleetTenantData[]): string | null {
  let newest: string | null = null;
  for (const d of data) {
    for (const v of d.edgeVersions ?? []) {
      if (!v.coreVersion) continue;
      if (newest == null || compareVersions(v.coreVersion, newest) > 0) newest = v.coreVersion;
    }
  }
  return newest;
}

/**
 * Vergleich zweier Versionsstrings, Zahlenblock für Zahlenblock (1.10.0 > 1.9.3
 * - ein Stringvergleich läge hier falsch). Ein nicht-numerischer Rest
 * (`1.4.2-rc1`) wird ignoriert statt geraten; sind alle Blöcke gleich, sind die
 * Versionen für uns gleich.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10));
  const pb = b.split('.').map((p) => parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Die offenen Pflege-Punkte einer Anlage - reine EXISTENZ-Checks über schon
 * vorhandene Felder, nie eine zweite Preisrechnung.
 *
 * Der Tarif-Check ist der teure: eine Anlage mit Tarifart `ohne` und ohne
 * gepflegtes Preisblatt rechnet seit dem Default-Komponenten-Flag mit
 * STANDARD-Komponenten statt mit den Preisen des Kunden - sichtbar war das
 * bisher nur je Slot in der Optimizer-Diagnose.
 */
export function pflegeItems(site: Site | undefined, row: OverviewSite): PflegeItem[] {
  const items: PflegeItem[] = [];
  if (site && site.tarifArt === 'ohne') {
    items.push({ id: 'tarif', label: 'Stromtarif fehlt' });
  }
  if (row.batteryWithoutDevice) {
    items.push({ id: 'speicher-ohne-geraet', label: 'Speicher ohne Gerät' });
  }
  return items;
}

/**
 * Eine Zeile je Anlage über ALLE geladenen Mandanten, Aufmerksamkeit zuerst.
 *
 * `now` ist die ANTWORTZEIT des Servers, nicht die Wanduhr - siehe die
 * Lebendigkeits-Lehre im Kopf dieser Datei.
 */
export function fleetRows(
  data: FleetTenantData[],
  sourcesBySite: Record<string, SiteSource[]> = {},
  now: Date = new Date(),
): FleetRow[] {
  const newest = newestCoreVersion(data);
  const rows: FleetRow[] = [];
  for (const d of data) {
    if (!d.overview) continue;
    const siteById = new Map((d.sites ?? []).map((s) => [s.id, s]));
    for (const site of d.overview.sites) {
      const pflege = d.sites == null ? null : pflegeItems(siteById.get(site.id), site);
      const sources = sourcesBySite[site.id] ? sourceHealth(sourcesBySite[site.id]) : null;
      const edge = edgeStand(d.edgeVersions, site.id, newest);
      const live = liveCell(site, now);
      const plan = planCell(site.lastPlanGeneratedAt ?? null, now);
      const devices = deviceCell(site);
      const hasStorage = (site.roleCounts?.storage ?? 0) > 0 || site.batteryWithoutDevice;
      const signals = rowSignals(site, sources, edge, pflege);
      rows.push({
        siteId: site.id,
        siteName: site.name,
        tenantId: d.tenant.id,
        tenantName: d.tenant.name,
        deviceText: devices.text,
        deviceTone: devices.tone,
        liveText: live.text,
        liveTone: live.tone,
        planText: plan.text,
        planTone: plan.tone,
        sources,
        edge,
        pflege,
        signals,
        attention: attentionScore(devices.tone, live.tone, plan.tone, sources, edge, pflege),
        hasStorage,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      b.attention - a.attention ||
      a.tenantName.localeCompare(b.tenantName, 'de') ||
      a.siteName.localeCompare(b.siteName, 'de'),
  );
}

function deviceCell(site: OverviewSite): { text: string; tone: Tone } {
  if (site.deviceCount === 0) return { text: 'kein Gerät', tone: 'off' };
  const stale = site.deviceCount - site.onlineCount - site.waitingCount;
  if (stale > 0) {
    return { text: `${site.onlineCount}/${site.deviceCount} online`, tone: 'warn' };
  }
  if (site.waitingCount > 0) {
    return {
      text: `${site.waitingCount} wartet auf erste Daten`,
      tone: 'off',
    };
  }
  return { text: `${site.onlineCount}/${site.deviceCount} online`, tone: 'ok' };
}

/**
 * Das Alter der jüngsten MESSUNG. Es hängt an `lastSeenAt` (der ANKUNFT der
 * Telemetrie, die Store-and-Forward-Regel), nicht am Beobachtungszeitpunkt -
 * eine wiedereinspielende Edge liest sonst fälschlich als offline.
 */
function liveCell(site: OverviewSite, now: Date): { text: string; tone: Tone } {
  if (!site.lastSeenAt) return { text: DASH, tone: 'off' };
  const age = now.getTime() - Date.parse(site.lastSeenAt);
  return { text: relAge(age), tone: age <= ONLINE_WINDOW_MS ? 'ok' : 'warn' };
}

function planCell(lastRun: string | null, now: Date): { text: string; tone: Tone } {
  if (!lastRun) return { text: 'kein aktueller Plan', tone: 'warn' };
  const age = now.getTime() - Date.parse(lastRun);
  return { text: relAge(age), tone: age > PLAN_STALE_MS ? 'warn' : 'ok' };
}

/** „vor 7 Min." in der Sprache von `format.fmtRelative`, aus einer Dauer. */
export function relAge(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `vor ${Math.round(s)} Sek.`;
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return `vor ${Math.round(s / 86400)} Tagen`;
}

/**
 * Die Chips einer Zeile. Sie NENNEN, was los ist - eine gesunde Zeile bekommt
 * genau einen ruhigen Chip, damit „alles in Ordnung" auch eine Aussage ist und
 * nicht bloß ein leeres Feld.
 */
export function rowSignals(
  site: OverviewSite,
  sources: SourceHealth | null,
  edge: EdgeStand,
  pflege: PflegeItem[] | null,
): FleetSignal[] {
  const out: FleetSignal[] = [];
  if (site.deviceCount === 0) {
    out.push({ id: 'kein-geraet', label: 'Kein Gerät verbunden', tone: 'off' });
  } else if (site.worstStatus === 'stale') {
    out.push({ id: 'still', label: 'Gerät meldet sich nicht', tone: 'warn' });
  } else if (site.worstStatus === 'waiting') {
    out.push({ id: 'wartet', label: 'Wartet auf erste Daten', tone: 'off' });
  }
  if (sources && sources.stale > 0) {
    out.push({
      id: 'quelle-still',
      label: `${sources.stale} Quelle${sources.stale > 1 ? 'n' : ''} ohne aktuelle Werte`,
      tone: 'warn',
    });
  }
  if (edge.outdated) {
    out.push({ id: 'edge-alt', label: 'Edge veraltet', tone: 'warn' });
  }
  for (const p of pflege ?? []) {
    out.push({ id: `pflege-${p.id}`, label: p.label, tone: 'warn' });
  }
  if (out.length === 0) {
    out.push({ id: 'ok', label: 'Alles in Ordnung', tone: 'ok' });
  }
  return out;
}

/**
 * Die Sortierung: je höher, desto eher braucht die Zeile jemanden. Bewusst eine
 * Summe von Gewichten statt einer Rangliste - eine Anlage, an der DREI Dinge
 * hängen, steht über einer mit einem.
 */
function attentionScore(
  device: Tone,
  live: Tone,
  plan: Tone,
  sources: SourceHealth | null,
  edge: EdgeStand,
  pflege: PflegeItem[] | null,
): number {
  let score = 0;
  if (device === 'warn') score += 100;
  if (live === 'warn') score += 60;
  if (sources?.tone === 'warn') score += 40;
  if (plan === 'warn') score += 30;
  if (device === 'off') score += 20;
  if (edge.outdated) score += 10;
  score += (pflege?.length ?? 0) * 5;
  return score;
}

/** Der Kopf-Puls über allen Zeilen. */
export interface FleetPulse {
  sites: number;
  gestoert: number;
  planAlt: number;
  wartet: number;
  pflegeOffen: number;
}

export function fleetPulse(rows: FleetRow[]): FleetPulse {
  return {
    sites: rows.length,
    gestoert: rows.filter((r) => r.deviceTone === 'warn' || r.liveTone === 'warn').length,
    planAlt: rows.filter((r) => r.planTone === 'warn').length,
    wartet: rows.filter((r) => r.signals.some((s) => s.id === 'wartet' || s.id === 'kein-geraet'))
      .length,
    pflegeOffen: rows.reduce((n, r) => n + (r.pflege?.length ?? 0), 0),
  };
}

/**
 * Der Satz über einen TEILAUSFALL. Ein toter Mandant darf den Puls nicht leeren
 * und auch nicht stillschweigend fehlen - er wird beim Namen genannt.
 * `null`, wenn alles geladen hat.
 */
export function fleetLoadNote(data: FleetTenantData[]): string | null {
  const failed = data.filter((d) => d.overview == null).map((d) => d.tenant.name);
  if (failed.length === 0) return null;
  if (failed.length === 1) {
    return `Für „${failed[0]}" konnten die Anlagen gerade nicht geladen werden - diese Zeilen fehlen.`;
  }
  return `Für ${failed.length} Mandanten konnten die Anlagen gerade nicht geladen werden (${failed.join(', ')}) - diese Zeilen fehlen.`;
}

// ---------------------------------------------------------------------------
// B2 · Die Steuerungs- und Abregel-Matrix (Sektion des Pulses)
// ---------------------------------------------------------------------------

/**
 * Die Pilsting-Support-Sicht: **wo ist Steuerung frei UND zertifiziert, und wo
 * klafft geplant gegen ausgeführt?**
 *
 * Der Fall, der den Baustein erzwungen hat: eine Anlage meldete „die PV wird
 * gedrosselt" neben 16,6 kW gemessener Einspeisung, weil `certifiedUnits <
 * units` war - der Beleg lag seit PR #313 in der DB, aber für Admins gab es
 * keine Fläche dafür. Sichtbar wurde es erst durch den Anruf des Kunden.
 *
 * **Die Wahrheit wird WIEDERVERWENDET, nie dupliziert:** die Abregel-Stufen
 * kommen aus `curtailment.curtailTruth` (dieselbe Funktion, die im
 * Kundenkontext die Drei-Stufen-Wortlaute trägt), die Ausführungs-Modi aus
 * `control.EXECUTION_MODE_LABEL`, das Stale-Fenster aus
 * `control.CONTROL_STALE_MS`. Die Admin-Fläche darf technischer beschriftet
 * sein - sie darf nie etwas ANDERES behaupten.
 */
export interface ControlMatrixRow {
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  /** Batterie-Steuerung: Zustand + Satz. */
  battery: { text: string; detail: string | null; tone: Tone };
  /** Abregelung: die Drei-Stufen-Wahrheit, technisch beschriftet. */
  curtail: { text: string; detail: string | null; tone: Tone };
  /** Ausführungs-Modus, den das Gerät zuletzt gemeldet hat. */
  executionText: string;
  /** Frische des Belegs; `null` = gar kein Beleg. */
  belegText: string;
  belegStale: boolean;
  /** Sortierschlüssel: je höher, desto eher braucht die Zeile jemanden. */
  attention: number;
}

/** Was für EINE Anlage der Matrix geladen wurde (beides einzeln optional). */
export interface ControlMatrixInput {
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  control: ControlStatus | null;
  curtailment: CurtailmentStatus | null;
}

/**
 * Die Matrix-Zeilen, Aufmerksamkeit zuerst. Eine Anlage ganz ohne Beleg bleibt
 * DRIN und sagt das - „keine Zeile" läse sich als „alles in Ordnung".
 */
export function controlMatrixRows(
  inputs: ControlMatrixInput[],
  now: Date = new Date(),
): ControlMatrixRow[] {
  return inputs
    .map((i) => controlMatrixRow(i, now))
    .sort(
      (a, b) =>
        b.attention - a.attention ||
        a.tenantName.localeCompare(b.tenantName, 'de') ||
        a.siteName.localeCompare(b.siteName, 'de'),
    );
}

export function controlMatrixRow(
  input: ControlMatrixInput,
  now: Date = new Date(),
): ControlMatrixRow {
  const battery = batteryCell(input.control, now);
  const truth = curtailTruth(input.curtailment, now);
  const curtail = curtailCell(input.curtailment, truth);
  const checkedAt = newestCheckedAt(input.control, input.curtailment);
  const stale = checkedAt == null ? false : now.getTime() - checkedAt > CONTROL_STALE_MS;
  return {
    siteId: input.siteId,
    siteName: input.siteName,
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    battery,
    curtail,
    executionText: executionText(input.control),
    belegText: checkedAt == null ? 'kein Beleg' : relAge(now.getTime() - checkedAt),
    belegStale: stale,
    attention:
      (battery.tone === 'warn' ? 60 : battery.tone === 'off' ? 20 : 0) +
      (curtail.tone === 'warn' ? 50 : curtail.tone === 'off' ? 10 : 0) +
      (checkedAt == null ? 15 : stale ? 25 : 0),
  };
}

function batteryCell(
  status: ControlStatus | null,
  now: Date,
): { text: string; detail: string | null; tone: Tone } {
  if (!status) {
    return { text: 'kein Beleg', detail: 'Das Gerät hat noch nie zurückgelesen.', tone: 'off' };
  }
  if (!status.controlEnabled) {
    return { text: 'Steuerung aus', detail: 'Not-Aus auf dem Gerät gesetzt.', tone: 'off' };
  }
  if (!status.certified) {
    return {
      text: 'nicht zertifiziert',
      detail: 'Das Modell ist für die Steuerung noch nicht freigegeben.',
      tone: 'off',
    };
  }
  const stale = now.getTime() - Date.parse(status.checkedAt) > CONTROL_STALE_MS;
  if (stale) {
    return {
      text: 'aktiv · zertifiziert',
      detail: 'Der letzte Beleg ist zu alt, um etwas zu bestätigen.',
      tone: 'off',
    };
  }
  if (!status.allMatch) {
    return {
      text: 'Rücklesen weicht ab',
      detail: status.mismatchRoles
        ? `Abweichung bei: ${status.mismatchRoles}`
        : 'Der Wechselrichter bestätigt einen anderen Wert.',
      tone: 'warn',
    };
  }
  return { text: 'aktiv · zertifiziert', detail: 'Werte stimmen überein.', tone: 'ok' };
}

/**
 * Die Abregel-Zelle - technisch beschriftet, aber Stufe für Stufe dieselbe
 * Wahrheit wie im Kundenkontext. Der Freigabestand ({@link releaseNote}) steht
 * PROMINENT, weil genau er der Pilsting-Fall war.
 */
function curtailCell(
  status: CurtailmentStatus | null,
  truth: CurtailTruth,
): { text: string; detail: string | null; tone: Tone } {
  if (!status || !(status.units > 0)) {
    return { text: 'kein Abregel-Aktor', detail: null, tone: 'off' };
  }
  const release = releaseNote(status.certifiedUnits, status.units);
  if (truth.stale) {
    return { text: release, detail: 'Der Beleg ist zu alt - Stand unbekannt.', tone: 'off' };
  }
  switch (truth.stufe) {
    case 'uebersteuert':
      return { text: release, detail: capitalize(truth.cause), tone: 'warn' };
    case 'nicht_umgesetzt':
      return { text: release, detail: capitalize(truth.cause), tone: 'warn' };
    case 'ausgefuehrt':
      return {
        text: release,
        detail:
          truth.appliedCapKw == null
            ? 'Begrenzung vom Wechselrichter bestätigt.'
            : `Begrenzung ${truth.appliedCapKw.toLocaleString('de-DE', {
                maximumFractionDigits: 1,
              })} kW - vom Wechselrichter bestätigt.`,
        tone: 'ok',
      };
    default:
      return { text: release, detail: null, tone: 'off' };
  }
}

/**
 * Der Ausführungs-Modus, den das GERÄT gemeldet hat. Ohne Meldung (ältere
 * Edge-Version) bleibt es beim Zeichen für „liegt nicht vor" - nie ein
 * geratener Modus.
 */
function executionText(status: ControlStatus | null): string {
  const mode = status?.executionMode;
  if (!mode) return DASH;
  return EXECUTION_MODE_LABEL[mode] ?? DASH;
}

/**
 * Der jüngste der beiden Beleg-Zeitpunkte. Die zwei Blöcke reisen im selben
 * Herzschlag, kommen aber unabhängig an - „geprüft" heißt deshalb: einer der
 * beiden hat sich zuletzt gemeldet.
 */
function newestCheckedAt(
  control: ControlStatus | null,
  curtailment: CurtailmentStatus | null,
): number | null {
  const times = [control?.checkedAt, curtailment?.checkedAt]
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  return times.length === 0 ? null : Math.max(...times);
}

function capitalize(s: string | null): string | null {
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

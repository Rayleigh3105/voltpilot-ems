import type { ControlStatus, CurtailmentStatus } from './api';
import { ONLINE_WINDOW_MS } from './api';
import type {
  AdminFleetEdge,
  AdminFleetForecast,
  AdminFleetKwp,
  AdminFleetPflege,
  AdminFleetRelease,
  AdminFleetSite,
  AdminFleetSources,
  AdminFleetUpdate,
} from './admin/fleetApi';
import { CONTROL_STALE_MS, EXECUTION_MODE_LABEL } from './control';
import { curtailTruth, releaseNote, type CurtailTruth } from './curtailment';

/**
 * Der Flotten-Puls der Plattform-Übersicht (Baustein B1) - die Antwort auf die
 * tägliche erste Frage eines EMS-Betreibers: **welche Anlage braucht heute
 * meine Aufmerksamkeit?**
 *
 * Bis dahin beantwortete das keine Fläche: alles Operative lag hinter dem
 * Mandanten-Umschalter, ein Mandant nach dem anderen. Es fehlten keine Daten,
 * es fehlte die Sichtachse.
 *
 * Dieses Modul ist REIN: es macht aus der EINEN Flotten-Antwort
 * (`GET /api/v1/admin/fleet`, Stufe 2) eine Zeile je Anlage - und sortiert
 * Aufmerksamkeit nach oben. **Die Ableitungen sind dieselben wie in Stufe 1;
 * nur die Datenquelle hat gewechselt** (die Mandanten-Schleife ist entfallen,
 * und die Pflege-Punkte kommen jetzt server-abgeleitet an - eine Wahrheit).
 *
 * Drei Ehrlichkeitsregeln gelten überall:
 *
 * 1. **Was nicht gemessen ist, bleibt leer** ({@link DASH}) und nennt seinen
 *    Grund - nie eine erfundene Null, nie ein geratener Zustand.
 * 2. **Ein FEHLGESCHLAGENER Abruf ist keine Datenlage.** Scheitert der
 *    Endpunkt, steht das als Fehler da; der Puls behauptet nie eine leere
 *    Flotte.
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

/** Ein Signal-Chip einer Zeile. `title` trägt die Begründung, wo es eine gibt. */
export interface FleetSignal {
  id: string;
  label: string;
  tone: Tone;
  title?: string;
}

/**
 * Ein offener Pflege-Punkt. Er wird SERVER-seitig abgeleitet (Stufe 2) - es gibt
 * bewusst keine zweite Ableitung im Client, sonst könnten Puls und Anlage
 * Verschiedenes behaupten.
 */
export type PflegeItem = AdminFleetPflege;

/**
 * Der Edge-Stand einer Zeile - seit OTA Stufe 0 ein SOLL-GEGEN-IST.
 *
 * `status` ist die eigentliche Aussage, und sie hat bewusst FÜNF Werte statt
 * eines Ja/Nein:
 *
 * - `unbekannt` - das Gerät hat gar nichts gemeldet. **Nie „veraltet".**
 * - `aktuell` - der gemeldete Stand IST der Soll-Stand.
 * - `veraltet` - der gemeldete Stand steht im Register UND liegt davor.
 * - `nicht_registriert` - der gemeldete Stand steht NICHT im Register (eine
 *   Bestands-Edge trägt eine nackte Commit-SHA). Das ist eine Lücke im
 *   Register, keine Aussage über das Alter des Geräts - deshalb ist es
 *   ausdrücklich kein „veraltet" und trägt keinen Warnton.
 * - `kein_massstab` - das Register ist leer. Ohne Maßstab wird nichts
 *   behauptet (der Zustand am Deploy-Tag, bevor ein Release eingetragen ist).
 */
export type EdgeStandStatus =
  | 'unbekannt'
  | 'aktuell'
  | 'veraltet'
  | 'nicht_registriert'
  | 'kein_massstab';

export interface EdgeStand {
  /** Die gemeldete Kernversion, oder null wenn nichts gemeldet wurde. */
  coreVersion: string | null;
  paletteVersion: string | null;
  status: EdgeStandStatus;
  text: string;
  tone: Tone;
  /** True NUR bei `veraltet` - also nur, wenn das Register es belegt. */
  outdated: boolean;
  /** Die Begründung des Zustands; sie reist als `title` am Text mit. */
  title: string;
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
  /** Quellen-Gesundheit; `null` = das Gerät hat nichts gemeldet (nie „alles gesund"). */
  sources: SourceHealth | null;
  edge: EdgeStand;
  /** Offene Pflege-Punkte (server-abgeleitet); leer = nichts offen. */
  pflege: PflegeItem[];
  /** Die kWp-Plausibilität - `unbekannt` nennt in `reason` ihren Grund. */
  kwp: AdminFleetKwp;
  /** Prognosequalität je Prognoseart; leer = kein bewerteter Tag. */
  forecast: AdminFleetForecast[];
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
 * Die Quellen-Gesundheit aus den vom Gerät gemeldeten Quellen. Ein Gerät, das
 * (noch) nichts meldet, hat gar keinen Block - daraus wird bewusst „keine
 * Meldung" (`null`) und nicht „0 gesund".
 */
export function sourceHealth(counts: AdminFleetSources | null): SourceHealth | null {
  if (!counts || counts.total === 0) return null;
  const { total, ok, stale, never } = counts;
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
 * Der SOLL-Stand der Flotte: der neueste Eintrag des Release-Registers, oder
 * `null` bei leerem Register. Der Endpunkt liefert das Register schon nach
 * `releaseSeq` absteigend - hier steht die Regel trotzdem EINMAL explizit, denn
 * sie ist die ganze Ordnung: `releaseSeq` ist eine monotone Ganzzahl, nie ein
 * String- oder SHA-Vergleich.
 */
export function sollRelease(releases: AdminFleetRelease[]): AdminFleetRelease | null {
  let newest: AdminFleetRelease | null = null;
  for (const r of releases) {
    if (newest == null || r.releaseSeq > newest.releaseSeq) newest = r;
  }
  return newest;
}

/**
 * Läuft `release` auf einem Gerät, das sich mit `stamped` meldet?
 *
 * Die Hausregel, gespiegelt aus `otaverify.ReleaseIsRunning` (Go-Core) und
 * `RolloutStates.releaseIsRunning` (api): edge-images stempelt bei einem
 * TAG-Lauf `<tag>-<kurzsha>` (`edge-images.yaml` „Compute version stamp"),
 * das Register trägt aber den nackten Tag - also zählt sowohl die blanke
 * Gleichheit als auch das Tag mit angehängter SHA. Ein Bestandsbau trägt eine
 * nackte SHA und gehört damit zu KEINEM Release; das ist die ehrliche Antwort,
 * nicht ein geratenes „ist wohl aktuell".
 *
 * **Die drei Kopien dürfen nicht auseinanderlaufen** (das refCheckChar/EdgeRef-
 * Muster) - sonst beantworten Gerät, Rollout-Wächter und Puls dieselbe Frage
 * verschieden.
 */
export function releaseIsRunning(release: string, stamped: string): boolean {
  const s = stamped.trim();
  if (!s || !release) return false;
  return s === release || s.startsWith(`${release}-`);
}

/**
 * Der Edge-Stand einer Anlage als SOLL-GEGEN-IST (OTA Stufe 0).
 *
 * Drei Ehrlichkeitsregeln, jede gegen einen konkreten früheren Fehlgriff:
 *
 * 1. **Kein gemeldeter Stand heißt „unbekannt", nie „veraltet".** Ein Gerät
 *    kann schweigen, weil es neu ist oder weil nie eine Automation ausgerollt
 *    wurde - daraus eine Alters-Aussage zu machen wäre eine Behauptung.
 * 2. **Die Ordnung ist das Register, nicht der Versionsstring.** Der Vorgänger
 *    verglich Zahlenblöcke, gestempelt werden aber 12-stellige Hex-SHAs -
 *    `parseInt("665d59b8…")` = 665 gegen `parseInt("3bf8c038…")` = 3 ist eine
 *    ZUFALLSORDNUNG. Verglichen wird jetzt ausschließlich `releaseSeq`.
 * 3. **Ein Stand, den das Register nicht kennt, ist „nicht registriert".** Das
 *    ist eine Lücke im Register (genau der Zustand einer Bestands-Edge mit
 *    nackter SHA), keine Aussage über das Gerät - also kein Warnton und
 *    ausdrücklich kein „veraltet". Zugeordnet wird über [releaseIsRunning],
 *    also die PRÄFIX-Regel des Hauses: ein Tag-Build meldet
 *    `<tag>-<kurzsha>`, im Register steht der nackte Tag - eine strikte
 *    Gleichheit hätte jedes erfolgreich angewandte Tag-Release als „nicht
 *    registriert" gelesen.
 *
 * Der IST-Stand kommt bevorzugt aus dem OTA-Block (er reist top-level im
 * Herzschlag und deckt auch Geräte ohne Flow-Deployment ab) und fällt sonst auf
 * den flows-getragenen `coreVersion` zurück - so bleibt eine ältere Edge
 * genauso sichtbar wie bisher.
 */
export function edgeStand(
  edge: AdminFleetEdge | null,
  update: AdminFleetUpdate | null,
  releases: AdminFleetRelease[],
): EdgeStand {
  const ist = update?.version ?? edge?.coreVersion ?? null;
  const paletteVersion = edge?.paletteVersion ?? null;
  if (!ist) {
    return {
      coreVersion: null,
      paletteVersion,
      status: 'unbekannt',
      text: 'unbekannt',
      tone: 'off',
      outdated: false,
      title: 'Das Gerät hat noch keinen Software-Stand gemeldet.',
    };
  }
  const soll = sollRelease(releases);
  if (!soll) {
    return {
      coreVersion: ist,
      paletteVersion,
      status: 'kein_massstab',
      text: ist,
      tone: 'off',
      outdated: false,
      title: 'Kein Release im Register - ohne Maßstab wird kein Stand als veraltet bewertet.',
    };
  }
  const entry = releases.find((r) => releaseIsRunning(r.version, ist));
  if (!entry) {
    return {
      coreVersion: ist,
      paletteVersion,
      status: 'nicht_registriert',
      text: `${ist} · nicht registriert`,
      tone: 'off',
      outdated: false,
      title:
        `Dieser Stand steht nicht im Release-Register (Soll: ${soll.version}). ` +
        'Ob er älter oder neuer ist, lässt sich daraus nicht sagen.',
    };
  }
  // Benannt wird ab hier der REGISTER-Eintrag, nicht die rohe Stempelung: ein
  // Tag-Build meldet `<tag>-<kurzsha>`, und in einer schmalen Spalte ist der
  // Release-Name die Aussage. Die Stempelung geht nicht verloren - sie bleibt
  // in `coreVersion` und, wo sie abweicht, im Titel.
  const stampNote = entry.version === ist ? '' : ` Gemeldet: ${ist}.`;
  if (entry.releaseSeq >= soll.releaseSeq) {
    return {
      coreVersion: ist,
      paletteVersion,
      status: 'aktuell',
      text: `${entry.version} ✓`,
      tone: 'ok',
      outdated: false,
      title: `Das Gerät fährt den aktuellen Stand des Release-Registers.${stampNote}`,
    };
  }
  return {
    coreVersion: ist,
    paletteVersion,
    status: 'veraltet',
    text: `${entry.version} → ${soll.version}`,
    tone: 'warn',
    outdated: true,
    title:
      `Das Gerät fährt ${entry.version}; im Register steht ${soll.version} ` +
      `als neuester Stand.${stampNote}`,
  };
}

/**
 * Eine Zeile je Anlage über die ganze Flotte, Aufmerksamkeit zuerst.
 *
 * `now` ist die ANTWORTZEIT des Servers, nicht die Wanduhr - siehe die
 * Lebendigkeits-Lehre im Kopf dieser Datei.
 *
 * `releases` ist das Release-Register aus derselben Antwort - der Maßstab für
 * „veraltet". Leer (oder weggelassen, etwa gegen einen älteren Backend-Stand)
 * heißt: kein Maßstab, also wird nichts als veraltet behauptet.
 */
export function fleetRows(
  sites: AdminFleetSite[],
  now: Date = new Date(),
  releases: AdminFleetRelease[] = [],
): FleetRow[] {
  const rows: FleetRow[] = sites.map((site) => {
    const sources = sourceHealth(site.sources);
    const edge = edgeStand(site.edge, site.update, releases);
    const live = liveCell(site, now);
    const plan = planCell(site.lastPlanGeneratedAt, now);
    const devices = deviceCell(site);
    return {
      siteId: site.siteId,
      siteName: site.siteName,
      tenantId: site.tenantId,
      tenantName: site.tenantName,
      deviceText: devices.text,
      deviceTone: devices.tone,
      liveText: live.text,
      liveTone: live.tone,
      planText: plan.text,
      planTone: plan.tone,
      sources,
      edge,
      pflege: site.pflege,
      kwp: site.kwp,
      forecast: site.forecast,
      signals: rowSignals(site, sources, edge, site.pflege),
      attention: attentionScore(devices.tone, live.tone, plan.tone, sources, edge, site.pflege),
      hasStorage: site.hasStorage,
    };
  });
  return rows.sort(
    (a, b) =>
      b.attention - a.attention ||
      a.tenantName.localeCompare(b.tenantName, 'de') ||
      a.siteName.localeCompare(b.siteName, 'de'),
  );
}

/**
 * Die Eingaben der B2-Matrix aus derselben EINEN Antwort - nur Anlagen mit
 * Speicher. Eine Anlage OHNE Beleg bleibt bewusst drin und sagt das; „keine
 * Zeile" läse sich als „alles in Ordnung".
 */
export function controlMatrixInputs(sites: AdminFleetSite[]): ControlMatrixInput[] {
  return sites
    .filter((s) => s.hasStorage)
    .map((s) => ({
      siteId: s.siteId,
      siteName: s.siteName,
      tenantId: s.tenantId,
      tenantName: s.tenantName,
      control: s.control,
      curtailment: s.curtailment,
    }));
}

function deviceCell(site: AdminFleetSite): { text: string; tone: Tone } {
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
function liveCell(site: AdminFleetSite, now: Date): { text: string; tone: Tone } {
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
  site: AdminFleetSite,
  sources: SourceHealth | null,
  edge: EdgeStand,
  pflege: PflegeItem[],
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
    // Der Chip trägt seine Begründung mit - sie benennt den Soll-Stand aus dem
    // Register, also WORAUFHIN das Gerät veraltet ist.
    out.push({ id: 'edge-alt', label: 'Edge veraltet', tone: 'warn', title: edge.title });
  }
  for (const p of pflege) {
    out.push({
      id: `pflege-${p.code}`,
      label: p.label,
      tone: 'warn',
      ...(p.detail ? { title: p.detail } : {}),
    });
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
  pflege: PflegeItem[],
): number {
  let score = 0;
  if (device === 'warn') score += 100;
  if (live === 'warn') score += 60;
  if (sources?.tone === 'warn') score += 40;
  if (plan === 'warn') score += 30;
  if (device === 'off') score += 20;
  if (edge.outdated) score += 10;
  score += pflege.length * 5;
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
    pflegeOffen: rows.reduce((n, r) => n + r.pflege.length, 0),
  };
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

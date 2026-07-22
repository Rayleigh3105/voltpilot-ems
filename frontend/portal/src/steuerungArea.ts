/**
 * Die Ableitung der Steuerungs-Fläche — rein, ohne React/Netzwerk (der
 * `surface.ts`/`fleet.ts`-Präzedenzfall).
 *
 * **Portal v3 · M4** (`docs/portal-v3/M4-steuerung.md`): die Steuerung
 * beantwortet EINE Frage — „Was darf VoltPilot, und was habe ich selbst
 * geregelt?" — mit ZWEI Kapseln plus einer schmalen Schutz-Zeile:
 *
 *  1. **Modus-Profile** (`profileRows`) — kompakte Zeilen: Statuspunkt, EIN
 *     Satz mit echten Zahlen, Schalter. Das Regal (Nutzen, Freischaltungen,
 *     Voraussetzungen) ist M3s Fläche; von hier führt „Profile verwalten →"
 *     dorthin. Der Ko-Optimierungs-Streifen + `socReservationStack` bilden die
 *     Fußzeile dieser Kapsel.
 *  2. **Automationen** (`automationRows`) — je Regel eine Zeile mit ihrem
 *     lebenden Zustand und EINEM „＋ Neue Automation"-Knopf.
 *
 * Die alte Werkzeugkiste („＋ Modus hinzufügen") ist ERSETZT: Angebote leben
 * ausschließlich in M3s Regal, die zweite Tür in den Editor gibt es nicht mehr.
 *
 * Zwei Regeln bleiben Gesetz:
 *  - **Nie eine erfundene Zahl.** Fehlt die Zuordnung (Automationen, E15) oder
 *    die Erlös-Antwort, steht dort „—", nie eine 0.
 *  - **Stammdaten-Ehrlichkeit** (report §1.2): ein nur über Stammdaten aktiver
 *    Modus sagt „Von VoltPilot eingerichtet" und bekommt KEINE
 *    „Flow öffnen"-Affordanz — nie einen editierbaren Flow versprechen, den es
 *    nicht gibt.
 */

import type { EarningsSite, EntityStrategy } from './api';
import { eurAmount, fmtNum } from './format';
import { steeringAttributionNote } from './erloesKomposition';
import { lifecycleLabel, type EditorEntity } from './flows/model';
import { AUTOMATIC_MODULES } from './moduleSurface';
import { blockedReason, type SiteProfile } from './profiles';
import {
  VOLTPILOT_MANAGED,
  type ActiveMode,
  type ModeKind,
  type MoneyStreamId,
  type StreamPeriod,
} from './surface';

// ---------------------------------------------------------------------------
// 1 · Der Beitrag eines Modus (echte Zahlen, sonst "—")
// ---------------------------------------------------------------------------

/**
 * Aus WELCHEM Feld der Erlös-Antwort ein Geld-Strom seinen Wert liest. Labels,
 * Reihenfolge und Periode kommen aus dem M0-Manifest (`surface.ts`), damit
 * Steuerung und Erlös-Komposition (M4) dieselbe Sprache sprechen; hier steht
 * nur die Auflösung auf ein konkretes Feld. `null` = es GIBT keine Zuordnung
 * (Automationen, E15 nicht gebaut) — die Zeile zeigt "—".
 */
const STREAM_FIELD: Record<MoneyStreamId, ((e: EarningsSite) => number | null) | null> = {
  eigenverbrauchswert: (e) => e.eigenverbrauchsWertEur,
  einspeisung: (e) => e.einspeiseErloesEur,
  handel: (e) => e.savedEur,
  lastspitzen: (e) => e.peakShaving?.avoidedEur ?? null,
  automation: null,
};

export interface ContributionRow {
  id: MoneyStreamId;
  label: string;
  /** Formatierter Betrag; null = keine Zahl (zeigt "—"). */
  value: string | null;
  period: StreamPeriod;
  /** Kurzer Zusatz (Periode/Kleingedrucktes); null = keiner. */
  note: string | null;
}

/** Periodenlabel — quer über Perioden wird NIE stillschweigend summiert (§1.4). */
export function periodLabel(period: StreamPeriod): string {
  return period === 'billing-period' ? 'laufende Abrechnungsperiode' : 'im gewählten Zeitraum';
}

/**
 * Der Beitrag eines Modus — eine Zeile je Geld-Strom seines M0-Manifests.
 * Fehlt die Erlös-Antwort oder das Feld, steht dort ehrlich "—", nie eine 0.
 */
export function contributionRows(
  mode: ActiveMode,
  earnings: EarningsSite | null | undefined,
): ContributionRow[] {
  return mode.manifest.moneyStreams.map((stream) => {
    const read = stream.unattributed ? null : STREAM_FIELD[stream.id];
    const raw = read && earnings ? read(earnings) : null;
    return {
      id: stream.id,
      label: stream.label,
      value: raw == null ? null : eurAmount(raw),
      period: stream.period,
      note: stream.unattributed
        ? 'Pro Regel noch nicht zugeordnet.'
        : [
            periodLabel(stream.period),
            // MIG §5: dieselbe EINE Zurechnungs-Wahrheit wie im Geld-Stapel —
            // der Steuerungs-Beitrag steht UNTER dem Erlös, nie daneben.
            stream.attribution === 'steering' && earnings
              ? steeringAttributionNote(earnings.savedEur)
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
    };
  });
}

/**
 * Der zusätzliche Nachweis-Satz eines Lastspitzen-Modus ("X kW vermieden").
 * Null, solange in der laufenden Periode nichts gemessen ist.
 */
export function peakContributionNote(earnings: EarningsSite | null | undefined): string | null {
  const peak = earnings?.peakShaving;
  if (!peak || peak.avoidedKw == null) return null;
  return `Vermiedene Spitze: ${fmtNum(peak.avoidedKw, 'kW')}`;
}

// ---------------------------------------------------------------------------
// 1 · Geräte-Chips (welche Geräte der Modus beansprucht)
// ---------------------------------------------------------------------------

export interface EntityChip {
  id: string;
  label: string;
}

/** Speicher-Entitäten der Anlage (die Einheit, die jede Batterie-Strategie steuert). */
export function storageEntities(entities: EditorEntity[]): EditorEntity[] {
  return entities.filter((e) => e.entityType === 'battery-hybrid');
}

/**
 * Die Geräte, die dieser Modus beansprucht:
 *  - Flow-getragen → die **echten Claims** aus `api.entityStrategies` (welcher
 *    aktive Flow welche Entität anfasst) — kein Raten.
 *  - Stammdaten-getragen (kein Flow) → die Speicher-Einheit, die die
 *    VoltPilot-Ko-Optimierung fährt; ein Modus ohne Speicherbezug bekommt
 *    KEINE Chips (lieber nichts als eine Behauptung).
 */
export function entityChips(
  mode: ActiveMode,
  strategies: Record<string, EntityStrategy[]> | null | undefined,
  entities: EditorEntity[],
): EntityChip[] {
  const byId = new Map(entities.map((e) => [e.id, e] as const));
  const flowId = mode.flowRef?.flowId ?? null;
  if (flowId && strategies) {
    const chips: EntityChip[] = [];
    for (const [entityId, rows] of Object.entries(strategies)) {
      if (!(rows ?? []).some((r) => r.flowId === flowId)) continue;
      chips.push({ id: entityId, label: byId.get(entityId)?.label ?? entityId });
    }
    return chips.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }
  if (!flowId && isBatteryMode(mode.kind)) {
    return storageEntities(entities).map((e) => ({ id: e.id, label: e.label }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// 1 · Aktionen einer Modus-Karte
// ---------------------------------------------------------------------------

export interface ModeActions {
  /** "Details/Öffnen" — nur mit WIRKLICH auflösbarem Flow (report §1.2). */
  canOpen: boolean;
  /** "Pausieren" = den Flow stilllegen; nie bei Stammdaten-Modi. */
  canPause: boolean;
  /** Die Ehrlichkeits-Zeile eines Stammdaten-Modus; null sonst. */
  managedNote: string | null;
}

export function modeActions(mode: ActiveMode): ModeActions {
  const open = mode.manifest.steuerungCard.action === 'open-flow' && mode.flowRef != null;
  return {
    canOpen: open,
    canPause: open,
    managedNote: mode.manifest.steuerungCard.managed ? VOLTPILOT_MANAGED : null,
  };
}

// ---------------------------------------------------------------------------
// 2 · Ko-Optimierungs-Streifen
// ---------------------------------------------------------------------------

/** Welche Modi um DENSELBEN Speicher konkurrieren (und deshalb ko-optimiert werden). */
const BATTERY_MODE_KINDS: ModeKind[] = [
  'lastspitzenkappung',
  'marktvermarktung',
  'eigenverbrauch',
];

export function isBatteryMode(kind: ModeKind): boolean {
  return BATTERY_MODE_KINDS.includes(kind);
}

/**
 * Die speicher-beanspruchenden Modi. "In Vorbereitung"-Modi zählen NICHT mit —
 * was noch nicht rechnet, kann auch nicht mit-optimiert werden.
 */
export function batteryModes(modes: ActiveMode[]): ActiveMode[] {
  return modes.filter((m) => !m.preview && isBatteryMode(m.kind));
}

export interface CoOptimization {
  count: number;
  modeLabels: string[];
  /** "3 Modi, ein Speicher — VoltPilot optimiert sie gemeinsam." */
  sentence: string;
  /** Wie die Auflösung passiert (der ehrliche Zusatz). */
  detail: string;
}

/** Null unter zwei Speicher-Modi — dann gibt es nichts zu ko-optimieren. */
export function coOptimization(modes: ActiveMode[]): CoOptimization | null {
  const battery = batteryModes(modes);
  if (battery.length < 2) return null;
  return {
    count: battery.length,
    modeLabels: battery.map((m) => m.label),
    sentence: `${battery.length} Modi, ein Speicher — VoltPilot optimiert sie gemeinsam.`,
    detail:
      'Alle 15 Minuten wird EIN gemeinsamer Fahrplan gerechnet, der alle Ziele zugleich ' +
      'verfolgt — die Reservierungen unten legen fest, wer welchen Teil des Speichers sicher hat.',
  };
}

// ---------------------------------------------------------------------------
// 2 · Der SoC-Reservierungs-Stack
// ---------------------------------------------------------------------------

export interface ReservationInput {
  /** Technische Untergrenze (Plattform/Anlage), z. B. 5 %. */
  socMinPct?: number | null;
  /** Obergrenze des nutzbaren Bandes, z. B. 95 %. */
  socMaxPct?: number | null;
  /** Notstrom-Reserve (harte SoC-Grenze, P11). */
  backupReserveSocPct?: number | null;
  /** Lastspitzen-Reserve (PS-2, `site.peak_reserve_soc_pct`). */
  peakReserveSocPct?: number | null;
}

export interface ReservationLayer {
  key: 'technisch' | 'notstrom' | 'lastspitze' | 'frei';
  label: string;
  /** Untere/obere Kante in Prozent (0..100) — die Balkengeometrie. */
  fromPct: number;
  toPct: number;
  /** Eine erklärende Zeile. */
  note: string;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/**
 * Der Reservierungs-Stack (technische Untergrenze < Notstrom-Reserve <
 * Lastspitzen-Reserve < freies Band) als Balkensegmente. **Es wird nichts
 * erfunden:** eine nicht bekannte Schicht (Feld fehlt, Endpunkt für diesen
 * Nutzer nicht lesbar) erscheint gar nicht, und ohne jede bekannte Schicht ist
 * das Ergebnis leer — der Streifen zeigt dann nur den Ko-Optimierungs-Satz.
 *
 * Die Schichten sind ABSOLUTE Grenzen, nicht additiv: die höchste bindet
 * (dieselbe Regel wie im Solver, `max` über die Reservierungen).
 */
export function socReservationStack(input: ReservationInput | null | undefined): ReservationLayer[] {
  if (!input) return [];
  const known: { key: ReservationLayer['key']; label: string; pct: number; note: string }[] = [];
  if (input.socMinPct != null && Number.isFinite(input.socMinPct)) {
    known.push({
      key: 'technisch',
      label: 'Technische Untergrenze',
      pct: clampPct(input.socMinPct),
      note: 'Schutz der Batterie — wird nie unterschritten.',
    });
  }
  if (input.backupReserveSocPct != null && Number.isFinite(input.backupReserveSocPct)) {
    known.push({
      key: 'notstrom',
      label: 'Notstrom-Reserve',
      pct: clampPct(input.backupReserveSocPct),
      note: 'Bleibt für Ihren Notstrombedarf reserviert — kein Preis überschreibt sie.',
    });
  }
  if (input.peakReserveSocPct != null && Number.isFinite(input.peakReserveSocPct)) {
    known.push({
      key: 'lastspitze',
      label: 'Lastspitzen-Reserve',
      pct: clampPct(input.peakReserveSocPct),
      note: 'Vorgehalten, um eine Bezugsspitze auch außerhalb des Fahrplans zu kappen.',
    });
  }
  if (known.length === 0) return [];

  const top = input.socMaxPct != null && Number.isFinite(input.socMaxPct)
    ? clampPct(input.socMaxPct)
    : 100;
  const layers: ReservationLayer[] = [];
  let cursor = 0;
  for (const l of known) {
    const to = Math.min(l.pct, top);
    // Die Schichten werden in ihrer kanonischen Reihenfolge (technisch →
    // Notstrom → Lastspitze) durchlaufen; eine Reservierung, die die bisher
    // erreichte Kante nicht überragt, ist bereits abgedeckt (absolute Grenzen,
    // die höchste bindet) - sie bekommt dann kein eigenes Segment.
    if (to > cursor) {
      layers.push({ key: l.key, label: l.label, fromPct: cursor, toPct: to, note: l.note });
      cursor = to;
    }
  }
  if (top > cursor) {
    layers.push({
      key: 'frei',
      label: 'Frei für die Modi',
      fromPct: cursor,
      toPct: top,
      note: 'Dieser Teil wird von allen aktiven Modi gemeinsam genutzt.',
    });
  }
  return layers;
}

// ---------------------------------------------------------------------------
// M4 · Kapsel 1 — die Modus-Profil-Zeilen
// ---------------------------------------------------------------------------

/**
 * Eine kompakte Profil-Zeile der Steuerung: Statuspunkt, EIN Satz mit dem, was
 * das Profil beiträgt (echte Zahl + Periode, sonst „—"), und der Schalter.
 * Das Regal selbst (Nutzen, Freischaltungen, Voraussetzungen) bleibt M3s
 * Fläche — hier steht nur, was gerade läuft und was es bringt.
 */
export interface ProfileRow {
  id: string;
  label: string;
  /** Der effektive Zustand (M3-Overlay) — der Schalter zeigt genau ihn. */
  on: boolean;
  /** Der Statuspunkt: läuft / läuft-noch-nicht / aus. */
  tone: 'on' | 'blocked' | 'off';
  /** „Wert des Eigenverbrauchs: 88,25 € · im gewählten Zeitraum" bzw. „—". */
  contribution: string;
  /** M3s ehrlicher Satz, wenn ein EINGESCHALTETES Profil nicht voll läuft. */
  blockedReason: string | null;
}

/** Der Beitrag eines Modus als EINE Zeile (echte Zahlen, sonst „—"). */
function contributionLine(mode: ActiveMode | null, earnings: EarningsSite | null | undefined): string {
  if (!mode) return '—';
  const rows = contributionRows(mode, earnings).filter((r) => r.value != null);
  if (rows.length === 0) return '—';
  const period = periodLabel(rows[0].period);
  const sameperiod = rows.every((r) => r.period === rows[0].period);
  const parts = rows.map((r) => (sameperiod
    ? `${r.label}: ${r.value}`
    : `${r.label}: ${r.value} (${periodLabel(r.period)})`));
  return sameperiod ? `${parts.join(' · ')} · ${period}` : parts.join(' · ');
}

/**
 * Die Profil-Kapsel: eine Zeile je Profil, mit dem Beitrag des zugehörigen
 * AKTIVEN Modus. Profil-Ids und `ModeKind` teilen sich dasselbe Vokabular
 * (M0/M3), deshalb wird hier nichts geraten — ein Profil ohne laufenden Modus
 * bekommt schlicht keine Zahl.
 */
export function profileRows(
  profiles: SiteProfile[] | null | undefined,
  modes: ActiveMode[],
  earnings: EarningsSite | null | undefined,
): ProfileRow[] {
  const byKind = new Map(modes.map((m) => [String(m.kind), m] as const));
  return (profiles ?? []).map((p) => {
    const mode = byKind.get(p.id) ?? null;
    const reason = blockedReason(p);
    return {
      id: p.id,
      label: p.label,
      on: p.active,
      tone: p.active ? (reason ? 'blocked' : 'on') : 'off',
      contribution: p.active ? contributionLine(mode, earnings) : '—',
      blockedReason: reason,
    };
  });
}

export const PROFILE_CAPSULE_TITLE = 'Modus-Profile';

export const PROFILE_CAPSULE_INTRO =
  'Was VoltPilot auf Ihrer Anlage tun darf — und was es Ihnen bringt.';

export const PROFILE_CAPSULE_EMPTY =
  'Für diese Anlage sind noch keine Profile hinterlegt.';

export const PROFILE_MANAGE_LABEL = 'Profile verwalten';

// ---------------------------------------------------------------------------
// M4 · Kapsel 2 — die Automations-Zeilen
// ---------------------------------------------------------------------------

/**
 * Was ein Gerät über eine Regel gemeldet hat. Optional und ADDITIV: der
 * Knoten-Status kommt erst mit M5 vom Edge — ohne ihn steht in der Zeile
 * schlicht „Läuft", nie eine erfundene Zahl.
 */
export interface AutomationActivity {
  flowId: string;
  /** Wie oft die Regel heute geschaltet hat; null/undefined = unbekannt. */
  switchedToday?: number | null;
  /** Zeitpunkt der letzten Schaltung (ISO); null/undefined = unbekannt. */
  lastSwitchedAt?: string | null;
}

export interface AutomationRow {
  flowId: string;
  name: string;
  active: boolean;
  version: number;
  /** „Läuft · heute 3× geschaltet · zuletzt 14:02" bzw. „Läuft" / „Entwurf". */
  state: string;
  /** Punkt-Tönung: grün wenn ausgerollt, sonst ruhig. */
  tone: 'on' | 'off';
}

function timeOfDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Eine Zeile je Automation mit ihrem LEBENDEN Zustand. Ohne Knoten-Status
 * (heute immer, bis M5 den Edge-Block liefert) bleibt es bei „Läuft" —
 * ein Schaltzähler wird niemals geschätzt.
 */
export function automationRows(
  flows: { flowId: string; name: string; activeVersion: number | null; latestVersion: number; latestLifecycle: string }[],
  activity?: AutomationActivity[] | null,
): AutomationRow[] {
  const byFlow = new Map((activity ?? []).map((a) => [a.flowId, a] as const));
  return (flows ?? []).map((f) => {
    const active = f.activeVersion != null;
    const a = byFlow.get(f.flowId);
    const parts: string[] = [active ? 'Läuft' : lifecycleLabel(f.latestLifecycle)];
    if (active && a) {
      if (a.switchedToday != null && Number.isFinite(a.switchedToday)) {
        parts.push(`heute ${a.switchedToday}× geschaltet`);
      }
      const at = a.lastSwitchedAt ? timeOfDay(a.lastSwitchedAt) : null;
      if (at) parts.push(`zuletzt ${at}`);
    }
    return {
      flowId: f.flowId,
      name: f.name,
      active,
      version: active ? (f.activeVersion as number) : f.latestVersion,
      state: parts.join(' · '),
      tone: active ? 'on' : 'off',
    };
  });
}

export const AUTOMATION_CAPSULE_TITLE = 'Automationen';

export const AUTOMATION_CAPSULE_INTRO =
  'Ihre eigenen Wenn/Dann-Regeln — geprüft, simuliert und erst dann aktiv.';

export const AUTOMATION_CAPSULE_EMPTY =
  'Noch keine eigene Regel. Legen Sie eine an — z. B. „Wallbox nur bei PV-Überschuss".';

export const NEUE_AUTOMATION_LABEL = '＋ Neue Automation';

// ---------------------------------------------------------------------------
// M4 · Die schmale Schutz-Zeile (läuft immer, ohne Profil)
// ---------------------------------------------------------------------------

export interface ProtectionItem {
  key: string;
  label: string;
  tip: string;
}

/**
 * Die immer laufenden Schutzfunktionen als schmale Zeile. „Nur Solarladen"
 * erscheint NUR, wenn das Netzladen für die Anlage tatsächlich gesperrt ist —
 * sonst wäre die Zeile eine Behauptung.
 */
export function protectionItems(site: { netzladenErlaubt?: boolean | null }): ProtectionItem[] {
  const items: ProtectionItem[] = AUTOMATIC_MODULES.map((m) => ({
    key: m.title,
    label: m.title,
    tip: m.tip,
  }));
  if (site?.netzladenErlaubt === false) {
    items.push({
      key: 'eeg',
      label: 'EEG: nur Solarladen',
      tip:
        'Ihr Speicher wird ausschließlich mit eigenem Solarstrom geladen — so bleibt Ihre '
        + 'EEG-Vergütung unangetastet. Ihr Gerät hält das auch dann ein, wenn die Verbindung abreißt.',
    });
  }
  return items;
}

export const PROTECTION_INTRO = 'Läuft immer mit, ganz ohne Profil:';

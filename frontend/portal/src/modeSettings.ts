/**
 * v3.1-M1 — die Einstellungs-Registry des „Modus-Containers".
 *
 * v3.1 macht jeden Modus zu einem CONTAINER: einschalten heißt konfigurieren
 * dürfen, und die thematisch zugehörigen Einstellungen leben IM Modus statt
 * verstreut in der Technik-Seite (report `data/vp-portal-v31-design/report.md`
 * §1/§2). Dieses reine Modul ist die WAHRHEIT darüber, WELCHE Einstellung von
 * WELCHEN Modi beansprucht wird — die Container-UI (v3.1-M2/M3) rendert daraus,
 * dieses Modul rendert NICHTS.
 *
 * Der Split ist der verbindliche §2-Audit (inkl. der Owner-Korrekturen):
 *  - „Umgang mit dem Speicher" (Speicherschonung) → Marktvermarktung UND
 *    Eigenverbrauch (Owner-Korrektur: beide Modi, sonst wäre die Einstellung auf
 *    einer EEG-Hausanlage mit ausgeschaltetem Markt-Modus unerreichbar).
 *  - „Netzladen des Speichers" + „Anzulegender Wert" → Marktvermarktung.
 *  - „Stromtarif" → Eigenverbrauch (Erst-Claim) + Marktvermarktung (Zweit-Claim).
 *  - „Leistungspreis" · „Abrechnungsperiode" · „Lastspitzen-Reserve" →
 *    Lastspitzenkappung, read-only (`editability: 'voltpilot'`).
 *  - Atypische Netznutzung / Automation beanspruchen keine Einstellung.
 *
 * Dedupe = ERST-AKTIVER-GEWINNT über `MODE_RANK` — exakt das bewährte
 * `moneyStreams()`-Muster (deterministisch, nie doppelt gezeigt). Eine von
 * mehreren aktiven Modi beanspruchte Einstellung (Speicherschonung/Stromtarif)
 * erscheint nur unter dem RANGHÖCHSTEN aktiven Claimer, nie zweimal — sie ist
 * aber aus JEDEM beanspruchenden Modus erreichbar, sobald dieser der ranghöchste
 * aktive Claimer ist (z. B. Speicherschonung unter Eigenverbrauch, wenn der
 * Markt-Modus aus ist; unter Marktvermarktung, wenn beide an sind).
 *
 * Owner-Korrektur (strenger als der Report-Teaser-Vorschlag): die Einstellungen
 * eines AUSGESCHALTETEN Modus werden gar nicht gezeigt — kein gesperrter Teaser.
 * Das „Verstecken bei aus" ist eine reine UI-Sorge von v3.1-M2. Dieses Modul
 * trägt daher KEINE Teaser-Copy; es meldet nur, welche Einstellungen ein AKTIVER
 * Modus zeigt (`settingsForMode`) und welche gerade unbeansprucht ruhen
 * (`orphanedSettings`, reine Auskunft ohne Copy).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ANDOCK-MUSTER für einen KÜNFTIGEN Modus (v3.1-M4-Doku; NICHT gebaut).
 *
 * Ein neuer Container (report §2/§7: „Fernzugriff" mit der Einstellung „VPN")
 * dockt OHNE Kern-Änderung an — drei additive Zeilen, alles andere rendert die
 * Container-UI (v3.1-M2/M3) datengetrieben:
 *   1. `surface.ts`: eine neue `ModeKind` + `ModeSettingId`, ein `manifestFor`-
 *      Zweig mit `settings: ['vpn']` und die Aktivierungsregel in `activeModes`.
 *   2. HIER: ein `SETTING_DEFS`-Eintrag `vpn`, der die Heimat des Werts festlegt —
 *      `claimedBy: ['fernzugriff']`, und die WICHTIGE Weiche `editability`:
 *      `'customer'` (mit `editForm`) für einen selbst-schaltbaren Wert ODER
 *      `'voltpilot'` (`editForm: null`) für einen read-only „Von VoltPilot
 *      eingerichtet"-Wert — exakt das Muster der drei Lastspitzen-Werte (v3.1-M4).
 *   3. `ModusContainer.tsx`: eine `settingReadValue`-Zeile (und, nur bei
 *      `'customer'`, ein Inline-Formular) für die neue Id.
 * Dedupe/Waisen/Verstecken-bei-aus/Voll-Repräsentations-Save gelten dann
 * automatisch — der neue Modus ist ein Container wie jeder andere.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { MODE_RANK, type ActiveMode, type ModeKind, type ModeSettingId } from './surface';

/** Wer die Einstellung bearbeiten darf: der Kunde selbst oder nur VoltPilot. */
export type SettingEditability = 'customer' | 'voltpilot';

/**
 * Eine Einstellung des §2-Audits, mit ihren Modus-Claims + UI-Handles. `readView`
 * und `editForm` sind opake Handles, die v3.1-M3 auf konkrete React-Zeilen bzw.
 * Formulare abbildet (heute identisch zur Id — 1:1); `editForm` ist null für
 * read-only (von VoltPilot eingerichtete) Einstellungen.
 */
export interface ModeSettingDef {
  id: ModeSettingId;
  label: string;
  /**
   * Die KANONISCHEN Modus-Arten, die diese Einstellung beanspruchen. `[0]` ist
   * der konzeptionelle Erst-Claim (§2). Der LAUFZEIT-Gewinner bei mehreren
   * gleichzeitig aktiven Claimern ist aber der ranghöchste per `MODE_RANK`
   * (siehe `settingsForMode`) — das bewährte `moneyStreams()`-Muster. Beides
   * fällt zusammen, AUSSER beim Stromtarif: sein §2-Erst-Claim ist der
   * Eigenverbrauch, doch wenn Markt UND Eigenverbrauch gleichzeitig aktiv sind,
   * gewinnt per MODE_RANK der Markt-Modus (30 < 40) — der DV-Anlage-mit-
   * explizitem-EV-Flow-Sonderfall. Im häufigen Ein-Geld-Modus-Fall erscheint der
   * Tarif genau unter dem aktiven Modus, wie in §2 gedacht.
   */
  claimedBy: ModeKind[];
  editability: SettingEditability;
  /** Handle für die Lese-Zeile im Container (v3.1-M3 verdrahtet sie). */
  readView: ModeSettingId;
  /** Handle für das Bearbeiten-Formular; null = read-only (von VoltPilot). */
  editForm: ModeSettingId | null;
}

/**
 * Die Einstellungs-Registry, indiziert nach Id. Die Einfüge-Reihenfolge ist die
 * kanonische Reihenfolge für `orphanedSettings` (deterministisch).
 */
export const SETTING_DEFS: Record<ModeSettingId, ModeSettingDef> = {
  speicherschonung: {
    id: 'speicherschonung',
    label: 'Umgang mit dem Speicher',
    // Eigenverbrauch ist kein Modus mehr (report §3.3); die Batterie-Einstellung
    // wird nur noch vom Markt-Modus beansprucht.
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    readView: 'speicherschonung',
    editForm: 'speicherschonung',
  },
  netzladen: {
    id: 'netzladen',
    label: 'Netzladen des Speichers',
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    readView: 'netzladen',
    editForm: 'netzladen',
  },
  'anzulegender-wert': {
    id: 'anzulegender-wert',
    label: 'Anzulegender Wert',
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    readView: 'anzulegender-wert',
    editForm: 'anzulegender-wert',
  },
  stromtarif: {
    id: 'stromtarif',
    label: 'Stromtarif',
    // Der Stromtarif wird vom Markt-Modus beansprucht (Eigenverbrauch ist kein
    // Modus mehr, report §3.3).
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    readView: 'stromtarif',
    editForm: 'stromtarif',
  },
  leistungspreis: {
    id: 'leistungspreis',
    label: 'Leistungspreis',
    claimedBy: ['lastspitzenkappung'],
    editability: 'voltpilot',
    readView: 'leistungspreis',
    editForm: null,
  },
  'abrechnung-leistung': {
    id: 'abrechnung-leistung',
    label: 'Abrechnungsperiode',
    claimedBy: ['lastspitzenkappung'],
    editability: 'voltpilot',
    readView: 'abrechnung-leistung',
    editForm: null,
  },
  'lastspitzen-reserve': {
    id: 'lastspitzen-reserve',
    label: 'Lastspitzen-Reserve',
    claimedBy: ['lastspitzenkappung'],
    editability: 'voltpilot',
    readView: 'lastspitzen-reserve',
    editForm: null,
  },
};

/** Alle Einstellungen in kanonischer Reihenfolge (Registry-Einfüge-Reihenfolge). */
export const ALL_SETTINGS: ModeSettingDef[] = Object.values(SETTING_DEFS);

/** Die Definition einer Einstellung. */
export function settingDef(id: ModeSettingId): ModeSettingDef {
  return SETTING_DEFS[id];
}

function activeKindsOf(activeModes: ActiveMode[] | null | undefined): Set<ModeKind> {
  return new Set((activeModes ?? []).map((m) => m.kind));
}

/**
 * Der ranghöchste AKTIVE beanspruchende Modus einer Einstellung (`MODE_RANK`),
 * oder null, wenn kein Claimer aktiv ist. Das ist das `moneyStreams()`-Muster:
 * unter den aktiven Claimern gewinnt der mit dem kleinsten MODE_RANK.
 */
function firstActiveClaimer(def: ModeSettingDef, activeKinds: Set<ModeKind>): ModeKind | null {
  let winner: ModeKind | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const kind of def.claimedBy) {
    if (!activeKinds.has(kind)) continue;
    if (MODE_RANK[kind] < bestRank) {
      bestRank = MODE_RANK[kind];
      winner = kind;
    }
  }
  return winner;
}

/**
 * Die Einstellungen, die dieser AKTIVE Modus in seinem Container zeigt — in der
 * Anzeige-Reihenfolge des Modus-Manifests, DEDUPLIZIERT: eine von mehreren
 * aktiven Modi beanspruchte Einstellung erscheint nur unter dem ranghöchsten
 * aktiven Claimer (erst-aktiver-gewinnt über `MODE_RANK`).
 *
 * Ist der Modus NICHT aktiv (nicht in `activeModes`), gibt es keine
 * Einstellungen — die Owner-Regel „ein ausgeschalteter Modus zeigt seine
 * Einstellungen gar nicht" fällt hier von selbst heraus.
 */
export function settingsForMode(
  mode: ActiveMode,
  activeModes: ActiveMode[] | null | undefined,
): ModeSettingDef[] {
  const activeKinds = activeKindsOf(activeModes);
  return (mode.manifest.settings ?? [])
    .map((id) => SETTING_DEFS[id])
    .filter((def) => firstActiveClaimer(def, activeKinds) === mode.kind);
}

/**
 * Die Einstellungen, die gerade KEIN aktiver Modus beansprucht — sie ruhen (der
 * gespeicherte Wert bleibt erhalten), sind aber über keinen Container erreichbar.
 * Die Waisen-Regel als reine Auskunft, ohne Teaser-Copy (Owner-Korrektur).
 */
export function orphanedSettings(
  activeModes: ActiveMode[] | null | undefined,
): ModeSettingDef[] {
  const activeKinds = activeKindsOf(activeModes);
  return ALL_SETTINGS.filter((def) => !def.claimedBy.some((kind) => activeKinds.has(kind)));
}

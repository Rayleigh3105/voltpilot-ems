/**
 * v3.1-M1 — die Einstellungs-Registry des „Modus-Containers".
 *
 * v3.1 machte jeden Modus zu einem CONTAINER: einschalten heißt konfigurieren
 * dürfen, und die thematisch zugehörigen Einstellungen lebten IM Modus statt
 * verstreut in der Technik-Seite (report `data/vp-portal-v31-design/report.md`
 * §1/§2). Dieses reine Modul ist die WAHRHEIT darüber, WELCHE Einstellung von
 * WELCHEN Modi beansprucht wird — die Container-UI (v3.1-M2/M3) rendert daraus,
 * dieses Modul rendert NICHTS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **E1 (Settings-UX, Captain-Entscheid D1 vom 31.07.2026) — die HEIMAT eines
 * Werts hängt nie davon ab, ob ein Modus an ist.**
 *
 * Der Befund, der das erzwang (Konzept `data/vp-settings-ux-konzept/report.md`
 * §3): seit „Eigenverbrauch ist kein Modus mehr" beanspruchten ALLE vier
 * Kunden-Einstellungen nur noch `marktvermarktung` — und `settingsForMode`
 * liefert nichts, solange der Modus aus ist. Auf einer gewöhnlichen
 * PV-+-Speicher-Hausanlage war damit der Stromtarif **über keine Fläche
 * erreichbar**, obwohl der Optimierer mit ihm plant und jede Euro-Zahl mit ihm
 * bewertet wird. Die Sackgasse schloss sich, weil der Markt-Modus seinerseits
 * einen dynamischen Tarif voraussetzt.
 *
 * Seit E1 gilt deshalb `home`: die vier Kunden-Einstellungen WOHNEN auf der
 * Einstellungs-Seite der Anlage (`settingsPageSettings`) und werden dort
 * bearbeitet — auf JEDER Anlage, unabhängig von Anlagentyp und aktivem Modus.
 * `claimedBy` beantwortet ab jetzt „welcher Modus BRAUCHT diesen Wert" (der
 * Container SPIEGELT ihn read-only mit Deep-Link), nicht mehr „wo darf man ihn
 * ändern". `orphanedSettings` schrumpft damit auf das, was wirklich keine
 * Heimat hat — die drei von-VoltPilot-Werte der Lastspitzenkappung (E4 gibt
 * ihnen ihre sichtbare Autoritäts-Stufe).
 * ─────────────────────────────────────────────────────────────────────────────
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
 *   2. HIER: ein `SETTING_DEFS`-Eintrag `vpn` mit `claimedBy: ['fernzugriff']`
 *      und den zwei WICHTIGEN Weichen — `home` (wo der Wert WOHNT:
 *      `'einstellungen'` für alles, was der Kunde selbst stellt, `'modus'` nur
 *      für einen Wert, der ohne seinen Modus sinnlos wäre) und `editability`
 *      (`'customer'` mit `editForm` ODER `'voltpilot'` mit `editForm: null` für
 *      einen read-only „Von VoltPilot eingerichtet"-Wert — das Muster der drei
 *      Lastspitzen-Werte, v3.1-M4).
 *   3. `components/SettingEditors.tsx`: eine `settingReadValue`-Zeile (und, nur
 *      bei `'customer'`, ein Inline-Formular) für die neue Id. Beide Flächen —
 *      Einstellungs-Seite und Modus-Container-Spiegel — rendern daraus.
 * Dedupe/Waisen/Verstecken-bei-aus/Voll-Repräsentations-Save gelten dann
 * automatisch — der neue Modus ist ein Container wie jeder andere.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { MODE_RANK, type ActiveMode, type ModeKind, type ModeSettingId } from './surface';

/** Wer die Einstellung bearbeiten darf: der Kunde selbst oder nur VoltPilot. */
export type SettingEditability = 'customer' | 'voltpilot';

/**
 * Die HEIMAT eines Werts (E1, Captain-Entscheid D1) — der Ort, der ihn BESITZT
 * und an dem er bearbeitet wird:
 *  - `'einstellungen'` = die Einstellungs-Seite der Anlage. Sie zeigt ihn auf
 *    JEDER Anlage, unabhängig davon, ob irgendein Modus läuft; ein Modus-
 *    Container SPIEGELT ihn nur read-only mit Deep-Link hierher.
 *  - `'modus'` = der Wert lebt weiterhin ausschließlich im Container seines
 *    Modus (heute nur die drei von VoltPilot eingerichteten Lastspitzen-Werte).
 */
export type SettingHome = 'einstellungen' | 'modus';

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
  /**
   * Die Heimat des Werts (E1). `'einstellungen'` heißt: die Einstellungs-Seite
   * besitzt ihn, der Container spiegelt ihn read-only — genau das schafft die
   * Waisen-Klasse strukturell ab.
   */
  home: SettingHome;
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
    home: 'einstellungen',
    readView: 'speicherschonung',
    editForm: 'speicherschonung',
  },
  netzladen: {
    id: 'netzladen',
    label: 'Netzladen des Speichers',
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    home: 'einstellungen',
    readView: 'netzladen',
    editForm: 'netzladen',
  },
  'anzulegender-wert': {
    id: 'anzulegender-wert',
    label: 'Anzulegender Wert',
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    home: 'einstellungen',
    readView: 'anzulegender-wert',
    editForm: 'anzulegender-wert',
  },
  stromtarif: {
    id: 'stromtarif',
    label: 'Stromtarif',
    // Der Stromtarif wird vom Markt-Modus beansprucht (Eigenverbrauch ist kein
    // Modus mehr, report §3.3) — seit E1 WOHNT er aber auf der Einstellungs-
    // Seite, sonst wäre er auf einer Eigenverbrauchs-Anlage unerreichbar.
    claimedBy: ['marktvermarktung'],
    editability: 'customer',
    home: 'einstellungen',
    readView: 'stromtarif',
    editForm: 'stromtarif',
  },
  leistungspreis: {
    id: 'leistungspreis',
    label: 'Leistungspreis',
    claimedBy: ['lastspitzenkappung'],
    editability: 'voltpilot',
    home: 'modus',
    readView: 'leistungspreis',
    editForm: null,
  },
  'abrechnung-leistung': {
    id: 'abrechnung-leistung',
    label: 'Abrechnungsperiode',
    claimedBy: ['lastspitzenkappung'],
    editability: 'voltpilot',
    home: 'modus',
    readView: 'abrechnung-leistung',
    editForm: null,
  },
  'lastspitzen-reserve': {
    id: 'lastspitzen-reserve',
    label: 'Lastspitzen-Reserve',
    claimedBy: ['lastspitzenkappung'],
    editability: 'voltpilot',
    home: 'modus',
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

/** Der Anlagen-Kontext, gegen den eine Einstellung auf RELEVANZ geprüft wird. */
export interface SettingContext {
  plantKind?: string | null;
}

/**
 * Ist die Einstellung für DIESE Anlage überhaupt wirksam? Genau eine kennt
 * heute so eine Regel: der **anzulegende Wert** ist der Vertragsfakt der
 * EEG-Marktprämie und wird ausschließlich für eine DIREKTVERMARKTUNGS-Anlage
 * verrechnet (`EarningsRepository` / `pricing.py`, dieselbe Bedingung, die auch
 * die Geld-Flächen prüfen). Auf einer Eigenverbrauchs-Anlage — etwa nach einer
 * Umstellung, bei der der Markt-Modus über Netzladen + dynamischen Tarif
 * weiterläuft — wäre das Feld eine wirkungslose Eingabe, also erscheint es
 * nicht. Ohne Kontext (ein Aufrufer ohne Anlagen-Daten) wird NICHTS gefiltert.
 */
export function settingRelevant(def: ModeSettingDef, ctx?: SettingContext | null): boolean {
  if (!ctx) return true;
  if (def.id === 'anzulegender-wert') return ctx.plantKind === 'direktvermarktung';
  return true;
}

/**
 * Die Einstellungen, die dieser AKTIVE Modus in seinem Container zeigt — in der
 * Anzeige-Reihenfolge des Modus-Manifests, DEDUPLIZIERT: eine von mehreren
 * aktiven Modi beanspruchte Einstellung erscheint nur unter dem ranghöchsten
 * aktiven Claimer (erst-aktiver-gewinnt über `MODE_RANK`) — und gefiltert auf
 * das, was für diese Anlage wirksam ist (`settingRelevant`).
 *
 * Ist der Modus NICHT aktiv (nicht in `activeModes`), gibt es keine
 * Einstellungen — die Owner-Regel „ein ausgeschalteter Modus zeigt seine
 * Einstellungen gar nicht" fällt hier von selbst heraus.
 */
export function settingsForMode(
  mode: ActiveMode,
  activeModes: ActiveMode[] | null | undefined,
  ctx?: SettingContext | null,
): ModeSettingDef[] {
  const activeKinds = activeKindsOf(activeModes);
  return (mode.manifest.settings ?? [])
    .map((id) => SETTING_DEFS[id])
    .filter((def) => firstActiveClaimer(def, activeKinds) === mode.kind)
    .filter((def) => settingRelevant(def, ctx));
}

/**
 * Die Einstellungen, die die **Einstellungs-Seite der Anlage** besitzt (E1) —
 * in kanonischer Reihenfolge und gefiltert auf das, was für DIESE Anlage
 * wirksam ist (`settingRelevant`; der anzulegende Wert bleibt ein
 * Direktvermarktungs-Fakt).
 *
 * Bewusst OHNE Modus-Argument: genau das ist die E1-Zusage — diese Werte sind
 * unabhängig von jedem Modus erreichbar, auch auf einer Anlage, auf der gar
 * kein Modus läuft.
 */
export function settingsPageSettings(ctx?: SettingContext | null): ModeSettingDef[] {
  return ALL_SETTINGS.filter((def) => def.home === 'einstellungen').filter((def) =>
    settingRelevant(def, ctx),
  );
}

/**
 * Die Einstellungen, die gerade KEIN aktiver Modus beansprucht **und** die auch
 * keine modus-unabhängige Heimat haben — sie ruhen (der gespeicherte Wert
 * bleibt erhalten), sind aber über keine Fläche erreichbar. Reine Auskunft,
 * ohne Teaser-Copy (Owner-Korrektur).
 *
 * Seit E1 kann eine Einstellung mit `home: 'einstellungen'` NIE verwaisen — sie
 * steht auf der Einstellungs-Seite, ob ein Modus läuft oder nicht. Übrig bleiben
 * die von VoltPilot eingerichteten Lastspitzen-Werte, die nur ihr Container
 * zeigt; ihre sichtbare Autoritäts-Stufe ist E4.
 */
export function orphanedSettings(
  activeModes: ActiveMode[] | null | undefined,
): ModeSettingDef[] {
  const activeKinds = activeKindsOf(activeModes);
  return ALL_SETTINGS.filter((def) => def.home !== 'einstellungen').filter(
    (def) => !def.claimedBy.some((kind) => activeKinds.has(kind)),
  );
}

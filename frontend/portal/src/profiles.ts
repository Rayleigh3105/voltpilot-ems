/**
 * Portal v3 · M3 — die **Anwendungen** als sichtbares Regal mit Schaltern.
 *
 * Das Kundenwort ist seit dem 24.08.2026 **Anwendung** (Captain-Vokabular, Stufe
 * 0 des Anwendungs-Programms); die Code-Ids bleiben unangetastet — `ModeKind`,
 * die Route `/profiles`, die Spalte `profile` und jeder Bezeichner hier.
 *
 * Der Funktionsumfang einer Anlage ist keine Blackbox mehr: Eigenverbrauch ·
 * Marktoptimierung · Gewerbe (Lastspitzenkappung) · weitere Anwendungen stehen
 * als Zeilen mit Schalter da — auf JEDER Anlage, auch einer einfachen v1-Anlage.
 * Jede sagt in EINEM Satz, was sie tut, **was sie freischaltet** (Ansichten ·
 * Kacheln · Geld-Strom) und **was sie voraussetzt** (✓ / fehlt).
 *
 * Das lebende Regal rendert `steuerungArea.profileRows`; dieses Modul liefert
 * die Wortschicht (Nutzen · Freischaltungen · Voraussetzungen · Sperrgrund ·
 * Herkunft) und die **Overlay-Regel** über die M0-Projektion.
 *
 * **Owner-Entscheidung: JEDE Anwendung ist ein direkter Kundenschalter.** Es gibt
 * keinen Zustand „Angefragt" und keine VoltPilot-Anfragewand — nur `an` und
 * `aus`, plus eine ehrliche Regel darüber: fehlt eine Voraussetzung, kippt der
 * Schalter trotzdem, die Zeile benennt konkret was fehlt, und der Teil, der
 * wirklich nicht laufen kann, läuft nicht. Nie ein Schein-Erfolg.
 *
 * Reines Logikmodul (der `surface.ts`/`cockpit.ts`-Präzedenzfall): keine
 * React-Imports, kein Netzwerk. Die Server-Antwort (`GET /sites/{id}/profiles`)
 * ist die Wahrheit über Voraussetzungen und Sperrgründe — dieses Modul
 * formuliert nur.
 */
import { anwendung } from './anwendungen';
import type { ActiveMode } from './surface';

// ---------------------------------------------------------------------------
// Vokabular (strukturgleich zur Server-Antwort)
// ---------------------------------------------------------------------------

/** Die EINZIGEN zwei Zustände. Es gibt bewusst kein „angefragt". */
export type ProfileState = 'an' | 'aus';

export interface ProfileRequirement {
  label: string;
  met: boolean;
}

export interface ProfileUnlocks {
  views: string[];
  widgets: string[];
  moneyStream: string | null;
}

/** Eine Anwendung, wie der Server sie liefert. */
export interface SiteProfile {
  id: string;
  label: string;
  /** Der GESPEICHERTE Kundenwille; null = kein Eintrag = abgeleiteter Default. */
  state: ProfileState | null;
  /** Was die Ableitung allein sagt (nie gespeichert). */
  derivedActive: boolean;
  /** Der effektive Zustand nach dem Overlay. */
  active: boolean;
  unlocks: ProfileUnlocks;
  requirements: ProfileRequirement[];
  /** Ehrlicher deutscher Satz, wenn eine EINGESCHALTETE Anwendung nicht voll läuft. */
  blockedReason: string | null;
  origin: 'masterdata' | 'flow' | null;
  flowRef: { flowId: string; name: string } | null;
  gatedNodeTypes: string[];
  gatedNodesEnabled: boolean;
}

export interface SiteProfiles {
  /**
   * Das REGAL: seit Steuerung Stufe 0 genau die BETRIEBSMODELLE — der Server
   * filtert, das Portal filtert über den Katalog ein zweites Mal.
   */
  profiles: SiteProfile[];
  /**
   * Die sichtbaren Anwendungen, die NICHT im Regal stehen (Basis + Regel).
   *
   * ⚠ Sie sind kein Beiwerk: das Cockpit-Tor „ist Eigene Auswertung an?" und
   * das Willens-Overlay der M0-Projektion lesen sie. Ein blosses Weglassen
   * hätte beide still beschädigt — ein gespeichertes `aus` wäre verloren und
   * ein abgeschalteter Modus wiederbelebt. Stufe 0 blendet aus, sie löscht
   * nicht. Optional, damit ein ÄLTERES Backend (ohne das Feld) genau wie
   * bisher gelesen wird.
   */
  weitere?: SiteProfile[];
}

/**
 * ALLE gemeldeten Karten — Regal plus das, was daneben weiterläuft. Jede
 * Fläche ausserhalb der Steuerung fragt hierüber, damit sie nicht davon
 * abhängt, was das Regal gerade zeigt.
 */
export function alleProfile(
  profiles: SiteProfiles | null | undefined,
): SiteProfile[] {
  if (!profiles) return [];
  return [...(profiles.profiles ?? []), ...(profiles.weitere ?? [])];
}

/** Die Overlay-Eingabe: Anwendungs-Id → gespeicherter Wille. */
export type ProfileStates = Record<string, ProfileState>;

// ---------------------------------------------------------------------------
// Copy (alle deutschen Texte leben hier)
// ---------------------------------------------------------------------------

/**
 * ⚠ Nutzen-Satz und Freischaltungs-Chips kommen seit Stufe 1 aus dem EINEN
 * Anwendungs-Katalog (`anwendungen.ts` ⟷ die byte-gleiche Server-Ressource),
 * nicht mehr aus einer Hand-Tabelle hier. Der Server sendet dieselben Labels
 * aus derselben Datei — Karte, Nav-Gruppe und Server können damit nicht mehr
 * verschiedene Worte für dieselbe Anwendung sagen.
 */
const FALLBACK_BENEFIT = 'Eine zusätzliche Betriebsart Ihrer Anlage.';

/** Was eine Anwendung tut — EIN Satz, Ergebnis-Sprache, keine Interna. */
export function benefitLine(profile: SiteProfile): string {
  return anwendung(profile.id)?.nutzen ?? FALLBACK_BENEFIT;
}

/** Was die Anwendung freischaltet ("Schaltet frei"-Chips). */
export function unlockChips(profile: SiteProfile): string[] {
  // Ohne kuratierte Worte lieber NICHTS behaupten als Feld-Ids zeigen.
  return anwendung(profile.id)?.unlock_chips ?? [];
}

/** Die Voraussetzungs-Chips: „PV-Erzeugung ✓" bzw. „Leistungspreis fehlt". */
export function requirementChips(
  profile: SiteProfile,
): { label: string; met: boolean; text: string }[] {
  return (profile.requirements ?? []).map((r) => ({
    label: r.label,
    met: r.met,
    text: r.met ? r.label : `${r.label} fehlt`,
  }));
}

/**
 * Der ehrliche „läuft noch nicht, weil …"-Satz einer EINGESCHALTETEN Anwendung.
 * Der Server entscheidet (eine Stelle: `SiteProfileService`); ohne Serversatz
 * wird aus den unerfüllten Voraussetzungen ein ebenso ehrlicher Satz gebaut.
 * Niemals eine Anfrage-Aufforderung.
 */
export function blockedReason(profile: SiteProfile): string | null {
  if (!profile.active) return null;
  if (profile.blockedReason) return profile.blockedReason;
  const missing = (profile.requirements ?? []).filter((r) => !r.met).map((r) => r.label);
  if (missing.length === 0) return null;
  return `Läuft noch nicht: ${missing.join(' und ')} fehlt.`;
}

/** Woher die Anwendung kommt — die Ehrlichkeitszeile für Stammdaten-Anwendungen. */
export const VOLTPILOT_MANAGED_LINE = 'Von VoltPilot eingerichtet.';

export function originLine(profile: SiteProfile): string | null {
  if (!profile.active) return null;
  if (profile.origin === 'masterdata') return VOLTPILOT_MANAGED_LINE;
  if (profile.origin === 'flow' && profile.flowRef) {
    return `Läuft über Ihre Steuerung „${profile.flowRef.name}".`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Das Overlay über die M0-Projektion
// ---------------------------------------------------------------------------

/** Anwendungs-Id → gespeicherter Wille; ohne Antwort (älteres Backend) leer. */
export function profileStatesFrom(
  profiles: SiteProfiles | null | undefined,
): ProfileStates | null {
  if (!profiles?.profiles) return null;
  const states: ProfileStates = {};
  // ⚠ Über ALLE Karten, nicht nur das Regal: ein gespeichertes `aus` einer
  // Regel-Anwendung muss den abgeleiteten Modus weiterhin unterdrücken.
  for (const p of alleProfile(profiles)) {
    if (p.state === 'an' || p.state === 'aus') states[p.id] = p.state;
  }
  return states;
}

/**
 * **Das Overlay** (M3): `aus` entfernt eine abgeleitete Anwendung — ein erneut
 * abgeleitetes Signal darf eine abgeschaltete Anwendung nicht stillschweigend
 * wiederbeleben. `an` erfindet NIE eine Anwendung, die die Anlage strukturell
 * nicht haben kann (sie erscheint, sobald ihr Flow wirklich läuft).
 *
 * Regeln (`kind: 'automation'`) sind keine Anwendungen und bleiben unberührt.
 * Ohne Zustände (älteres Backend, Ladefehler) ist das Ergebnis **identisch**
 * zur Eingabe — byte-gleich zum Verhalten vor M3.
 */
export function applyProfileStates(
  modes: ActiveMode[],
  states: ProfileStates | null | undefined,
): ActiveMode[] {
  if (!states) return modes;
  return modes.filter((mode) => {
    if (mode.kind === 'automation') return true;
    return states[mode.kind] !== 'aus';
  });
}

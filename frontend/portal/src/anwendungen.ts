/**
 * Der EINE Anwendungs-Katalog, Portal-Seite (Zielbild
 * `data/vp-portal-zielbild-anwendungen/report.md` §3.2/§4.1, Stufe 1).
 *
 * Eine **Anwendung** ist der Oberbegriff für alles, was VoltPilot auf einer
 * Anlage tun kann — Basis-Anwendungen (immer an), Regel-Anwendungen (der Kunde
 * baut ihren Inhalt selbst) und Geschäfts-Anwendungen (Strategie hinter einem
 * Tor). Vor dieser Stufe lag derselbe Katalog an ACHT Stellen in zwei Sprachen
 * (§2.2): Label in `surface.ts MODE_LABELS`, Nutzen + Freischaltungen in
 * `profiles.ts COPY`, Voraussetzungen/Sperrgründe/Freischaltungen im Java-Dienst,
 * Einstellungs-Ansprüche in `modeSettings.ts SETTING_DEFS.claimedBy` — und zwei
 * Zwillinge waren ungepinnt.
 *
 * `src/anwendungen/catalog.json` ist die **byte-gleiche Kopie** der Server-
 * Ressource `services/api/src/main/resources/anwendungen/catalog.json`
 * (`anwendungen.sync.test.ts`, das `flows/catalog.sync.test.ts`-Muster) —
 * **beide zusammen ändern**.
 *
 * **Was hier NICHT lebt:** die Aktivierungs-LOGIK steht als `derivedAnwendungen`
 * unten im Code und ist gegen den Java-Zwilling
 * (`profile/AnwendungDerivation`) über `docs/contracts/v2/anwendung-vectors.json`
 * gepinnt — das `usage-profile-vectors.json`-Muster. Und die RENDER-Hälfte
 * (`surface.ts manifestFor`, `cockpitWidgets.ts`, die Drill-ins) bleibt dort, wo
 * sie ist; sie liest ihre Ids aus dem Katalog, und ein Konsistenz-Test
 * (`anwendungen.test.ts`) verhindert einen Katalog-Eintrag ohne Manifest.
 *
 * Reines Logikmodul (der `surface.ts`/`profiles.ts`-Präzedenzfall): keine
 * React-Imports, kein Netzwerk.
 */
import rawCatalog from './anwendungen/catalog.json';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Woraus eine Anwendung besteht — und was ihr Schalter tut. */
export type AnwendungKlasse = 'basis' | 'regel' | 'geschaeft' | 'reserviert';

/** Die Sortierung im Regal und in der Wizard-Vorauswahl. */
export type AnwendungKategorie = 'basis' | 'steuerung' | 'geschaeft' | 'auswertung';

/** Die Vorauswahl je Profil (Stufe 2 liest sie; Stufe 1 trägt sie nur). */
export type PresetWert = 'an' | 'angeboten' | 'verborgen' | 'abgeleitet';

export interface AnwendungVoraussetzung {
  id: string;
  label: string;
  /** Der ehrliche Satz, wenn GENAU diese Voraussetzung fehlt. */
  blocked_reason: string | null;
}

export interface AnwendungBausteine {
  /** Cockpit-Block-Ids (`CockpitBlockId`), die diese Anwendung beisteuert. */
  cockpit: string[];
  /** Tiefen-Ansichten (`DeepViewId`), die sie beisteuert. */
  ansichten: string[];
  /** Ihr primärer Geld-Strom (`MoneyStreamId`), oder null. */
  geldstrom: string | null;
  steuerungskarte: boolean;
  nav_gruppe: boolean;
}

export interface AnwendungDef {
  id: string;
  label: string;
  kategorie: AnwendungKategorie;
  klasse: AnwendungKlasse;
  rang: number;
  /** EIN Satz: was die Anwendung für den Kunden tut. */
  nutzen: string;
  abschaltbar: boolean;
  /** false = reserviert: kein Schalter, keine Regal-Zeile. */
  sichtbar: boolean;
  strategie_knoten: string | null;
  starter: string | null;
  bedarf: { rollen: string[]; actuate: string[]; messung: string[] };
  voraussetzungen: AnwendungVoraussetzung[];
  /** Ein Satz, der IMMER gilt (Ökonomie noch nicht gebaut). */
  blocked_reason_immer: string | null;
  /** Der ehrliche Leer-Satz einer eingeschalteten Regel-Anwendung ohne Regel. */
  leer_zustand: string | null;
  bausteine: AnwendungBausteine;
  /** Die Kundenworte für „Schaltet frei". */
  unlock_chips: string[];
  /** Die beanspruchten Einstellungs-Ids (`ModeSettingId`). */
  einstellungen: string[];
  /** Wo diese Einstellungen wohnen — `einstellungen` | `modus` | `regeln`. */
  einstellungen_verweis: string | null;
  preset: { privat: PresetWert; gewerbe: PresetWert };
}

interface AnwendungCatalog {
  catalog_version: string;
  anwendungen: AnwendungDef[];
}

const CATALOG = rawCatalog as unknown as AnwendungCatalog;

/** Alle Einträge in kanonischer Reihenfolge (Rang) — auch die reservierten. */
export const ANWENDUNGEN: AnwendungDef[] = [...CATALOG.anwendungen].sort(
  (a, b) => a.rang - b.rang || a.id.localeCompare(b.id),
);

const BY_ID = new Map(ANWENDUNGEN.map((a) => [a.id, a] as const));

/**
 * Das REGAL: die sichtbaren Anwendungen. Eine reservierte steht bewusst nicht
 * darin — ein Schalter, der nichts bewirken kann, wäre eine Zusage, die niemand
 * einlöst.
 */
export const REGAL: AnwendungDef[] = ANWENDUNGEN.filter((a) => a.sichtbar);

/** Die Anwendung mit dieser Id, oder null (ein neuerer Server, ältere Kopie). */
export function anwendung(id: string | null | undefined): AnwendungDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Ihr kundenseitiger Name; ohne Katalog-Eintrag die Id selbst (nie geraten). */
export function anwendungLabel(id: string): string {
  return anwendung(id)?.label ?? id;
}

/** Ist sie eine Basis-Anwendung (immer an, kein Schalter)? */
export function istBasis(id: string | null | undefined): boolean {
  return anwendung(id)?.klasse === 'basis';
}

/** Ist sie eine Regel-Anwendung (Schalter = reine Absicht)? */
export function istRegel(id: string | null | undefined): boolean {
  return anwendung(id)?.klasse === 'regel';
}

/**
 * Lässt sie sich abschalten? Eine unbekannte Anwendung (neuerer Server) gilt
 * als schaltbar — der Server ist die Wahrheit und lehnt sonst ehrlich ab.
 */
export function istAbschaltbar(id: string | null | undefined): boolean {
  return anwendung(id)?.abschaltbar ?? true;
}

/** Die Einstellungs-Ids, die diese Anwendung beansprucht. */
export function einstellungenVon(id: string): string[] {
  return anwendung(id)?.einstellungen ?? [];
}

/**
 * Welche Anwendungen eine Einstellung beanspruchen, in Katalog-Reihenfolge —
 * die Umkehrung von `einstellungen`. `modeSettings.ts` liest daraus sein
 * `claimedBy`, statt es ein zweites Mal zu pflegen.
 */
export function anwendungenFuerEinstellung(settingId: string): string[] {
  return ANWENDUNGEN.filter((a) => a.einstellungen.includes(settingId)).map((a) => a.id);
}

// ---------------------------------------------------------------------------
// Die Ableitung — der Zwilling von Java `profile/AnwendungDerivation`
// ---------------------------------------------------------------------------

/**
 * Alles, woraus eine Anwendung abgeleitet wird — die Schnittmenge dessen, was
 * Server und Portal beide besitzen. Genau diese Felder stehen in den geteilten
 * Vektoren (`docs/contracts/v2/anwendung-vectors.json`).
 */
export interface AnwendungSignals {
  hasStorage: boolean;
  hasPv: boolean;
  hasControllableConsumer: boolean;
  hasChargePoint: boolean;
  hasMeasurement: boolean;
  hasLeistungspreis: boolean;
  hasGridLimit: boolean;
  /** Die Knotentypen der AKTIVEN Flows. */
  activeNodeTypes: string[];
  /** ≥ 1 aktiver Flow OHNE Strategie-Knoten = eine Kunden-Regel. */
  hasCustomerRule: boolean;
  plantKind: string | null;
  tarifArt: string | null;
  netzladenErlaubt: boolean;
}

/** Der generierte Verbraucher-Executor (D-19) — der Beleg für eine Regel. */
export const NODE_CONSUMER_REACTIVE = 'vp.consumer.reactive';

const NODE_MARKET = 'vp.strategy.market';
const NODE_PEAKSHAVING = 'vp.strategy.peakshaving';
const NODE_ATYPICAL_GRID = 'vp.strategy.atypical-grid';

function carries(signals: AnwendungSignals, nodeType: string): boolean {
  return (signals.activeNodeTypes ?? []).includes(nodeType);
}

function isDirektvermarktung(signals: AnwendungSignals): boolean {
  return signals.plantKind === 'direktvermarktung';
}

function isDynamicTariff(signals: AnwendungSignals): boolean {
  return signals.tarifArt === 'dynamisch';
}

/** Marktzugang = dynamischer Tarif und/oder Direktvermarktung (OPEN(O1)). */
export function hasMarketAccess(signals: AnwendungSignals): boolean {
  return isDynamicTariff(signals) || isDirektvermarktung(signals);
}

/**
 * Aktiviert die Ableitung allein diese Anwendung? Byte-gleich zum Java-Zwilling
 * `AnwendungDerivation.derivedActive`; der abgeleitete Wert wird nie gespeichert
 * (die AE7-Regel).
 *
 * **Zwei Ehrlichkeitsregeln, an denen das hängt:**
 *  - `ueberschuss` wird **nie** abgeleitet. Eine Überschuss-Regel und eine
 *    Zeitplan-Regel entstehen beide im Verbraucher-Baukasten und sind nur an
 *    ihrem Bedingungsbaum zu unterscheiden — daraus einen Zustand zu behaupten,
 *    wäre eine Erfindung. Ihr Schalter ist reine Absicht.
 *  - `verbraucher` wird abgeleitet, sobald ein AKTIVER Flow den generierten
 *    Verbraucher-Executor trägt — das ist beweisbar.
 */
export function derivedActive(id: string, signals: AnwendungSignals): boolean {
  switch (id) {
    case 'monitoring':
      // Jede Anlage wird beobachtet. Ob schon Werte ankommen, sagt der
      // Voraussetzungs-Chip - nicht der Zustand.
      return true;
    case 'speicher-fahrplan':
      // Der Optimierer plant für JEDE Speicher-Anlage alle 15 Minuten.
      return signals.hasStorage;
    case 'ueberschuss':
      return false;
    case 'verbraucher':
      return carries(signals, NODE_CONSUMER_REACTIVE);
    case 'marktvermarktung':
      return (
        isDirektvermarktung(signals) ||
        (signals.netzladenErlaubt && isDynamicTariff(signals)) ||
        carries(signals, NODE_MARKET)
      );
    case 'lastspitzenkappung':
      return signals.hasLeistungspreis || carries(signals, NODE_PEAKSHAVING);
    case 'atypische-netznutzung':
      return carries(signals, NODE_ATYPICAL_GRID);
    case 'lastmanagement':
      // Es gibt keinen Strategie-Knoten: der Verteiler LÄUFT auf der Box,
      // sobald eine Säule da ist.
      return signals.hasChargePoint;
    default:
      return false;
  }
}

/** Die Menge der abgeleitet aktiven Anwendungen, in Katalog-Reihenfolge. */
export function derivedAnwendungen(signals: AnwendungSignals): string[] {
  return ANWENDUNGEN.filter((a) => derivedActive(a.id, signals)).map((a) => a.id);
}

/**
 * Ist diese Voraussetzung erfüllt? Ein UNBEKANNTER Name gilt als NICHT erfüllt —
 * eine Voraussetzung, die niemand prüfen kann, darf nie als Häkchen erscheinen.
 */
export function requirementMet(requirementId: string, signals: AnwendungSignals): boolean {
  switch (requirementId) {
    case 'messwert':
      return signals.hasMeasurement;
    case 'speicher':
      return signals.hasStorage;
    case 'pv':
      return signals.hasPv;
    case 'steuerbares-geraet':
      return signals.hasControllableConsumer;
    case 'marktzugang':
      return hasMarketAccess(signals);
    case 'leistungspreis':
    case 'leistungsmessung':
      return signals.hasLeistungspreis;
    case 'ladepunkt':
      return signals.hasChargePoint;
    case 'anschlussgrenze':
      return signals.hasGridLimit;
    default:
      return false;
  }
}

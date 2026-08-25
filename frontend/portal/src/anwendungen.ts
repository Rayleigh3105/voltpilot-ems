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

/** Die Vorauswahl je Profil. */
export type PresetWert = 'an' | 'angeboten' | 'verborgen' | 'abgeleitet';

/** Das PRESET einer Anlage (Stufe 2) — Vorauswahl, Tonalität, Reset-Basis. */
export type Profil = 'privat' | 'gewerbe';

/** Die Geld-Sprache eines Profils. */
export type Tonalitaet = 'sparen' | 'verdienen';

export interface AnwendungVoraussetzung {
  id: string;
  label: string;
  /** Der ehrliche Satz, wenn GENAU diese Voraussetzung fehlt. */
  blocked_reason: string | null;
}

export interface AnwendungBausteine {
  /** Cockpit-Block-Ids (`CockpitBlockId`), die diese Anwendung beisteuert. */
  cockpit: string[];
  /**
   * Baustein-Schlüssel der PORTFOLIO-Fläche (Stufe 4). Anders als `cockpit`
   * nennt dieses Feld unmittelbar Bausteine: über der Kunden-Fläche gibt es
   * keine Blockschicht, ein Portfolio-Baustein IST die Einheit.
   */
  portfolio: string[];
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

/** Ein Profil-Preset: Label, „wir starten mit …"-Satz, Tonalität. */
export interface PresetDef {
  id: Profil;
  label: string;
  satz: string;
  tonalitaet: Tonalitaet;
}

interface AnwendungCatalog {
  catalog_version: string;
  presets: PresetDef[];
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

/**
 * Die Anwendungen, die diesen PORTFOLIO-Baustein beisteuern, in
 * Katalog-Reihenfolge — der Zwilling von Java
 * `AnwendungKatalog.beigesteuertVon` für die Kunden-Fläche.
 */
export function anwendungenFuerPortfolioBaustein(bausteinId: string): string[] {
  return ANWENDUNGEN.filter((a) => a.bausteine.portfolio.includes(bausteinId)).map((a) => a.id);
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
// Die PRESETS (Stufe 2) — Vorauswahl + Tonalität, nie ein Signal der Ableitung
// ---------------------------------------------------------------------------

/**
 * Die zwei Profil-Presets in Katalog-Reihenfolge (Privat, Gewerbe).
 *
 * ⚠ Ein Preset trägt bewusst KEINE Liste von Anwendungen — die steht je
 * Anwendung im Feld `preset` und wird daraus abgeleitet ({@link vorauswahl}).
 * Zwei Listen über dieselbe Sache wären zwei Wahrheiten, die abdriften.
 */
export const PRESETS: PresetDef[] = CATALOG.presets ?? [];

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p] as const));

/** Kennt der Katalog dieses Wort als Profil? (Ein unbekanntes gilt nie.) */
export function istProfil(value: unknown): value is Profil {
  return typeof value === 'string' && PRESET_BY_ID.has(value as Profil);
}

/** Das Preset mit dieser Id, oder null. */
export function preset(profil: string | null | undefined): PresetDef | null {
  return istProfil(profil) ? (PRESET_BY_ID.get(profil) ?? null) : null;
}

/**
 * Die Tonalität eines Profils — `null`, solange keins gewählt ist. Genau dieses
 * `null` ist der Rückfall auf die bisherige `plant_kind`-Regel und damit die
 * Byte-Identität jeder Bestandsanlage.
 */
export function tonalitaetVon(profil: string | null | undefined): Tonalitaet | null {
  return preset(profil)?.tonalitaet ?? null;
}

/** Der Preset-Wert dieser Anwendung unter diesem Profil, oder null. */
export function presetWert(
  anwendungId: string,
  profil: string | null | undefined,
): PresetWert | null {
  const p = preset(profil);
  const def = anwendung(anwendungId);
  return p && def ? (def.preset[p.id] ?? null) : null;
}

/**
 * Die VORAUSWAHL eines Profils: die Anwendungen, deren Preset `an` sagt —
 * sichtbar und abschaltbar, in Katalog-Reihenfolge. Der Zwilling von Java
 * `AnwendungKatalog.vorauswahl`.
 *
 * Eine BASIS-Anwendung steht nie darin: sie ist ohnehin an und hat gar keinen
 * Schalter (der Server lehnt einen Schaltversuch mit 400 ab) — sie hier zu
 * nennen hieße, eine Handlung vorzuschlagen, die es nicht gibt.
 */
export function vorauswahl(profil: string | null | undefined): string[] {
  const p = preset(profil);
  if (!p) return [];
  return REGAL.filter((a) => a.abschaltbar && a.preset[p.id] === 'an').map((a) => a.id);
}

/**
 * Wie das Regal unter einem Profil aufgeräumt wird: was sofort dasteht und was
 * hinter „Weitere Anwendungen" zurücktritt. `verborgen` ist die dritte Klasse —
 * für dieses Profil unpassend, aber nie gelöscht (der Kunde kommt über
 * „Weitere Anwendungen" heran, und ohne Profil ist alles gleichrangig).
 *
 * ⚠ `immerVorne` ist die Ehrlichkeits-Ausnahme: **was auf DIESER Anlage schon
 * läuft, wird nie eingeklappt.** Ein aktiver Ladepark auf einer Privat-Anlage
 * hinter „Weitere Anwendungen" zu verstecken hieße, ihren Funktionsumfang vor
 * ihr zu verbergen — das Preset ordnet, es blendet nicht aus.
 */
export function regalFuerProfil(
  profil: string | null | undefined,
  immerVorne: readonly string[] = [],
): { vorne: AnwendungDef[]; weitere: AnwendungDef[] } {
  const p = preset(profil);
  if (!p) return { vorne: REGAL, weitere: [] };
  const erzwungen = new Set(immerVorne);
  const vorne = REGAL.filter(
    (a) =>
      a.preset[p.id] === 'an' || a.preset[p.id] === 'abgeleitet' || erzwungen.has(a.id),
  );
  const weitere = REGAL.filter((a) => !vorne.includes(a));
  return { vorne, weitere };
}

// -- Die Anwendung des Presets auf EINE Anlage ------------------------------

/**
 * Die Felder einer Regal-Karte, die für die Preset-Anwendung zählen — ein
 * struktureller Ausschnitt der Server-Antwort (`SiteProfile`). Bewusst hier
 * dupliziert statt aus `profiles.ts` importiert: jenes Modul liest DIESES
 * (der Katalog ist die Wortschicht), und die Abhängigkeit darf nicht kreisen.
 */
export interface RegalKarte {
  id: string;
  label: string;
  /** Der GESPEICHERTE Wille (`an` | `aus`), oder null. */
  state: string | null;
  /** Der effektive Zustand nach dem Overlay. */
  active: boolean;
  requirements: { label: string; met: boolean }[];
}

/** Eine vorgeschlagene, aber zurückgestellte Anwendung samt ihrem Grund. */
export interface Zurueckgestellt {
  id: string;
  label: string;
  /** Die Labels der Voraussetzungen, die fehlen. */
  fehlend: string[];
}

/**
 * Was ein Profil auf DIESER Anlage vorschlägt.
 *
 * ⚠ **Die Vorauswahl ist voraussetzungs-bewusst, und das ist eine
 * Ehrlichkeitsregel, kein Detail** (Konzept §4.2 „bei Marktzugang" / „bei
 * Leistungspreis"): ein Häkchen, das der Kunde nie gesetzt hat und das
 * anschließend „läuft noch nicht" sagt, wäre eine Zusage, die die Anlage nicht
 * halten kann. Ein Schalter, den der KUNDE selbst kippt, darf das sehr wohl —
 * dann benennt die Zeile ehrlich, was fehlt (Owner-Entscheid M3). Deshalb
 * kommt eine vorgeschlagene Anwendung mit unerfüllter Voraussetzung nicht ins
 * Häkchen, sondern in `zurueckgestellt` — sie wird GENANNT, nicht verschwiegen.
 */
export function presetVorschlag(
  profil: string | null | undefined,
  karten: RegalKarte[],
): { ticken: string[]; zurueckgestellt: Zurueckgestellt[] } {
  const ids = new Set(vorauswahl(profil));
  const ticken: string[] = [];
  const zurueckgestellt: Zurueckgestellt[] = [];
  for (const karte of karten) {
    if (!ids.has(karte.id)) continue;
    const fehlend = (karte.requirements ?? []).filter((r) => !r.met).map((r) => r.label);
    if (fehlend.length === 0) ticken.push(karte.id);
    else zurueckgestellt.push({ id: karte.id, label: karte.label, fehlend });
  }
  return { ticken, zurueckgestellt };
}

/**
 * Der SCHALTPLAN: welche `PUT /profiles`-Aufrufe die Wahl des Kunden von der
 * heutigen Server-Wahrheit trennen — in Katalog-Reihenfolge, damit die Wirkung
 * (Tor öffnen, Starter säen) reproduzierbar bleibt.
 *
 * Es sind ZWEI Mengen, und der Unterschied ist tragend:
 *  - `gewollt` = was der Kunde AUSDRÜCKLICH will (die Preset-Vorauswahl plus
 *    jeder von Hand eingeschaltete Schalter),
 *  - `getickt` = was im Regal gerade an steht (also zusätzlich alles, was
 *    ohnehin schon läuft).
 *
 * Daraus folgen die drei Regeln:
 *  - **`an` wird auch für eine BEREITS abgeleitet aktive Anwendung geschrieben**,
 *    solange kein `an` gespeichert ist. Genau das ist der Mechanismus, der das
 *    Tor öffnet und den Starter sät — ein „ist ja schon aktiv, also nichts tun"
 *    ließe eine Direktvermarktungs-Anlage ohne ihren Start-Flow zurück.
 *  - **Aber nur, wenn der Kunde es WOLLTE.** Wer den Schritt nur durchklickt,
 *    schreibt NICHTS: eine gespeicherte Absicht, die niemand geäußert hat,
 *    wäre die Vorbelegung, die dieses Haus überall vermeidet.
 *  - **`aus` nur für etwas, das WIRKLICH an ist.** Ein `aus` auf eine ohnehin
 *    stille Anwendung wäre eine gespeicherte Absicht ohne Anlass — und sie
 *    würde später eine abgeleitete Aktivierung unterdrücken.
 *
 * Eine BASIS-Anwendung steht NIE im Plan (sie hat keinen Schalter).
 */
export function presetSchaltplan(
  gewollt: readonly string[],
  getickt: readonly string[],
  karten: RegalKarte[],
): { id: string; state: 'an' | 'aus' }[] {
  const wanted = new Set(gewollt);
  const an = new Set(getickt);
  const rang = new Map(ANWENDUNGEN.map((a, i) => [a.id, i] as const));
  const plan: { id: string; state: 'an' | 'aus' }[] = [];
  for (const karte of karten) {
    // Eine BASIS-Anwendung hat gar keinen Schalter, der Server lehnt sie mit
    // 400 ab. Sie ist immer „aktiv", also erzeugte ein fehlendes Häkchen sonst
    // ein `aus`, das nie ankommen kann.
    if (!istAbschaltbar(karte.id)) continue;
    if (an.has(karte.id)) {
      if (wanted.has(karte.id) && karte.state !== 'an') {
        plan.push({ id: karte.id, state: 'an' });
      }
    } else if (karte.active) {
      plan.push({ id: karte.id, state: 'aus' });
    }
  }
  plan.sort((a, b) => (rang.get(a.id) ?? 999) - (rang.get(b.id) ?? 999));
  return plan;
}

/** Der Name des gewählten Profils; ohne Profil der ehrliche Leer-Satz. */
export const PROFIL_UNGESETZT = 'noch nicht festgelegt';

export function profilLabel(profil: string | null | undefined): string {
  return preset(profil)?.label ?? PROFIL_UNGESETZT;
}

/**
 * Die Folgenliste des „Profil ändern"-Dialogs.
 *
 * ⚠ Sie nennt ausdrücklich auch, **was GLEICH bleibt** — sonst liest sich das
 * Umlegen wie ein Lockern der Regeln (die Haus-Regel jedes `ConfirmDialog`).
 * Und sie verspricht NICHT, dass Anwendungen mitwandern: das Profil ist
 * Vorauswahl + Tonalität, es schaltet nichts (Captain-Entscheid E3). Wer seine
 * Anwendungen ändern will, tut das im Regal — dort, wo jede Zeile ihren
 * Zustand und ihren Grund trägt.
 */
export function profilAenderungsFolgen(neu: Profil | null): string[] {
  const ton =
    neu === 'gewerbe'
      ? 'Ihre Geld-Zahlen lesen sich künftig als „verdient".'
      : neu === 'privat'
        ? 'Ihre Geld-Zahlen lesen sich künftig als „gespart".'
        : 'Für die Wortwahl beim Geld gilt wieder Ihre Veräußerungsform.';
  return [
    ton,
    neu
      ? `Beim nächsten Anlegen schlagen wir die Anwendungen vor, die zu „${profilLabel(neu)}" passen.`
      : 'Wir schlagen dann keine Anwendungen mehr vor.',
    'Ihre eingeschalteten Anwendungen bleiben unverändert — hier wird nichts an- oder abgeschaltet.',
    'Sie können das Profil jederzeit wieder ändern.',
  ];
}

/**
 * Der eine Satz der Abschluss-Seite: welche Anwendungen der Assistent
 * eingeschaltet hat. Leer ⇒ **null** — es wird nichts behauptet, wo nichts
 * geschaltet wurde (ein „keine Anwendungen aktiviert" läse sich wie ein
 * Versäumnis, dabei laufen die Basis-Anwendungen ohnehin).
 */
export function anwendungenSatz(ids: readonly string[]): string | null {
  const namen = ANWENDUNGEN.filter((a) => ids.includes(a.id)).map((a) => a.label);
  if (namen.length === 0) return null;
  return `Eingeschaltet: ${namen.join(', ')}.`;
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

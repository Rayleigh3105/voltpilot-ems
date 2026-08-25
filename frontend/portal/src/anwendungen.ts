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

/**
 * Woraus eine Anwendung besteht — und was ihr Schalter tut.
 *
 * ⚠ **`cockpit` ist NICHT `basis`** (Steuerung Stufe 8): beide haben keinen
 * Schalter, aber aus verschiedenen Gründen. Eine Basis-Anwendung LÄUFT ohnehin
 * („immer an"); eine Cockpit-Anwendung wird an einem ANDEREN Ort gesteuert —
 * im Cockpit unter „Anpassen". Der Unterschied ist der Satz, den der Server auf
 * einen Schaltversuch antwortet, und der darf den Weg nicht verschweigen.
 */
export type AnwendungKlasse = 'basis' | 'regel' | 'cockpit' | 'geschaeft' | 'reserviert';

/** Die Sortierung im Regal und in der Wizard-Vorauswahl. */
export type AnwendungKategorie = 'basis' | 'steuerung' | 'geschaeft' | 'auswertung';

/** Die Vorauswahl je Profil. */
export type PresetWert = 'an' | 'angeboten' | 'verborgen' | 'abgeleitet';

/** Das PRESET einer Anlage (Stufe 2) — Vorauswahl, Tonalität, Reset-Basis. */
export type Profil = 'privat' | 'gewerbe';

/** Die Geld-Sprache eines Profils. */
export type Tonalitaet = 'sparen' | 'verdienen';

/**
 * Die zwei SORTEN einer Voraussetzung (Steuerung Stufe 5):
 *  - `hardware`    — was die Anlage physisch hergeben muss. Fehlt davon etwas,
 *    kann das Betriebsmodell HIER gar nicht laufen.
 *  - `einstellung` — ein Wert, den jemand einträgt. Dann steht die Karte
 *    normal da, und die Ampel zeigt den Weg.
 */
export type VoraussetzungsArt = 'hardware' | 'einstellung';

/** Wohin der Kunde muss, um eine Voraussetzung zu erfüllen. */
export type BehebungsZiel = 'einstellungen' | 'modell' | 'ladepark' | 'voltpilot';

export interface AnwendungBehebung {
  ziel: BehebungsZiel;
  /**
   * Die Beschriftung des Wegs — `null` für `voltpilot`: ein admin-conditionaler
   * Wert hat kein Klickziel, VoltPilot trägt ihn ein (Konzept §3.4).
   */
  label: string | null;
}

export interface AnwendungVoraussetzung {
  id: string;
  label: string;
  /** Der ehrliche Satz, wenn GENAU diese Voraussetzung fehlt. */
  blocked_reason: string | null;
  /** Hardware oder Einstellung (Stufe 5). */
  art: VoraussetzungsArt;
  /** Der Weg zur Behebung, oder null — dann wird auch keiner behauptet. */
  behebung: AnwendungBehebung | null;
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
  /** false = reserviert: es GIBT diese Anwendung noch nicht. */
  sichtbar: boolean;
  /**
   * false = sie steht NICHT im Regal der Steuerung (Basis- und
   * Regel-Anwendungen seit Steuerung Stufe 0). Ihr Zustand existiert
   * unverändert weiter — nur die Seite zeigt sie nicht mehr.
   */
  regal: boolean;
  /**
   * Die Exklusivitäts-Gruppe (Stufe 5) oder `null`: zwei Betriebsmodelle
   * DERSELBEN Gruppe sind nie zugleich an — ihr Schalter ist ein Radio, und
   * der SERVER erzwingt es beim Schreiben. Heute gibt es genau eine Gruppe
   * (`speicher`) mit den drei Modellen, die um denselben Speicher
   * konkurrieren; das Ladepark-Lastmanagement gehört bewusst keiner an
   * (Begründung im Katalog-Kopf).
   */
  exklusiv_gruppe: string | null;
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
 * Das REGAL der Steuerung: seit Steuerung Stufe 0 „Entwirrung" (Scout
 * `vp-steuerung-konzept-b3` §5) genau die vier BETRIEBSMODELLE — das
 * Katalog-Feld `regal` sagt es, nicht mehr `sichtbar`.
 *
 * Der Befund davor: drei Sorten in EINER Optik. Eine Basis-Anwendung rendert
 * einen Schalter, den der Server mit 400 ablehnt; eine Regel-Anwendung einen,
 * der gar nichts auslöst. Beide sind seither ausgeblendet — **nicht gelöscht**:
 * ihre Zustände reisen in `SiteProfiles.weitere` weiter, und die Flächen, die
 * sie lesen (das Cockpit-Tor „Eigene Auswertung", das Willens-Overlay), sehen
 * unverändert dasselbe.
 *
 * ⚠ Der Server ist die EINE Stelle, die filtert; dies hier ist der zweite,
 * unabhängige Filter derselben Regel aus der byte-gleichen Katalog-Kopie — ein
 * älterer Server kann damit keine Zeile ins Regal schmuggeln.
 */
export const REGAL: AnwendungDef[] = ANWENDUNGEN.filter((a) => a.sichtbar && a.regal);

/**
 * Die sichtbaren Anwendungen, die NICHT im Regal stehen (Basis + Regel). Sie
 * sind der Gegenpart zu {@link REGAL} und die Menge, deren Zustände weiter
 * beantwortet werden.
 */
export const AUSSERHALB_REGAL: AnwendungDef[] = ANWENDUNGEN.filter(
  (a) => a.sichtbar && !a.regal,
);

/**
 * Steht diese Anwendung im Regal der Steuerung? Eine dem Katalog UNBEKANNTE Id
 * (neuerer Server, ältere Kopie) steht **nicht** darin — das Regal zeigt nur,
 * was es benennen kann, statt eine Zeile ohne Nutzen-Satz zu rendern.
 */
export function imRegal(id: string | null | undefined): boolean {
  const def = anwendung(id);
  return def != null && def.sichtbar && def.regal;
}

/** Die Anwendung mit dieser Id, oder null (ein neuerer Server, ältere Kopie). */
export function anwendung(id: string | null | undefined): AnwendungDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/**
 * Die Exklusivitäts-Gruppe einer Anwendung, oder `null` (Steuerung Stufe 5).
 * Eine dem Katalog UNBEKANNTE Id gehört zu keiner Gruppe — was wir nicht kennen,
 * schaltet nichts anderes ab.
 */
export function exklusivGruppe(id: string | null | undefined): string | null {
  return anwendung(id)?.exklusiv_gruppe ?? null;
}

/**
 * Die ANDEREN sichtbaren Anwendungen derselben Gruppe — genau die, die beim
 * Einschalten dieser hier enden. Ohne Gruppe ist das Ergebnis LEER, und das ist
 * die tragende Regel: ein Modell ohne Gruppe schaltet nie etwas anderes ab.
 *
 * ⚠ Der SERVER erzwingt die Exklusivität beim Schreiben; diese Funktion sorgt
 * nur dafür, dass eine Fläche VOR dem Absenden dasselbe zeigt, was danach gilt.
 */
export function exklusivGeschwister(id: string): string[] {
  const gruppe = exklusivGruppe(id);
  if (!gruppe) return [];
  return ANWENDUNGEN.filter(
    (a) => a.sichtbar && a.id !== id && a.exklusiv_gruppe === gruppe,
  ).map((a) => a.id);
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
 * Wird sie im COCKPIT gesteuert statt in der Steuerung (Stufe 8)? Dann gibt es
 * hier keinen Schalter — und die Fläche, die sie zeigt, fragt gar nicht erst
 * nach einem Zustand.
 */
export function istCockpitGesteuert(id: string | null | undefined): boolean {
  return anwendung(id)?.klasse === 'cockpit';
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
 * Die VORAUSWAHL eines Profils: die Betriebsmodelle, deren Preset `an` sagt,
 * in Katalog-Reihenfolge. Der Zwilling von Java `AnwendungKatalog.vorauswahl`.
 *
 * Seit Steuerung Stufe 0 läuft sie über das REGAL, enthält also **höchstens
 * einen** Eintrag: eine Basis-Anwendung ist ohnehin an und hat gar keinen
 * Schalter (der Server lehnt einen Schaltversuch mit 400 ab), und eine
 * Regel-Anwendung vorzuschlagen hiesse, eine Absicht zu setzen, die nichts
 * auslöst. Was der Assistent daraus macht — und was einspringt, wenn eine
 * Voraussetzung fehlt — entscheidet {@link betriebsmodellVorschlag}.
 */
export function vorauswahl(profil: string | null | undefined): string[] {
  const p = preset(profil);
  if (!p) return [];
  return REGAL.filter((a) => a.abschaltbar && a.preset[p.id] === 'an').map((a) => a.id);
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
 * Der VORSCHLAG des Assistenten: **genau EIN Betriebsmodell**, oder keins
 * (Steuerung Stufe 0, Konzept §3.9 — „Gewerbe: Lastspitzenkappung, wenn
 * Leistungspreis hinterlegt, sonst Marktoptimierung, wenn Marktzugang; Privat:
 * keins — Ihr Speicher fährt den Eigenverbrauchs-Fahrplan").
 *
 * Die Rangfolge steht in den DATEN, nicht in einer zweiten Liste: `an` ist das
 * Betriebsmodell, mit dem ein Profil startet (höchstens EINES je Profil),
 * `angeboten` sind seine Rückfälle. Daraus die vier Regeln:
 *
 *  - **Ohne `an`-Kandidaten wird NICHTS vorgeschlagen** — auch dann nicht, wenn
 *    ein `angeboten`-Modell technisch könnte. Genau das ist „Privat: keins":
 *    ein Rückfall ohne Startwahl wäre eine Empfehlung, die niemand getroffen
 *    hat.
 *  - **Vorgeschlagen wird nur, was laufen KANN** (alle Voraussetzungs-Chips
 *    erfüllt) — ein Häkchen, das anschliessend „läuft noch nicht" sagt, wäre
 *    eine Zusage, die die Anlage nicht halten kann (Konzept §4.2).
 *  - **Was nicht kann, wird GENANNT, nicht verschwiegen**: das `an`-Modell
 *    landet mit seinen fehlenden Voraussetzungen in `zurueckgestellt`.
 *  - **Ein Modell, dessen Ökonomie gar nicht gebaut ist** (`blocked_reason_immer`
 *    — heute die atypische Netznutzung), ist nie Kandidat.
 *
 * Ein Katalog-Eintrag ohne Karte dieses Servers wird übersprungen: ein
 * Vorschlag, den der Server nicht kennt, liesse sich nicht einschalten.
 */
export interface BetriebsmodellVorschlag {
  /** Das vorgeschlagene Betriebsmodell, oder null. */
  ticken: string | null;
  /** Das gemeinte Modell samt fehlender Voraussetzungen, oder null. */
  zurueckgestellt: Zurueckgestellt | null;
}

export function betriebsmodellVorschlag(
  profil: string | null | undefined,
  karten: RegalKarte[],
): BetriebsmodellVorschlag {
  const p = preset(profil);
  const leer: BetriebsmodellVorschlag = { ticken: null, zurueckgestellt: null };
  if (!p) return leer;
  const kandidat = (wert: PresetWert) =>
    REGAL.filter(
      (a) =>
        a.klasse === 'geschaeft' &&
        a.abschaltbar &&
        a.blocked_reason_immer == null &&
        a.preset[p.id] === wert,
    );
  const start = kandidat('an');
  // Ohne Startwahl schlägt das Profil nichts vor - der Rückfall gilt nur
  // INNERHALB eines Profils, das eines gewählt hat.
  if (start.length === 0) return leer;
  const byId = new Map(karten.map((k) => [k.id, k] as const));
  const fehlendeVon = (k: RegalKarte) =>
    (k.requirements ?? []).filter((r) => !r.met).map((r) => r.label);
  for (const def of [...start, ...kandidat('angeboten')]) {
    const karte = byId.get(def.id);
    if (!karte) continue;
    if (fehlendeVon(karte).length === 0) return { ticken: def.id, zurueckgestellt: null };
  }
  const gemeint = byId.get(start[0].id);
  return {
    ticken: null,
    zurueckgestellt: gemeint
      ? { id: gemeint.id, label: gemeint.label, fehlend: fehlendeVon(gemeint) }
      : null,
  };
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
      ? `Beim nächsten Anlegen schlagen wir das Betriebsmodell vor, das zu „${profilLabel(neu)}" passt.`
      : 'Wir schlagen dann kein Betriebsmodell mehr vor.',
    'Ihre eingeschalteten Betriebsmodelle bleiben unverändert — hier wird nichts an- oder abgeschaltet.',
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

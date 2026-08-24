/**
 * Der LAYOUT-Speicher des Cockpits, reine Hälfte (Anwendungs-Programm Stufe 3;
 * Scout `data/vp-portal-zielbild-anwendungen` §3.2 E / §3.4, Captain-Entscheide
 * E1/E2/E4 vom 24.08.2026).
 *
 * Bis hierher war die Komposition des Cockpits deterministisch und
 * UNGESPEICHERT: `cockpitBlocks` + `BLOCK_ORDER` + `leadSlot` entschieden
 * alles, es gab weder Editor noch Ablage (§2.4). Diese Datei ist die EINE
 * Stelle, an der aus dem gespeicherten WILLEN und dem, was die Anlage
 * tatsächlich hat, eine Reihenfolge wird — Docker-frei, ohne DOM, ohne Uhr
 * (das `Tagesprotokoll`/`FleetPflege`/`layoutResolve`-Muster).
 *
 * ## Die vier Schichten (E2: „Kunde gewinnt")
 *
 * ```
 *   Katalog-Standard  →  Preset (site.profil)  →  Vorgabe  →  Eigen
 *   (kanonisch)          (anwendungen/catalog)    (Betreiber)  (Kunde)
 * ```
 *
 * Bei der Vorgabe gilt zusätzlich E1 wörtlich: die ANLAGEN-Vorgabe schlägt die
 * kunden-weite („für alle meine Anlagen") — ein Betreiber mit 20 Anlagen
 * pflegt eine Vorgabe und weicht für einzelne Anlagen davon ab.
 *
 * ## Drei Regeln, die die Auflösung ehrlich halten
 *
 * 1. **Gespeichert wird nur ABSICHT, nie die Fläche.** Welche Bausteine eine
 *    Anlage überhaupt hat, entscheidet weiterhin `anlageSurface` (Anwendungen ×
 *    Fähigkeiten) und wird bei jedem Rendern neu abgeleitet. Ein Dokument, das
 *    einen Baustein nennt, den es hier gerade nicht gibt, wird STILL
 *    übersprungen — seine Präferenz bleibt gespeichert, und ein späteres
 *    Wiedereinschalten der Anwendung stellt das alte Bild her.
 * 2. **Ungenannte Bausteine erscheinen an ihrer KANONISCHEN Stelle**, nicht
 *    hinten. Das ist der Fall „eine neue Anwendung wurde aktiviert": ihr
 *    Baustein taucht dort auf, wo er hingehört, statt als Anhängsel unter dem,
 *    was der Kunde arrangiert hat.
 * 3. **Pflicht-Bausteine ignorieren jedes `hidden`** (E2). Das ist eine
 *    Katalog-Eigenschaft (Status-Kopf, Zustand), kein Admin-Wille: eine
 *    Vorgabe kann in V1 keinen einzelnen Baustein sperren.
 *
 * ## Warum die kanonische Reihenfolge ein PARAMETER ist
 *
 * Sie ist je Bildschirmbreite verschieden — am Telefon führen Fahrplan und
 * Preis als Zeilen, am Rechner die Kacheln (eine abgenommene Entscheidung,
 * `vp-mobile-views-x1`). Der gespeicherte Wille nennt deshalb nur RELATIVE
 * Reihenfolge, und die Auflösung bekommt die kanonische Liste der jeweiligen
 * Fassung übergeben. Der Server braucht sie gar nicht: er prüft Schlüssel.
 */
import CATALOG from './anwendungen/catalog.json';
import type { CockpitBlock, CockpitBlockId } from './surface';
import { LEAD_CANDIDATES, leadBlock } from './leadSlot';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Ein Baustein-Schlüssel — das Vokabular des Dokuments. */
export type BausteinId =
  | 'status'
  | 'energiefluss'
  | 'geld'
  | 'steuerung'
  | 'fahrplan'
  | 'strompreis'
  | 'kacheln'
  | 'komponenten'
  | 'zustand';

/** Die Schichten des Speichers. `eigen` gewinnt (E2). */
export type LayoutLayer = 'vorgabe' | 'eigen';

/** Der gespeicherte Wille — NUR Absicht. */
export interface LayoutDocument {
  order: string[];
  hidden: string[];
  shown: string[];
  lead: string | null;
}

/** Ein Baustein, wie der Katalog ihn beschreibt. */
export interface BausteinDef {
  id: BausteinId;
  label: string;
  flaeche: string;
  /** true = kann NIE ausgeblendet werden (E2). */
  pflicht: boolean;
  /** false = bleibt an seiner kanonischen Stelle (Kopf, Bühne). */
  beweglich: boolean;
  /** Der Block, den sein Stern als Lead setzt; null = kein Stern. */
  lead_block: CockpitBlockId | null;
  /** Die Cockpit-Blöcke, die er rendert. */
  bloecke: CockpitBlockId[];
}

const RAW_BAUSTEINE = (CATALOG as { bausteine?: BausteinDef[] }).bausteine ?? [];

/** Alle Bausteine der Cockpit-Fläche, in Katalog-Reihenfolge. */
export const BAUSTEINE: BausteinDef[] = RAW_BAUSTEINE.filter((b) => b.flaeche === 'cockpit');

const BY_ID = new Map<string, BausteinDef>(BAUSTEINE.map((b) => [b.id, b]));

/** Der Baustein mit dieser Id, oder null (auch für ein unbekanntes Wort). */
export function baustein(id: string | null | undefined): BausteinDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Der kundenseitige Name eines Bausteins; unbekannt → die Id (nie leer). */
export function bausteinLabel(id: string): string {
  return baustein(id)?.label ?? id;
}

/**
 * Die kanonische Reihenfolge der Cockpit-Bausteine AM RECHNER — Zeichen für
 * Zeichen die Render-Reihenfolge, die `AnlagenPage` vor dieser Stufe hart
 * codiert hatte. Ohne gespeichertes Layout kommt genau sie heraus, und das ist
 * der Bestands-Beweis (`migration.test.ts`).
 */
export const CANONICAL_DESKTOP: BausteinId[] = [
  'status',
  'energiefluss',
  'geld',
  'steuerung',
  'kacheln',
  'strompreis',
  'fahrplan',
  'komponenten',
  'zustand',
];

/**
 * Dieselbe Menge am TELEFON: dort führen die zwei täglichen Fragen als Zeilen
 * (Fahrplan zuerst, dann der Preis, der ihn erklärt), die Kacheln folgen
 * darunter — die abgenommene Entscheidung des Mobil-Umbaus. Deshalb gibt es
 * zwei kanonische Listen und nicht eine mit einer Ausnahme.
 */
export const CANONICAL_PHONE: BausteinId[] = [
  'status',
  'energiefluss',
  'geld',
  'fahrplan',
  'steuerung',
  'strompreis',
  'kacheln',
  'komponenten',
  'zustand',
];

// ---------------------------------------------------------------------------
// Die Server-Antwort (`GET /api/v1/sites/{id}/cockpit-layout`)
// ---------------------------------------------------------------------------

/** Der Server liefert alle Schichten GETRENNT — nie das aufgelöste Ergebnis. */
export interface CockpitLayoutDocument extends LayoutDocument {
  version?: number;
}

/** Eine gespeicherte Schicht samt Papier-Spur. */
export interface CockpitLayoutLayerDto {
  document: CockpitLayoutDocument;
  updatedBy: string | null;
  updatedAt: string | null;
}

export type CockpitLayoutLayer = LayoutLayer;

export interface CockpitLayoutResponse {
  surface: string;
  profil: string | null;
  presetLayout: CockpitLayoutDocument | null;
  tenantVorgabe: CockpitLayoutLayerDto | null;
  siteVorgabe: CockpitLayoutLayerDto | null;
  eigen: CockpitLayoutLayerDto | null;
  bausteine: Array<{
    id: string;
    label: string;
    pflicht: boolean;
    beweglich: boolean;
    leadBlock: string | null;
    beigesteuertVon: string[];
  }>;
  /** true = dieser Aufrufer darf die Vorgabe-Schicht schreiben (platform-admin). */
  darfVorgabe: boolean;
}

// ---------------------------------------------------------------------------
// Die Preset-Schicht
// ---------------------------------------------------------------------------

interface PresetEntry {
  id: string;
  layout?: LayoutDocument;
}

const PRESET_LAYOUTS = new Map<string, LayoutDocument>(
  ((CATALOG as { presets?: PresetEntry[] }).presets ?? [])
    .filter((p) => p.layout != null)
    .map((p) => [p.id, p.layout as LayoutDocument]),
);

/**
 * Die Preset-Schicht eines Profils. Ohne Profil (jede Bestandsanlage) und für
 * ein unbekanntes Wort gibt es sie NICHT — ein Preset, das nichts sagt, ändert
 * auch nichts.
 */
export function presetLayout(profil: string | null | undefined): LayoutDocument | null {
  return profil ? (PRESET_LAYOUTS.get(profil) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Auflösung
// ---------------------------------------------------------------------------

/** Woher die wirksame Anordnung kommt — die Ansage des Reset-Knopfes (E2). */
export type LayoutQuelle = 'katalog' | 'preset' | 'vorgabe-kunde' | 'vorgabe-anlage' | 'eigen';

export interface LayoutResolveInput {
  /** Die kanonische Reihenfolge dieser Fassung (Rechner bzw. Telefon). */
  canonical: BausteinId[];
  /** Was diese Anlage GERADE hat — alles andere wird still übersprungen. */
  verfuegbar: readonly BausteinId[];
  /** Die Blöcke der Projektion (M0) — sie entscheiden über den Lead. */
  blocks?: CockpitBlock[] | null;
  /** Das Preset der Anlage (`site.profil`). */
  profil?: string | null;
  /** Die kunden-weite Vorgabe des Betreibers (E1). */
  tenantVorgabe?: LayoutDocument | null;
  /** Die Vorgabe DIESER Anlage — sie schlägt die kunden-weite (E1). */
  siteVorgabe?: LayoutDocument | null;
  /** Der Wille des Kunden — er gewinnt (E2). */
  eigen?: LayoutDocument | null;
}

export interface ResolvedLayout {
  /** Die sichtbaren Bausteine in ihrer wirksamen Reihenfolge — was gerendert wird. */
  order: BausteinId[];
  /**
   * ALLE verfügbaren Bausteine in derselben Anordnung, ausgeblendete
   * eingeschlossen. Der Anpassen-Modus arbeitet auf dieser Liste, damit ein
   * wieder eingeblendeter Baustein an seinen Platz zurückkehrt statt hinten
   * anzuhängen.
   */
  arrangement: BausteinId[];
  /** Verfügbar, aber ausgeblendet — die Zeile „Ausgeblendet (n)". */
  hidden: BausteinId[];
  /** Der hervorgehobene Block; null = kein lead-fähiger Block vorhanden. */
  lead: CockpitBlockId | null;
  /** Die oberste Schicht, die wirklich etwas gesagt hat. */
  quelle: LayoutQuelle;
}

/** Ein Dokument, das gar nichts aussagt, zählt als keine Schicht. */
function saysSomething(doc: LayoutDocument | null | undefined): doc is LayoutDocument {
  if (!doc) return false;
  return (
    doc.order.length > 0 || doc.hidden.length > 0 || doc.shown.length > 0 || doc.lead != null
  );
}

/**
 * Setzt eine Schicht auf die laufende Anordnung an.
 *
 * `order` ist eine RELATIVE Aussage: die genannten (und hier verfügbaren)
 * Bausteine kommen in ihrer Reihenfolge, jeder ungenannte wird an seiner
 * kanonischen Stelle wieder eingefügt — direkt hinter demjenigen genannten
 * Baustein, der ihm kanonisch vorausgeht. Genau das lässt eine frisch
 * aktivierte Anwendung an der richtigen Stelle auftauchen, statt hinten
 * anzuhängen.
 */
function applyOrder(current: BausteinId[], wanted: string[]): BausteinId[] {
  const known = new Set(current);
  const named: BausteinId[] = [];
  const seen = new Set<string>();
  for (const id of wanted) {
    if (!known.has(id as BausteinId) || seen.has(id)) continue;
    seen.add(id);
    named.push(id as BausteinId);
  }
  if (named.length === 0) return current;

  const out = [...named];
  // Die ungenannten in KANONISCHER Reihenfolge (= der Reihenfolge, in der sie
  // gerade stehen), jeweils hinter ihren kanonischen Vorgänger.
  for (const id of current) {
    if (seen.has(id)) continue;
    const canonicalIndex = current.indexOf(id);
    let insertAt = 0;
    for (let i = canonicalIndex - 1; i >= 0; i--) {
      const pos = out.indexOf(current[i]);
      if (pos >= 0) {
        insertAt = pos + 1;
        break;
      }
    }
    out.splice(insertAt, 0, id);
    seen.add(id);
  }
  return out;
}

/**
 * Unbewegliche Bausteine zurück an ihre kanonische Stelle. Der Status-Kopf ist
 * der Kopf, und die BÜHNE (Energiefluss samt der Geld-Leiste und dem
 * Steuerungs-Fuß, die am Rechner IN ihr wohnen) darf nicht zerlegt werden —
 * das ist die Auflage des Stufenplans zum Lead-Wechsel. Ein Dokument kann sie
 * damit nicht verschieben, auch ein handgeschriebenes nicht.
 */
function pinFixed(order: BausteinId[], canonical: BausteinId[]): BausteinId[] {
  const fixed = order.filter((id) => baustein(id)?.beweglich === false);
  if (fixed.length === 0) return order;
  const movable = order.filter((id) => baustein(id)?.beweglich !== false);
  const out: BausteinId[] = [];
  let m = 0;
  for (const id of canonical) {
    if (!order.includes(id)) continue;
    if (fixed.includes(id)) {
      out.push(id);
    } else {
      // An dieser kanonischen Stelle steht ein beweglicher Baustein: nimm den
      // nächsten aus der gewünschten Reihenfolge.
      out.push(movable[m]);
      m += 1;
    }
  }
  return out;
}

/**
 * Die wirksame Anordnung des Cockpits: Katalog → Preset → kunden-weite Vorgabe
 * → Anlagen-Vorgabe → Eigen, jede Schicht additiv über der darunter.
 */
export function layoutResolve(input: LayoutResolveInput): ResolvedLayout {
  const verfuegbar = new Set(input.verfuegbar);
  let order = input.canonical.filter((id) => verfuegbar.has(id));
  const hidden = new Set<BausteinId>();
  let lead: string | null = null;
  let quelle: LayoutQuelle = 'katalog';

  const layers: Array<[LayoutQuelle, LayoutDocument | null | undefined]> = [
    ['preset', presetLayout(input.profil)],
    ['vorgabe-kunde', input.tenantVorgabe],
    ['vorgabe-anlage', input.siteVorgabe],
    ['eigen', input.eigen],
  ];
  for (const [name, doc] of layers) {
    if (!saysSomething(doc)) continue;
    quelle = name;
    order = pinFixed(applyOrder(order, doc.order), input.canonical);
    for (const id of doc.hidden) {
      if (verfuegbar.has(id as BausteinId)) hidden.add(id as BausteinId);
    }
    // `shown` nimmt einer TIEFEREN Schicht ihr `hidden` zurück — deshalb ist es
    // nicht dasselbe wie „steht nicht in hidden".
    for (const id of doc.shown) hidden.delete(id as BausteinId);
    if (doc.lead != null) lead = doc.lead;
  }

  // Pflicht-Bausteine ignorieren JEDES hidden (E2) — Katalog-Eigenschaft.
  for (const id of [...hidden]) {
    if (baustein(id)?.pflicht) hidden.delete(id);
  }

  const present = new Set((input.blocks ?? []).map((b) => b.id));
  const wantedLead =
    lead != null && LEAD_CANDIDATES.includes(lead as CockpitBlockId) && present.has(lead as CockpitBlockId)
      ? (lead as CockpitBlockId)
      : // Ein Lead, den es hier nicht (mehr) gibt, wird still übersprungen wie
        // jeder andere Baustein — die M0-Regel peak → Geld → Fluss übernimmt.
        leadBlock(input.blocks ?? []);

  return {
    order: order.filter((id) => !hidden.has(id)),
    arrangement: order,
    hidden: [...hidden],
    lead: wantedLead,
    quelle,
  };
}

// ---------------------------------------------------------------------------
// Der Anpassen-Modus
// ---------------------------------------------------------------------------

/** Eine Zeile des Anpassen-Modus (Desktop-Overlay wie Telefon-Liste). */
export interface AnpassenZeile {
  id: BausteinId;
  label: string;
  sichtbar: boolean;
  pflicht: boolean;
  beweglich: boolean;
  /** Der Block, den ihr Stern setzt; null = kein Stern. */
  leadBlock: CockpitBlockId | null;
  /** true = dieser Baustein führt gerade. */
  lead: boolean;
  /** Kann sie eine Position nach oben? (Tastatur-Alternative zu Drag/Drop.) */
  kannHoch: boolean;
  kannRunter: boolean;
}

/**
 * Die Zeilen des Anpassen-Modus: erst die sichtbaren in ihrer Reihenfolge,
 * dann die ausgeblendeten (die Zeile „Ausgeblendet (n)" bleibt erreichbar).
 * `kannHoch`/`kannRunter` sind die BARRIEREFREIE Alternative zum Ziehen — ein
 * Layout-Editor, den man nur mit der Maus bedienen kann, ist keiner.
 *
 * Eingabe ist das ARRANGEMENT (alle verfügbaren Bausteine), nicht die
 * gerenderte Liste: ein ausgeblendeter Baustein behält damit seinen Platz und
 * kehrt beim Wiedereinblenden dorthin zurück.
 */
export function anpassenZeilen(input: {
  arrangement: readonly BausteinId[];
  hidden: readonly BausteinId[];
  lead: CockpitBlockId | null;
}): AnpassenZeile[] {
  const hidden = new Set(input.hidden);
  const sichtbar = input.arrangement.filter((id) => !hidden.has(id));
  const movable = sichtbar.filter((id) => baustein(id)?.beweglich !== false);
  const zeile = (id: BausteinId, ist: boolean): AnpassenZeile => {
    const def = baustein(id);
    const mi = ist ? movable.indexOf(id) : -1;
    return {
      id,
      label: bausteinLabel(id),
      sichtbar: ist,
      pflicht: def?.pflicht ?? false,
      beweglich: def?.beweglich !== false,
      leadBlock: def?.lead_block ?? null,
      lead: ist && def?.lead_block != null && def.lead_block === input.lead,
      kannHoch: mi > 0,
      kannRunter: mi >= 0 && mi < movable.length - 1,
    };
  };
  return [
    ...sichtbar.map((id) => zeile(id, true)),
    ...input.arrangement.filter((id) => hidden.has(id)).map((id) => zeile(id, false)),
  ];
}

/**
 * Verschiebt einen BEWEGLICHEN Baustein um eine Position. Unbewegliche
 * Bausteine bleiben, wo sie sind — der Tausch findet ausschließlich unter den
 * beweglichen statt, damit die Bühne nicht zerfällt.
 */
export function verschiebe(
  order: BausteinId[],
  id: BausteinId,
  richtung: 'hoch' | 'runter',
): BausteinId[] {
  const movable = order.filter((b) => baustein(b)?.beweglich !== false);
  const i = movable.indexOf(id);
  const j = richtung === 'hoch' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= movable.length) return order;
  const swapped = [...movable];
  swapped[i] = movable[j];
  swapped[j] = movable[i];
  let m = 0;
  return order.map((b) => (baustein(b)?.beweglich === false ? b : swapped[m++]));
}

/**
 * Das Dokument, das der Anpassen-Modus speichert: die VOLLE Reihenfolge der
 * gerade verfügbaren Bausteine plus die ausdrücklichen Aussagen.
 *
 * Es nennt die Reihenfolge vollständig, damit ein späteres Rendern nichts
 * raten muss; ein Baustein, der erst später auftaucht (neue Anwendung), wird
 * beim Auflösen an seiner kanonischen Stelle eingefügt.
 *
 * `shown` trägt die Bausteine, die eine TIEFERE Schicht ausblenden würde und
 * die der Kunde ausdrücklich wieder sehen will — ohne das könnte ein Kunde
 * eine Vorgabe seines Betreibers nie zurücknehmen.
 */
export function anpassenDokument(input: {
  /** Das volle Arrangement, ausgeblendete Bausteine eingeschlossen. */
  arrangement: readonly BausteinId[];
  hidden: readonly BausteinId[];
  lead: CockpitBlockId | null;
  /** Was die Schichten UNTER „eigen" ausblenden würden. */
  geerbtVersteckt?: readonly BausteinId[];
}): LayoutDocument {
  const hidden = input.hidden.filter((id) => !baustein(id)?.pflicht);
  const shown = (input.geerbtVersteckt ?? []).filter((id) => !hidden.includes(id));
  return {
    order: [...input.arrangement],
    hidden: [...hidden],
    shown: [...shown],
    lead: input.lead,
  };
}

/**
 * Der Satz für einen Baustein, der am RECHNER keinen eigenen Stapel-Knoten hat
 * — er wohnt entweder im Kopf (Status) oder in der Bühne (Geld-Leiste,
 * Steuerungs-Fuß). Seine Zeile erscheint im Anpassen-Modus trotzdem, sonst
 * wären das die einzigen Bausteine, die man am Rechner nicht ausblenden oder
 * hervorheben könnte — und der Kunde suchte einen Knopf, den es nur am Telefon
 * gibt. `null` = dieser Baustein rendert sich selbst.
 */
export function ortsHinweis(id: BausteinId): string | null {
  switch (id) {
    case 'status':
      return 'Der Kopf Ihrer Anlage — er steht immer oben.';
    case 'geld':
    case 'steuerung':
      return 'Wird am Rechner in der Bühne angezeigt.';
    default:
      return null;
  }
}

/**
 * Worauf ein „Zurücksetzen" fällt — der Knopf SAGT es (E2). Ohne diese Ansage
 * wäre „Zurücksetzen" ein Sprung ins Ungewisse: bei einem Betreiber-Kunden
 * landet man auf dessen Vorgabe, sonst auf dem VoltPilot-Standard.
 */
export function resetZiel(input: {
  tenantVorgabe?: LayoutDocument | null;
  siteVorgabe?: LayoutDocument | null;
  profil?: string | null;
}): { ziel: LayoutQuelle; satz: string } {
  if (saysSomething(input.siteVorgabe) || saysSomething(input.tenantVorgabe)) {
    return {
      ziel: saysSomething(input.siteVorgabe) ? 'vorgabe-anlage' : 'vorgabe-kunde',
      satz: 'Ihre Anordnung wird verworfen — es gilt wieder die Vorgabe Ihres Betreibers.',
    };
  }
  if (saysSomething(presetLayout(input.profil))) {
    return {
      ziel: 'preset',
      satz: 'Ihre Anordnung wird verworfen — es gilt wieder der VoltPilot-Standard für Ihr Profil.',
    };
  }
  return {
    ziel: 'katalog',
    satz: 'Ihre Anordnung wird verworfen — es gilt wieder der VoltPilot-Standard.',
  };
}

/** Die Ansage über der Fläche, wenn ein Admin die VORGABE gestaltet (§3.4). */
export function vorgabeBand(kunde: string | null | undefined): string {
  return kunde
    ? `Sie gestalten die Vorgabe für ${kunde}. Ihre Kunden können davon abweichen.`
    : 'Sie gestalten die Vorgabe für diesen Kunden. Ihre Kunden können davon abweichen.';
}

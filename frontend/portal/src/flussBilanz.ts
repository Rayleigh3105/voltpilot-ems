/**
 * **Die Bilanz des Moments „jetzt“** im Cockpit: EIN stimmiger Satz aus Erzeugung, Netz, Speicher
 * und Verbrauch, aus dem Knoten, Satz und Anteile gerechnet werden.
 *
 * Die Box bildet ihre Hausbilanz aus den FRISCHEN Erzeugern (`Haus = PV + Netz − Speicher`,
 * `docs/edge-runtime.md#messwerte`); das Haus-Mitglied der Topologie ist genau diese Zahl. Das
 * Cockpit muss deshalb dieselben Erzeuger zählen wie die Box, sonst stehen an den Knoten Zahlen aus
 * zwei verschiedenen Sätzen. Gefunden bei Schramm „Zuhause“ am 07.11.2026, 14:20: „Erzeugung 1,2 kW,
 * Bezug 5,9 kW, Verbrauch 9,6 kW, Sonne deckt 12 %“. Eine PV-Zuordnung nannte nur den PIKO; das
 * Cockpit nahm sie als Sonne der ganzen Anlage, das Haus der Box enthielt aber auch die drei KACO
 * (2,5 kW). Die Regeln:
 *
 *  1. **Eine PV-Zuordnung ersetzt die Zahl der beteiligten Geräte, nicht die der Anlage.** So
 *     verspricht es der Dialog („Ersetzt in der Anlagen-Übersicht die PV-Zahl der beteiligten
 *     Geräte“, `RolleAendernDialog`, Vertrag `rollen-zuordnung.md`). Erzeuger ohne Zuordnung zählen
 *     mit ihrer eigenen Messung weiter. Der Wert der Zuordnung bleibt die Zahl des Servers: ein
 *     Summenwert an mehreren Geräten zählt einmal, er wird nie aus Gerätezeilen nachgerechnet.
 *  2. **Ein Erzeuger ohne aktuellen Wert zählt nicht still mit.** Die Box rechnet ihn nicht ins Haus.
 *     Das Cockpit legt seinen letzten Wert deshalb nicht zur Erzeugung, sondern nennt ihn
 *     („Nicht mitgezählt: …“). „Aktuell“ ist dieselbe Regel wie im Anlagenkopf und in den
 *     Gruppenköpfen der Anlage ({@link wertAktuell}). Ebenso Netz, Haus und Speicher, wenn sie allein
 *     keinen aktuellen Wert tragen; ist die ganze Anlage still, gilt die Frische-Anzeige der Bühne.
 *  3. **Passen die vier Werte trotzdem nicht zusammen** (ein zugeordneter Teilverbrauch, ein
 *     Summenwert auf anderer Zeitbasis, eine Box ohne Hausbilanz), rechnet das Cockpit keine Anteile
 *     aus. Der Satz nennt beide Seiten ({@link widerspruchSatz}).
 *
 * Netz und Verbrauch mit Zuordnung bleiben, wie sie sind (H-3): der kanonische Wert ersetzt den
 * Knoten. Rein und rahmenfrei (getestet in `flussBilanz.test.ts`).
 */
import type { RollenKanonischerWert, SiteTopology, TopologyEntity } from './api';
import { jetztFluss, type JetztFluss } from './flussJetzt';
import { kw, TOTBAND_KW, type FlussWerte } from './leitungsplan';
import type { LiveSnapshot } from './live';
import type { PvComposition, PvContribution } from './pvComposition';
import { cockpitRollenTopologie } from './pvRolle';
import { wertAktuell } from './wertAktuell';

/** Ein Rest bis hierher ist Messrauschen zweier Zähler, kein Widerspruch (kW). */
export const BILANZ_TOLERANZ_KW = 0.3;
/** …oder bis zu diesem Anteil der umgesetzten Leistung - bei großen Anlagen springt die Last in Sekunden. */
export const BILANZ_TOLERANZ_ANTEIL = 0.1;

/** Höchstens so viele Namen nennt die Zeile „Nicht mitgezählt“, danach „und n weitere“. */
const LUECKEN_NAMEN = 3;

/** Der Grund, mit dem ein veralteter Teil benannt wird - dasselbe Wort wie in den Gerätezeilen. */
export const GRUND_VERALTET = 'meldet sich gerade nicht';

/** Ein Teil des Moments, der fehlt oder veraltet ist - der Satz nennt ihn, statt ihn still zu verrechnen. */
export interface BilanzLuecke {
  rolle: 'pv' | 'grid' | 'batt' | 'load';
  /** Gerätename (wie in den Listen) oder das Kundenwort der Rolle. */
  name: string;
  /** Der Grund in Worten, z. B. „meldet sich gerade nicht“ oder „wartet auf erste Daten“. */
  grund: string;
}

export interface FlussBilanz extends JetztFluss {
  /**
   * Die Erzeugung je Gerät ohne PV-Zuordnung, wie sie zählt: ein veralteter Erzeuger steht ohne
   * Wert unter `unmeasured` (Σ `parts` = Sonnen-Knoten). `null` ohne Zusammensetzung.
   */
  erzeugung: PvComposition | null;
  /**
   * Mit PV-Zuordnung: die Erzeuger, die sie NICHT erfasst. Sie zählen mit ihrer eigenen Messung
   * (die ohne Wert stehen mit ihrem Grund dabei). Leer ohne Zuordnung.
   */
  weitereErzeuger: PvContribution[];
  /** Was im Moment fehlt oder veraltet ist. */
  luecken: BilanzLuecke[];
  /** Erzeugung + Netz − Speicher − Verbrauch (kW); `null`, wenn ein Wert fehlt. */
  restKw: number | null;
  /** Passen die vier Werte als ein Satz zusammen? Nur dann gibt es Anteile und Prozente. */
  stimmig: boolean;
}

export interface FlussBilanzEingabe {
  /** Die ROHE Topologie (ohne kanonische Rollen): sie trägt die Werte, aus denen die Box ihr Haus bildet. */
  topology: SiteTopology | null;
  snapshot: LiveSnapshot;
  /** Die PV-Zusammensetzung aus der rohen Topologie (`pvComposition`), `null` ohne PV-Knoten. */
  pv: PvComposition | null;
  /** Die kanonischen Rollenwerte (`GET …/rollen/{pv|consumer|grid}`); ohne Zuordnung `null`. */
  rollen?: {
    pv?: RollenKanonischerWert | null;
    load?: RollenKanonischerWert | null;
    grid?: RollenKanonischerWert | null;
  } | null;
}

function aktiv(r: RollenKanonischerWert | null | undefined): RollenKanonischerWert | null {
  return r?.zuordnung_vorhanden === true ? r : null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function summe(teile: PvContribution[]): number {
  return teile.reduce((s, p) => s + (p.kw ?? 0), 0);
}

/** Der Name eines Topologie-Mitglieds wie in den Listen; ein leerer Name wird das Kundenwort der Rolle. */
function nameVon(e: TopologyEntity | undefined, rueckfall: string): string {
  const n = (e?.label ?? '').trim();
  return n || rueckfall;
}

/**
 * Ein Erzeuger mit einem Wert, der nicht aktuell ist ({@link wertAktuell}): die Box rechnet ihn nicht
 * ins Haus. Gilt für die Werte je Gerät (`entity`); in der Rekonstruktion aus `/sources` steckt die
 * Summe schon im Hybrid und bleibt die der Box. Die Gesundheit ist die der Zeile (`pvComposition`):
 * der Bericht der Box über ihre Quelle, sonst die Lebendigkeit der Komponente.
 */
function zaehltNicht(c: PvComposition, p: PvContribution): boolean {
  // Ein verwaister Erzeuger trägt in der Zusammensetzung `never` und keinen Wert.
  return c.origin === 'entity' && p.kw != null && !wertAktuell({ health: p.health, verwaist: false, hatWert: true });
}

/** Die Zusammensetzung, wie sie zählt: Erzeuger ohne aktuellen Wert stehen ohne Zahl, mit ihrem Grund. */
function zaehlendeErzeugung(c: PvComposition): PvComposition {
  const still = c.parts.filter((p) => zaehltNicht(c, p));
  if (still.length === 0) return c;
  const parts = c.parts.filter((p) => !zaehltNicht(c, p));
  return {
    ...c,
    parts,
    unmeasured: [
      ...c.unmeasured,
      ...still.map((p) => ({ ...p, kw: null, note: p.health === 'never' ? 'wartet auf erste Daten' : GRUND_VERALTET })),
    ],
    totalKw: parts.length === 0 ? null : round3(summe(parts)),
  };
}

/** „über den Wechselrichter mitgemessen“ fehlt nicht - seine Leistung steckt im Hybrid. */
function fehltWirklich(p: PvContribution): boolean {
  return p.kw == null && p.note !== 'über den Wechselrichter mitgemessen';
}

/**
 * Die Bilanz des Moments. Ohne Topologie bleibt es beim Schnappschuss der Übersicht (eine Zahlenquelle,
 * nichts zu verrechnen).
 */
export function flussBilanz(e: FlussBilanzEingabe): FlussBilanz {
  const pvRolle = aktiv(e.rollen?.pv);
  const loadRolle = aktiv(e.rollen?.load);
  const gridRolle = aktiv(e.rollen?.grid);
  // Netz und Verbrauch mit Zuordnung ersetzen ihren Knoten (H-3); die PV rechnet diese Funktion selbst.
  const topo = cockpitRollenTopologie(e.topology, [gridRolle, loadRolle]);
  const basis = jetztFluss(topo, e.snapshot, {
    pvTotalKw: null,
    loadKanonisch: loadRolle ? { wert: loadRolle.wert } : null,
  });
  const luecken: BilanzLuecke[] = [];
  const werte: FlussWerte = { ...basis.werte };
  let hat = basis.hat;
  // Nur wenn die Anlage sonst lebt, ist ein veralteter Teil eine Lücke. Schweigt alles, zeigt die
  // Bühne den letzten Stand mit ihrer Frische-Marke - dann wird nichts herausgenommen.
  const lebt = (e.topology?.entities ?? []).some((x) => x.health === 'ok');

  // --- Erzeugung -------------------------------------------------------------
  const roh = e.pv;
  const erzeugung = roh ? (lebt ? zaehlendeErzeugung(roh) : roh) : null;
  let weitereErzeuger: PvContribution[] = [];
  if (pvRolle) {
    // Je Gerät ersetzen geht nur, wo die Geräte eigene Werte tragen. In der Rekonstruktion aus
    // `/sources` trägt der Hybrid die Summe der Anlage; dort bleibt die Zuordnung die ganze Sonne
    // (wie bisher) - passt das nicht zum Haus, sagt es die Prüfung unten.
    const jeGeraet = erzeugung?.origin === 'entity';
    const erfasst = new Set(pvRolle.geraete.map((g) => g.entity_id));
    const frei = (p: PvContribution) => p.entityId == null || !erfasst.has(p.entityId);
    weitereErzeuger = erzeugung && jeGeraet ? [...erzeugung.parts, ...erzeugung.unmeasured].filter(frei) : [];
    const gemessen = weitereErzeuger.filter((p) => p.kw != null);
    // Eine stumme Zuordnung bleibt unbekannt (Vertrag: kein stiller Rückfall auf die Rohzahl).
    werte.pv = pvRolle.wert == null ? null : round3(Math.abs(pvRolle.wert) + summe(gemessen));
    for (const g of pvRolle.geraete) {
      if (!g.liefernd) luecken.push({ rolle: 'pv', name: g.name?.trim() || 'Gerät', grund: 'liefert gerade nicht' });
    }
    for (const p of weitereErzeuger) {
      if (fehltWirklich(p)) luecken.push({ rolle: 'pv', name: p.label, grund: p.note ?? 'ohne Messung' });
    }
    hat = { ...hat, pv: true };
  } else if (erzeugung) {
    if (erzeugung.parts.length > 0) werte.pv = erzeugung.totalKw;
    // Alle Erzeuger mit Wert sind veraltet: die Erzeugung ist gerade unbekannt, nicht ihr letzter Stand.
    else if (roh!.parts.length > 0) werte.pv = null;
    for (const p of erzeugung.unmeasured) {
      if (fehltWirklich(p)) luecken.push({ rolle: 'pv', name: p.label, grund: p.note ?? 'ohne Messung' });
    }
  }

  // --- Netz, Haus und Speicher: allein veraltet zählen sie nicht -----------------
  const entities = new Map((e.topology?.entities ?? []).map((x) => [x.id, x] as const));
  const nodes = e.topology?.topology.nodes ?? [];
  if (lebt) {
    const grN = nodes.find((n) => n.role === 'grid');
    const netzMitglied = grN?.members.find((m) => m.primary) ?? grN?.members[0];
    const netz = netzMitglied ? entities.get(netzMitglied.entity_id) : undefined;
    if (!gridRolle && werte.grid != null && netz != null && netz.health !== 'ok') {
      werte.grid = null;
      luecken.push({ rolle: 'grid', name: nameVon(netz, 'Netz'), grund: GRUND_VERALTET });
    }
    const haus = (e.topology?.entities ?? []).find((x) => x.entityType === 'house-load');
    if (!loadRolle && werte.load != null && haus != null && haus.health !== 'ok') {
      werte.load = null;
      luecken.push({ rolle: 'load', name: 'Verbrauch', grund: 'ohne aktuelle Messung' });
    }
    const stN = nodes.find((n) => n.role === 'storage');
    const speicher = (stN?.members ?? []).map((m) => entities.get(m.entity_id)).filter((x): x is TopologyEntity => x != null);
    if (werte.batt != null && speicher.length > 0 && speicher.every((x) => x.health !== 'ok')) {
      werte.batt = null;
      luecken.push({ rolle: 'batt', name: nameVon(speicher[0], 'Speicher'), grund: GRUND_VERALTET });
    }
  }
  for (const [rolle, r] of [['grid', gridRolle], ['load', loadRolle]] as const) {
    for (const g of r?.geraete ?? []) {
      if (!g.liefernd) luecken.push({ rolle, name: g.name?.trim() || 'Gerät', grund: 'liefert gerade nicht' });
    }
  }

  const restKw = bilanzRest(werte);
  return {
    ...basis,
    werte,
    hat,
    erzeugung,
    weitereErzeuger,
    // Schweigt die ganze Anlage, sagt es die Frische-Marke der Bühne - keine Liste stummer Geräte.
    luecken: lebt ? luecken : [],
    restKw,
    stimmig: restKw == null || Math.abs(restKw) <= bilanzToleranz(werte),
  };
}

/** Erzeugung + Netz − Speicher − Verbrauch (kW), `null` sobald ein Wert fehlt. */
export function bilanzRest(w: FlussWerte): number | null {
  if (w.pv == null || w.grid == null || w.batt == null || w.load == null) return null;
  return round3(w.pv + w.grid - w.batt - w.load);
}

/** Wie groß ein Rest werden darf, bevor die Werte „nicht zusammenpassen“ (kW). */
export function bilanzToleranz(w: FlussWerte): number {
  const zufluss = Math.max(w.pv ?? 0, 0) + Math.max(w.grid ?? 0, 0) + Math.max(-(w.batt ?? 0), 0);
  const skala = Math.max(Math.abs(w.load ?? 0), zufluss);
  return Math.max(BILANZ_TOLERANZ_KW, BILANZ_TOLERANZ_ANTEIL * skala);
}

function und(namen: readonly string[]): string {
  return namen.length <= 1 ? namen.join('') : `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/**
 * Der Satz, wenn die vier Werte nicht zusammenpassen: was liefert und was abnimmt, beide Seiten mit Zahl,
 * keine Ursache erfunden („Erzeugung und Bezug liefern 7,1 kW, der Verbrauch zeigt 9,6 kW“).
 */
export function widerspruchSatz(w: FlussWerte): string | null {
  if (w.pv == null || w.grid == null || w.batt == null || w.load == null) return null;
  const liefern: [string, number][] = [['Erzeugung', Math.max(w.pv, 0)]];
  if (w.grid > TOTBAND_KW) liefern.push(['Bezug', w.grid]);
  if (w.batt < -TOTBAND_KW) liefern.push(['Speicher', -w.batt]);
  const nehmen: [string, number][] = [['Verbrauch', Math.max(w.load, 0)]];
  if (w.grid < -TOTBAND_KW) nehmen.push(['Einspeisung', -w.grid]);
  if (w.batt > TOTBAND_KW) nehmen.push(['Laden', w.batt]);
  const summe = (l: [string, number][]) => kw(l.reduce((s, [, v]) => s + v, 0));
  const namen = (l: [string, number][]) => und(l.map(([n]) => n));
  const links = `${namen(liefern)} ${liefern.length > 1 ? 'liefern' : 'liefert'} ${summe(liefern)}`;
  const rechts = nehmen.length > 1 ? `${namen(nehmen)} zeigen ${summe(nehmen)}` : `der Verbrauch zeigt ${summe(nehmen)}`;
  return `Die Werte passen gerade nicht zusammen: ${links}, ${rechts}. Darum rechnet das Cockpit keine Anteile aus.`;
}

/** Die Zeile unter dem Satz: welche Teile fehlen oder veraltet sind. `null` ohne Lücke. */
export function lueckenSatz(luecken: readonly BilanzLuecke[]): string | null {
  if (luecken.length === 0) return null;
  const gesehen = new Set<string>();
  const eindeutig = luecken.filter((l) => {
    const k = `${l.name}|${l.grund}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
  const genannt = eindeutig.slice(0, LUECKEN_NAMEN).map((l) => `${l.name} (${l.grund})`);
  const mehr = eindeutig.length - genannt.length;
  return `Nicht mitgezählt: ${genannt.join(', ')}${mehr > 0 ? ` und ${mehr} weitere` : ''}.`;
}

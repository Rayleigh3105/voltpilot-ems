/**
 * Das GESICHT einer Geräteseite (Scout `data/vp-geraeteseite-rev-b8` §4,
 * Captain-Punkt 2: „mehr Kreativität und Vielfalt, benutzerzentrischer").
 *
 * Der behobene Befund ist NICHT fehlende Gestaltung, sondern ein ZUSCHNITT:
 * derselbe Renderer schickte Hybrid-Wechselrichter, PV-Melder, Zähler,
 * Verbraucher und Ladesäule durch DIESELBE Sektionsliste in derselben
 * Reihenfolge - jede Seite beantwortete also zuerst dieselbe Frage
 * („wie ist dieses Gerät angebunden?"), obwohl der Benutzer je Typ eine andere
 * hat. Was ihn ZUERST interessiert (Support-Fälle Pilsting/Herzogau):
 *
 * | Typ | Die erste Frage |
 * |---|---|
 * | Wechselrichter mit Speicher | Was macht mein Speicher gerade, und folgt er dem Fahrplan? |
 * | Wechselrichter ohne Speicher | Wie viel erzeugt er gerade? |
 * | PV-Melder | Wie viel erzeugt er, wird er gedrosselt - und von wem? |
 * | Zähler | Bezug oder Einspeisung jetzt, und ist er der maßgebliche? |
 * | Verbraucher | Läuft es, und warum? |
 * | Ladesäule | Welcher Stecker lädt mit wie viel, wer wartet? |
 *
 * **Diese Datei entscheidet, WAS oben steht und welche Sektionen in welcher
 * Reihenfolge folgen - mehr nicht.** Die Sektions-Bauteile bleiben geteilt
 * (Zeilen-Liste, Komponenten-Zeile, Befehls-Film, Register-Tabelle, Drawer):
 * sieben Gesichter sind sieben Stellen, an denen eine Regel vergessen werden
 * kann, deshalb liegt die Auswahl in EINER reinen Datei mit einem Test je
 * Gattung, und es entsteht keine zweite Wahrheit über ein Gerät.
 *
 * Drei Ehrlichkeitsregeln tragen sie - alle sind Haus-Regeln:
 *
 * 1. **Ein Fach, das nur seine Nicht-Zuständigkeit erklärt, entfällt - still.**
 *    Das ist die Lehre der Box-Seite (Stufe 1), zu Ende gedacht (Geräteseiten
 *    „Ein Blick, eine Antwort", S5): Sätze wie „An einen Zähler schickt
 *    VoltPilot keine Befehle" halfen niemandem. Was es nicht gibt, fehlt.
 * 2. **Der eine Satz oben wird nie erfunden.** Er kommt aus den GETEILTEN
 *    Ableitungen (`controlStrip` für die Steuerung, der durchgereichte Satz der
 *    Box für die Säule) oder aus einem gemessenen Wert; wo nichts belegt ist,
 *    steht nichts.
 * 3. **Ein fehlender Wert ist `null`, nie eine 0** - und die Richtung ist ein
 *    WORT, nie ein Vorzeichen (die portalweite `live.ts`-Konvention).
 *
 * Rein + framework-frei (der `komponenten.ts`/`geraetSeite.ts`-Präzedenzfall).
 */
import type {
  ControlStatus, CurtailmentStatus, SiteEntity, SiteSource, TopologyEntity,
} from './api';
import { ladestandVon } from './ladestandVon';
import { channelLabel } from './channels';
import { NACHWEIS_FREIGABE, type NachweisArt } from './consumers/questions';
import { controlStrip } from './control';
import { fmtNum } from './format';
import type { GeraetArt, GeraetTon } from './geraetSeite';
import type { PlantComponent } from './komponenten';
import type { ChargeConnector, ChargePoint } from './ladepunkte';
import { NO_DATA } from './nodata';
import type { FlowNode } from './topology';

/**
 * Die Gattung einer Geräteseite - sie entscheidet Held und Sektions-Folge.
 *
 * `geraet` ist die ehrliche RÜCKFALL-Gattung: eine gemeldete Quelle, deren
 * Rolle die Box nicht nennt und deren Komponenten nichts verraten. Sie bekommt
 * die Sektions-Folge wie vor dieser Stufe - geraten wird nichts.
 */
export type Gattung =
  | 'wechselrichter-speicher'
  | 'wechselrichter'
  | 'pv-melder'
  | 'zaehler'
  | 'verbraucher'
  | 'ladepunkt'
  | 'geraet';

/** Eine Sektion der Seite. Nicht genannte Sektionen werden NICHT gerendert. */
export type SektionId =
  | 'jetzt'
  | 'befehle'
  | 'komponenten'
  | 'grenzen'
  | 'einspeise'
  | 'ausfallschutz'
  | 'register'
  | 'verbindung'
  | 'ladepark';

/** Eine Kachel des Helds. */
export interface HeldKachel {
  /**
   * Der stabile Schlüssel dieser Kachel - zugleich der SPRUNGPUNKT eines
   * Deep-Links (`?abschnitt=jetzt&kachel=speicher`, Blatt 3 / §5.3).
   *
   * ⚠ Er ist nicht das Label: der Kunde darf eine Kachel umbenennen (der
   * Speicher heißt „Keller"), die Adresse darf davon nicht abhängen.
   */
  key: string;
  label: string;
  /** Der formatierte Wert, oder `—`. */
  wert: string;
  /** Das Wort darunter („lädt", „Einspeisung", „frei"), oder null. */
  wort: string | null;
  ton?: GeraetTon | null;
  /** Die FÜHRENDE Kachel einer Gattung wird größer gesetzt. */
  gross?: boolean;
}

/** Der Held: das Erste, was die Seite zeigt. */
export interface Held {
  /** Die Überschrift der Held-Karte („Jetzt", „Erzeugung", „Stecker"). */
  titel: string;
  kacheln: HeldKachel[];
  /** Die 1-Satz-Aussage - null, wo nichts belegt ist. */
  satz: string | null;
  satzTon: GeraetTon;
  /** Ein ruhiger Zusatz unter dem Satz (Nennleistung, Grund), oder null. */
  hinweis: string | null;
  /**
   * Ruhige ZUSATZ-Zeilen unter dem Satz - die Erfüllungs-Zeile eines
   * Verbrauchers (§5.4/§5.7).
   *
   * ⚠ Sie kommt aus ihrer GETEILTEN Ableitung
   * (`consumers/fulfillment.fulfilmentSummary`) und wird hier nur EINGEREIHT -
   * eine eigene Formulierung wäre ein zweites Urteil. Was nicht belegt ist,
   * steht gar nicht da; die Liste ist dann leer, nie „—".
   */
  zeilen: string[];
  /** Auslastung als ruhiger Balken - nur wo ein BELEGTER Bezug existiert. */
  balken: { pct: number; label: string } | null;
  /**
   * Die ROHEN Zahlen der Bühnen-Grafik (Batterie-Füllstand, Sonnenbogen,
   * Waage, Fluss-Tempo). ⚠ Es sind DIESELBEN Zahlen, aus denen die Kacheln
   * oben entstehen - an derselben Stelle gelesen, damit Grafik und Zahl nie
   * Verschiedenes zeigen. `null` = nicht gemeldet, nie eine 0.
   */
  werte: BuehneWerte;
}

/** Die rohen Zahlen einer Bühne - Vorzeichen nach der `live.ts`-Konvention. */
export interface BuehneWerte {
  /** Solarleistung dieses Geräts (kW). */
  pvKw: number | null;
  /** Netzleistung: `+` Bezug, `−` Einspeisung. */
  netzKw: number | null;
  /** Hausverbrauch (abgeleitet). */
  hausKw: number | null;
  /** Batterieleistung: `+` lädt, `−` gibt ab. */
  batterieKw: number | null;
  ladestandPct: number | null;
  /** Die GELESENE Reserve (`guards.limits.soc_min_pct`). */
  reservePct: number | null;
  /** Die gepflegte Nennleistung (kWp). */
  kwp: number | null;
  /** Leistung eines Verbrauchers - nur wo sie GEMESSEN wird. */
  verbraucherKw: number | null;
  /** Läuft der Verbraucher (bzw. ist die Freigabe gesetzt)? null = unbekannt. */
  laeuft: boolean | null;
  /** Ist dieser Zähler die maßgebliche Messung der Bilanz? */
  massgeblich: boolean;
}

/** Nichts gemeldet - der Ausgangspunkt jeder Bühne. */
export const KEINE_WERTE: BuehneWerte = {
  pvKw: null,
  netzKw: null,
  hausKw: null,
  batterieKw: null,
  ladestandPct: null,
  reservePct: null,
  kwp: null,
  verbraucherKw: null,
  laeuft: null,
  massgeblich: false,
};

export interface Gesicht {
  gattung: Gattung;
  /**
   * Blatt 8 (§5.8): dieses Gerät hat der KUNDE selbst beschrieben
   * (`modbus-generic` = nur messen, `modbus-load` = schaltbar nach Freigabe).
   *
   * ⚠ Es ist BELEGT, nicht geraten - der Beleg ist `freigabeFaehig` an der
   * Komponente, das genau die zwei Selbstbau-Typen trägt. Und es ist eine
   * EIGENSCHAFT neben der Gattung, keine eigene: ein selbst gebauter Sensor
   * bleibt der Zähler-Fläche treu (§5.6 nennt ihn dort ausdrücklich), ein
   * selbst gebauter Schalter der Verbraucher-Fläche - nur ihr JETZT zeigt die
   * eigenen Kanäle, und ihre Software-Sektion entfällt.
   */
  eigenbau: boolean;
  /**
   * Ein I/O-Modul (Ebyte M31): es misst keine Energie, seine Bühne ist der
   * Klemmenplan seiner Ein- und Ausgänge. BELEGT über den Transport, den nur
   * dieses Modul spricht (`ebyte_modbus_tcp`), nie geraten.
   */
  ioModul: boolean;
  held: Held;
  /**
   * Was dieses Blatt HAT - fehlt ein Fach, fällt es still weg (S5: kein Kasten
   * mehr, der seine eigene Nicht-Zuständigkeit erklärt).
   */
  sektionen: SektionId[];
}

export interface GesichtInput {
  art: GeraetArt;
  /** Die Kennung dieses Geräts auf der Box (`inverter`, `src-…`, `cp-…`). */
  geraetId: string;
  /** Die von der Box GEMELDETE Rolle (`pv-generation`/`grid-meter`/`consumer`). */
  rolle: string | null;
  /** Die Kommunikationsart, wie Soll oder Ist sie nennen. */
  communication: string | null;
  komponenten: PlantComponent[];
  /** Die Entitäten der Anlage - für die gepflegte Nennleistung (kWp). */
  entities?: SiteEntity[] | null;
  /** Der gemeldete Ist-Zustand DIESES Geräts. */
  src?: SiteSource | null;
  charger?: ChargePoint | null;
  /**
   * Der Steuerungs-Beleg - **schon auf dieses Gerät gefiltert** (die
   * `eigenerBeleg`-Regel: eine Anlage kann mehrere Boxen haben, der Beleg kommt
   * von genau einer).
   */
  control?: ControlStatus | null;
  curtailment?: CurtailmentStatus | null;
  /** Die Namen der Regeln, die eine Komponente dieses Geräts anfassen. */
  regeln?: string[];
  /**
   * Die Kanal-WERTE der Entitäten dieser Anlage (`GET /topology`) - die einzige
   * Quelle, die je Kanal einen Live-Wert trägt. Sie speist die Batterie-Kachel
   * des Hybriden und die selbst definierten Kanäle des Eigenbaus (§5.1/§5.8);
   * ohne sie fehlen genau diese Kacheln, nie eine erfundene 0.
   */
  topologie?: TopologyEntity[] | null;
  /**
   * Der SPEICHER-KNOTEN des Lesemodells (P6 Speiser-Bindung). Er trägt als
   * einziger die Auskunft, WOHER der Ladestand kommt (`soc_source`) und was
   * das BMS zulässt (`limits`) - beides muss nicht von diesem Gerät stammen:
   * eine ausdrücklich gebundene Selbstbau-Batterie liefert den Ladestand,
   * während der Hybrid-Wechselrichter die Leistung weiter misst.
   *
   * `null`/absent = die Anlage hat keinen Speicher-Knoten; dann steht hier
   * nichts, nie ein geratener Wert.
   */
  speicherKnoten?: FlowNode | null;
  /**
   * Die Erfüllungs-Zeile eines Verbrauchers - WÖRTLICH die geteilte
   * `fulfilmentSummary(...).headline` (§5.4/§5.7). Leer = keine wiederkehrende
   * Aufgabe; dann steht dort nichts.
   */
  erfuellung?: string | null;
  /**
   * Die D3-BESTÄTIGUNGSSTUFE eines Verbrauchers (§5.7): `true` = die Leistung
   * wird GEMESSEN, `false` = die Energie wird ANGENOMMEN (Nennleistung × Zeit).
   *
   * ⚠ `null`/absent heißt „nicht bekannt" und behauptet keines von beidem - die
   * Zeile entfällt dann. Der Wert kommt aus der geteilten
   * `consumers/questions.consumerHasMeasurement`; eine zweite Heuristik hier
   * wäre ein Zwilling, der abdriftet.
   */
  gemessen?: boolean | null;
  /**
   * Die D3-NACHWEISART eines Verbrauchers (P8) - sie schlägt `gemessen`, wo sie
   * vorliegt, und trägt die dritte Möglichkeit, die ein Boolean nicht kennt:
   * `freigabe`. Eine SG-Ready-Wärmepumpe wird über einen potentialfreien
   * Kontakt FREIGEGEBEN; ob sie anläuft und mit welcher Leistung, entscheidet
   * sie selbst. Ohne dieses Feld läse sie sich als „angenommen (Nennleistung ×
   * Zeit)" - eine erfundene Energie über ein Gerät, das wir nicht messen.
   *
   * ⚠ `null`/absent = nicht bekannt; dann gilt `gemessen` wie bisher.
   */
  nachweis?: NachweisArt | null;
  /**
   * K4: der zuletzt GEMELDETE Zustand des Relais-Ausgangs, an dem dieser
   * Verbraucher hängt - nur, wenn die Meldung des Moduls AKTUELL ist. Er zählt
   * erst, wenn der Verbraucher selbst weder Leistung noch Relais meldet.
   */
  ioAusgangAn?: boolean | null;
  now?: number;
}

/**
 * Transporte OHNE Modbus-Register. Ein Gerät, das über seine Web-Schnittstelle
 * gelesen wird, bekommt keine Register-Sektion, die nur erklärt, dass es hier
 * keine gibt - der Satz steht stattdessen im Technik-Aufklapper.
 */
const OHNE_REGISTER = new Set([
  'fronius_solar_api', 'goe_http_api', 'shelly_http', 'ocpp', 'ebyte_modbus_tcp',
]);

/**
 * Transporte, deren Geräte-Socket der Box-Kern allein besitzt: Register GIBT
 * es dort, aber ein freier Zugriff liefe an Verbrauchersteuerung, Schutzgrenzen
 * und Geräte-Watchdog vorbei - der Grund ist deshalb ein anderer Satz.
 */
const KERN_EIGEN = new Set(['ebyte_modbus_tcp']);

/** Ab welcher Leistung ein Verbraucher als „läuft" gilt (die Rausch-Schwelle). */
const LAEUFT_AB_KW = 0.05;

/**
 * Die feste Ordnung der Gesicht-Fächer. Sie ist eine MENGE mit Reihenfolge:
 * ein Blatt LÄSST AUS, was sein Typ nicht hat, sortiert aber nie um - so bleibt
 * die Auswahl lesbar und ihr Test eine Aussage über die Ordnung.
 */
const KANONISCH: readonly SektionId[] = [
  'jetzt',
  'befehle',
  'grenzen',
  'einspeise',
  'ausfallschutz',
  'ladepark',
  'komponenten',
  'register',
  'verbindung',
];

/**
 * Der Hilfetext des Blatts „Schaltbarer Verbraucher" (§5.7).
 *
 * ⚠ Er steht im HILFETEXT, nie im Titel: eine Wärmepumpe ist im Katalog kein
 * eigener Typ, sie läuft als generische Last über ein Schaltrelais. Ein Blatt
 * „Wärmepumpe" behauptete eine Gerätekenntnis, die die Plattform nicht hat.
 */
export const WAERMEPUMPE_HINWEIS =
  'Eine Wärmepumpe führt VoltPilot als schaltbaren Verbraucher: geschaltet wird das Relais '
  + 'davor, nicht die Pumpe selbst.';

/**
 * Der Satz, wenn KEINE Kachel des Helds einen Wert trägt.
 *
 * ⚠ Er ist die Fortschreibung der Regel „jede leere Sektion nennt ihren Grund"
 * auf den Held: eine Reihe von „—" ohne ein Wort daneben liest sich als Fehler
 * der Seite, nicht als Zustand des Geräts.
 */
export const KEINE_MESSWERTE = 'Dieses Gerät hat noch keine Messwerte geliefert.';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function kw(v: number | null): string {
  return v == null ? NO_DATA : fmtNum(v, 'kW');
}

/**
 * Der TYP in Kundenworten - die erste Hälfte der Kopf-Unterzeile („Hybrid-
 * Wechselrichter · Deye SUN-12K"). Dieselben Wörter wie `geraetSeite.ART_WORT`/
 * `ROLLEN_WORT`, damit Zentrale-Karte und Geräteseite ein Gerät gleich nennen.
 */
export const TYP_WORT: Record<Gattung, string> = {
  'wechselrichter-speicher': 'Hybrid-Wechselrichter',
  wechselrichter: 'Wechselrichter',
  'pv-melder': 'PV-Wechselrichter',
  zaehler: 'Zähler',
  verbraucher: 'Verbraucher',
  ladepunkt: 'Wallbox',
  geraet: 'Gerät',
};

/** Der Typ dieses Blatts - ein I/O-Modul und ein Eigenbau sagen, was sie sind. */
export function typWort(g: Pick<Gesicht, 'gattung' | 'eigenbau' | 'ioModul'>): string {
  if (g.ioModul) return 'I/O-Modul';
  const basis = TYP_WORT[g.gattung];
  return g.eigenbau ? `${basis} (selbst beschrieben)` : basis;
}

/** Die Gattung aus dem, was BELEGT ist - nie geraten. */
export function gattungVon(input: {
  art: GeraetArt;
  rolle: string | null;
  komponenten: PlantComponent[];
}): Gattung {
  if (input.art === 'ladepunkt') return 'ladepunkt';
  if (input.art === 'hauptgeraet') {
    return input.komponenten.some((c) => c.role === 'storage')
      ? 'wechselrichter-speicher'
      : 'wechselrichter';
  }
  // Die gemeldete Rolle FÜHRT: sie ist die Aussage des Geräts über sich selbst.
  if (input.rolle === 'pv-generation') return 'pv-melder';
  if (input.rolle === 'grid-meter') return 'zaehler';
  if (input.rolle === 'consumer') return 'verbraucher';
  // Sonst entscheiden die Komponenten - und nur, wenn sie EINDEUTIG sind.
  const rollen = new Set(input.komponenten.filter((c) => c.aspect === 'main').map((c) => c.role));
  if (rollen.size === 1) {
    const [r] = Array.from(rollen);
    if (r === 'pv') return 'pv-melder';
    if (r === 'grid') return 'zaehler';
    if (r === 'consumer') return 'verbraucher';
    if (r === 'storage') return 'wechselrichter-speicher';
  }
  return 'geraet';
}

/**
 * Welche Sektionen ein Blatt HAT (§5.1-§5.9) - kanonisch sortiert.
 *
 * ⚠ Das Ergebnis läuft durch {@link KANONISCH}: die Auswahl ist eine MENGE, die
 * Ordnung gehört dem Rahmen.
 */
function sektionenVon(i: {
  gattung: Gattung;
  registerMoeglich: boolean;
  eigenbau: boolean;
}): SektionId[] {
  const hat = new Set<SektionId>(['jetzt', 'komponenten', 'verbindung']);
  if (i.registerMoeglich) hat.add('register');
  switch (i.gattung) {
    case 'wechselrichter-speicher':
    case 'wechselrichter':
      // Die Grenzen stehen DIREKT über dem Werkzeug: die Zeile „Ihr
      // Wechselrichter begrenzt auf 33,0 kW - hinterlegt sind 70,0 kW" ist
      // genau das, was einen Register-Schreibvorgang motiviert.
      hat.add('befehle');
      hat.add('grenzen');
      break;
    case 'pv-melder':
      hat.add('befehle');
      hat.add('einspeise');
      break;
    case 'zaehler':
      // Kein Befehls-Kasten: an einen Zähler geht kein Befehl, und ein leerer
      // Kasten mit seiner eigenen Erklärung ist die Box-Lehre. Ein SELBSTBAU-
      // Sensor bekommt trotzdem „Grenzen" - dort wohnt sein Freigabe-Einstieg.
      if (i.eigenbau) hat.add('grenzen');
      break;
    case 'verbraucher':
      // §5.7: Nennleistung, Schonzeiten und der Totmann-Hinweis wohnen in den
      // Grenzen - vor dieser Stufe hatte ein Verbraucher sie gar nicht.
      hat.add('befehle');
      hat.add('grenzen');
      break;
    case 'ladepunkt':
      hat.add('befehle');
      hat.add('ausfallschutz');
      hat.add('ladepark');
      break;
    default:
      hat.add('befehle');
      if (i.eigenbau) hat.add('grenzen');
      break;
  }
  return KANONISCH.filter((id) => hat.has(id));
}

/**
 * Der Live-Wert EINES Kanals einer Entität aus dem Topologie-Lesemodell.
 *
 * ⚠ Es ist die einzige Quelle, die je Kanal einen Wert trägt (`/sources` kennt
 * nur die vier Sammel-Kanäle). Ohne sie fehlt die Kachel - nie eine erfundene 0.
 */
function kanalWert(
  topologie: TopologyEntity[] | null | undefined,
  entityId: string,
  channel: string,
): { wert: number; unit: string | null } | null {
  const e = (topologie ?? []).find((t) => t.id === entityId);
  const c = e?.capabilities?.find((k) => k.channel === channel);
  const v = num(c?.value);
  return v == null ? null : { wert: v, unit: c?.unit ?? null };
}

/** Eine Zahl aus dem Guard-Block einer Entität - gelesen, nie geschlossen. */
function guardZahl(
  entities: SiteEntity[] | null | undefined,
  entityId: string,
  key: string,
): number | null {
  const limits = (entities ?? []).find((e) => e.id === entityId)?.guards?.limits;
  return num((limits as Record<string, unknown> | undefined)?.[key]);
}

/** Der Entitätstyp einer Komponente - für die Blatt-eigenen Hilfetexte. */
function entityTypeOf(
  entities: SiteEntity[] | null | undefined,
  entityId: string,
): string | null {
  return (entities ?? []).find((e) => e.id === entityId)?.entityType ?? null;
}

/** Die gepflegte Nennleistung der PV-Komponenten dieses Geräts (kWp). */
function kwpVon(komponenten: PlantComponent[], entities: SiteEntity[] | null | undefined):
number | null {
  const ids = new Set(komponenten.filter((c) => c.role === 'pv').map((c) => c.entityId));
  let summe: number | null = null;
  for (const e of entities ?? []) {
    if (!ids.has(e.id)) continue;
    const v = num(e.capacityKwp);
    if (v != null && v > 0) summe = (summe ?? 0) + v;
  }
  return summe;
}

/** Die Netz-Kachel: die Richtung ist ein WORT, nie ein Vorzeichen. */
function netzKachel(grid: number | null, gross = false): HeldKachel {
  return {
    key: 'netz',
    label: 'Netz',
    wert: kw(grid == null ? null : Math.abs(grid)),
    wort: grid == null ? null : grid < 0 ? 'Einspeisung' : grid > 0 ? 'Bezug' : 'ausgeglichen',
    gross,
  };
}

/**
 * Der SPEICHER-TEIL des Hybrid-Blatts (§5.1): Ladestand · Batterieleistung mit
 * Richtungs-WORT · Reserve.
 *
 * ⚠ Die Batterieleistung kommt aus dem KANAL der Speicher-Entität, nie aus
 * einer Bilanz-Ableitung - und ihre Richtung ist ein Wort (die `live.ts`-
 * Konvention: `+` lädt, `−` gibt ab). Die Reserve wird GELESEN
 * (`guards.limits.soc_min_pct`), nie aus einem Messwert geschlossen.
 */
export const SPEICHER_KACHEL = 'speicher';

/**
 * Die Beschriftung des §5.3-Absprungs. Sie sagt, WO der Speicher wohnt - er
 * hat keine eigene Seite, und ein „Geräteseite öffnen" an einer Batterie-Zeile
 * verspräche eine, die es nicht gibt.
 */
export const SPEICHER_BLATT_LABEL = 'Speicher am Wechselrichter';

/** Der Speicher-Teil: seine Kacheln UND die rohen Zahlen, aus denen sie entstehen. */
interface SpeicherTeil {
  kacheln: HeldKachel[];
  ladestandPct: number | null;
  batterieKw: number | null;
  reservePct: number | null;
}

function speicherTeil(input: GesichtInput): SpeicherTeil {
  const c = input.komponenten.find((k) => k.role === 'storage');
  if (!c) return { kacheln: [], ladestandPct: null, batterieKw: null, reservePct: null };
  const out: HeldKachel[] = [];
  let ladestandPct: number | null = null;
  const knoten = input.speicherKnoten ?? null;
  /*
    P6 Speiser-Bindung: der Ladestand des Speicher-KNOTENS gewinnt, sobald er
    von einem ANDEREN Gerät kommt als diesem - und die Kachel sagt dann, von
    welchem. Der Grund ist der Live-Fall, für den es dieses Paket gibt: der Deye
    im Spannungsmodus MISST keinen Ladestand, das DIYBMS des Kunden schon (über
    die Kennlinie). Ohne diesen Zweig zeigte die Geräteseite weiter das
    Schweigen des Wechselrichters, während das Cockpit daneben den gebundenen
    Wert führt - zwei Flächen, eine Anlage, zwei Antworten.
  */
  const quelle = knoten?.soc_source ?? null;
  const gebundenerSoc = quelle != null && quelle.entity_id !== c.entityId
    ? knoten?.soc_pct ?? null
    : null;
  if (gebundenerSoc != null && quelle != null) {
    ladestandPct = num(gebundenerSoc);
    out.push({
      key: SPEICHER_KACHEL,
      label: 'Ladestand',
      wert: fmtNum(gebundenerSoc, '%'),
      wort: ladestandVon(quelle.label),
      gross: true,
    });
  } else if (c.reading) {
    // Nur ein Prozentwert ist ein Ladestand - ohne ihn trägt die Zeile die
    // Leistung, und die gehört nicht in den Füllstand.
    if (c.reading.unit === '%') ladestandPct = c.reading.value;
    out.push({
      key: SPEICHER_KACHEL,
      label: 'Ladestand',
      wert: fmtNum(c.reading.value, c.reading.unit),
      wort: c.reading.caption,
      gross: true,
    });
  }
  const batt = kanalWert(input.topologie, c.entityId, 'battery_power_kw');
  if (batt) {
    out.push({
      key: 'batterie',
      label: 'Batterieleistung',
      wert: kw(Math.abs(batt.wert)),
      wort: Math.abs(batt.wert) <= LAEUFT_AB_KW
        ? 'ruht'
        : batt.wert > 0 ? 'lädt' : 'gibt ab',
    });
  }
  const reserve = guardZahl(input.entities, c.entityId, 'soc_min_pct');
  if (reserve != null) {
    out.push({ key: 'reserve', label: 'Reserve', wert: `${reserve} %`, wort: 'nicht unterschritten' });
  }
  /*
    P6: was das BMS gerade ZULÄSST. Eine gesperrte Richtung ist die wichtigere
    Aussage als eine Zahl - sie erklärt einen ruhenden Speicher, den sonst
    niemand erklärt. Ein abwesendes Feld wird ÜBERGANGEN, nie als „erlaubt"
    gelesen.
  */
  const l = knoten?.limits ?? null;
  if (l) {
    if (l.charge_allowed === false || l.charge_limit_a != null) {
      out.push({
        key: 'bms-laden',
        label: 'Laden (BMS)',
        wert: l.charge_allowed === false ? 'gesperrt' : fmtNum(l.charge_limit_a ?? 0, 'A', 0),
        wort: l.charge_allowed === false ? null : 'höchstens',
      });
    }
    if (l.discharge_allowed === false || l.discharge_limit_a != null) {
      out.push({
        key: 'bms-entladen',
        label: 'Entladen (BMS)',
        wert: l.discharge_allowed === false
          ? 'gesperrt'
          : fmtNum(l.discharge_limit_a ?? 0, 'A', 0),
        wort: l.discharge_allowed === false ? null : 'höchstens',
      });
    }
  }
  return { kacheln: out, ladestandPct, batterieKw: batt?.wert ?? null, reservePct: reserve };
}

/**
 * Was die ABREGELUNG über GENAU DIESES Gerät sagt (Geräteseiten Stufe 1
 * lieferte die Einheiten-Liste - erst sie macht die Aussage möglich).
 *
 * ⚠ Ohne einen Eintrag für dieses Gerät wird NICHTS über es behauptet: die
 * Zähler (`units`/`certifiedUnits`) sind eine Aussage über die ANLAGE, und sie
 * einem von mehreren Wechselrichtern anzulasten wäre genau die erfundene
 * Zuordnung, die `ANLAGENWEITE_BEFEHLE` vermeidet.
 */
export function abregelungDiesesGeraets(
  status: CurtailmentStatus | null | undefined,
  geraetId: string,
): { satz: string; ton: GeraetTon } | null {
  if (!status) return null;
  const unit = (status.perUnit ?? []).find((u) => u.sourceId === geraetId);
  if (!unit) {
    if ((status.units ?? 0) <= 0) return null;
    return {
      satz: 'Welche Einheit gerade wie stark begrenzt wird, meldet Ihre Box noch nicht einzeln '
        + `— die Begrenzung gilt anlagenweit (${status.certifiedUnits} von ${status.units} `
        + 'Wechselrichtern freigegeben).',
      ton: status.certifiedUnits < status.units ? 'warn' : 'ok',
    };
  }
  if (!unit.certified) {
    return {
      satz: 'Dieses Gerät ist für die Einspeise-Begrenzung noch nicht freigegeben — VoltPilot '
        + 'prüft das Modell zuerst am Prüfstand.',
      ton: 'off',
    };
  }
  const cap = num(unit.appliedCapKw);
  if (cap == null) {
    return {
      satz: 'Dieses Gerät nimmt Einspeise-Begrenzungen von VoltPilot an — gerade ist keine aktiv.',
      ton: 'ok',
    };
  }
  const bestaetigt = unit.match === true
    ? ' · vom Gerät bestätigt'
    : unit.match === false
      ? ' · das Gerät bestätigt sie nicht'
      : '';
  return {
    satz: `Begrenzt gerade auf ${fmtNum(cap, 'kW')}${bestaetigt}.`,
    ton: unit.match === false ? 'warn' : 'ok',
  };
}

/**
 * Der Held der Gattung B/B' (§5.1/§5.2) - PV-Teil, Speicher-Teil, und Netz/Haus
 * NUR, wenn dieses Gerät sie misst.
 *
 * ⚠ Die letzte Regel ist der behobene Befund: „Netz —" und „Haus —" standen
 * bisher an JEDEM Wechselrichter, auch an einem, der gar keinen CT hat. Zwei
 * Striche sind keine Auskunft; die Kacheln entfallen dort ersatzlos.
 */
function heldWechselrichter(input: GesichtInput, mitSpeicher: boolean): Held {
  const src = input.src ?? null;
  const kacheln: HeldKachel[] = [];
  const pv = num(src?.pvKw);
  // Der PV-Teil steht IMMER: ein Wechselrichter erzeugt, das ist seine Rolle -
  // eine fehlende Zahl ist dort eine Aussage über die Messung, kein fehlender
  // Gegenstand.
  kacheln.push({ key: 'pv', label: 'Solarstrom', wert: kw(pv), wort: null, gross: !mitSpeicher });
  const speicher = mitSpeicher ? speicherTeil(input) : null;
  if (speicher) kacheln.push(...speicher.kacheln);
  const grid = num(src?.powerKw);
  if (grid != null) kacheln.push(netzKachel(grid));
  const load = num(src?.loadKw);
  if (load != null) {
    kacheln.push({ key: 'haus', label: 'Haus', wert: kw(load), wort: 'abgeleitet' });
  }
  const werte: BuehneWerte = {
    ...KEINE_WERTE,
    pvKw: pv,
    netzKw: grid,
    hausKw: load,
    batterieKw: speicher?.batterieKw ?? null,
    ladestandPct: speicher?.ladestandPct ?? null,
    reservePct: speicher?.reservePct ?? null,
    kwp: kwpVon(input.komponenten, input.entities),
  };

  const gesteuert = input.komponenten.filter((c) => c.control);
  if (gesteuert.length === 0) {
    // ⚠ „nur gelesen" trägt der Kopf als Abzeichen („nur Messung") - die
    // Bühne sagt, was das Gerät TUT. Am Speicher erzählen Zahl, Grafik und
    // Batterie-Chip das schon; ein erfundener Speicher-Satz wäre keine Messung.
    return {
      titel: 'Jetzt',
      kacheln,
      satz: mitSpeicher ? null : erzeugtSatz(pv, werte.kwp),
      satzTon: mitSpeicher || pv == null ? 'off' : 'ok',
      hinweis: null,
      zeilen: [],
      balken: null,
      werte,
    };
  }
  // ⚠ DIESELBE Ableitung wie Cockpit und Befehle-Seite - drei Flächen, ein
  // Satz. Ein eigener hier wäre eine zweite Wahrheit über denselben Sollwert.
  const strip = controlStrip(input.control ?? null, new Date(input.now ?? Date.now()), true);
  // ⚠ Der Freigabe-Stand steht NICHT auf der Bühne: er ist eine Auskunft über
  // das Gerät, keine über den Augenblick - sein Ort ist „Gerät & Verbindung"
  // (`geraetSeite` · Steuerungs-Bezüge). Zweimal auf einer Seite war der Befund.
  return {
    titel: 'Jetzt',
    kacheln,
    satz: strip?.sentence ?? null,
    satzTon: strip?.tone === 'warn' ? 'warn' : strip?.tone === 'ok' ? 'ok' : 'off',
    hinweis: strip?.execution ?? strip?.reason ?? null,
    zeilen: [],
    balken: null,
    werte,
  };
}

/** Der Erzeugungs-Satz - EINER für PV-Melder und ungesteuerte Wechselrichter. */
function erzeugtSatz(pv: number | null, kwp: number | null): string {
  if (pv == null) return 'Dieses Gerät meldet gerade keine Erzeugung.';
  return kwp == null
    ? `Erzeugt gerade ${fmtNum(pv, 'kW')}.`
    : `Erzeugt gerade ${fmtNum(pv, 'kW')} von ${fmtNum(kwp, 'kWp')}.`;
}

/** Der Held der Gattung C - Erzeugung, Nennleistung, Drosselung. */
function heldPvMelder(input: GesichtInput): Held {
  const pv = num(input.src?.pvKw)
    ?? num(input.komponenten.find((c) => c.role === 'pv' && c.reading)?.reading?.value ?? null);
  const kwp = kwpVon(input.komponenten, input.entities);
  const kacheln: HeldKachel[] = [
    { key: 'pv', label: 'Erzeugung jetzt', wert: kw(pv), wort: null, gross: true },
  ];
  if (kwp != null) {
    kacheln.push({ key: 'kwp', label: 'Nennleistung', wert: fmtNum(kwp, 'kWp'), wort: 'gepflegt' });
  }
  const satz = erzeugtSatz(pv, kwp);
  return {
    titel: 'Erzeugung',
    kacheln,
    satz,
    satzTon: pv == null ? 'off' : 'ok',
    // ⚠ Die Drosselung steht NICHT hier: die Sektion „Einspeise-Begrenzung"
    // direkt unter dem Held ist ihr Ort, und derselbe Satz zweimal auf einem
    // Bildschirm ist die dokumentierte Doppelung (im Browser aufgefallen).
    hinweis: null,
    zeilen: [],
    // ⚠ Nur mit BELEGTEM Bezug: ohne gepflegte Nennleistung gäbe es keinen
    // Maßstab, und ein Balken ohne Maßstab ist eine erfundene Aussage.
    balken: pv != null && kwp != null && kwp > 0
      ? { pct: Math.max(0, Math.min(100, (pv / kwp) * 100)), label: 'Auslastung' }
      : null,
    werte: { ...KEINE_WERTE, pvKw: pv, kwp },
  };
}

/** Der Held der Gattung D - Bezug oder Einspeisung, und ob er maßgeblich ist. */
function heldZaehler(input: GesichtInput, eigenbau: boolean): Held {
  // ⚠ §5.8 gilt AUCH hier: ein selbst gebauter Sensor ist katalog-seitig ein
  // `meter` und damit ein Zähler - aber er misst keinen Netzanschluss, sondern
  // SEINE Kanäle. Sie sind sein Gesicht; „Netz —" wäre dort keine Auskunft.
  const eigene = eigenbau ? eigenbauKacheln(input) : [];
  if (eigene.length > 0) {
    return {
      titel: 'Jetzt',
      kacheln: eigene,
      satz: null,
      satzTon: 'ok',
      hinweis: null,
      // „nur gelesen" steht als Abzeichen im Kopf - nie zweimal.
      zeilen: [],
      balken: null,
      werte: KEINE_WERTE,
    };
  }
  // ⚠ Die GEMESSENE Netz-Komponente dieses Zählers - nur ihre Zahl, nie eine
  // geliehene: ein Unterzähler trägt keine `grid`-Rolle mit `primary`.
  const grid = num(input.src?.powerKw)
    ?? num(input.komponenten.find((c) => c.role === 'grid' && c.reading)?.reading?.value ?? null);
  const massgeblich = input.komponenten.some((c) => c.role === 'grid' && c.primary);
  const richtung = grid == null ? null : grid < 0 ? 'Einspeisung' : grid > 0 ? 'Bezug' : null;
  // K2 (behobener Widerspruch): „Ihre Anlage bezieht …" ist eine Aussage über
  // den NETZANSCHLUSS und steht deshalb nur am maßgeblichen Zähler. Ein
  // Unterzähler misst einen Abzweig - er sagt nur, was er misst.
  const satz = grid == null
    ? 'Dieser Zähler meldet gerade keinen Wert.'
    : !massgeblich
      ? `Misst gerade ${fmtNum(Math.abs(grid), 'kW')}.`
      : richtung == null
        ? 'Ihre Anlage ist gerade ausgeglichen — es fließt weder Bezug noch Einspeisung.'
        : richtung === 'Bezug'
          ? `Ihre Anlage bezieht gerade ${fmtNum(Math.abs(grid), 'kW')}.`
          : `Ihre Anlage speist gerade ${fmtNum(Math.abs(grid), 'kW')} ein.`;
  const kachel = netzKachel(grid, true);
  return {
    titel: massgeblich ? 'Bezug & Einspeisung' : 'Messung',
    // Am Unterzähler heißt die Zahl nicht „Netz" - sie misst einen Abzweig.
    kacheln: [massgeblich ? kachel : { ...kachel, label: 'Leistung' }],
    satz,
    satzTon: grid == null ? 'off' : 'ok',
    // „maßgeblich für die Bilanz" und „nur Messung" trägt der Kopf als
    // Abzeichen - die Bühne sagt nur, was KEIN Abzeichen sagt.
    hinweis: massgeblich ? null : 'Die maßgebliche Messung Ihrer Bilanz liefert ein anderes Gerät.',
    // §5.6 „Braucht NICHT: Freigabe, Sofortaktionen, Speicher-Kacheln" - an
    // einen Zähler geht kein Befehl, also gibt es auch nichts freizugeben.
    zeilen: [],
    balken: null,
    werte: { ...KEINE_WERTE, netzKw: grid, massgeblich },
  };
}

/**
 * Der Held der Gattung E (§5.4 Wallbox · §5.7 schaltbarer Verbraucher) - läuft
 * es, mit wie viel, und warum?
 *
 * ⚠ Die D3-BESTÄTIGUNGSSTUFE steht als WORT an der Kachel: ein Shelly ohne
 * Leistungsmessung meldet nur sein Relais, die Energie ist dort ANGENOMMEN
 * (Nennleistung × Zeit). Sie zu verschweigen ließe eine geschätzte Zahl wie
 * eine gemessene aussehen.
 */
function heldVerbraucher(input: GesichtInput, eigenbau: boolean): Held {
  const eigen = input.komponenten.find((c) => c.role === 'consumer');
  // ⚠ Eine FREIGABE misst nichts - eine Leistung, die daneben gemeldet wird,
  // gehört dem Relais, nicht der Wärmepumpe, und darf hier nie als „läuft mit
  // X kW" auftreten.
  const nachweis: NachweisArt | null = input.nachweis
    ?? (input.gemessen == null ? null : input.gemessen ? 'gemessen' : 'angenommen');
  const freigabe = nachweis === 'freigabe';
  const leistung = freigabe
    ? null
    : num(input.src?.loadKw) ?? num(eigen?.reading?.value ?? null);
  const gemessen = freigabe ? false : input.gemessen ?? null;
  // Ohne Leistungsmessung ist der Zustand das RELAIS, nicht eine Leistung:
  // `relay_on` kommt als 0/1 über den Kanal (die Kanäle sind 0/1-Zahlen).
  const relais = eigen ? kanalWert(input.topologie, eigen.entityId, 'relay_on') : null;
  const laeuft = leistung != null
    ? leistung > LAEUFT_AB_KW
    : relais != null ? relais.wert > 0 : input.ioAusgangAn ?? null;
  const regeln = input.regeln ?? [];
  const satz = laeuft == null
    ? (freigabe
      ? 'Dieses Gerät meldet gerade keine Freigabe.'
      : 'Dieses Gerät meldet gerade keinen Wert.')
    : freigabe
      ? (laeuft
        ? 'Die Freigabe ist gesetzt — ob die Wärmepumpe anläuft, entscheidet sie selbst.'
        : 'Die Freigabe ist aufgehoben — die Wärmepumpe läuft im Normalbetrieb.')
      : laeuft
        ? (leistung != null ? `Läuft gerade mit ${fmtNum(leistung, 'kW')}.` : 'Läuft gerade.')
        : 'Läuft gerade nicht.';
  // ⚠ Der GRUND wird nur genannt, wo eine Regel dieses Gerät wirklich anfasst -
  // „warum" ohne Beleg wäre eine Behauptung über eine Automatik, die es
  // vielleicht gar nicht gibt. Der Wohnort der Regel bleibt die Steuerung (D2).
  const hinweis = regeln.length === 0
    ? null
    : regeln.length === 1
      ? `Geschaltet von der Regel „${regeln[0]}".`
      : `Geschaltet von den Regeln „${regeln.join('", „')}".`;
  const kachel: HeldKachel = freigabe
    ? {
      // Die Frage lautet hier NICHT „wie viel", sondern „ist freigegeben".
      key: 'freigabe',
      label: 'Freigabe',
      wert: laeuft == null ? NO_DATA : laeuft ? 'Gesetzt' : 'Aufgehoben',
      wort: 'SG-Ready · Anlaufempfehlung',
      ton: laeuft == null ? 'off' : laeuft ? 'ok' : null,
      gross: true,
    }
    : leistung != null || gemessen !== false
    ? {
      key: 'leistung',
      label: 'Leistung',
      wert: kw(leistung),
      wort: laeuft == null ? null : laeuft ? 'läuft' : 'aus',
      ton: laeuft == null ? 'off' : laeuft ? 'ok' : null,
      gross: true,
    }
    : {
      // Ohne Messung gibt es keine Leistung zu zeigen - nur den Zustand.
      key: 'relais',
      label: 'Zustand',
      wert: laeuft == null ? NO_DATA : laeuft ? 'Ein' : 'Aus',
      wort: 'ohne Leistungsmessung',
      ton: laeuft == null ? 'off' : laeuft ? 'ok' : null,
      gross: true,
    };
  const zeilen: string[] = [];
  if (freigabe) {
    // ⚠ Kein „Energie: …"-Satz: über den Verbrauch der Wärmepumpe wissen wir
    // NICHTS, und eine Stufe zu nennen hieße, eine Zahl anzudeuten.
    zeilen.push(NACHWEIS_FREIGABE);
  } else if (gemessen != null) {
    zeilen.push(gemessen
      ? 'Energie: gemessen'
      : 'Energie: angenommen (Nennleistung × Zeit)');
  }
  // ⚠ Die Erfüllungs-Zeile ist WÖRTLICH die geteilte `fulfilmentSummary`-
  // Kopfzeile (§5.4/§5.7) - eine eigene Formulierung wäre ein zweites Urteil
  // über dieselben Aufgaben.
  const erfuellung = (input.erfuellung ?? '').trim();
  if (erfuellung) zeilen.push(erfuellung);
  return {
    titel: 'Zustand',
    // ⚠ §5.8: ein SELBST gebauter Schalter misst zusätzlich, was der Kunde bei
    // ihm definiert hat. Der Schalt-Zustand führt (er ist die erste Frage),
    // seine Kanäle stehen daneben - sie werden nie verschwiegen.
    kacheln: [kachel, ...(eigenbau ? eigenbauKacheln(input) : [])],
    satz,
    satzTon: laeuft == null ? 'off' : 'ok',
    hinweis,
    zeilen,
    balken: null,
    werte: { ...KEINE_WERTE, verbraucherKw: leistung, laeuft },
  };
}

/** Der Held der Gattung F - welcher Stecker lädt, wer wartet. */
function heldLadepunkt(input: GesichtInput): Held {
  const charger = input.charger ?? null;
  const stecker: ChargeConnector[] = charger?.connectors ?? [];
  const kacheln: HeldKachel[] = stecker.map((k) => {
    const p = num(k.powerKw);
    const zugeteilt = num(k.allocatedKw);
    return {
      key: `stecker:${k.connectorId}`,
      label: `Stecker ${k.connectorId}`,
      wert: k.charging ? kw(p) : (p != null && p > LAEUFT_AB_KW ? kw(p) : 'frei'),
      wort: k.charging
        ? (zugeteilt == null ? 'lädt' : `lädt · zugeteilt ${fmtNum(zugeteilt, 'kW')}`)
        : (k.status?.trim() ? k.status.trim() : 'bereit'),
      ton: k.charging ? 'ok' : null,
      gross: stecker.length <= 2,
    };
  });
  const ladend = stecker.filter((k) => k.charging);
  const satz = stecker.length === 0
    ? 'Diese Säule meldet noch keine Stecker.'
    : ladend.length === 0
      ? 'Gerade lädt kein Fahrzeug an dieser Säule.'
      : ladend.length === 1
        ? `Stecker ${ladend[0].connectorId} lädt gerade mit ${kw(num(ladend[0].powerKw))}.`
        : `${ladend.length} Fahrzeuge laden gerade an dieser Säule.`;
  return {
    titel: 'Stecker',
    kacheln,
    satz,
    satzTon: stecker.length === 0 ? 'off' : 'ok',
    // ⚠ Der Satz der BOX wird DURCHGEREICHT, nie neu formuliert: nur sie kennt
    // die Zahlen der Verteilung. Er wohnt am STECKER (dort entsteht er) - der
    // erste, der einen trägt, spricht für die Säule.
    hinweis: stecker.map((k) => k.reasonText?.trim()).find((t) => !!t)
      ?? (charger?.note?.trim() ? charger.note.trim() : null),
    zeilen: [],
    balken: null,
    werte: KEINE_WERTE,
  };
}

/**
 * Die SELBST definierten Kanäle als Kacheln (§5.8, Blatt Eigenbau).
 *
 * ⚠ Sie ist die einzige Kachel-Quelle, die aus der Kanal-LISTE der Komponente
 * kommt: bei einem selbst gebauten Gerät IST sie die Vorlage, es gibt keine
 * feste Rollen-Semantik dahinter. Ein Kanal ohne Wert erscheint GAR NICHT - nie
 * eine erfundene 0.
 */
function eigenbauKacheln(input: GesichtInput): HeldKachel[] {
  const out: HeldKachel[] = [];
  const gesehen = new Set<string>();
  for (const c of input.komponenten) {
    for (const m of c.channels) {
      if (gesehen.has(m.raw)) continue;
      const v = kanalWert(input.topologie, c.entityId, m.raw);
      if (!v) continue;
      gesehen.add(m.raw);
      out.push({
        key: `kanal:${m.raw}`,
        // Der Name ist der, den der Kunde beim Anlegen getippt hat - die
        // geteilte `channelLabel` fällt für einen unbekannten Kanal auf genau
        // ihn zurück, statt ihn zu verstecken oder zu erfinden.
        label: channelLabel(m.raw),
        wert: v.unit ? fmtNum(v.wert, v.unit) : String(v.wert),
        wort: null,
        gross: out.length === 0,
      });
    }
  }
  return out;
}

/** Der Held der Rückfall-Gattung: zeigen, was gemeldet wird - nichts deuten. */
/** Der Held eines I/O-Moduls: keine Leistung, nur der Weg zu seinen Zuständen. */
function heldIoModul(): Held {
  return {
    titel: 'I/O-Modul',
    kacheln: [],
    satz: null,
    satzTon: 'off',
    hinweis: IO_MODUL_HELD_SATZ,
    zeilen: [],
    balken: null,
    werte: KEINE_WERTE,
  };
}

export const IO_MODUL_HELD_SATZ =
  'Ein I/O-Modul misst keine Leistung. Seine Eingänge und Ausgänge stehen darunter; '
  + 'geschaltet wird jeder Ausgang über den Verbraucher, dem er zugeordnet ist.';

function heldGeraet(input: GesichtInput, eigenbau: boolean): Held {
  const src = input.src ?? null;
  const kacheln: HeldKachel[] = eigenbau ? eigenbauKacheln(input) : [];
  // Die Sammel-Kanäle gelten nur, wo sie auch die Kacheln tragen - neben den
  // eigenen Kanälen eines Eigenbaus wären sie eine zweite, stille Aussage.
  const sammel = kacheln.length === 0;
  let werte: BuehneWerte = KEINE_WERTE;
  if (sammel) {
    const pv = num(src?.pvKw);
    const grid = num(src?.powerKw);
    const load = num(src?.loadKw);
    werte = { ...KEINE_WERTE, pvKw: pv, netzKw: grid, hausKw: load };
    if (pv != null) {
      kacheln.push({ key: 'pv', label: 'Solarstrom', wert: kw(pv), wort: null, gross: true });
    }
    if (grid != null) kacheln.push(netzKachel(grid, pv == null));
    if (load != null) {
      kacheln.push({
        key: 'haus',
        label: 'Verbrauch',
        wert: kw(load),
        wort: null,
        gross: pv == null && grid == null,
      });
    }
  }
  // Ein SCHALTBARES Selbstbau-Gerät nennt seinen Schalter-Zustand und den
  // Sicherheitswert - beides GELESEN, nie geschlossen.
  const schalt = eigenbau ? input.komponenten.find((c) => c.schaltbar) : undefined;
  if (schalt) {
    const relais = kanalWert(input.topologie, schalt.entityId, 'relay_on');
    kacheln.push({
      key: 'schalter',
      label: 'Schalter',
      wert: relais == null ? NO_DATA : relais.wert > 0 ? 'Ein' : 'Aus',
      wort: relais == null ? null : relais.wert > 0 ? 'geschaltet' : 'aus',
      ton: relais == null ? 'off' : relais.wert > 0 ? 'ok' : null,
    });
  }
  return {
    titel: 'Jetzt',
    kacheln,
    satz: kacheln.length === 0 ? 'Dieses Gerät hat noch keine Messwerte geliefert.' : null,
    satzTon: kacheln.length === 0 ? 'off' : 'ok',
    hinweis: null,
    zeilen: schalt
      ? ['Fällt VoltPilot aus, geht dieses Gerät in seinen Sicherheitswert.']
      : [],
    balken: null,
    werte,
  };
}

/**
 * Das Gesicht dieser Seite - EIN Aufruf, EIN Ergebnis.
 *
 * Die Gattung entscheidet den Held und die Sektions-Folge; die Sektionen selbst
 * bleiben die geteilten Bauteile.
 */
export function gesicht(input: GesichtInput): Gesicht {
  // Ein I/O-Modul misst keine Energie: es trägt die Rückfall-Gattung, und sein
  // Held erklärt, wo seine Zustände stehen, statt eine Reihe leerer
  // Leistungs-Kacheln zu zeigen.
  const ioModul = KERN_EIGEN.has((input.communication ?? '').trim());
  const gattung = ioModul ? 'geraet' : gattungVon(input);
  const registerMoeglich = gattung !== 'ladepunkt'
    && !OHNE_REGISTER.has((input.communication ?? '').trim());
  // ⚠ BELEGT, nicht geraten: `freigabeFaehig` trägt genau die zwei Selbstbau-
  // Typen (`modbus-generic`/`modbus-load`) - es ist die Portal-Seite derselben
  // Menge, mit der auch der Freigabe-Assistent gattert.
  const eigenbau = input.komponenten.some((c) => c.freigabeFaehig);
  const sektionen = sektionenVon({ gattung, registerMoeglich, eigenbau });
  const held = ioModul
    ? heldIoModul()
    : gattung === 'wechselrichter-speicher'
    ? heldWechselrichter(input, true)
    : gattung === 'wechselrichter'
      ? heldWechselrichter(input, false)
      : gattung === 'pv-melder'
        ? heldPvMelder(input)
        : gattung === 'zaehler'
          ? heldZaehler(input, eigenbau)
          : gattung === 'verbraucher'
            ? heldVerbraucher(input, eigenbau)
            : gattung === 'ladepunkt'
              ? heldLadepunkt(input)
              : heldGeraet(input, eigenbau);
  // ⚠ EINE Regel für JEDE Gattung: trägt keine Kachel einen Wert, wird der
  // Grund GENANNT - eine Reihe von „—" ist keine Auskunft.
  const stumm = held.kacheln.length === 0 || held.kacheln.every((k) => k.wert === NO_DATA);
  const ehrlich: Held = stumm && !held.hinweis
    ? { ...held, hinweis: KEINE_MESSWERTE }
    : held;

  return { gattung, eigenbau, ioModul, held: ehrlich, sektionen };
}

/**
 * Der Hilfetext DIESES Blatts, oder null (§5.7).
 *
 * Heute gibt es genau einen: die Wärmepumpe ist im Katalog kein eigener Typ -
 * sie läuft als `generic-load`/`pump` über ein Schaltrelais, und das Blatt sagt
 * das im HILFETEXT, nie im Titel.
 */
export function blattHinweis(
  g: Gesicht,
  input: Pick<GesichtInput, 'komponenten' | 'entities'>,
): string | null {
  if (g.gattung !== 'verbraucher') return null;
  const typen = input.komponenten
    .filter((c) => c.role === 'consumer')
    .map((c) => entityTypeOf(input.entities, c.entityId));
  return typen.some((t) => t === 'generic-load' || t === 'pump') ? WAERMEPUMPE_HINWEIS : null;
}

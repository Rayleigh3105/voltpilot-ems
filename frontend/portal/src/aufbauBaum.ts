/**
 * Der AUFBAU als Baum: Standort → Anlagen → VoltPilot-Boxen → Geräte.
 *
 * Konzept „Anlage – neu gedacht" (Entscheide E1–E6 = A vom 25.09.2026). Der
 * Reiter „Aufbau" ersetzt Anlagenbild UND Liste: EINE Sicht, in der jede Ebene
 * etwas trägt - der Standort seinen Ort, die Anlage ihre Live-Werte, die Box
 * ihre Verbindung, das Gerät seine Messwerte als kurze Chips. Komponenten sind
 * keine eigene Ebene mehr: sie stehen als Werte am Gerät, das sie speist
 * (vorher stand „Speicher Scheune" in der Liste siebenmal da).
 *
 * Rein + deterministisch (das `zentraleListe.ts`-Muster): die Geräte-Karten
 * kommen unverändert aus `zentraleListe`, dieses Modul ordnet sie nur in den
 * Baum und leitet die Chips ab. Kein React, kein Netz, keine Uhr.
 *
 * ⚠ **Welche Box welches Gerät liest, weiß das Portal heute nur mit EINER Box
 * sicher.** Die Geräteliste einer Anlage geht als Ganzes an die führende Box
 * (`registry.deviceId`), und der gemeldete Bestand kommt ohne Box-Kennung an.
 * Bei zwei und mehr Boxen hängen deshalb die angelegten Geräte unter der Box,
 * an die die Liste ging; Ladesäulen tragen ihre Box selbst; ein neu gemeldetes
 * Gerät, dessen Box niemand kennt, steht ehrlich unter der Anlage statt unter
 * einer geratenen Box.
 *
 * Was eine Box LIEST, weiß das Portal dagegen sicher: die Datenquellen (UEMS
 * AP-06) tragen ihre zuständige Box. Konzept „Ein Gerät, ein Eintrag" (GE-1,
 * entschieden 23.10.2026): **je Kasten ein Eintrag.** Eine Datenquelle ist der
 * WEG zu einem Gerät, kein Kasten — sie steht nicht als eigene Zeile da:
 *
 * - **1 : 1** — der Weg trägt genau ein Gerät: er ist dessen Anbindung
 *   (`AufbauGeraet.anbindungen`, zweite Textzeile), und das Gerät steht unter
 *   der Box, die den Weg liest.
 * - **1 : N** — ein Gateway: eigene Zeile, die Geräte darunter (`AufbauWeg`).
 * - **1 : 0** — angefangen, noch kein Gerät: „Anschluss ohne Gerät" (`AufbauWeg`),
 *   auch ohne zuständige Box.
 *
 * Weg und Gerät verbinden NUR gespeicherte Verweise: `geraet.data_source_id` am
 * UEMS-Gerät, das eine Komponente des Aufbau-Geräts speist (`GET …/geraete`).
 * Gleiche Adresse, gleicher Port oder gleicher Pin beweisen nichts (AGENTS.md
 * „Verträge und Identitäten") — was sich so nicht zuordnen lässt, bleibt als
 * „Anschluss ohne Gerät" sichtbar. Ein gestörter Weg macht sein Gerät gestört.
 *
 * **Einheiten hinter einer Steuerung sind Kästen** (GE-3, Regel 7, Variante d1):
 * jede Erzeugungseinheit einer Anlagensteuerung (`GET …/anlagensteuerungen`)
 * steht als eigenes Gerät direkt unter ihr (`AufbauGeraet.einheit`), mit Ist-
 * Leistung und Zustand aus den Werten der Steuerung, und zählt als Gerät. Die
 * Box liest sie nicht selbst — „über die Steuerung“; ihre Seite ist
 * `as-<Entität>~te-<n>` (`einheitSeite.ts`).
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type {
  AnlagensteuerungListe,
  AnlagensteuerungWerte,
  Device,
  EntityLocalSetup,
  OverviewSite,
  StandortAdresse,
  StandorteAmStichtag,
  UemsDatenquelle,
  UemsGeraet,
} from './api';
import { boxLast, protokollName, quellWeg, quellZeile } from './boxUebersicht';
import { technicalDeviceName } from './entityLabel';
import { siteLiveFresh } from './fleet';
import { fmtNum } from './format';
import type { GeraetTon } from './geraetSeite';
import type { ComponentRole, PlantComponent } from './komponenten';
import { anlagensteuerungGeraetId, chargerGeraetId, fuehrendeBoxOf } from './geraetAdresse';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import { gridState } from './live';
import { einheitHref, einheitStand, UEBER_DIE_STEUERUNG } from './erzeugungseinheit';
import { kwText } from './anlagensteuerung';
import { boxSeiteHash } from './nav';
import { sanitizeSoc } from './plausible';
import { boxLage, type GeraeteKarte, type KartenArt } from './zentraleListe';

/** Welche Größe ein Chip zeigt - bestimmt Symbol und Farbe, nie den Wert. */
export type AufbauWertArt = 'pv' | 'speicher' | 'netz' | 'haus' | 'verbraucher' | 'laden';

/** Ein Wert-Chip: Zahl + kurzes Richtungswort, nie ein erfundener Wert. */
export interface AufbauWert {
  art: AufbauWertArt;
  /** Sichtbar, ohne Rollenwort: „6,2 kW", „64,0 % geladen", „3,4 kW Einspeisung". */
  text: string;
  /** Vollständig für Screenreader: „PV 6,2 kW". */
  label: string;
}

/** Die Farbe der Kachel eines Knotens - die Kategorie-Verläufe des Designsystems. */
export type AufbauKategorie =
  | 'solar'
  | 'battery'
  | 'ev'
  | 'home'
  | 'grid'
  | 'navy'
  | 'fund'
  | 'warn';

/** Ein Gerät im Baum. Die Karte reist mit, weil an ihr die Handlungen hängen. */
export interface AufbauGeraet {
  id: string;
  art: Exclude<KartenArt, 'box'>;
  titel: string;
  /** Modell bzw. Art in einer Zeile: „Deye SUN-12K-SG04LP3-EU". */
  unterzeile: string;
  ton: GeraetTon;
  /** Zustand MIT Zeitbezug („liefert Daten · vor 12 Sek."). */
  zustand: string;
  /** Derselbe Zustand getrennt: das Wort („liefert Daten") … */
  zustandWort: string;
  /** … und sein Zeitbezug („vor 12 Sek."); null = keiner bekannt. */
  zustandZeit: string | null;
  /** Die Art in Kundenworten („Hybrid-Wechselrichter · Hauptgerät", „Ladesäule"). */
  artWort: string;
  /** Der Hersteller, wenn die Box ihn meldet („Deye"); null = unbekannt. */
  marke: string | null;
  /** Eine Kennung, nach der man sucht (Ladesäule: ihre OCPP-Kennung); null = keine. */
  kennung: string | null;
  werte: AufbauWert[];
  kategorie: AufbauKategorie;
  icon: IconName;
  karte: GeraeteKarte;
  /**
   * Die Wege, über die eine Box dieses Gerät liest (GE-1) — nur aus gespeicherten Verweisen, der erste nach
   * Kennzeichen zuerst; leer = keiner bekannt (Katalog-Gerät ohne Weg, oder `GET …/geraete` nicht geladen).
   */
  anbindungen: AufbauAnbindung[];
  /** Was unter dem Modell steht: „Modbus TCP · 192.168.4.165:503“, hinter einem Gateway „Geräte-ID 2“; null = nichts. */
  anbindungText: string | null;
  /** Das Gateway, hinter dem es antwortet (1 : N); null = keins. */
  gateway: { id: string; titel: string } | null;
  /**
   * Eine Erzeugungseinheit hinter einer Anlagensteuerung (GE-3): die Zeile der Steuerung (`steuerungId`), unter der
   * sie steht, und ihre TE-Nr.; null = ein gewöhnliches Gerät. Ohne eigene Komponente — ihre Werte sind die der Steuerung.
   */
  einheit: { steuerungId: string; teNr: number } | null;
}

/**
 * Die ANBINDUNG eines Geräts (Konzept „Ein Gerät, ein Eintrag", GE-1): der Weg — eine Datenquelle aus UEMS
 * AP-06 —, über den eine Box es liest. Kein eigener Kasten, sondern Teil dessen, an dem er endet.
 */
export interface AufbauAnbindung {
  quelleId: string;
  /** „DQ-1“ — klein, zum Suchen und für den Support (GD-5 A). */
  kennzeichen: string;
  /** Protokoll und Adresse: „Modbus TCP · 192.168.4.165:503“. */
  weg: string;
  /** Die Box, die den Weg heute liest; `name` null = sie hat keinen mehr. null = keine Box zuständig. */
  box: { id: string; name: string | null } | null;
  /**
   * Meldet die zuständige Box, dass über diesen Weg nichts kommt: das Wort und der Grund. null = keine Störung
   * gemeldet — auch „Box meldet noch nicht je Quelle" ist keine (`boxUebersicht.quellZeile`).
   */
  stoerung: { wort: string; grund: string | null } | null;
}

/**
 * Ein Weg mit eigener Zeile (GE-1): ein GATEWAY, hinter dem mehrere Geräte antworten (1 : N, GD-3 A — das
 * Gateway ist ein Kasten), oder ein ANSCHLUSS OHNE GERÄT (1 : 0, angefangen). Die Zuständigkeit ist am Server
 * je Datenquelle geführt (`zustaendige_box`), nie geraten.
 */
export interface AufbauWeg {
  id: string;
  kennzeichen: string;
  art: 'gateway' | 'offen';
  /** Gateway: sein Name, sonst „Gateway“; offen: „Anschluss ohne Gerät“. */
  titel: string;
  /** „Modbus TCP · 192.168.10.31:502 · Geräte-IDs 1–4 · Kennung DQ-3“. */
  weg: string;
  ton: GeraetTon;
  zustandWort: string;
  zustandZeit: string | null;
  /** Nur am Gateway: die Geräte dahinter — dieselben Objekte, die in `AufbauBox.geraete` gezählt werden. */
  geraete: AufbauGeraet[];
}

export interface AufbauBox {
  id: string;
  ref: string;
  /** Der Name der Box, sonst „VoltPilot-Box". */
  name: string;
  ton: GeraetTon;
  zustand: string;
  zustandWort: string;
  zustandZeit: string | null;
  /** Nur ab zwei Boxen: die Box, an die die Geräteliste der Anlage geht. */
  fuehrend: boolean;
  href: string;
  /** Alle Geräte unter dieser Box — auch die hinter einem Gateway (sie zählen als Geräte). */
  geraete: AufbauGeraet[];
  /** Gateways und Anschlüsse ohne Gerät unter dieser Box; leer = keine (oder unbekannt). */
  wege: AufbauWeg[];
  /** GE-4: „Last 51 %" der Wege, die diese Box liest — dieselbe Rechnung wie die Box-Seite; null = sie liest keinen. */
  last: string | null;
}

/** Wie aktuell die Live-Werte einer Anlage sind. */
export type WertStand = 'aktuell' | 'veraltet' | 'unbekannt';

export interface AufbauAnlage {
  id: string;
  name: string;
  /** Die geöffnete Anlage („Sie sind hier"). */
  aktuell: boolean;
  werte: AufbauWert[];
  wertStand: WertStand;
  boxen: AufbauBox[];
  /** Geräte, deren Box das Portal nicht sicher kennt (siehe Modulkopf). */
  ohneBox: AufbauGeraet[];
  /** Gateways und Anschlüsse ohne Gerät an einer Anlage ohne Box. */
  wegeOhneBox: AufbauWeg[];
  /** Angelegte Geräte (ohne Funde); null = für diese Anlage noch nicht geladen. */
  geraeteZahl: number | null;
}

export interface AufbauWurzel {
  art: 'standort' | 'ohne-standort';
  id: string | null;
  name: string;
  kurzzeichen: string | null;
  /** „Sonnenweg 1 · 80331 München"; null = keine Adresse hinterlegt. */
  adresse: string | null;
  /** Ein automatisch angelegter Standort bleibt Entwurf, bis die Adresse steht. */
  entwurf: boolean;
}

export interface AufbauBaum {
  /** null = der Server kennt noch keine Standorte (älteres Backend, Fehler). */
  wurzel: AufbauWurzel | null;
  anlagen: AufbauAnlage[];
  boxZahl: number;
}

export interface AufbauEingabe {
  siteId: string;
  siteName: string;
  /** `GET /api/v1/standorte`; null = nicht geladen oder nicht verfügbar. */
  standorte: StandorteAmStichtag | null;
  /** Alle Boxen des Kundenbereichs (die Liste der Schale), mit ihrer Anlage. */
  devices: Device[] | null;
  devicesFetchedAt?: number | null;
  /** Die Karten der geöffneten Anlage (`zentraleListe`); null = noch nicht geladen. */
  karten: GeraeteKarte[] | null;
  /** Der gemeldete Bestand der geöffneten Anlage (Hersteller/Modell je Gerät). */
  localSetup: EntityLocalSetup[] | null;
  charging: SiteCharging | null;
  /** Die Box, an die die Geräteliste zuletzt ging (`/entities.registry.deviceId`). */
  registryBoxId: string | null;
  /** Die Übersicht der Schale (Live-Werte je Anlage); null = nicht geladen. */
  overview: OverviewSite[] | null;
  /** Karten weiterer Anlagen am Standort, sobald sie aufgeklappt geladen sind. */
  nachbarKarten?: Record<string, GeraeteKarte[] | undefined>;
  /** Die Datenquellen der Anlagen im Baum (UEMS AP-06); null/fehlend = unbekannt, dann trägt keine Box welche. */
  datenquellen?: readonly UemsDatenquelle[] | null;
  /**
   * Die UEMS-Geräte je Anlage (`GET …/geraete`): ihr `data_source_id` ist der einzige Verweis Weg → Gerät
   * (GE-1). Fehlt eine Anlage oder ist sie null, ist die Zuordnung unbekannt — dann stehen dort weder
   * Anbindungen noch Gateways noch Anschlüsse, nie ein geratener „Anschluss ohne Gerät".
   */
  uemsGeraete?: Readonly<Record<string, readonly UemsGeraet[] | null | undefined>>;
  /**
   * Die Anlagensteuerungen je Anlage mit ihren jüngsten Werten (GE-3): ihre Erzeugungseinheiten stehen als Geräte
   * unter der Steuerung. Fehlt eine Anlage, stehen dort keine Einheiten — nie geratene.
   */
  anlagensteuerungen?: Readonly<
    Record<string, { liste: AnlagensteuerungListe | null; werte: Readonly<Record<string, AnlagensteuerungWerte>> } | undefined>
  >;
  now: number;
}

/** Der Titel eines Standorts, dem die Anlage (noch) nicht zugeordnet ist. */
export const OHNE_STANDORT = 'Noch keinem Standort zugeordnet';

const ROLLE_WERT: Record<ComponentRole, AufbauWertArt> = {
  pv: 'pv',
  storage: 'speicher',
  grid: 'netz',
  house: 'haus',
  consumer: 'verbraucher',
};

/** Das Rollenwort vor der Zahl - nur für Screenreader, sichtbar trägt es das Symbol. */
export const WERT_WORT: Record<AufbauWertArt, string> = {
  pv: 'PV',
  speicher: 'Speicher',
  netz: 'Netz',
  haus: 'Haus',
  verbraucher: 'Verbraucher',
  laden: 'Laden',
};

/** Welche Rolle die Kachel eines Geräts färbt: der Speicher vor der PV (Hybrid). */
const KACHEL_REIHENFOLGE: ComponentRole[] = ['storage', 'pv', 'grid', 'consumer', 'house'];
const KACHEL: Record<ComponentRole, { kategorie: AufbauKategorie; icon: IconName }> = {
  storage: { kategorie: 'battery', icon: 'battery' },
  pv: { kategorie: 'solar', icon: 'sun' },
  grid: { kategorie: 'grid', icon: 'activity' },
  consumer: { kategorie: 'home', icon: 'sliders' },
  house: { kategorie: 'home', icon: 'home' },
};

function wert(art: AufbauWertArt, text: string): AufbauWert {
  return { art, text, label: `${WERT_WORT[art]} ${text}` };
}

/**
 * Der Messwert EINER Komponente als kurzer Text („6,2 kW", „64 % geladen");
 * null = sie meldet keinen - fehlend ist keine Null.
 */
export function komponentenText(c: PlantComponent): string | null {
  if (!c.reading) return null;
  // Ein Ladestand steht als ganze Zahl da - wie am Anlagen-Kopf (`anlagenWerte`).
  const zahl = fmtNum(c.reading.value, c.reading.unit, c.reading.unit === '%' ? 0 : 1);
  return c.reading.caption ? `${zahl} ${c.reading.caption}` : zahl;
}

/** Die Chips eines Geräts aus seinen Komponenten - ohne Messwert kein Chip. */
export function komponentenWerte(komponenten: PlantComponent[]): AufbauWert[] {
  const out: AufbauWert[] = [];
  for (const c of komponenten) {
    const text = komponentenText(c);
    if (text != null) out.push(wert(ROLLE_WERT[c.role], text));
  }
  return out;
}

/**
 * Der Chip einer Ladesäule aus ihrem Stecker-Bericht: „lädt 1,4 kW", sonst
 * „frei", wenn jeder Stecker frei meldet. Alles andere erklärt die Geräteseite.
 */
export function ladeWert(c: ChargePoint): AufbauWert | null {
  const stecker = c.connectors ?? [];
  const laedt = stecker.filter((k) => k.charging);
  if (laedt.length > 0) {
    const kw = laedt
      .map((k) => k.powerKw)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return wert('laden', kw.length > 0 ? `lädt ${fmtNum(kw.reduce((a, b) => a + b, 0), 'kW')}` : 'lädt');
  }
  if (stecker.length > 0 && stecker.every((k) => k.status === 'Available')) {
    return wert('laden', 'frei');
  }
  return null;
}

/** Die Live-Chips einer Anlage aus der Übersicht - nur, wenn sie aktuell sind. */
export function anlagenWerte(
  site: OverviewSite | null | undefined,
  now: number,
): { werte: AufbauWert[]; stand: WertStand } {
  if (!site || !site.live) return { werte: [], stand: 'unbekannt' };
  if (!siteLiveFresh(site, new Date(now))) return { werte: [], stand: 'veraltet' };
  const { pvKw, socPct, gridKw } = site.live;
  const werte: AufbauWert[] = [];
  if (typeof pvKw === 'number' && Number.isFinite(pvKw)) {
    werte.push(wert('pv', fmtNum(Math.max(0, pvKw), 'kW')));
  }
  const soc = sanitizeSoc(socPct);
  if (soc != null) werte.push(wert('speicher', fmtNum(soc, '%', 0)));
  const netz = gridState(gridKw);
  if (netz === 'ausgeglichen') werte.push(wert('netz', 'ausgeglichen'));
  if ((netz === 'bezug' || netz === 'einspeisung') && gridKw != null) {
    werte.push(
      wert('netz', `${netz === 'bezug' ? 'Bezug' : 'Einspeisung'} ${fmtNum(Math.abs(gridKw), 'kW')}`),
    );
  }
  return { werte, stand: 'aktuell' };
}

function adresseText(a: StandortAdresse | null): string | null {
  if (!a) return null;
  const ort = [a.plz, a.ort].filter((t) => t && t.trim()).join(' ');
  const teile = [a.strasse, ort].filter((t): t is string => Boolean(t && t.trim()));
  return teile.length > 0 ? teile.join(' · ') : null;
}

/** Der Standort der Anlage und seine weiteren Anlagen. */
export function aufbauWurzel(
  standorte: StandorteAmStichtag | null,
  siteId: string,
): { wurzel: AufbauWurzel | null; nachbarn: { id: string; name: string }[] } {
  if (!standorte) return { wurzel: null, nachbarn: [] };
  const st = standorte.standorte.find((s) => s.anlagen.some((a) => a.id === siteId));
  if (st) {
    return {
      wurzel: {
        art: 'standort',
        id: st.id,
        name: st.name,
        kurzzeichen: st.kurzzeichen || null,
        adresse: adresseText(st.adresse),
        entwurf: st.zustand === 'entwurf',
      },
      nachbarn: st.anlagen.filter((a) => a.id !== siteId).map((a) => ({ id: a.id, name: a.name })),
    };
  }
  // Nicht zugeordnet: die ANDEREN nicht zugeordneten Anlagen sind kein Ort -
  // sie stehen deshalb nicht als Geschwister daneben.
  return {
    wurzel: {
      art: 'ohne-standort',
      id: null,
      name: OHNE_STANDORT,
      kurzzeichen: null,
      adresse: null,
      entwurf: false,
    },
    nachbarn: [],
  };
}

function kachelFuer(karte: GeraeteKarte): { kategorie: AufbauKategorie; icon: IconName } {
  if (karte.art === 'neu') return { kategorie: 'fund', icon: 'search' };
  if (karte.art === 'verwaist') return { kategorie: 'warn', icon: 'alert-triangle' };
  if (karte.art === 'ladepunkt') return { kategorie: 'ev', icon: 'zap' };
  for (const rolle of KACHEL_REIHENFOLGE) {
    if (karte.komponenten.some((c) => c.role === rolle)) return KACHEL[rolle];
  }
  return { kategorie: 'navy', icon: 'cpu' };
}

function unterzeileFuer(karte: GeraeteKarte, setup: EntityLocalSetup | undefined): string {
  if (karte.art === 'neu') return karte.untertitel;
  const modell = setup ? technicalDeviceName({ brand: setup.brand, model: setup.model ?? null }) : null;
  if (modell && modell !== karte.titel) return modell;
  if (karte.technischerName && karte.technischerName !== karte.titel) return karte.technischerName;
  return karte.untertitel;
}

/** Eine Karte der Liste als Baum-Gerät. */
export function aufbauGeraet(
  karte: GeraeteKarte,
  kontext: { localSetup?: EntityLocalSetup[] | null; charging?: SiteCharging | null } = {},
): AufbauGeraet {
  const setup = (kontext.localSetup ?? []).find((l) => l.id === karte.id);
  let werte = komponentenWerte(karte.komponenten);
  const saeule =
    karte.art === 'ladepunkt'
      ? (kontext.charging?.chargers ?? []).find((c) => chargerGeraetId(c.chargePointId) === karte.id)
      : undefined;
  if (karte.art === 'ladepunkt' && werte.length === 0) {
    const w = saeule ? ladeWert(saeule) : null;
    werte = w ? [w] : [];
  }
  const kachel = kachelFuer(karte);
  const markeRoh = karte.art === 'neu' ? karte.quelle?.brand : setup?.brand;
  return {
    id: karte.id,
    art: karte.art as Exclude<KartenArt, 'box'>,
    titel: karte.art === 'neu' ? neuTitel(karte) : karte.titel,
    unterzeile: unterzeileFuer(karte, setup),
    ton: karte.ton,
    zustand: karte.zustand,
    zustandWort: karte.zustandWort ?? karte.zustand,
    zustandZeit: karte.zustandZeit ?? null,
    artWort: artWortFuer(karte),
    marke: markeRoh ? technicalDeviceName({ brand: markeRoh, model: null }) : null,
    kennung: saeule?.chargePointId ?? null,
    werte,
    kategorie: kachel.kategorie,
    icon: kachel.icon,
    karte,
    anbindungen: [],
    anbindungText: null,
    gateway: null,
    einheit: null,
  };
}

/** Die Art einer Karte in Kundenworten - dieselben Wörter wie auf der Geräteseite. */
function artWortFuer(karte: GeraeteKarte): string {
  switch (karte.art) {
    case 'neu':
      return 'Von der Box gemeldet';
    case 'verwaist':
      return 'Nicht mehr verbunden';
    case 'ladepunkt':
      return 'Ladesäule';
    default:
      return karte.untertitel;
  }
}

/** „Fronius gefunden" - der Hersteller, wenn die Box ihn nennt. */
function neuTitel(karte: GeraeteKarte): string {
  const q = karte.quelle;
  const name = q ? technicalDeviceName({ brand: q.brand, model: null }) : null;
  return name ? `${name} gefunden` : 'Neues Gerät gefunden';
}

/** Die Referenz der Box, unter der die Geräteseiten einer Anlage stehen — dieselbe Regel wie `boxRefOf`. */
function boxRefDer(boxen: readonly Device[], siteId: string): string | null {
  return fuehrendeBoxOf([...boxen], siteId)?.externalRef ?? null;
}

function boxName(box: Device): string {
  const name = (box.name ?? '').trim();
  return name || 'VoltPilot-Box';
}

/**
 * Wohin ein Kasten gehört (Regeln im Modulkopf): unter die Box DIESER Anlage, die seinen Weg liest (GE-1, Regel
 * 6). Liest ihn keine von ihnen, gilt die frühere Regel — eine Box: diese; mehrere: eine Säule unter ihre eigene,
 * alles andere unter die führende, ein Fund unter keine geratene. null = ohne sichere Box.
 */
function zielBox(
  art: AufbauGeraet['art'],
  lesend: string | null,
  saeule: string | null,
  boxen: readonly Device[],
  fuehrende: string | null,
): string | null {
  const hier = (box: string | null): box is string => box != null && boxen.some((b) => b.id === box);
  if (hier(lesend)) return lesend;
  if (boxen.length === 1) return boxen[0].id;
  if (boxen.length === 0 || art === 'neu') return null;
  if (art === 'ladepunkt' && hier(saeule)) return saeule;
  return fuehrende;
}

const nachKennzeichen = (a: { kennzeichen: string }, b: { kennzeichen: string }) =>
  a.kennzeichen.localeCompare(b.kennzeichen, 'de', { numeric: true });

/** Ein gespeicherter Verweis Gerät → Weg: das UEMS-Gerät, dessen `data_source_id` auf die Datenquelle zeigt. */
interface Verweis {
  quelle: UemsDatenquelle;
  uems: UemsGeraet;
}

/** Die Säule hinter einer Ladepunkt-Zeile; null = keine (oder kein Ladepunkt). */
function saeuleVon(g: AufbauGeraet, charging: SiteCharging | null): ChargePoint | null {
  if (g.art !== 'ladepunkt') return null;
  return (charging?.chargers ?? []).find((c) => chargerGeraetId(c.chargePointId) === g.id) ?? null;
}

/**
 * Weg → Gerät NUR über gespeicherte Verweise: eine Datenquelle gehört zu einem Aufbau-Gerät, wenn ein eingebautes
 * UEMS-Gerät mit dieser `data_source_id` eine seiner Komponenten speist (bis auf Weiteres). Adresse, Port und Pin
 * kommen hier gar nicht vor — dieselbe Verbindung beweist keine Gerätegleichheit (AGENTS.md „Verträge und
 * Identitäten"). Gibt je Aufbau-Gerät seine Verweise zurück, nach Kennzeichen.
 */
function verweise(
  geraete: readonly AufbauGeraet[],
  quellen: readonly UemsDatenquelle[],
  uems: readonly UemsGeraet[],
  charging: SiteCharging | null,
  now: number,
): Map<string, Verweis[]> {
  const quelle = new Map(quellen.map((q) => [q.id, q]));
  const laeuft = (ende: string | null | undefined) => ende == null || Date.parse(ende) > now;
  const jeEntitaet = new Map<string, Verweis[]>();
  for (const u of uems) {
    const q = u.data_source_id ? quelle.get(u.data_source_id) : undefined;
    if (!q || !laeuft(u.ausgebaut_am)) continue;
    for (const k of u.komponenten ?? []) {
      if (!laeuft(k.gueltig_bis)) continue;
      jeEntitaet.set(k.entity_id, [...(jeEntitaet.get(k.entity_id) ?? []), { quelle: q, uems: u }]);
    }
  }
  const out = new Map<string, Verweis[]>();
  for (const g of geraete) {
    if (g.art !== 'geraet' && g.art !== 'ladepunkt') continue;
    const entitaeten = [...g.karte.komponenten.map((c) => c.entityId), saeuleVon(g, charging)?.entityId];
    const je = new Map<string, Verweis>();
    for (const e of entitaeten) {
      for (const v of (e && jeEntitaet.get(e)) || []) if (!je.has(v.quelle.id)) je.set(v.quelle.id, v);
    }
    if (je.size > 0) out.set(g.id, [...je.values()].sort((a, b) => nachKennzeichen(a.quelle, b.quelle)));
  }
  return out;
}

/** Der Name einer Box für einen Satz: aus der Boxenliste, sonst wie der Server sie nennt; null = keiner. */
function boxNameVon(boxId: string, boxen: readonly Device[], serverName: string | null): string | null {
  const d = boxen.find((b) => b.id === boxId);
  return d ? boxName(d) : serverName?.trim() || null;
}

function anbindungVon(q: UemsDatenquelle, boxen: readonly Device[]): AufbauAnbindung {
  const zust = q.zustaendige_box;
  let stoerung: AufbauAnbindung['stoerung'] = null;
  if (q.rueckmeldung?.zustand === 'liefert_nicht') {
    const z = quellZeile(q);
    stoerung = { wort: z.zustand, grund: [z.fehlerklasse, z.seit].filter(Boolean).join(' · ') || null };
  }
  return {
    quelleId: q.id,
    kennzeichen: q.kennzeichen,
    // GD-5 A: unter dem Gerätenamen nur Protokoll und Adresse — die Geräte-ID ist hier kein Kundenwort.
    weg: [protokollName(q.protokoll), q.adresse].filter(Boolean).join(' · '),
    box: zust ? { id: zust.id, name: boxNameVon(zust.id, boxen, zust.name) } : null,
    stoerung,
  };
}

/**
 * Wer liest, als Satzteil — nur, wenn es NICHT die Box ist, unter der der Eintrag steht: „gelesen von Box Halle 2".
 * Ohne zuständige Box „von keiner Box gelesen" (nur wo kein Zustand es schon sagt).
 */
function leseHinweis(box: AufbauAnbindung['box'], ziel: string | null, ohneBoxSagen: boolean): string | null {
  if (!box) return ohneBoxSagen ? 'von keiner Box gelesen' : null;
  return box.id !== ziel && box.name ? `gelesen von ${box.name}` : null;
}

/** Ein eigener Name der Datenquelle — nie das Kennzeichen noch einmal. */
function eigenerName(q: UemsDatenquelle): string | null {
  const n = q.name?.trim();
  return n && n !== q.kennzeichen ? n : null;
}

/** Der Zustand einer Weg-Zeile: was die Box zu ihm meldet; ein Anschluss ohne Gerät ist „angefangen". */
function wegZustand(q: UemsDatenquelle, art: AufbauWeg['art']): Pick<AufbauWeg, 'ton' | 'zustandWort' | 'zustandZeit'> {
  const z = quellZeile(q);
  const r = q.rueckmeldung?.zustand;
  if (r === 'liefert') return { ton: z.ton, zustandWort: z.zustand, zustandZeit: z.seit };
  if (r === 'liefert_nicht') {
    return { ton: z.ton, zustandWort: z.zustand, zustandZeit: [z.fehlerklasse, z.seit].filter(Boolean).join(' · ') || null };
  }
  const gelesen = q.zustaendige_box != null;
  if (art === 'offen') return { ton: 'off', zustandWort: 'Angefangen', zustandZeit: gelesen ? null : 'von keiner Box gelesen' };
  return gelesen
    ? { ton: z.ton, zustandWort: z.zustand, zustandZeit: null }
    : { ton: 'off', zustandWort: 'Von keiner Box gelesen', zustandZeit: null };
}

/**
 * EIN Zustand je Gerät (GE-1, Regel 5): der schlechtere aus Gerätewerten und Box-Rückmeldung zu seinem Weg, mit
 * Grund. Eine gemeldete Störung ist immer „Achtung" und gewinnt — auch gegen eigene Achtung der Werte, weil sie
 * die Ursache nennt. „Box meldet noch nicht je Quelle" ist keine Störung und ändert nichts. Die Geräteseite
 * (GE-2) setzt ihren Kopf mit derselben Regel (`wegStoerung`).
 */
export function wegStoerung(anbindungen: readonly AufbauAnbindung[]): AufbauAnbindung['stoerung'] {
  return anbindungen.find((a) => a.stoerung)?.stoerung ?? null;
}

function mitWegZustand(g: AufbauGeraet, anbindungen: readonly AufbauAnbindung[]): AufbauGeraet {
  const s = wegStoerung(anbindungen);
  if (!s) return g;
  return {
    ...g,
    ton: 'warn',
    zustand: s.grund ? `${s.wort} · ${s.grund}` : s.wort,
    zustandWort: s.wort,
    zustandZeit: s.grund,
  };
}

/** Ein Weg mit eigener Zeile unter seinem Ziel (Gateway oder Anschluss ohne Gerät). */
function wegZeile(q: UemsDatenquelle, art: AufbauWeg['art'], geraete: AufbauGeraet[], ziel: string | null, boxen: readonly Device[]): AufbauWeg {
  const name = eigenerName(q);
  const box = anbindungVon(q, boxen).box;
  return {
    id: q.id,
    kennzeichen: q.kennzeichen,
    art,
    titel: art === 'gateway' ? name ?? 'Gateway' : 'Anschluss ohne Gerät',
    weg: [art === 'offen' ? name : null, quellWeg(q), `Kennung ${q.kennzeichen}`, leseHinweis(box, ziel, false)]
      .filter(Boolean)
      .join(' · '),
    ...wegZustand(q, art),
    geraete,
  };
}

/**
 * Die Erzeugungseinheiten einer Anlagensteuerung als Geräte unter ihrer Zeile (GE-3, d1): Name oder „Wechselrichter
 * n“, Typ · Nennleistung, Ist-Leistung und Zustand je Einheit aus den Werten der Steuerung — ohne Lesung „—“ und
 * „noch keine Daten“, nie 0. Ohne Werte (noch nicht geladen) „unbekannt“, nie geraten.
 */
function einheitenUnter(
  steuerung: AufbauGeraet,
  s: NonNullable<AnlagensteuerungListe>['steuerungen'][number],
  werte: AnlagensteuerungWerte | null,
  siteId: string,
  ref: string | null,
  now: number,
): AufbauGeraet[] {
  return [...s.einheiten]
    .sort((a, b) => a.te_nr - b.te_nr)
    .map((e) => {
      const st = einheitStand(e, werte, new Date(now));
      const id = `${steuerung.id}~te-${e.te_nr}`;
      const ist = st.istW != null ? kwText(st.istW) : null;
      const zustand = st.zustandZeit ? `${st.zustandWort} · ${st.zustandZeit}` : st.zustandWort;
      return {
        id,
        art: 'geraet' as const,
        titel: st.name,
        unterzeile: st.unter,
        ton: st.ton,
        zustand,
        zustandWort: st.zustandWort,
        zustandZeit: st.zustandZeit,
        artWort: `${st.artWort} · ${UEBER_DIE_STEUERUNG}`,
        marke: null,
        kennung: e.registry_unit_id,
        werte: ist ? [{ art: 'pv' as const, text: ist, label: `Ist-Leistung ${ist}` }] : [],
        kategorie: 'solar' as const,
        icon: st.symbol,
        karte: {
          id,
          art: 'geraet' as const,
          titel: st.name,
          untertitel: st.artWort,
          zustand,
          zustandWort: st.zustandWort,
          zustandZeit: st.zustandZeit,
          ton: st.ton,
          href: einheitHref(siteId, ref, s.entity_id, e.te_nr),
          komponenten: [],
          zusatz: null,
        },
        anbindungen: [],
        anbindungText: `gelesen über ${steuerung.titel}`,
        // Hinter einem Gateway steht die Steuerung — die Einheit steht hinter der Steuerung, nicht am Gateway.
        gateway: null,
        einheit: { steuerungId: steuerung.id, teNr: e.te_nr },
      };
    });
}

function anlageKnoten(
  input: AufbauEingabe,
  id: string,
  name: string,
  aktuell: boolean,
): AufbauAnlage {
  const boxenRoh = (input.devices ?? []).filter((d) => d.siteId === id);
  const mehrere = boxenRoh.length > 1;
  const registryBoxId = aktuell ? input.registryBoxId : null;
  // „führend“ an der offenen Anlage: die Box, an die ihre Geräteliste geht. An den übrigen Anlagen des Standorts
  // das Server-Fakt `fuehrtAnlage` (dieselbe Regel wie `fuehrendeBoxOf`, nie die Reihenfolge) — es markiert nur,
  // Geräte verteilt es nicht.
  const fuehrendeId = registryBoxId ?? (aktuell ? null : fuehrendeBoxOf(boxenRoh, id)?.id ?? null);
  // Die führende Box steht oben; sonst bleibt die Reihenfolge der Liste.
  const boxenSortiert = [...boxenRoh].sort(
    (a, b) => Number(b.id === fuehrendeId) - Number(a.id === fuehrendeId),
  );
  const fuehrende = boxenSortiert.some((b) => b.id === registryBoxId) ? registryBoxId : null;
  const charging = aktuell ? input.charging : null;
  const alleBoxen = input.devices ?? [];
  const karten = aktuell ? input.karten : input.nachbarKarten?.[id] ?? null;
  const kontext = aktuell ? { localSetup: input.localSetup, charging: input.charging } : {};
  const roh = (karten ?? [])
    .filter((k) => k.art !== 'box')
    .map((k) => aufbauGeraet(k, kontext));

  // Die Wege dieser Anlage — nur, wenn Geräte UND Verweise bekannt sind: sonst wäre jeder Weg ein geratener
  // „Anschluss ohne Gerät".
  const uems = input.uemsGeraete?.[id];
  const quellen =
    karten != null && uems != null
      ? (input.datenquellen ?? []).filter((q) => q.anlage === id && q.archiviert_am == null).sort(nachKennzeichen)
      : [];
  const zuGeraet = verweise(roh, quellen, uems ?? [], charging, input.now);
  const hinter = new Map<string, AufbauGeraet[]>(quellen.map((q) => [q.id, []]));
  for (const g of roh) for (const v of zuGeraet.get(g.id) ?? []) hinter.get(v.quelle.id)?.push(g);
  // 1 : N — ein Gerät steht hinter höchstens EINEM Gateway, dem ersten nach Kennzeichen.
  const gatewayVon = new Map<string, UemsDatenquelle>();
  for (const q of quellen) {
    const dahinter = hinter.get(q.id) ?? [];
    if (dahinter.length > 1) for (const g of dahinter) if (!gatewayVon.has(g.id)) gatewayVon.set(g.id, q);
  }
  const wegZiel = (q: UemsDatenquelle) =>
    zielBox('geraet', q.zustaendige_box?.id ?? null, null, boxenSortiert, fuehrende);

  const platziert = roh.map((g0): { g: AufbauGeraet; ziel: string | null } => {
    const vs = zuGeraet.get(g0.id) ?? [];
    const saeule = saeuleVon(g0, charging)?.deviceId ?? null;
    if (vs.length === 0) return { g: g0, ziel: zielBox(g0.art, null, saeule, boxenSortiert, fuehrende) };
    const anbindungen = vs.map((v) => anbindungVon(v.quelle, alleBoxen));
    const gw = gatewayVon.get(g0.id);
    const ziel = gw ? wegZiel(gw) : zielBox(g0.art, anbindungen[0].box?.id ?? null, saeule, boxenSortiert, fuehrende);
    // Das Modell vom UEMS-Gerät, wo die Box keins meldet („WAGO PFC200" statt der Art noch einmal).
    const modell = vs
      .map((v) => technicalDeviceName({ brand: v.uems.hersteller ?? null, model: v.uems.typ ?? null }))
      .find((m): m is string => Boolean(m));
    const unterzeile = g0.unterzeile === g0.karte.untertitel && modell ? modell : g0.unterzeile;
    let anbindungText: string | null;
    if (gw) {
      const nr = vs.find((v) => v.quelle.id === gw.id)?.uems.geraete_id;
      anbindungText = nr != null ? `Geräte-ID ${nr}` : null;
    } else {
      const weitere = vs.length - 1;
      anbindungText = [
        anbindungen[0].weg,
        leseHinweis(anbindungen[0].box, ziel, true),
        weitere > 0 ? `+${weitere} ${weitere === 1 ? 'weitere Anbindung' : 'weitere Anbindungen'}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    const g = mitWegZustand(
      {
        ...g0,
        unterzeile,
        artWort: gw ? `${g0.artWort} · über das Gateway` : g0.artWort,
        anbindungen,
        anbindungText,
        gateway: gw ? { id: gw.id, titel: eigenerName(gw) ?? 'Gateway' } : null,
      },
      anbindungen,
    );
    return { g, ziel };
  });
  // GE-3: die Einheiten jeder Anlagensteuerung direkt hinter ihrer Zeile, am selben Ort (Box bzw. Gateway).
  const steuerungen = input.anlagensteuerungen?.[id];
  const ref = boxRefDer(boxenRoh, id);
  for (let i = platziert.length - 1; i >= 0; i -= 1) {
    const { g, ziel } = platziert[i];
    const s = (steuerungen?.liste?.steuerungen ?? []).find((x) => anlagensteuerungGeraetId(x.entity_id) === g.id);
    if (!s || s.einheiten.length === 0) continue;
    const einheiten = einheitenUnter(g, s, steuerungen?.werte[s.geraet_id] ?? null, id, ref, input.now);
    platziert.splice(i + 1, 0, ...einheiten.map((e) => ({ g: e, ziel })));
  }
  const geraete = platziert.map((x) => x.g);

  const jeBox = new Map<string, AufbauGeraet[]>(boxenSortiert.map((b) => [b.id, []]));
  const ohneBox: AufbauGeraet[] = [];
  for (const { g, ziel } of platziert) {
    if (ziel != null && jeBox.has(ziel)) jeBox.get(ziel)!.push(g);
    else ohneBox.push(g);
  }
  const wegeJeBox = new Map<string, AufbauWeg[]>(boxenSortiert.map((b) => [b.id, []]));
  const wegeOhneBox: AufbauWeg[] = [];
  for (const q of quellen) {
    const kinder = geraete.filter((g) => g.gateway?.id === q.id);
    // 1 : 1 steht am Gerät; ein Weg, dessen Geräte alle schon hinter einem anderen Gateway stehen, auch.
    const art: AufbauWeg['art'] | null = kinder.length > 0 ? 'gateway' : (hinter.get(q.id) ?? []).length === 0 ? 'offen' : null;
    if (!art) continue;
    const ziel = wegZiel(q);
    const weg = wegZeile(q, art, kinder, ziel, alleBoxen);
    if (ziel != null && wegeJeBox.has(ziel)) wegeJeBox.get(ziel)!.push(weg);
    else wegeOhneBox.push(weg);
  }

  const site = (input.overview ?? []).find((s) => s.id === id);
  const live = anlagenWerte(site, input.now);
  return {
    id,
    name,
    aktuell,
    werte: live.werte,
    wertStand: live.stand,
    boxen: boxenSortiert.map((b) => {
      const lage = boxLage(b, input.devicesFetchedAt, input.now);
      return {
        id: b.id,
        ref: b.externalRef,
        name: boxName(b),
        ton: lage.ton,
        zustand: lage.zustand,
        zustandWort: lage.zustandWort,
        zustandZeit: lage.zustandZeit,
        fuehrend: mehrere && b.id === fuehrendeId,
        href: boxSeiteHash(id, b.externalRef),
        geraete: jeBox.get(b.id) ?? [],
        wege: wegeJeBox.get(b.id) ?? [],
        last: boxLast(b.id, input.datenquellen).kurz,
      };
    }),
    ohneBox,
    wegeOhneBox,
    geraeteZahl:
      karten == null
        ? null
        : geraete.filter((g) => g.art === 'geraet' || g.art === 'ladepunkt').length,
  };
}

/** Der ganze Baum: die geöffnete Anlage zuerst, dann ihre Nachbarn am Standort. */
export function aufbauBaum(input: AufbauEingabe): AufbauBaum {
  const { wurzel, nachbarn } = aufbauWurzel(input.standorte, input.siteId);
  const anlagen = [
    anlageKnoten(input, input.siteId, input.siteName, true),
    ...nachbarn.map((n) => anlageKnoten(input, n.id, n.name, false)),
  ];
  return {
    wurzel,
    anlagen,
    boxZahl: anlagen.reduce((n, a) => n + a.boxen.length, 0),
  };
}

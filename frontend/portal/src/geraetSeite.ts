/**
 * Die GERÄTE-DETAILSEITE der Anlagen-Zentrale als reine Ableitung (Konzept
 * `data/vp-anlagen-zentrale-konzept-h6` §7, Stufe 1 PR 1a).
 *
 * Der belegte Schmerz ist der ORT, nicht die Daten: ein Gerät lag über vier
 * Teilwahrheiten verstreut (Anlagen-Modell: eine Kachel ohne Klick · die
 * Plattform-Geräteseite: nur die Box · Befehle: nur je Komponente ·
 * Installateur-Ansicht: nur Admin), und die Funktionen auf GERÄTE-Ebene
 * (Register lesen/schreiben, Befehle, Software, Freigabe) hingen an der ROLLE
 * statt am Gerät. Diese Datei komponiert die Sektionen A–J aus genau den
 * Lesepfaden, die es längst gibt - **es entsteht kein Backend und keine zweite
 * Wahrheit:** die Komponenten-Zeilen kommen aus `plantModel`
 * (`komponenten.ts`), die Namen aus `entityLabel.deviceName`, die Frische aus
 * `liveness.ts`/`/sources`.
 *
 * Vier Regeln tragen die Fläche - alle sind Haus-Regeln:
 *
 * 1. **Der Seitentitel ist der TECHNISCHE Gerätename** (Marke + Modell). Der
 *    Kundenname lebt an der Komponente, nie am Gerät (w7 R6, PR 432) - ein
 *    Gerät wird nie umbenannt, nur seine Komponenten. Es entsteht damit kein
 *    viertes Namenssystem.
 * 2. **Unbekannt ist nie „nein".** Ein fehlender Block heißt „nicht gemeldet"
 *    und trägt seinen Grund; ein fehlender Wert ist `—`, nie eine 0.
 * 3. **Jede leere Sektion nennt ihren Grund** („Dieses Gerät meldet keine
 *    Verbindungsdaten"), nie ein leerer Kasten.
 * 4. **Zwei Frische-Anker, beide benannt.** Die BOX altert gegen ihre
 *    Telemetrie (`Device.lastSeenAt`, die `liveness.ts`-Bezugszeit), ein GERÄT
 *    dahinter gegen `sources.readAt`. Die Seite sagt, worauf sich „vor 12 s"
 *    bezieht - sie mischt die beiden nie.
 *
 * Rein + framework-frei (der `komponenten.ts`/`rollen.ts`-Präzedenzfall): die
 * Seite rendert nur, was hier entschieden wird.
 */
import type {
  ControlStatus,
  CurtailmentStatus,
  CurtailmentStatus as Curtailment,
  Device,
  EdgeVersion,
  EntityLocalSetup,
  EntityStrategy,
  SiteComponentRow,
  SiteComponents,
  SiteEntity,
  SiteSource,
} from './api';
import { deviceLiveStatus } from './api';
import { deviceName, technicalDeviceName } from './entityLabel';
import { fmtNum, fmtRelative } from './format';
import { WAECHTER_LABEL } from './curtailment';
import { chargerName, type SiteCharging } from './ladepunkte';
import { NO_DATA } from './nodata';
import type { ComponentHealth, PlantComponent, PlantModel } from './komponenten';
import { deviceState } from './komponenten';

/** Welche ART von Gerät die Seite zeigt. */
/**
 * Welche ART von Gerät die Seite zeigt.
 *
 * ⚠ Die BOX steht hier bewusst NICHT mehr (Geräteseiten Stufe 1, Gattung A):
 * sie ist ein TOR, kein Gerät, und lief bis dahin als vierte Art durch dieselbe
 * Sektions-Schablone - inklusive dreier Sektionen, die nur dastanden, um ihre
 * Nicht-Zuständigkeit zu erklären. Ihre Fläche ist `boxSeite.ts`.
 */
export type GeraetArt = 'hauptgeraet' | 'quelle' | 'ladepunkt';

/** Ton einer Zeile/eines Zustands - dieselben drei Töne wie überall. */
export type GeraetTon = 'ok' | 'warn' | 'off';

/** Eine Zeile einer Sektion: Beschriftung, Wert, optional ein Untersatz. */
export interface Zeile {
  label: string;
  wert: string;
  /** Der ehrliche Zusatz („so, wie Ihre Box sie gespeichert hat"). */
  detail?: string | null;
  ton?: GeraetTon | null;
  /** Monospace-Darstellung (Adressen, Kennungen). */
  mono?: boolean;
}

/** Eine Live-Kachel der Sektion B. */
export interface LiveKachel {
  /** „Solarstrom", „Ladestand", … */
  label: string;
  /** Der formatierte Wert, oder `—`. */
  wert: string;
  /** Das Wort darunter („lädt", „Einspeisung", „abgeleitet"), oder null. */
  wort: string | null;
}

/** Ein Gerät AN der Box - die Sektion B der Box-Seite. */
export interface BoxGeraet {
  /** Die Kennung im Pfad (`inverter`, `src-…`, `cp-…`). */
  geraetId: string;
  name: string;
  art: string;
  zustand: string;
  ton: GeraetTon;
}

/** Der Kopf der Seite. */
export interface GeraetKopf {
  /** Der TECHNISCHE Gerätename - nie ein Kundenalias (Regel 1). */
  titel: string;
  /** „Hybrid-Wechselrichter · Hauptgerät an Ihrer VoltPilot-Box „Pilsting"". */
  unterzeile: string;
  /** Die Kennung, wie sie auf der Box heißt (mono). */
  kennung: string;
  /** Zustands-Pill mit Zeitbezug. */
  zustand: { wort: string; ton: GeraetTon; detail: string | null };
  /** „⚡ VoltPilot steuert den Speicher"; null wenn nichts gesteuert wird. */
  steuerAbzeichen: string | null;
  /** „Einrichtung: im Portal" / „… an Ihrer Box"; null solange unbekannt. */
  pflegeOrt: string | null;
}

/** Das Ergebnis: was die Seite rendert. */
export interface GeraetSeiteView {
  /** false = die Adresse nennt kein Gerät dieser Anlage (mit Grund). */
  gefunden: boolean;
  /** Der Grund, wenn nichts gefunden wurde. */
  grund: string | null;
  art: GeraetArt;
  kopf: GeraetKopf;
  /** A · Verbindung & Gesundheit. */
  verbindung: Zeile[];
  verbindungLeer: string | null;
  /** B · Live-Werte des Geräts. */
  live: LiveKachel[];
  liveStand: string | null;
  liveLeer: string | null;
  /** C · Misst & steuert. */
  komponenten: PlantComponent[];
  komponentenLeer: string | null;
  /** G · Steuerungs-Bezüge. */
  steuerung: Zeile[];
  /** H · Software. */
  software: Zeile[];
  /** I · Diagnose (Aufklapper). */
  diagnose: Zeile[];
}

/**
 * Die Lesepfade, aus denen die Seite entsteht - **jeder EINZELN optional**,
 * weil jeder einzeln ausfallen darf. Ein fehlgeschlagener Nebenabruf macht die
 * Seite nicht unbenutzbar; er macht seine Sektion ehrlich leer.
 */
export interface GeraetSeiteInput {
  /** Die Referenz der VoltPilot-Box aus der Adresse. */
  ref: string;
  /** `inverter` · `src-…` · `cp-…`; null = die Box selbst. */
  geraetId: string | null;
  siteName: string;
  /** Die Geräteliste der Schale (`GET /devices`), auf diese Anlage gefiltert. */
  devices: Device[] | null;
  /** Bezugszeit der Geräteliste - die Box altert dagegen (`liveness.ts`). */
  devicesFetchedAt?: number | null;
  entities: SiteEntity[] | null;
  localSetup: EntityLocalSetup[] | null;
  sources: SiteSource[] | null;
  components: SiteComponents | null;
  control: ControlStatus | null;
  curtailment: CurtailmentStatus | null;
  edgeVersions: EdgeVersion[] | null;
  charging: SiteCharging | null;
  /** `GET /entity-strategies` - welche Regeln eine Komponente anfassen. */
  strategies: Record<string, EntityStrategy[]> | null;
  /** Das SCHON berechnete Anlagen-Modell (eine Wahrheit, keine zweite). */
  model: PlantModel | null;
  now?: number;
}

/** Der Satz, den eine Box ohne gemeldete LAN-Adresse trägt. */
export const LAN_UNBEKANNT = 'meldet Ihre Box noch nicht';

/**
 * Die eigene Erreichbarkeit der Box als ZEILE (Anlagen-Zentrale Stufe 2, D5).
 *
 * **⚠ Die zwei Belege dürfen nie unter einem Wort verschwinden:** `erreicht`
 * heißt, dass ein Browser die lokale Oberfläche unter dieser Adresse
 * NACHWEISLICH geöffnet hat - das ist der stärkste mögliche Nachweis und
 * zugleich genau die Adresse, die ein Mensch wieder eintippt. `schnittstelle`
 * ist nur die eigene Netzwerk-Adresse der Box; sie sagt, wo sie steckt, nicht
 * dass dort etwas antwortet.
 *
 * Ohne gemeldete Adresse bleibt es beim ehrlichen {@link LAN_UNBEKANNT} - eine
 * erfundene Adresse schickte einen Menschen auf eine Seite, die nicht antwortet.
 */
export function lanZeile(device: Device | undefined, now: number): Zeile {
  const host = (device?.lanHost ?? '').trim();
  if (!host) {
    return {
      label: 'Eigene Adresse im Netzwerk',
      wert: LAN_UNBEKANNT,
      detail: 'Der Weg zur lokalen Oberfläche steht in Ihrer Einrichtungs-Anleitung.',
      ton: 'off',
    };
  }
  const rel = alter(device?.lanSeenAt, now);
  const erreicht = device?.lanSource === 'erreicht';
  return {
    label: 'Eigene Adresse im Netzwerk',
    wert: host,
    mono: true,
    detail: erreicht
      ? `So wurde Ihre Box zuletzt erreicht${rel ? ` (${rel})` : ''} — dort erreichen Sie ihre Oberfläche.`
      : `So meldet sich Ihre Box im Netzwerk${rel ? ` (${rel})` : ''}. Ob sie darunter antwortet, sagt erst ein Aufruf.`,
    ton: erreicht ? 'ok' : null,
  };
}

/** Der Satz, der die fehlende Verbindungs-Historie ehrlich benennt. */
export const KEIN_VERBINDUNGS_VERLAUF =
  'Einen längeren Verlauf der Verbindung zeichnet VoltPilot heute nicht auf.';

/** Die k3-F4-Zeile: dieses Gerät wird nur gelesen. */
export const NUR_GELESEN = 'VoltPilot steuert dieses Gerät nicht — es wird nur gelesen.';

const HEALTH_TON: Record<ComponentHealth, GeraetTon> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  unknown: 'off',
};

/**
 * Die Art in Kundenworten - was oben unter dem Titel steht.
 *
 * Die BOX steht hier als eigener Schlüssel, obwohl sie keine {@link GeraetArt}
 * mehr ist: die Zentrale-Liste und das Schaltbild benennen sie weiterhin (die
 * Rolle des Tors ist auch dort dieselbe), ihre SEITE hat aber eine eigene
 * Gattung. Der Satz lebt deshalb einmal - `boxSeite.BOX_ROLLE` liest ihn.
 */
export const ART_WORT: Record<GeraetArt | 'box', string> = {
  box: 'Ihre Verbindung zu VoltPilot',
  hauptgeraet: 'Wechselrichter',
  quelle: 'Gerät an Ihrer Box',
  ladepunkt: 'Ladesäule',
};

/** Die Rollen-Wörter der gemeldeten Quellen (`localSetup.role`). */
export const ROLLEN_WORT: Record<string, string> = {
  'pv-generation': 'PV-Wechselrichter',
  'grid-meter': 'Zähler',
  consumer: 'Verbraucher',
};

/** Die drei Kommunikationsarten in Kundenworten. */
const COMM_WORT: Record<string, string> = {
  solarman_v5: 'Solarman-Logger (WLAN-Stick)',
  modbus_tcp: 'Modbus über das Netzwerk',
  fronius_sunspec: 'SunSpec über das Netzwerk',
  sunspec_tcp: 'SunSpec über das Netzwerk',
  kaco_http: 'App-Schnittstelle über das Netzwerk',
  kaco_modbus: 'Modbus über das Netzwerk',
  kostal_modbus: 'Modbus über das Netzwerk',
  fronius_solar_api: 'Solar-API über das Netzwerk',
  goe_http_api: 'go-e über das Netzwerk',
  shelly_http: 'Shelly über das Netzwerk',
  ocpp: 'OCPP 1.6J — die Säule wählt VoltPilot an',
  self_build: 'Modbus über das Netzwerk (selbst eingerichtet)',
};

function text(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Die Referenz der EINEN VoltPilot-Box dieser Anlage - sonst null.
 *
 * Eine Anlage hat per Captain-Korrektur genau EINE Box; sind es (noch) mehrere
 * oder keine, wird KEINE geraten: ein Weg auf eine Geräteseite, die vielleicht
 * die falsche Box meint, ist schlechter als kein Weg.
 */
export function boxRefOf(devices: Device[] | null | undefined, siteId: string): string | null {
  return boxOf(devices, siteId)?.externalRef ?? null;
}

/**
 * Dieselbe Regel, aber das ganze Gerät - für alles, was mehr braucht als die
 * Referenz (etwa die gemeldete LAN-Adresse, D5).
 *
 * ⚠ Sie lebt EINMAL: zwei Stellen, die „welche Box ist es denn?" verschieden
 * beantworten, wären zwei Wahrheiten über dieselbe Anlage.
 */
export function boxOf(devices: Device[] | null | undefined, siteId: string): Device | null {
  const eigene = (devices ?? []).filter((d) => d.siteId === siteId);
  return eigene.length === 1 ? eigene[0] : null;
}

/**
 * Hat dieses Gerät des Anlagen-Modells eine eigene Seite?
 *
 * `plantModel` bildet als LETZTE Regel ein SYNTHETISCHES Gerät (`dev:<uuid>`)
 * für Komponenten, die zwar an einer Box hängen, aber von keiner gemeldeten
 * Quelle stammen - dahinter steckt kein Eintrag im gemeldeten Bestand, die
 * Seite fände also nichts. Ein Weg ins Leere wird deshalb gar nicht erst
 * angeboten (die `applyView`-Regel des Hauses).
 */
export function geraetAdressierbar(deviceId: string): boolean {
  return !deviceId.startsWith('dev:');
}

/**
 * Die ART eines Geräts in Kundenworten - „Hybrid-Wechselrichter · Hauptgerät",
 * „PV-Wechselrichter", „Ladesäule".
 *
 * Sie lebt hier und wird von der Geräte-KARTE der Zentrale mitbenutzt: die
 * Karte und die Seite, auf die sie führt, dürfen dasselbe Gerät nie
 * verschieden benennen.
 */
export function geraeteArtWort(
  art: GeraetArt,
  rolle: string | null,
  komponenten: PlantComponent[],
): string {
  if (art === 'hauptgeraet') {
    const hatSpeicher = komponenten.some((c) => c.role === 'storage');
    return `${hatSpeicher ? 'Hybrid-Wechselrichter' : ART_WORT.hauptgeraet} · Hauptgerät`;
  }
  if (art === 'quelle') return ROLLEN_WORT[rolle ?? ''] ?? ART_WORT.quelle;
  return ART_WORT[art];
}

/** Die Kennung einer OCPP-Säule im Pfad: `cp-<ChargePointId>`. */
export function chargerGeraetId(chargePointId: string): string {
  return `cp-${chargePointId}`;
}

/** Rückrichtung: `cp-…` → die ChargePointId; null wenn es keine Säule ist. */
export function chargePointIdOf(geraetId: string | null): string | null {
  if (!geraetId || !geraetId.startsWith('cp-')) return null;
  const id = geraetId.slice(3);
  return id ? id : null;
}

/**
 * Wie alt ein Zeitpunkt ist („vor 12 Sek."); null wenn unbekannt. Bewusst die
 * EINE Haus-Formatierung {@link fmtRelative} - eine zweite Alters-Schreibweise
 * neben der des Cockpits wäre genau die Doppeldeutigkeit, gegen die die
 * Frische-Anker-Regel gebaut ist.
 */
function alter(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return fmtRelative(iso, new Date(now));
}

/** Die Uhrzeit eines Zeitpunkts („13:24:12"); null wenn unbekannt. */
function uhrzeit(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Die Zustands-Pill eines GERÄTS hinter der Box (Anker: `sources.readAt`).
 *
 * Exportiert, weil die BOX-Seite ihre Geräte-Liste damit beschriftet - zwei
 * Ableitungen desselben Zustands wären zwei Wahrheiten über dasselbe Gerät.
 */
export function quellenZustand(
  src: SiteSource | undefined,
  now: number,
): { wort: string; ton: GeraetTon; detail: string | null } {
  if (!src) {
    return { wort: 'noch keine Rückmeldung', ton: 'off', detail: null };
  }
  const rel = alter(src.readAt, now);
  if (src.health === 'ok') {
    return { wort: 'liefert Daten', ton: 'ok', detail: rel };
  }
  if (src.health === 'stale') {
    return { wort: 'meldet sich gerade nicht', ton: 'warn', detail: rel ? `zuletzt ${rel}` : null };
  }
  return { wort: 'noch keine Daten', ton: 'off', detail: null };
}

/**
 * Die Zustands-Pill der BOX (Anker: Telemetrie-`lastSeenAt`).
 *
 * Exportiert, weil die BOX-Seite (`boxSeite.ts`) sie teilt - zwei Ableitungen
 * desselben Zustands wären zwei Wahrheiten über dieselbe Box.
 */
export function boxZustand(
  device: Device | undefined,
  fetchedAt: number | null | undefined,
  now: number,
): { wort: string; ton: GeraetTon; detail: string | null } {
  if (!device) return { wort: 'nicht verbunden', ton: 'off', detail: null };
  const at = fetchedAt == null ? new Date(now) : new Date(Math.min(fetchedAt, now));
  const status = deviceLiveStatus(device, at);
  const rel = alter(device.lastSeenAt, now);
  if (status === 'online') return { wort: 'verbunden', ton: 'ok', detail: rel };
  if (status === 'stale') {
    return { wort: 'meldet sich gerade nicht', ton: 'warn', detail: rel ? `zuletzt ${rel}` : null };
  }
  return { wort: 'wartet auf die ersten Daten', ton: 'off', detail: null };
}

/** Die gespeicherte Verbindung einer Komponente dieses Geräts, sonst null. */
function componentRowOf(
  components: SiteComponents | null,
  entityIds: Set<string>,
  edgeSourceId: string | null,
): SiteComponentRow | null {
  const rows = components?.components ?? [];
  if (edgeSourceId) {
    const byPin = rows.find((r) => r.edgeSourceId === edgeSourceId);
    if (byPin) return byPin;
  }
  return rows.find((r) => entityIds.has(r.id)) ?? null;
}

/** „192.168.254.210 : 8899" aus dem gespeicherten Verbindungs-Block. */
function adresse(connection: Record<string, unknown> | null | undefined): string | null {
  if (!connection) return null;
  const transport = (connection.transport as Record<string, unknown> | undefined) ?? connection;
  const host = str(transport.host) ?? str(transport.ip);
  if (!host) return null;
  const port = num(transport.port);
  return port == null ? host : `${host} : ${port}`;
}

/** Der Zusatz hinter der Adresse: Logger-Nummer bzw. Modbus-Adresse. */
function adressZusatz(connection: Record<string, unknown> | null | undefined): string | null {
  if (!connection) return null;
  const transport = (connection.transport as Record<string, unknown> | undefined) ?? connection;
  const serial = str(transport.serial);
  if (serial) return `Logger-Nr. ${serial}`;
  const unit = num(transport.unit_id) ?? num(transport.mb_slave_id);
  return unit == null ? null : `Modbus-Adresse ${unit}`;
}

/** Der Lesetakt aus dem gespeicherten Verbindungs-Block. */
function lesetakt(connection: Record<string, unknown> | null | undefined): string | null {
  const transport =
    ((connection?.transport as Record<string, unknown> | undefined) ?? connection) ?? null;
  const s = num(connection?.interval_s) ?? num(transport?.interval_s);
  return s == null ? null : `alle ${s} s`;
}

/**
 * WIE dieses Gerät erreicht wird - aus dem gespeicherten SOLL, sonst aus dem
 * gemeldeten IST (Anlagen-Zentrale Stufe 2, PR 2b).
 *
 * Bis zu dieser Stufe kannte die Seite nur das Soll (`/components`), das es auf
 * einer BOX-verwalteten Bestandsanlage gar nicht gibt: dort stand darum immer
 * „Dieses Gerät meldet keine Verbindungsdaten", obwohl die Box ihre Adresse
 * längst in jedem Herzschlag meldet. Sie reist jetzt additiv auf
 * `/entities.localSetup` mit - **derselbe Lesepfad, aus dem auch das
 * Struktur-Schaltbild seine Kanten beschriftet**, damit die beiden dieselbe
 * Adresse nie verschieden nennen können.
 *
 * Das Soll führt, wo es vorliegt: auf einer portal-verwalteten Anlage ist es
 * das, was gepflegt wurde, und die Seite soll die gepflegte Wahrheit zeigen.
 * Fehlt es, wird das Gemeldete genommen - und fehlt beides, wird nichts
 * behauptet (die Regel „unbekannt ist nie nein").
 */
function verbindungsWeg(
  row: SiteComponentRow | null,
  setup: EntityLocalSetup | undefined,
): { anbindung: string | null; adresse: string | null; zusatz: string | null; takt: string | null } {
  const sollAdresse = adresse(row?.connection);
  if (row?.communication || sollAdresse) {
    return {
      anbindung: COMM_WORT[row?.communication ?? ''] ?? null,
      adresse: sollAdresse,
      zusatz: adressZusatz(row?.connection),
      takt: lesetakt(row?.connection),
    };
  }
  const host = str(setup?.host);
  const port = num(setup?.port);
  const serial = str(setup?.serial);
  const unit = num(setup?.unitId);
  const takt = num(setup?.intervalS);
  return {
    anbindung: COMM_WORT[setup?.communication ?? ''] ?? null,
    adresse: host == null ? null : port == null ? host : `${host} : ${port}`,
    zusatz: serial
      ? `Logger-Nr. ${serial}`
      : unit == null
        ? null
        : `Modbus-Adresse ${unit}`,
    takt: takt == null ? null : `alle ${takt} s`,
  };
}

/** Die Zeile „Einrichtung" - WO gepflegt wird (Einheitsmodell Stufe 1/2). */
function pflegeOrtWort(authority: string | null | undefined): string | null {
  if (authority === 'portal') return 'Einrichtung: im Portal';
  if (authority === 'box') return 'Einrichtung: an Ihrer Box';
  return null;
}

/**
 * Die Geräteseite - EIN Aufruf, EIN Ergebnis. Alles Fehlende wird BENANNT,
 * nie weggelassen und nie erfunden.
 */
export function geraetSeite(input: GeraetSeiteInput): GeraetSeiteView {
  const now = input.now ?? Date.now();
  const devices = input.devices ?? [];
  const box = devices.find((d) => d.externalRef === input.ref);
  const localSetup = input.localSetup ?? [];
  const sources = input.sources ?? [];
  const chargers = input.charging?.chargers ?? [];
  const model = input.model;

  const leer = (grund: string, art: GeraetArt = 'quelle'): GeraetSeiteView => ({
    gefunden: false,
    grund,
    art,
    kopf: {
      titel: 'Unbekanntes Gerät',
      unterzeile: '',
      kennung: input.geraetId ?? input.ref,
      zustand: { wort: 'unbekannt', ton: 'off', detail: null },
      steuerAbzeichen: null,
      pflegeOrt: null,
    },
    verbindung: [],
    verbindungLeer: null,
    live: [],
    liveStand: null,
    liveLeer: null,
    komponenten: [],
    komponentenLeer: null,
    steuerung: [],
    software: [],
    diagnose: [],
  });

  // ------------------------------------------------------------------
  // Identität: WELCHES Gerät nennt die Adresse?
  // ------------------------------------------------------------------
  const chargePointId = chargePointIdOf(input.geraetId);
  const charger = chargePointId
    ? chargers.find((c) => c.chargePointId === chargePointId)
    : undefined;
  const setup = input.geraetId ? localSetup.find((l) => l.id === input.geraetId) : undefined;

  // ⚠ Ohne Gerät hinter der Box ist diese Fläche nicht zuständig: die BOX hat
  // seit Geräteseiten Stufe 1 ihre EIGENE Gattung und Adresse (`boxSeite.ts`,
  // `#/anlage/{id}/box`). Die Adresse leitet dorthin um, dieser Zweig ist also
  // die defensive Antwort - und er nennt den Weg, statt ins Leere zu zeigen.
  if (input.geraetId == null) {
    return leer(
      'Diese Adresse nennt kein Gerät an Ihrer Box. Ihre Box selbst hat eine eigene Seite.',
    );
  }
  if (!setup && !charger) {
    return leer(
      'Dieses Gerät meldet sich an Ihrer Box gerade nicht. Sobald es wieder Daten liefert, erscheint hier seine Seite.',
    );
  }

  const art: GeraetArt = charger
    ? 'ladepunkt'
    : setup?.kind === 'inverter'
      ? 'hauptgeraet'
      : 'quelle';

  // ------------------------------------------------------------------
  // Die Komponenten DIESES Geräts - aus `plantModel`, nie neu abgeleitet.
  // ------------------------------------------------------------------
  // ⚠ EINE SÄULE HAT GENAU IHRE EIGENE KOMPONENTE - nie die des Geräts, an
  // dessen Box sie hängt. Die Ladepunkt-Komponente wird an der BOX komponiert,
  // also trägt deren Modell-Gerät auch Speicher/Netz/Haus; über den Umweg „ein
  // Gerät, das irgendeine Komponente dieser Entität hält" landete die Säule
  // damit bei der ganzen Grundausstattung des Wechselrichters (im Browser
  // aufgefallen: „Misst & steuert: Speicher · Solarmodule · Hausverbrauch").
  const komponenten: PlantComponent[] = charger
    ? (charger.entityId
        ? (model?.components.filter((c) => c.entityId === charger.entityId) ?? [])
        : [])
    : (input.geraetId
        ? (model?.devices.find((d) => d.id === input.geraetId)?.componentIds
            .map((cid) => model?.components.find((c) => c.id === cid))
            .filter((c): c is PlantComponent => c != null) ?? [])
        : []);
  const entityIds = new Set(komponenten.map((c) => c.entityId));
  const componentRow = componentRowOf(input.components, entityIds, input.geraetId);

  // Der gemeldete Ist-Zustand dieses Geräts (`/sources`).
  const src = input.geraetId
    ? sources.find((s) => s.sourceId === input.geraetId)
    : undefined;

  // ------------------------------------------------------------------
  // Kopf
  // ------------------------------------------------------------------
  const boxLabel = box ? deviceName({ storedLabel: box.name }) || box.externalRef : input.ref;
  const technicalTitle = charger
    ? chargerName(charger)
    : (technicalDeviceName({
        edgeLabel: setup?.label ?? null,
        brand: setup?.brand ?? null,
        model: setup?.model ?? null,
      }) ?? 'Gerät');
  const titel = charger ? technicalTitle : (componentRow?.label?.trim() || technicalTitle);

  const artWort = geraeteArtWort(art, setup?.role ?? null, komponenten);
  const unterzeile = `${titel !== technicalTitle ? `${technicalTitle} · ` : ''}${artWort} an Ihrer VoltPilot-Box ${boxLabel}`;

  const zustand = charger
    ? {
        wort: charger.connected ? 'verbunden' : 'getrennt',
        ton: (charger.connected ? 'ok' : 'warn') as GeraetTon,
        detail: alter(charger.lastSeen, now),
      }
    : quellenZustand(src, now);

  const gesteuert = komponenten.filter((c) => c.control);
  const steuerAbzeichen =
    gesteuert.length === 0
      ? null
      : gesteuert.length === 1 && gesteuert[0].role === 'storage'
        ? 'VoltPilot steuert den Speicher'
        : `VoltPilot steuert ${gesteuert.map((c) => c.label).join(', ')}`;

  const kopf: GeraetKopf = {
    titel,
    unterzeile,
    // ⚠ Ein Ladepunkt nennt seine OCPP-Kennung, nicht unser `cp-`-Präfix: die
    // steht am Gerät und im Anbinden-Dialog, das Präfix ist ein reiner
    // Adress-Schlüssel dieser Seite.
    kennung: charger ? charger.chargePointId : input.geraetId,
    zustand,
    steuerAbzeichen,
    // Die Pflege-Herkunft beschreibt die KOMPONENTEN-Konfiguration; ein
    // Ladepunkt hat keine, also behauptet die Seite dort auch keine.
    pflegeOrt:
      art === 'ladepunkt' ? null : pflegeOrtWort(input.components?.componentAuthority),
  };

  // ------------------------------------------------------------------
  // A · Verbindung & Gesundheit
  // ------------------------------------------------------------------
  const verbindung: Zeile[] = [];
  let verbindungLeer: string | null = null;

  if (charger) {
    verbindung.push({
      label: 'Anbindung',
      wert: COMM_WORT.ocpp,
      detail: 'Die Säule baut die Verbindung auf; VoltPilot verteilt nur die Leistung.',
    });
    verbindung.push({ label: 'Kennung', wert: charger.chargePointId, mono: true });
    verbindung.push({
      label: 'Letzte Meldung',
      wert: uhrzeit(charger.lastSeen) ?? NO_DATA,
      detail: alter(charger.lastSeen, now),
      ton: zustand.ton,
    });
    verbindung.push({
      label: 'Zustand',
      wert: zustand.wort,
      detail: KEIN_VERBINDUNGS_VERLAUF,
      ton: zustand.ton,
    });
  } else {
    const weg = verbindungsWeg(componentRow, setup);
    if (weg.anbindung || weg.adresse) {
      if (weg.anbindung) verbindung.push({ label: 'Anbindung', wert: weg.anbindung });
      if (weg.adresse) {
        verbindung.push({
          label: 'Adresse',
          wert: weg.adresse,
          detail: weg.zusatz,
          mono: true,
        });
      }
      if (weg.takt) verbindung.push({ label: 'Lesetakt', wert: weg.takt });
    } else {
      verbindungLeer =
        'Dieses Gerät meldet keine Verbindungsdaten — dafür braucht Ihre Box einen neueren Stand.';
    }
    verbindung.push({
      label: 'Letzte Messung',
      wert: uhrzeit(src?.readAt) ?? NO_DATA,
      detail: zustand.detail,
      ton: zustand.ton,
    });
    verbindung.push({
      label: 'Zustand',
      wert: zustand.wort,
      detail: KEIN_VERBINDUNGS_VERLAUF,
      ton: zustand.ton,
    });
    const stand = fassungsSatz(input.components, componentRow);
    if (stand) verbindung.push({ label: 'Einrichtung', wert: stand });
  }

  // ------------------------------------------------------------------
  // B · Live-Werte des Geräts
  // ------------------------------------------------------------------
  const live: LiveKachel[] = [];
  let liveLeer: string | null = null;

  if (charger) {
    for (const k of charger.connectors ?? []) {
      const p = num(k.powerKw);
      live.push({
        label: `Stecker ${k.connectorId}`,
        wert: p == null ? NO_DATA : fmtNum(p, 'kW'),
        wort: k.charging ? 'lädt' : (text(k.status) ?? 'bereit'),
      });
    }
    if (live.length === 0) liveLeer = 'Diese Säule meldet noch keine Stecker.';
  } else {
    const pv = num(src?.pvKw);
    const grid = num(src?.powerKw);
    const load = num(src?.loadKw);
    if (pv != null) live.push({ label: 'Solarstrom', wert: fmtNum(pv, 'kW'), wort: null });
    for (const c of komponenten) {
      if (c.role === 'storage' && c.reading) {
        live.push({
          label: 'Ladestand',
          wert: fmtNum(c.reading.value, c.reading.unit),
          wort: c.reading.caption,
        });
      }
    }
    if (grid != null) {
      live.push({
        label: 'Netz',
        wert: fmtNum(Math.abs(grid), 'kW'),
        wort: grid < 0 ? 'Einspeisung' : grid > 0 ? 'Bezug' : 'ausgeglichen',
      });
    }
    if (load != null) live.push({ label: 'Haus', wert: fmtNum(load, 'kW'), wort: 'abgeleitet' });
    if (live.length === 0) {
      liveLeer = 'Dieses Gerät hat noch keine Messwerte geliefert.';
    }
  }
  const liveStand = uhrzeit(charger ? charger.reportedAt : src?.readAt) ?? null;

  // ------------------------------------------------------------------
  // C · Misst & steuert
  // ------------------------------------------------------------------
  const komponentenLeer =
    komponenten.length === 0
      ? 'Dieses Gerät misst noch nichts — übernehmen Sie es im Anlagen-Modell als Komponente.'
      : null;

  // ------------------------------------------------------------------
  // G · Steuerungs-Bezüge
  // ------------------------------------------------------------------
  const steuerung: Zeile[] = [];
  {
    if (gesteuert.length === 0) {
      steuerung.push({ label: 'Steuerung', wert: NUR_GELESEN, ton: 'off' });
    } else {
      steuerung.push({
        label: 'VoltPilot steuert',
        wert: gesteuert.map((c) => c.label).join(', '),
        detail: 'nach dem Fahrplan Ihrer Anlage',
        ton: 'ok',
      });
      const freigabe = freigabeSatz(input.control, box?.id ?? null);
      if (freigabe) steuerung.push({ label: 'Freigabe', wert: freigabe.wert, detail: freigabe.detail });
      if (input.control && input.control.deviceId === box?.id) {
        steuerung.push({
          label: 'Not-Aus an der Box',
          wert: input.control.controlEnabled ? 'aus — Steuerung läuft' : 'an — VoltPilot steuert nicht',
          ton: input.control.controlEnabled ? 'ok' : 'warn',
        });
      }
    }
    const regeln = regelNamen(input.strategies, entityIds);
    if (regeln.length > 0) {
      steuerung.push({ label: 'Regeln, die dieses Gerät nutzen', wert: regeln.join(', ') });
    }
    const waechter = waechterSatz(input.curtailment, komponenten);
    if (waechter) steuerung.push({ label: WAECHTER_LABEL, wert: waechter });
  }

  // ------------------------------------------------------------------
  // H · Software
  // ------------------------------------------------------------------
  const software: Zeile[] = [];
  const edge = input.edgeVersions?.find((v) => v.deviceId === box?.id);
  if (charger) {
    software.push({
      label: 'Firmware der Säule',
      wert: text(charger.firmware) ?? 'meldet keine Firmware',
      ton: charger.firmware ? 'ok' : 'off',
    });
    const hersteller = [text(charger.vendor), text(charger.model)].filter(Boolean).join(' ');
    if (hersteller) software.push({ label: 'Hersteller', wert: hersteller });
  } else {
    software.push({
      label: 'Firmware des Geräts',
      wert: 'liest Ihre Box nicht aus',
      detail: 'Über die Messverbindung meldet dieses Gerät seinen Software-Stand nicht.',
      ton: 'off',
    });
    software.push({
      label: 'Software Ihrer Box',
      wert: text(edge?.coreVersion) ?? 'meldet keinen Stand',
      mono: edge?.coreVersion != null,
    });
  }

  // ------------------------------------------------------------------
  // I · Diagnose
  // ------------------------------------------------------------------
  const diagnose: Zeile[] = [];
  const kanaele = Array.from(
    new Set(komponenten.flatMap((c) => c.channels.map((m) => m.raw))),
  );
  if (kanaele.length > 0) {
    diagnose.push({ label: 'Rohkanäle', wert: kanaele.join(' · '), mono: true });
  }
  diagnose.push({ label: 'Kennung auf der Box', wert: input.geraetId, mono: true });
  if (!charger) {
    const row = componentRowOf(input.components, entityIds, input.geraetId);
    const familie = text(row?.family);
    if (familie) diagnose.push({ label: 'Familie', wert: familie, mono: true });
    const sync = text(row?.syncStatus);
    if (sync) {
      diagnose.push({
        label: 'Einrichtung Soll/Ist',
        wert: sync,
        detail: text(input.components?.appliedRevision)
          ? `angewandte Fassung ${input.components?.appliedRevision}`
          : null,
        mono: true,
      });
    }
  }

  return {
    gefunden: true,
    grund: null,
    art,
    kopf,
    verbindung,
    verbindungLeer,
    live,
    liveStand,
    liveLeer,
    komponenten,
    komponentenLeer,
    steuerung,
    software,
    diagnose,
  };
}

/** „wird im Portal gepflegt (Fassung 3)" - null, solange nichts bekannt ist. */
function fassungsSatz(
  components: SiteComponents | null,
  row: SiteComponentRow | null,
): string | null {
  const ort = pflegeOrtWort(components?.componentAuthority);
  if (!ort) return null;
  const wo = components?.componentAuthority === 'portal' ? 'wird im Portal gepflegt' : 'wird an Ihrer Box gepflegt';
  const fassung = row?.definitionVersion;
  return fassung && fassung > 0 ? `${wo} (Fassung ${fassung})` : wo;
}

/**
 * Der Freigabe-Satz aus dem Steuerungs-Beleg - **nur wenn der Beleg diesem
 * Gerät gehört** (die `eigenerBeleg`-Regel: eine Anlage kann mehrere Geräte
 * haben, der Beleg kommt von genau einem).
 */
function freigabeSatz(
  control: ControlStatus | null,
  boxDeviceId: string | null,
): { wert: string; detail: string | null } | null {
  if (!control || !boxDeviceId || control.deviceId !== boxDeviceId) return null;
  if (control.certified) {
    return {
      wert: 'freigegeben',
      detail: control.allMatch ? 'das Gerät bestätigt die Sollwerte' : null,
    };
  }
  return {
    wert: 'noch nicht freigegeben',
    detail: 'VoltPilot prüft dieses Modell zuerst am Prüfstand.',
  };
}

/** Die Namen der Regeln, die eine der Komponenten dieses Geräts anfassen. */
function regelNamen(
  strategies: Record<string, EntityStrategy[]> | null,
  entityIds: Set<string>,
): string[] {
  if (!strategies) return [];
  const out = new Set<string>();
  for (const id of entityIds) {
    for (const s of strategies[id] ?? []) {
      if (s.flowName?.trim()) out.add(s.flowName.trim());
    }
  }
  return Array.from(out);
}

/** Was der Einspeise-Wächter über dieses Gerät sagt; null wenn nichts bekannt. */
function waechterSatz(
  curtailment: Curtailment | null,
  komponenten: PlantComponent[],
): string | null {
  const guard = curtailment?.exportGuard;
  if (!guard) return null;
  // Nur dort nennen, wo eine ERZEUGENDE Komponente hängt - an einem Zähler
  // wäre der Satz eine Aussage über ein fremdes Gerät.
  if (!komponenten.some((c) => c.role === 'pv')) return null;
  const grenze = fmtNum(guard.limitKw, 'kW');
  if (!guard.effective) {
    return `${grenze} am Netzanschluss — ${guard.reach ?? 'die Begrenzung erreicht gerade kein Gerät'}`;
  }
  return guard.limiting
    ? `begrenzt gerade auf ${grenze} am Netzanschluss`
    : `überwacht ${grenze} am Netzanschluss`;
}

/** Der Zustands-Ton einer Komponenten-Gesundheit (für die Fläche). */
export function komponentenTon(health: ComponentHealth): GeraetTon {
  return HEALTH_TON[health];
}

/** Das Zustandswort eines Geräts - dieselbe Ableitung wie im Anlagen-Modell. */
export { deviceState };

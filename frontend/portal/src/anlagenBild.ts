/**
 * Das elektrische Anlagenbild der Anlagen-Zentrale (Geräte-Erlebnis Slice 1,
 * vereinfacht Captain-Auftrag 27.08.2026).
 *
 * Es ist bewusst eine REINE Projektion des schon geladenen Lesesatzes:
 * `zentraleListe` liefert die Geräte samt Komponenten und Zuständen, hier
 * werden daraus elektrische Orte und deterministische Koordinaten. Es gibt
 * keine gespeicherten Pixelpositionen und kein zweites Backend-Modell.
 *
 * Ehrlichkeit ist Teil des Typs: ein fehlender Livewert erzeugt keine Kachel,
 * ein alter Wert behält den Zustands-/Zeittext seiner Gerätekarte und jeder
 * Zustand trägt ein Wort zusätzlich zu seiner Farbe.
 *
 * ⚠ **Der Einstieg ist ein NAVIGATIONS-Bild, keine Auswahl-Fläche.** Ein echtes
 * Gerät IST ein Link auf seine Detailseite; die früheren inline „hinzufügen"-
 * Plätze und die Detail-Seitenleiste sind ersatzlos entfallen (der EINE
 * „Gerät hinzufügen"-Knopf bleibt der Anlege-Weg). Deshalb trägt dieser Typ
 * keine Slots mehr — nur Knoten und die Datenverbindungs-Karte der Box.
 */
import type { ComponentRole } from './komponenten';
import type { AdoptableSource } from './rollen';
import type { GeraeteKarte } from './zentraleListe';
import type { Device, EdgeVersion } from './api';
import { fmtNum } from './format';
import { lanZeile, LAN_UNBEKANNT } from './geraetSeite';
import { versionLabel } from './edgeVersionLabel';
import { isPrivateHost } from './selbstbau';
import type { IconName } from '../designsystem/components/core/Icon';

export type AnlagenZone = 'pv' | 'storage' | 'house' | 'grid' | 'consumer';
export type AnlagenZustand =
  | 'online'
  | 'gestoert'
  | 'ungesteuert'
  | 'nicht-verbunden'
  | 'zuzuordnen';

export const ANLAGEN_ZONE: Record<
  AnlagenZone,
  { label: string; kurz: string; icon: IconName }
> = {
  pv: { label: 'PV', kurz: 'Erzeugung', icon: 'sun' },
  storage: { label: 'Speicher', kurz: 'Speicher', icon: 'battery' },
  house: { label: 'Hausverteilung', kurz: 'Haus', icon: 'home' },
  grid: { label: 'Netz', kurz: 'Netzübergang', icon: 'activity' },
  consumer: { label: 'Verbraucher', kurz: 'Verbraucher', icon: 'zap' },
};

export interface AnlagenWert {
  label: string;
  wert: string;
  /** Der elektrische Ort des Werts; die Karten-Kopfzahl folgt ihrem Knoten. */
  zone: AnlagenZone;
  /** Derselbe Frischeanker wie am Gerät; null = die Quelle nennt keinen. */
  stand: string | null;
}

export interface AnlagenKnoten {
  id: string;
  karteId: string;
  titel: string;
  untertitel: string;
  zone: AnlagenZone;
  /** Alle tatsächlich gemeldeten elektrischen Rollen dieses Geräts. */
  rollen: AnlagenZone[];
  /**
   * Die WEITEREN elektrischen Rollen neben der Spalte, in der der Knoten steht
   * — die sichtbare Zuordnung eines Hybriden zu seinem Speicher (ohne die
   * abgeleitete Hausverteilung, die kein eigenes Gerät ist).
   */
  nebenrollen: AnlagenZone[];
  zustand: AnlagenZustand;
  zustandLabel: string;
  zustandDetail: string | null;
  /** Die Geräte-Detailseite; ein echtes Gerät IST ein Link darauf. */
  href: string | null;
  werte: AnlagenWert[];
  /** Ein belegter Satz der vorhandenen Karte, nie eine geratene Adresse. */
  verbindung: string | null;
  /** Nur ein schon gemeldetes, noch nicht übernommenes Gerät trägt die Aktion. */
  quelle: AdoptableSource | null;
}

/** Die private/lokale Adresse der Box im Kundennetz — NIE eine WAN-Adresse. */
export interface DatenServiceLan {
  wert: string;
  detail: string;
  mono: boolean;
  /** false = die Box meldet (noch) keine Adresse; NIE „nicht erreichbar". */
  bekannt: boolean;
}

/** Der installierte VoltPilot-Edge-Softwarestand. */
export interface DatenServiceVersion {
  wert: string;
  /** false = die Box hat noch keinen Stand gemeldet. */
  bekannt: boolean;
}

export interface DatenService {
  titel: string;
  zustand: string;
  ton: 'ok' | 'warn' | 'off';
  /** Die Box-Detailseite; null = keine (dann ist die Karte kein Link). */
  href: string | null;
  lan: DatenServiceLan;
  version: DatenServiceVersion;
}

export interface AnlagenBild {
  knoten: AnlagenKnoten[];
  service: DatenService | null;
}

const ROLE_ZONE: Record<ComponentRole, AnlagenZone> = {
  pv: 'pv',
  storage: 'storage',
  grid: 'grid',
  house: 'house',
  consumer: 'consumer',
};

/**
 * ⚠ **Ein Hybrid wohnt am PV-Zweig, nicht am Speicherzweig** (Captain-Auftrag
 * 27.08.2026): ein Wechselrichter mit PV UND Speicher wird EINMAL unter PV
 * dargestellt, seine Speicher-Rolle als {@link AnlagenKnoten.nebenrollen}
 * sichtbar daneben — das physische Gerät erscheint NIE zusätzlich als zweiter
 * Knoten im Speicher. `pv` steht deshalb vor `storage` im Rang. Die
 * Hausverteilung ist der abgeleitete Bus und rangiert zuletzt.
 */
const ZONEN_RANG: AnlagenZone[] = ['pv', 'storage', 'grid', 'consumer', 'house'];

function gemeldeteZone(role: string | null | undefined): AnlagenZone | null {
  switch (role) {
    case 'pv':
    case 'pv-generation':
      return 'pv';
    case 'storage':
      return 'storage';
    case 'grid':
    case 'grid-meter':
      return 'grid';
    case 'consumer':
      return 'consumer';
    default:
      return null;
  }
}

/** Die elektrischen Rollen einer Karte, geordnet nach {@link ZONEN_RANG}. */
function rollenFuer(karte: GeraeteKarte): AnlagenZone[] {
  const rollen = new Set(karte.komponenten.map((c) => ROLE_ZONE[c.role]));
  if (karte.art === 'ladepunkt') rollen.add('consumer');
  const quelle = karte.art === 'neu' ? gemeldeteZone(karte.quelle?.role) : null;
  if (quelle) rollen.add(quelle);
  return ZONEN_RANG.filter((zone) => rollen.has(zone));
}

function zustandFuer(karte: GeraeteKarte): AnlagenZustand {
  const wort = karte.zustand.toLocaleLowerCase('de-DE');
  if (karte.art === 'neu') return 'zuzuordnen';
  if (
    karte.art === 'verwaist' ||
    karte.ton === 'off' ||
    wort.includes('getrennt') ||
    wort.includes('nicht verbunden') ||
    wort.includes('wartet auf')
  ) {
    return 'nicht-verbunden';
  }
  if (karte.ton === 'warn') return 'gestoert';
  const kannSteuern = karte.komponenten.some((c) => c.control);
  const wirdGesteuert = karte.komponenten.some((c) => c.schaltbar);
  return kannSteuern && !wirdGesteuert ? 'ungesteuert' : 'online';
}

const ZUSTAND_LABEL: Record<AnlagenZustand, string> = {
  online: 'Online',
  gestoert: 'Gestört',
  ungesteuert: 'Ungesteuert',
  'nicht-verbunden': 'Nicht verbunden',
  zuzuordnen: 'Zuordnung ausstehend',
};

function standAus(zustand: string): string | null {
  const teile = zustand
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  if (teile.length < 2) return null;
  return teile.slice(1).join(' · ');
}

function werteFuer(karte: GeraeteKarte, hauptzone: AnlagenZone): AnlagenWert[] {
  const stand = standAus(karte.zustand);
  const gesehen = new Set<string>();
  const out: AnlagenWert[] = [];
  // Die sichtbare Kopfzahl beantwortet dieselbe Frage wie die Spalte. Beim
  // Hybrid steht deshalb die PV-Produktion vor SoC/Batterieleistung. Fehlt der
  // PV-Wert, bleibt die Kopfzahl leer; ein Speicherwert wird nicht als
  // vermeintliche PV-Produktion nach oben gezogen.
  const komponenten = [...karte.komponenten].sort((a, b) => {
    const aHaupt = ROLE_ZONE[a.role] === hauptzone ? 0 : 1;
    const bHaupt = ROLE_ZONE[b.role] === hauptzone ? 0 : 1;
    return aHaupt - bHaupt;
  });
  for (const c of komponenten) {
    if (!c.reading) continue;
    const zone = ROLE_ZONE[c.role];
    const key = `${zone}:${c.label}:${c.reading.unit}`;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    out.push({
      label: c.label,
      wert: fmtNum(c.reading.value, c.reading.unit),
      zone,
      stand,
    });
    if (out.length === 3) break;
  }
  return out;
}

function knotenFuer(karte: GeraeteKarte): AnlagenKnoten {
  const zustand = zustandFuer(karte);
  const rollen = rollenFuer(karte);
  const zone = rollen[0] ?? 'house';
  // Die WEITEREN Rollen zeigen einem Hybriden seine Speicher-/Netz-Funktion an
  // — die Hausverteilung ist kein eigenes Gerät und bleibt aus den Chips.
  const nebenrollen = rollen.filter((r) => r !== zone && r !== 'house');
  return {
    id: `knoten:${karte.id}`,
    karteId: karte.id,
    titel: karte.titel,
    untertitel: karte.untertitel,
    zone,
    rollen,
    nebenrollen,
    zustand,
    zustandLabel: ZUSTAND_LABEL[zustand],
    zustandDetail: karte.zustand || null,
    href: karte.href,
    werte: werteFuer(karte, zone),
    verbindung: karte.zusatz,
    quelle: karte.quelle ?? null,
  };
}

/**
 * Die Datenverbindungs-Karte der Box: sie IST ein Link auf die Box-Seite und
 * zeigt ihre lokale Netz-Adresse (nie eine WAN-Adresse) samt dem installierten
 * Software-Stand. Beides wird ehrlich behandelt — eine Box, die (noch) nichts
 * meldet, bekommt einen ruhigen Platzhalter statt einer erfundenen Angabe.
 */
export interface AnlagenBildOptions {
  /** Die EINE VoltPilot-Box dieser Anlage (für ihre gemeldete LAN-Adresse). */
  boxDevice?: Device | null;
  /** Der Software-Stand dieser Box aus `GET /edge-versions`. */
  edge?: EdgeVersion | null;
  /** Bezugszeit für den Frischeanker der LAN-Adresse. */
  now?: number;
}

/**
 * Ein `lanHost` ist ein Anzeige-Beleg, aber kein Freibrief: der Host-Kopf kann
 * auch über einen öffentlichen Reverse-Proxy entstanden sein. Die Box-Karte
 * zeigt deshalb nur eine nach dem bestehenden, vertragsgeteilten LAN-Prüfer
 * belegbar private/lokale Adresse. Port und Klammern bleiben für die Anzeige
 * unverändert; Pfade, Userinfo und ungültige Ports sind keine Host-Adresse.
 */
function privateLanAddress(raw: string | null | undefined): string | null {
  const address = (raw ?? '').trim();
  if (!address || address.length > 255 || /[\s/@?#]/.test(address)) return null;

  let host = address;
  const bracketed = /^\[([^\]]+)](?::(\d{1,5}))?$/.exec(address);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2] && !gueltigerPort(bracketed[2])) return null;
  } else {
    const colonCount = (address.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const withPort = /^(.+):(\d{1,5})$/.exec(address);
      if (!withPort || !gueltigerPort(withPort[2])) return null;
      host = withPort[1];
    }
    // Mehrere Doppelpunkte ohne Klammern sind ein reines IPv6-Literal. Ein
    // Port daran wäre nicht eindeutig und wird vom privaten Prüfer abgelehnt.
  }
  // Der geteilte Selbstbau-Prüfer erlaubt Loopback mit Absicht für lokale
  // Modbus-Ziele. Auf der Box-Karte wäre das jedoch keine Adresse IM
  // KUNDENNETZ, sondern nur die Box selbst — deshalb gilt hier die engere
  // Anzeige-Regel.
  if (istLoopbackHost(host)) return null;
  return isPrivateHost(host) ? address : null;
}

/** Port 0 ist kein erreichbarer Kunden-Endpunkt; erlaubt ist exakt 1..65535. */
function gueltigerPort(raw: string): boolean {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Loopback nach Host-FAMILIE statt nur nach Schreibweise erkennen. Der
 * geteilte Selbstbau-Prüfer akzeptiert `127/8` absichtlich für lokale Modbus-
 * Ziele und faltet `::ffff:127.x.y.z` auf IPv4 zurück; auf der Kundenkarte
 * müssen BEIDE Darstellungen draußen bleiben.
 */
function istLoopbackHost(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  const ipv4 = mapped?.[1] ?? normalized;
  return ipv4.startsWith('127.');
}

function boxLan(device: Device | null, now: number): DatenServiceLan {
  const privateAddress = privateLanAddress(device?.lanHost);
  const safeDevice = device
    ? { ...device, lanHost: privateAddress, lanSeenAt: privateAddress ? device.lanSeenAt : null }
    : undefined;
  const zeile = lanZeile(safeDevice, now);
  return {
    wert: zeile.wert,
    detail: zeile.detail ?? '',
    mono: !!zeile.mono,
    bekannt: zeile.wert !== LAN_UNBEKANNT,
  };
}

function boxVersion(edge: EdgeVersion | null): DatenServiceVersion {
  const stand = (edge?.coreVersion ?? '').trim();
  if (!stand) return { wert: 'meldet keinen Stand', bekannt: false };
  const soll = (edge?.newestRelease ?? '').trim();
  return { wert: versionLabel(stand, soll ? [{ version: soll }] : []), bekannt: true };
}

function datenService(box: GeraeteKarte, opts: AnlagenBildOptions): DatenService {
  const now = opts.now ?? Date.now();
  return {
    titel: box.titel,
    zustand: box.zustand,
    ton: box.ton,
    href: box.href,
    lan: boxLan(opts.boxDevice ?? null, now),
    version: boxVersion(opts.edge ?? null),
  };
}

/** Alles, was das Anlagenbild braucht, aus der synchronen Geräte-Zweitsicht. */
export function anlagenBild(
  karten: GeraeteKarte[],
  opts: AnlagenBildOptions = {},
): AnlagenBild {
  const box = karten.find((k) => k.art === 'box') ?? null;
  const knoten = karten.filter((k) => k.art !== 'box').map(knotenFuer);
  return {
    knoten,
    service: box ? datenService(box, opts) : null,
  };
}

// ---------------------------------------------------------------------------
// Deterministische Desktop-Geometrie
// ---------------------------------------------------------------------------

export const ANLAGEN_BILD_BREITE = 1040;
export const ANLAGEN_KNOTEN_BREITE = 204;
export const ANLAGEN_KNOTEN_HOEHE = 84;
const ANLAGEN_ROLLEN_ZEILE_HOEHE = 22;
const ABSTAND = 14;
const OBEN = 62;
export const ANLAGEN_SPALTEN_X: Record<AnlagenZone, number> = {
  pv: 26,
  storage: 280,
  house: 534,
  grid: 810,
  consumer: 810,
};

export interface AnlagenLayoutItem {
  id: string;
  zone: AnlagenZone;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnlagenLinie {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  art: 'bus' | 'zweig';
}

export interface AnlagenBildLayout {
  breite: number;
  hoehe: number;
  busY: number;
  serviceY: number;
  items: AnlagenLayoutItem[];
  linien: AnlagenLinie[];
}

function zonenKnoten(bild: AnlagenBild, zone: AnlagenZone): AnlagenKnoten[] {
  return bild.knoten.filter((k) => k.zone === zone);
}

function knotenHoehe(knoten: AnlagenKnoten): number {
  if (knoten.nebenrollen.length === 0) return ANLAGEN_KNOTEN_HOEHE;
  // Zwei Rollen passen in die 204-px-Karte auf eine Zeile; eine dritte bekommt
  // deterministisch eine weitere. So kann der sichtbare Hybrid-Hinweis den
  // nächsten Knoten nie überdecken.
  return ANLAGEN_KNOTEN_HOEHE +
    Math.ceil(knoten.nebenrollen.length / 2) * ANLAGEN_ROLLEN_ZEILE_HOEHE;
}

function stapelHoehe(knoten: AnlagenKnoten[]): number {
  if (knoten.length === 0) return 0;
  return knoten.reduce((summe, item) => summe + knotenHoehe(item), 0) +
    (knoten.length - 1) * ABSTAND;
}

/**
 * Feste Spalten, stabile Reihenfolge, wachsende Höhe. Weder Browserbreite noch
 * Messwerte verändern die Position; nur der belegte Bestand verlängert einen
 * Zweig. Damit bleibt die mentale Karte zwischen zwei Abrufen stabil.
 */
export function layoutAnlagenBild(bild: AnlagenBild): AnlagenBildLayout {
  const obenZonen: AnlagenZone[] = ['pv', 'storage', 'grid'];
  const obenGruppen = Object.fromEntries(
    obenZonen.map((z) => [z, zonenKnoten(bild, z)]),
  ) as Record<AnlagenZone, AnlagenKnoten[]>;
  const maxOben = Math.max(...obenZonen.map((z) => stapelHoehe(obenGruppen[z])), 0);
  const busY = Math.max(320, OBEN + maxOben + 64);
  const untenStart = busY + 84;
  const haus = zonenKnoten(bild, 'house');
  const verbraucher = zonenKnoten(bild, 'consumer');
  const untenHoehe = Math.max(stapelHoehe(haus), stapelHoehe(verbraucher), 80);
  const serviceY = untenStart + untenHoehe + 64;
  const items: AnlagenLayoutItem[] = [];

  const setze = (gruppe: AnlagenKnoten[], zone: AnlagenZone, startY: number) => {
    let y = startY;
    for (const knoten of gruppe) {
      const h = knotenHoehe(knoten);
      items.push({
        id: knoten.id,
        zone,
        x: ANLAGEN_SPALTEN_X[zone],
        y,
        w: ANLAGEN_KNOTEN_BREITE,
        h,
      });
      y += h + ABSTAND;
    }
  };

  for (const zone of obenZonen) setze(obenGruppen[zone], zone, OBEN);
  setze(haus, 'house', untenStart);
  setze(verbraucher, 'consumer', untenStart);

  const mitteX = (zone: AnlagenZone) =>
    ANLAGEN_SPALTEN_X[zone] + ANLAGEN_KNOTEN_BREITE / 2;
  const linien: AnlagenLinie[] = [
    { id: 'bus', x1: mitteX('pv'), y1: busY, x2: mitteX('grid'), y2: busY, art: 'bus' },
  ];
  for (const zone of obenZonen) {
    const gruppe = items.filter((i) => i.zone === zone);
    if (gruppe.length === 0) continue;
    linien.push({
      id: `zweig-${zone}`,
      x1: mitteX(zone),
      y1: gruppe[0].y + gruppe[0].h / 2,
      x2: mitteX(zone),
      y2: busY,
      art: 'zweig',
    });
  }
  for (const zone of ['house', 'consumer'] as const) {
    const gruppe = items.filter((i) => i.zone === zone);
    if (gruppe.length === 0) continue;
    const letztes = gruppe[gruppe.length - 1];
    linien.push({
      id: `zweig-${zone}`,
      x1: mitteX(zone),
      y1: busY,
      x2: mitteX(zone),
      y2: letztes.y + letztes.h / 2,
      art: 'zweig',
    });
  }

  return {
    breite: ANLAGEN_BILD_BREITE,
    hoehe: serviceY + 76,
    busY,
    serviceY,
    items,
    linien,
  };
}

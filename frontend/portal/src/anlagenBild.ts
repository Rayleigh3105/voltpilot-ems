/**
 * Das elektrische Anlagenbild der Anlagen-Zentrale (Geräte-Erlebnis Slice 1).
 *
 * Es ist bewusst eine REINE Projektion des schon geladenen Lesesatzes:
 * `zentraleListe` liefert die Geräte samt Komponenten und Zuständen, hier
 * werden daraus elektrische Orte, optionale Plätze und deterministische
 * Koordinaten. Es gibt keine gespeicherten Pixelpositionen und kein zweites
 * Backend-Modell.
 *
 * Ehrlichkeit ist Teil des Typs: ein fehlender Livewert erzeugt keine Kachel,
 * ein alter Wert behält den Zustands-/Zeittext seiner Gerätekarte und jeder
 * Zustand trägt ein Wort zusätzlich zu seiner Farbe.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { TypId } from './anlegenFlow';
import type { ComponentRole } from './komponenten';
import type { KomponentenRolle } from './komponentenAssistent';
import type { AdoptableSource } from './rollen';
import type { GeraeteKarte } from './zentraleListe';
import { fmtNum } from './format';

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
  zustand: AnlagenZustand;
  zustandLabel: string;
  zustandDetail: string | null;
  href: string | null;
  werte: AnlagenWert[];
  /** Ein belegter Satz der vorhandenen Karte, nie eine geratene Adresse. */
  verbindung: string | null;
  /** Nur ein schon gemeldetes, noch nicht übernommenes Gerät trägt die Aktion. */
  quelle: AdoptableSource | null;
}

export interface AnlagenSlot {
  id: string;
  zone: AnlagenZone;
  label: string;
  typ: TypId;
  /** Elektrische Absicht für die vorhandene Anlege-API; null = Typ-Ableitung. */
  initialRolle: KomponentenRolle | null;
  icon: IconName;
}

export interface DatenService {
  titel: string;
  zustand: string;
  ton: 'ok' | 'warn' | 'off';
}

export interface AnlagenBild {
  knoten: AnlagenKnoten[];
  slots: AnlagenSlot[];
  service: DatenService | null;
}

const ROLE_ZONE: Record<ComponentRole, AnlagenZone> = {
  pv: 'pv',
  storage: 'storage',
  grid: 'grid',
  house: 'house',
  consumer: 'consumer',
};

/** Ein Hybrid wohnt einmal am Speicherzweig, nicht zusätzlich in PV und Haus. */
const ZONEN_RANG: AnlagenZone[] = ['storage', 'pv', 'grid', 'consumer', 'house'];

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

function zoneFuer(karte: GeraeteKarte): AnlagenZone {
  if (karte.art === 'ladepunkt') return 'consumer';
  const rollen = new Set(karte.komponenten.map((c) => ROLE_ZONE[c.role]));
  const quelle = karte.art === 'neu' ? gemeldeteZone(karte.quelle?.role) : null;
  if (quelle) rollen.add(quelle);
  return ZONEN_RANG.find((zone) => rollen.has(zone)) ?? 'house';
}

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

function werteFuer(karte: GeraeteKarte): AnlagenWert[] {
  const stand = standAus(karte.zustand);
  const gesehen = new Set<string>();
  const out: AnlagenWert[] = [];
  for (const c of karte.komponenten) {
    if (!c.reading) continue;
    const key = `${c.label}:${c.reading.unit}`;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    out.push({
      label: c.label,
      wert: fmtNum(c.reading.value, c.reading.unit),
      stand,
    });
    if (out.length === 3) break;
  }
  return out;
}

function knotenFuer(karte: GeraeteKarte): AnlagenKnoten {
  const zustand = zustandFuer(karte);
  return {
    id: `knoten:${karte.id}`,
    karteId: karte.id,
    titel: karte.titel,
    untertitel: karte.untertitel,
    zone: zoneFuer(karte),
    rollen: rollenFuer(karte),
    zustand,
    zustandLabel: ZUSTAND_LABEL[zustand],
    zustandDetail: karte.zustand || null,
    href: karte.href,
    werte: werteFuer(karte),
    verbindung: karte.zusatz,
    quelle: karte.quelle ?? null,
  };
}

/**
 * Die sichtbaren freien Plätze. Nur der maßgebliche Netz-Zähler ist
 * kardinalitätsbegrenzt: sobald ein Netzgerät belegt ist, wird kein zweiter
 * Standardplatz angeboten. Alle übrigen Plätze sind ausdrücklich optional.
 */
function slotsFuer(knoten: AnlagenKnoten[]): AnlagenSlot[] {
  const slots: AnlagenSlot[] = [
    {
      id: 'slot-pv',
      zone: 'pv',
      label: 'PV-Wechselrichter hinzufügen',
      typ: 'wechselrichter',
      initialRolle: null,
      icon: 'sun',
    },
    {
      id: 'slot-storage',
      zone: 'storage',
      label: 'Speicher hinzufügen',
      typ: 'wechselrichter',
      initialRolle: 'inverter',
      icon: 'battery',
    },
    {
      id: 'slot-charger',
      zone: 'consumer',
      label: 'Ladesäule anbinden',
      typ: 'ladesaeule',
      initialRolle: null,
      icon: 'battery-charging',
    },
    {
      id: 'slot-consumer',
      zone: 'consumer',
      label: 'Verbraucher hinzufügen',
      typ: 'verbraucher',
      initialRolle: null,
      icon: 'zap',
    },
  ];
  if (!knoten.some((k) => k.rollen.includes('grid'))) {
    slots.splice(2, 0, {
      id: 'slot-grid',
      zone: 'grid',
      label: 'Netz-Zähler hinzufügen',
      typ: 'zaehler',
      initialRolle: null,
      icon: 'activity',
    });
  }
  return slots;
}

/** Alles, was das Anlagenbild braucht, aus der synchronen Geräte-Zweitsicht. */
export function anlagenBild(karten: GeraeteKarte[]): AnlagenBild {
  const box = karten.find((k) => k.art === 'box') ?? null;
  const knoten = karten.filter((k) => k.art !== 'box').map(knotenFuer);
  return {
    knoten,
    slots: slotsFuer(knoten),
    service: box
      ? { titel: box.titel, zustand: box.zustand, ton: box.ton }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Deterministische Desktop-Geometrie
// ---------------------------------------------------------------------------

export const ANLAGEN_BILD_BREITE = 1040;
export const ANLAGEN_KNOTEN_BREITE = 204;
export const ANLAGEN_KNOTEN_HOEHE = 84;
const SLOT_HOEHE = 74;
const ABSTAND = 14;
const OBEN = 62;
export const ANLAGEN_SPALTEN_X: Record<AnlagenZone, number> = {
  pv: 26,
  storage: 280,
  house: 534,
  grid: 810,
  consumer: 810,
};

export type AnlagenLayoutArt = 'knoten' | 'slot';
export interface AnlagenLayoutItem {
  id: string;
  art: AnlagenLayoutArt;
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

type LayoutQuelle = Pick<AnlagenKnoten, 'id' | 'zone'> | Pick<AnlagenSlot, 'id' | 'zone'>;

function zonenQuellen(bild: AnlagenBild, zone: AnlagenZone): Array<{
  quelle: LayoutQuelle;
  art: AnlagenLayoutArt;
}> {
  return [
    ...bild.knoten.filter((k) => k.zone === zone).map((quelle) => ({ quelle, art: 'knoten' as const })),
    ...bild.slots.filter((s) => s.zone === zone).map((quelle) => ({ quelle, art: 'slot' as const })),
  ];
}

function stapelHoehe(anzahl: number): number {
  if (anzahl === 0) return 0;
  return anzahl * ANLAGEN_KNOTEN_HOEHE + (anzahl - 1) * ABSTAND;
}

/**
 * Feste Spalten, stabile Reihenfolge, wachsende Höhe. Weder Browserbreite noch
 * Messwerte verändern die Position; nur der belegte Bestand verlängert einen
 * Zweig. Damit bleibt die mentale Karte zwischen zwei Abrufen stabil.
 */
export function layoutAnlagenBild(bild: AnlagenBild): AnlagenBildLayout {
  const obenZonen: AnlagenZone[] = ['pv', 'storage', 'grid'];
  const obenGruppen = Object.fromEntries(obenZonen.map((z) => [z, zonenQuellen(bild, z)])) as Record<
    AnlagenZone,
    ReturnType<typeof zonenQuellen>
  >;
  const maxOben = Math.max(...obenZonen.map((z) => stapelHoehe(obenGruppen[z].length)), 0);
  const busY = Math.max(320, OBEN + maxOben + 64);
  const untenStart = busY + 84;
  const haus = zonenQuellen(bild, 'house');
  const verbraucher = zonenQuellen(bild, 'consumer');
  const untenHoehe = Math.max(stapelHoehe(haus.length), stapelHoehe(verbraucher.length), 80);
  const serviceY = untenStart + untenHoehe + 64;
  const items: AnlagenLayoutItem[] = [];

  const setze = (
    gruppe: ReturnType<typeof zonenQuellen>,
    zone: AnlagenZone,
    startY: number,
  ) => {
    let y = startY;
    for (const { quelle, art } of gruppe) {
      const h = art === 'slot' ? SLOT_HOEHE : ANLAGEN_KNOTEN_HOEHE;
      items.push({
        id: quelle.id,
        art,
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

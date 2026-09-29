/**
 * SZENEN (Konzept `docs/konzepte/steuerung`, E6): ein Tipp, mehrere Geräte.
 *
 * Eine Szene pausiert die gewählten Geräte über den bestehenden Pausenweg
 * (Regel zurückgezogen, sicherer Zustand des Geräts), bis der Kunde sie
 * beendet (`/scene`, `SzenenService`). Sie stellt KEINE Temperatur und keine
 * Ladeart um - dafür gibt es keinen Weg der Box, und eine Szene, die mehr
 * verspricht, als sie schaltet, wäre gelogen.
 *
 * Welche Geräte eine Szene vorschlägt, folgt dem Gerät (Symbol aus Typ und
 * Name, Steuerart); der Kunde ändert die Auswahl im Blatt. Das Vokabular ist
 * geschlossen und gleich im Server (`Szenen.java`, DB-CHECK).
 *
 * Rein und getestet (`szenen.test.ts`).
 */
import type { SiteScene, SzeneKey } from '../api';
import type { GeraetBild } from './bild';
import type { IcName } from './Ic';

export interface SzeneDef {
  id: SzeneKey;
  name: string;
  icon: IcName;
  /** Was sie tut, in einer Zeile - so, wie die Box es ausführt. */
  kurz: string;
  /** Schlägt die Szene dieses Gerät vor? */
  passt: (g: GeraetBild) => boolean;
}

/** Komfort, den im Urlaub niemand braucht. */
const KOMFORT = new Set(['waves', 'thermo', 'snow', 'heater', 'sauna', 'fan', 'sprout']);
/** Haushaltsgeräte, die ohne Bewohner nicht laufen sollen. */
const HAUSHALT = new Set(['washer', 'wind', 'dish']);
/** Was tagsüber nur für Anwesende läuft. */
const ANWESEND = new Set(['snow', 'heater', 'fan']);
/** Steuerarten, die Strom unabhängig von Sonne und Preis ziehen. */
const OHNE_PREIS = new Set(['sofort', 'feste_zeiten']);

export const SZENEN: SzeneDef[] = [
  { id: 'urlaub', name: 'Urlaub', icon: 'plane', kurz: 'Pool, Klima und Haushalt aus', passt: (g) => KOMFORT.has(g.symbol) || HAUSHALT.has(g.symbol) },
  { id: 'unterwegs', name: 'Unterwegs', icon: 'door', kurz: 'Tagsüber niemand da', passt: (g) => ANWESEND.has(g.symbol) },
  { id: 'sparen', name: 'Sparen', icon: 'leaf', kurz: 'Nur Sonne und günstig', passt: (g) => OHNE_PREIS.has(g.steuerart?.quelle ?? '') },
];

export const szeneDef = (id: string | null | undefined): SzeneDef | null => SZENEN.find((s) => s.id === id) ?? null;

/**
 * Kann eine Szene dieses Gerät pausieren? Nur ein Verbraucher mit eigenem,
 * aktivem Auftrag (der Server prüft dasselbe) - ein Ladepunkt hat seinen
 * eigenen Weg, und ein Gerät ohne Auftrag schaltet VoltPilot ohnehin nicht.
 */
export function szenenfaehig(g: GeraetBild): boolean {
  if (g.ladepunkt || !g.consumer || !g.schreibbar) return false;
  return g.consumer.controlActivation === 'active' || g.consumer.controlActivation === 'paused';
}

/** Die Geräte im Blatt einer Szene: alle fähigen, die vorgeschlagenen zuerst. */
export function szenenGeraete(def: SzeneDef, alle: GeraetBild[]): { g: GeraetBild; vorgeschlagen: boolean }[] {
  const faehig = alle.filter(szenenfaehig);
  const ja = faehig.filter((g) => def.passt(g));
  const nein = faehig.filter((g) => !def.passt(g));
  return [...ja.map((g) => ({ g, vorgeschlagen: true })), ...nein.map((g) => ({ g, vorgeschlagen: false }))];
}

/** Was eine Szene an einem Gerät bewirkt - ehrlich: pausieren, sonst nichts. */
export function szenenWirkung(g: GeraetBild): string {
  if (g.consumer?.controlActivation === 'paused') return 'ist schon pausiert, bleibt es';
  return 'aus';
}

/** Die laufende Szene, wie die Seite sie braucht. */
export interface SzenenStand {
  def: SzeneDef;
  seitMs: number | null;
  ids: string[];
}

export function szenenStand(s: SiteScene | null | undefined): SzenenStand | null {
  const sz = s?.scene;
  const def = szeneDef(sz?.key);
  if (!sz || !def) return null;
  const seit = Date.parse(sz.since);
  return { def, seitMs: Number.isFinite(seit) ? seit : null, ids: Array.isArray(sz.pausedEntityIds) ? sz.pausedEntityIds : [] };
}

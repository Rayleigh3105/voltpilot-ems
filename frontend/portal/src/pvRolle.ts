import type { RollenGeraetBeitrag, RollenKanonischerWert, SiteTopology } from './api';
import { DEADBAND_KW, type FlowNode } from './topology';

/**
 * Reine Cockpit-Sicht der kanonischen Rollen PV, Verbrauch und Netz.
 * Ohne ausdrückliche Zuordnung bleibt die Roh-Telemetrie unmarkiert.
 * Die historischen PV-Exporte bleiben für bestehende Aufrufer erhalten.
 */

export interface PvRolleZeile {
  entityId: string;
  name: string;
  /** kW, oder `null`, wenn dieses Gerät gerade nicht liefert (dann „liefert gerade nicht"). */
  kw: number | null;
  liefernd: boolean;
}

export interface PvRolleView {
  /** Die kanonische Summe der liefernden Geräte (kW), oder `null`, wenn gerade keines liefert. */
  summe: number | null;
  stand: string | null;
  einheit: string;
  zeilen: PvRolleZeile[];
  /** Wie viele der zugeordneten Geräte gerade liefern. */
  beitragend: number;
  /** Wie viele Geräte insgesamt zugeordnet sind. */
  gesamt: number;
  /** Mindestens ein zugeordnetes Gerät liefert gerade nicht (in `zeilen` benannt). */
  unvollstaendig: boolean;
  summenwertHinweis: boolean;
}

/**
 * Die Sicht der kanonischen PV-Rolle - oder `null`, wenn keine Zuordnung existiert (Rückfall, das
 * Cockpit zeigt dann die Roh-Telemetrie ohne Herkunfts-Merkmal).
 */
export function pvRolleView(wert: RollenKanonischerWert | null | undefined): PvRolleView | null {
  if (!wert || !wert.zuordnung_vorhanden) return null;
  const zeilen = wert.geraete.map(zeile);
  return {
    summe: wert.wert,
    stand: wert.stand,
    einheit: wert.einheit,
    zeilen,
    beitragend: zeilen.filter((z) => z.liefernd).length,
    gesamt: zeilen.length,
    unvollstaendig: wert.unvollstaendig,
    summenwertHinweis: zeilen.length > 1 && wert.geraete.some((g) => g.art === 'gesamtwert'),
  };
}

function zeile(g: RollenGeraetBeitrag): PvRolleZeile {
  return {
    entityId: g.entity_id,
    name: g.name && g.name.trim() ? g.name : 'Gerät',
    // Ehrlich: ein stummes Gerät trägt keinen Wert (null), nie eine erfundene 0.
    kw: g.liefernd ? g.wert : null,
    liefernd: g.liefernd,
  };
}

/**
 * Die ehrliche Teil-Summen-Zeile „aus N von M Geräten" - nur, wenn sie etwas SAGT: bei mehreren
 * zugeordneten Geräten oder sobald eines stumm ist. Ein einzelnes, lieferndes Gerät braucht sie
 * nicht (die Summe darunter ist dann dieselbe Zahl).
 */
export function teilSummeText(view: PvRolleView): string | null {
  if (view.gesamt <= 1 && !view.unvollstaendig) return null;
  return `aus ${view.beitragend} von ${view.gesamt} Geräten`;
}

/** Dieselbe reine Sicht für PV, Verbrauch und Netz; keine zweite Summenrechnung. */
export const rollenView = pvRolleView;

export const ROLLEN_WOERTER = {
  pv: { label: 'Gesamt-PV', erklaerung: 'So setzt sich Ihre PV-Produktion zusammen', icon: 'sun' },
  consumer: { label: 'Verbrauch', erklaerung: 'So setzt sich Ihr Verbrauch zusammen', icon: 'home' },
  grid: { label: 'Netz', erklaerung: 'So setzt sich Ihr Netzwert zusammen', icon: 'zap' },
} as const;

export function rollenStand(stand: string | null): string {
  if (!stand) return 'Stand unbekannt';
  const datum = new Date(stand);
  if (!Number.isFinite(datum.getTime())) return 'Stand unbekannt';
  return `Stand ${datum.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr`;
}

/** Nur die Cockpit-Zeichnung: übernimmt Serverzahlen ohne sie aus Gerätezeilen neu zu summieren.
 * Derselbe Summenwert kann mehreren Geräten zugeordnet sein und zählt trotzdem einmal.
 * Die Original-Topologie bleibt für alle Steuer-/Gerätewege unverändert.
 */
export function cockpitRollenTopologie(topology: SiteTopology | null,
  rollen: readonly (RollenKanonischerWert | null | undefined)[]): SiteTopology | null {
  const aktiv = rollen.filter((r): r is RollenKanonischerWert => r?.zuordnung_vorhanden === true);
  if (!topology || aktiv.length === 0) return topology;
  const nodes = [...topology.topology.nodes];
  for (const r of aktiv) {
    if (!(r.role in ROLLEN_WOERTER)) continue;
    const role = r.role as keyof typeof ROLLEN_WOERTER;
    const active = r.wert != null && Math.abs(r.wert) > DEADBAND_KW;
    const node: FlowNode = {
      role,
      ...(r.wert == null ? {} : { value_kw: Math.abs(r.wert) }),
      flow_active: active,
      ...(active ? { direction: role === 'consumer' || (role === 'grid' && r.wert! < 0) ? 'out' as const : 'in' as const } : {}),
      members: r.geraete.map((g) => ({ entity_id: g.entity_id, label: g.name, primary: true })),
    };
    const index = nodes.findIndex((n) => n.role === role);
    if (index < 0) nodes.push(node);
    else nodes[index] = node;
  }
  return { ...topology, topology: { ...topology.topology, nodes } };
}

import type { RollenGeraetBeitrag, RollenKanonischerWert } from './api';

/**
 * Die Cockpit-Aufschlüsselung der kanonischen PV-Rolle (vp-agg §2.4/B): reine Ableitung aus dem
 * Endpoint `GET /api/v1/sites/{id}/rollen/pv`. `pvRolleView` gibt `null`, wenn KEINE Zuordnung
 * existiert - dann bleibt das Cockpit stumm beim Rückfall `telemetry.pv_power_kw` (kein
 * „berechnet"-Merkmal, keine Aufschlüsselung). Fachregel als reines Modul; die Komponente rendert
 * nur ihr Ergebnis (`components/PvRollenBreakdown.tsx`).
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
  einheit: string;
  zeilen: PvRolleZeile[];
  /** Wie viele der zugeordneten Geräte gerade liefern. */
  beitragend: number;
  /** Wie viele Geräte insgesamt zugeordnet sind. */
  gesamt: number;
  /** Mindestens ein zugeordnetes Gerät liefert gerade nicht (in `zeilen` benannt). */
  unvollstaendig: boolean;
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
    einheit: wert.einheit,
    zeilen,
    beitragend: zeilen.filter((z) => z.liefernd).length,
    gesamt: zeilen.length,
    unvollstaendig: wert.unvollstaendig,
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

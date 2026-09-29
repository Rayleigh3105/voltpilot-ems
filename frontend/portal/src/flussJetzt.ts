/**
 * Der Moment „jetzt“ für den Leitungsplan: Sonne, Haus, Speicher und Netz aus
 * der Topologie einer migrierten Anlage, sonst aus dem Live-Schnappschuss.
 *
 * Vorzeichen wie `LiveSnapshot`: Speicher + lädt, Netz + Bezug. Eine Rolle,
 * die die Anlage GAR NICHT hat (kein Speicher, keine PV), ist 0 und ihr Knoten
 * entfällt; eine Rolle, die sie hat, aber gerade nicht meldet, ist `null`.
 */
import type { SiteTopology } from './api';
import type { FlussWerte } from './leitungsplan';
import type { LiveSnapshot } from './live';
import { hausLeistungKw } from './verbrauchKomposition';

export interface JetztFluss {
  werte: FlussWerte;
  socPct: number | null;
  hat: { pv: boolean; batt: boolean };
}

export function jetztFluss(
  topology: SiteTopology | null,
  snapshot: LiveSnapshot,
  opts: {
    pvTotalKw?: number | null;
    /** Kanonischer Verbrauchs-Wert (Rolle mit Zuordnung) - er gewinnt vor dem Haus-Mitglied; null = „—“. */
    loadKanonisch?: { wert: number | null } | null;
  } = {},
): JetztFluss {
  if (!topology) {
    const hatBatt = snapshot.socPct != null || snapshot.battKw != null;
    return {
      werte: { pv: snapshot.pvKw, load: snapshot.loadKw, batt: hatBatt ? snapshot.battKw : 0, grid: snapshot.gridKw },
      socPct: snapshot.socPct,
      hat: { pv: snapshot.pvKw != null, batt: hatBatt },
    };
  }
  const nodes = topology.topology.nodes;
  const pvN = nodes.find((n) => n.role === 'pv');
  const stN = nodes.find((n) => n.role === 'storage');
  const grN = nodes.find((n) => n.role === 'grid');
  const betrag = (v: number | undefined) => (v == null ? null : Math.abs(v));
  const pv = pvN ? (opts.pvTotalKw ?? betrag(pvN.value_kw)) : 0;
  let batt: number | null = 0;
  if (stN) {
    const b = betrag(stN.value_kw);
    batt = b == null ? null : stN.direction === 'in' ? -b : b;
  }
  let grid: number | null = null;
  if (grN) {
    const g = betrag(grN.value_kw);
    grid = g == null ? null : grN.direction === 'out' ? -g : g;
  } else grid = snapshot.gridKw;
  const load = opts.loadKanonisch
    ? opts.loadKanonisch.wert == null ? null : Math.abs(opts.loadKanonisch.wert)
    : hausLeistungKw(topology) ?? snapshot.loadKw;
  return {
    werte: { pv, load, batt, grid },
    socPct: stN?.soc_pct ?? snapshot.socPct ?? null,
    hat: { pv: pvN != null, batt: stN != null },
  };
}

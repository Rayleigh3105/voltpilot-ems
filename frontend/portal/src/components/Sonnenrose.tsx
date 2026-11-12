import type { RegisterEinheit } from '../api';
import { compassLabel, fmtNum } from '../format';

/**
 * E1=B (Captain-Entscheid 11.11.2026, vp-mastr-mehrere-einheiten-konzept):
 * eine Anlage mit mehreren PV-Einheiten als EIN Bild - jede Dachfläche ein
 * Strahl in ihre Himmelsrichtung, Länge nach kWp, Farbe je Einheit (älter =
 * dunkler, dieselbe Orange-Familie wie überall sonst Solar: die hellste Farbe
 * IST `--vp-flow-pv`). Flächen gleicher Richtung liegen hintereinander auf
 * demselben Strahl (ältere Einheit innen). Der Sonnenweg Ost-Süd-West steht
 * als beschriftete Punkte am Rand; in der Mitte die Summe.
 *
 * Reine Anzeige - keine Richtungs-Bearbeitung hier (das Einheit-Blatt).
 */

// SIZE braucht genug Rand für die Sonnenweg-Beschriftung ("West" bei
// textAnchor="middle" reicht ~±14px über ihren Ankerpunkt hinaus) - sonst
// schneidet der viewBox-Rand die Wörter ab (gefunden am echten Browser-Bild).
const SIZE = 260;
const CENTER = SIZE / 2;
const MAX_RAY_LEN = 85;
const MIN_SEGMENT_LEN = 7;
const SEGMENT_GAP = 2;

/** Älter = dunkler; die hellste Stufe ist IMMER `--vp-flow-pv` (das Solar-Orange überall sonst). */
const PALETTE_4 = ['#7c2d12', '#9a3412', '#ea580c', 'var(--vp-flow-pv)'];

function paletteFor(n: number): string[] {
  if (n <= 0) return [];
  if (n <= 4) return PALETTE_4.slice(4 - n);
  return [...Array(n - 4).fill(PALETTE_4[0]), ...PALETTE_4];
}

function toXY(richtungGrad: number, radius: number): { x: number; y: number } {
  const rad = (richtungGrad * Math.PI) / 180;
  return { x: CENTER + radius * Math.sin(rad), y: CENTER - radius * Math.cos(rad) };
}

interface Segment {
  einheitId: string;
  farbe: string;
  anteilKwp: number;
}

export function Sonnenrose({ einheiten }: { einheiten: RegisterEinheit[] }) {
  const pvEinheiten = einheiten.filter((e) => e.art === 'pv' && e.bestaetigtAm != null);
  // Älteste zuerst (unbekanntes Datum zuletzt) - bestimmt Farbtiefe und die
  // Reihenfolge auf einem gemeinsamen Strahl (ältere Einheit innen).
  const sortiert = [...pvEinheiten].sort((a, b) => {
    if (!a.inbetriebnahme && !b.inbetriebnahme) return 0;
    if (!a.inbetriebnahme) return 1;
    if (!b.inbetriebnahme) return -1;
    return a.inbetriebnahme.localeCompare(b.inbetriebnahme);
  });
  const farben = new Map(sortiert.map((e, i) => [e.id, paletteFor(sortiert.length)[i]]));

  const byRichtung = new Map<number, Segment[]>();
  for (const e of sortiert) {
    for (const f of e.flaechen) {
      const key = Math.round(f.richtungGrad);
      const liste = byRichtung.get(key) ?? [];
      liste.push({ einheitId: e.id, farbe: farben.get(e.id) ?? 'var(--vp-flow-pv)', anteilKwp: f.anteilKwp });
      byRichtung.set(key, liste);
    }
  }
  const summeKwp = sortiert.reduce((s, e) => s + (e.leistungKwp ?? 0), 0);
  const maxStrahlKwp = Math.max(1, ...[...byRichtung.values()].map((segs) => segs.reduce((s, x) => s + x.anteilKwp, 0)));
  const pxPerKwp = MAX_RAY_LEN / maxStrahlKwp;

  const kompass = [0, 45, 90, 135, 180, 225, 270, 315];
  const sonnenweg: { grad: number; label: string }[] = [
    { grad: 90, label: 'Ost' },
    { grad: 180, label: 'Süd' },
    { grad: 270, label: 'West' },
  ];

  return (
    <figure className="vp-sonnenrose" aria-label={`Sonnenrose, ${sortiert.length} Einheit${sortiert.length === 1 ? '' : 'en'}, zusammen ${fmtNum(summeKwp, 'kWp', 1)}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-hidden="true">
        {/* Dezente Himmelsrichtungs-Strahlen zur Orientierung. */}
        {kompass.map((grad) => {
          const p = toXY(grad, MAX_RAY_LEN + 10);
          return (
            <line key={grad} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y} className="vp-sonnenrose-grid" />
          );
        })}
        <circle cx={CENTER} cy={CENTER} r={MAX_RAY_LEN + 10} className="vp-sonnenrose-rim" />
        {/* Die Dachflächen: ein Segment je Einheit, gleiche Richtung hintereinander. */}
        {[...byRichtung.entries()].map(([grad, segs]) => {
          let along = 0;
          return segs.map((seg, i) => {
            const laenge = Math.max(MIN_SEGMENT_LEN, seg.anteilKwp * pxPerKwp);
            const von = toXY(grad, along + 4);
            along += laenge + SEGMENT_GAP;
            const bis = toXY(grad, Math.min(along, MAX_RAY_LEN + 4));
            return (
              <line
                key={`${grad}-${i}`}
                x1={von.x}
                y1={von.y}
                x2={bis.x}
                y2={bis.y}
                stroke={seg.farbe}
                strokeWidth={10}
                strokeLinecap="round"
              />
            );
          });
        })}
        {/* Der Sonnenweg Ost-Süd-West als beschriftete Punkte am Rand. */}
        {sonnenweg.map(({ grad, label }) => {
          const p = toXY(grad, MAX_RAY_LEN + 22);
          return (
            <text key={grad} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" className="vp-sonnenrose-sonnenweg">
              {label}
            </text>
          );
        })}
        {/* Die Summe in der Mitte. */}
        <text x={CENTER} y={CENTER - 4} textAnchor="middle" className="vp-sonnenrose-summe">
          {summeKwp.toLocaleString('de-DE', { maximumFractionDigits: 1 })}
        </text>
        <text x={CENTER} y={CENTER + 16} textAnchor="middle" className="vp-sonnenrose-summe-einheit">
          kWp
        </text>
      </svg>
      <figcaption className="vp-sonnenrose-legende">
        {sortiert.map((e) => (
          <span key={e.id} className="vp-sonnenrose-legende-zeile">
            <i className="vp-sonnenrose-schwatch" style={{ background: farben.get(e.id) }} aria-hidden="true" />
            <span>
              {e.leistungKwp != null ? fmtNum(e.leistungKwp, 'kWp', 1) : 'Leistung unbekannt'}
              {e.inbetriebnahme ? ` · seit ${e.inbetriebnahme.slice(0, 4)}` : ''}
              {richtungLabelFuer(e) ? ` · ${richtungLabelFuer(e)}` : ''}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Eine Fläche: ihre Richtung als Wort; mehrere Flächen: "mehrere Richtungen". */
function richtungLabelFuer(e: RegisterEinheit): string | null {
  if (e.flaechen.length === 0) return null;
  if (e.flaechen.length > 1) return 'mehrere Richtungen';
  const grad = e.flaechen[0].richtungGrad;
  return compassLabel(grad) ?? `${grad.toLocaleString('de-DE')}°`;
}

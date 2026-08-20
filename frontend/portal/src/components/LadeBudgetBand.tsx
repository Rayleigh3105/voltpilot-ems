import type { BudgetBand } from '../ladepunkte';
import { fmtNum } from '../format';
import './LadeBudgetBand.css';

/**
 * Das Budget-Band: EIN Balken von 0 bis zur Anschlussgrenze, segmentiert in
 * Gebäude · Laden · Sicherheitsabstand · frei (Mockups Fläche 1).
 *
 * ⚠ Jede Kodierung trägt ihr WORT (K10): der Sicherheitsabstand ist
 * schraffiert UND beschriftet, jedes Segment steht mit Namen in der Legende,
 * und ROT ist ausschließlich die Grenz-Linie - eine Warnfarbe wird hier nie zur
 * Serienfarbe.
 */
export function LadeBudgetBand({ band }: { band: BudgetBand }) {
  const total = band.limitKw ?? band.segments.reduce((a, s) => a + s.kw, 0);
  const pct = (kw: number) => (total > 0 ? Math.max(0, Math.min(100, (kw / total) * 100)) : 0);
  return (
    <div className="vp-lade-band">
      {band.headline && <div className="vp-lade-band-headline">{band.headline}</div>}
      <div
        className="vp-lade-band-track"
        role="img"
        aria-label={band.headline ? `Netzanschluss: ${band.headline}` : 'Netzanschluss'}
      >
        {band.segments.map((s) => (
          <span
            key={s.id}
            className={`vp-lade-seg seg-${s.id}${s.hatched ? ' hatched' : ''}`}
            style={{ width: `${pct(s.kw)}%` }}
          />
        ))}
        {band.limitKw != null && <span className="vp-lade-limit" aria-hidden="true" />}
      </div>
      <ul className="vp-lade-legend">
        {band.segments.map((s) => (
          <li key={s.id}>
            <span className={`vp-lade-key seg-${s.id}${s.hatched ? ' hatched' : ''}`} aria-hidden="true" />
            {s.label} {fmtNum(s.kw, 'kW')}
          </li>
        ))}
        {band.limitKw != null && (
          <li>
            <span className="vp-lade-key limit" aria-hidden="true" />
            Grenze {fmtNum(band.limitKw, 'kW')}
          </li>
        )}
      </ul>
      <p className="vp-lade-band-line">{band.line}</p>
      {band.sourceLine && (
        <p className={`vp-lade-band-source${band.blind ? ' blind' : ''}`}>{band.sourceLine}</p>
      )}
    </div>
  );
}

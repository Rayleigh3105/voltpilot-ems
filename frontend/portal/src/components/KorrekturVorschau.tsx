import type { KorrekturAuswirkungen, KorrekturPeriode } from '../api';
import { PERIODEN, periodenZahl, vorschauBalken } from '../korrekturen';
import { zeitText } from '../uemsEreignis';
import './Korrekturen.css';

export function KorrekturVorschau({ perioden, auswirkungen, einheit, zone }: {
  perioden: readonly KorrekturPeriode[]; auswirkungen: KorrekturAuswirkungen; einheit: string; zone: string;
}) {
  const balken = vorschauBalken(perioden);
  const geordnet = [...perioden.filter(p => p.periode !== 'viertelstunde'), ...perioden.filter(p => p.periode === 'viertelstunde')];
  return <div className="vp-korr-vorschau">
    {balken.length > 1 && <figure className="vp-korr-profil">
      <figcaption>Vorschau des Verlaufs · {einheit}</figcaption>
      <svg viewBox={`0 0 ${balken.length * 8} 84`} role="img" aria-label="Vorgeschlagene Mengen je Viertelstunde" preserveAspectRatio="none">
        {balken.map((b, i) => <rect key={b.von} x={i * 8} y={82 - b.hoehe} width={6} height={b.hoehe}>
          <title>{zeitText(b.von, zone)}: {periodenZahl(b.menge, einheit)}</title>
        </rect>)}
      </svg>
      <p>Jeder Balken ist eine Viertelstunde. Die genauen Werte stehen darunter.</p>
    </figure>}
    <div className="vp-korr-tabelle" tabIndex={0} aria-label="Versionen im Vergleich">
      <table><thead><tr><th>Zeitraum</th><th>Bisher</th><th>Nach Änderung</th></tr></thead><tbody>
        {geordnet.map((p, i) => <tr key={`${p.periode}-${p.von}-${i}`}>
          <th scope="row">{PERIODEN[p.periode] ?? 'Zeitraum'}<small>{zeitText(p.von, zone)}{p.von !== p.bis && <> bis {zeitText(p.bis, zone)}</>}</small>
            <small>Version {p.version_alt ?? '—'} → {p.version_neu ?? '—'}</small></th>
          {[p.alt, p.neu].map((s, n) => <td key={n}><strong>{periodenZahl(s?.menge, einheit)}</strong>
            <small>{s?.menge_zustand ?? 'Keine Werte'}</small>
            {s?.abdeckung_prozent != null && <small>Abdeckung {s.abdeckung_prozent} %</small>}
            {s?.kennzeichen?.map(k => <small key={k}>{k}</small>)}
          </td>)}
        </tr>)}
      </tbody></table>
    </div>
    {!perioden.length && <p>Für diesen Vorgang liegt keine Wertvorschau vor.</p>}
    <section className="vp-korr-folgen" aria-label="Auswirkungen"><h3>Was sich mitändert</h3>
      <p>Betroffene Zeiträume: {auswirkungen.perioden.join(', ')}.</p>
      <p>{auswirkungen.berechnete_messstellen}</p><p>{auswirkungen.kennzahlen}</p><p>{auswirkungen.berichte}</p>
    </section>
  </div>;
}

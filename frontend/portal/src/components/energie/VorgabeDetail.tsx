import { useEffect, useRef, useState } from 'react';
import type { ErzeugerVorgabeDetail } from '../../api';
import { vorgabeFakten, rohwertText } from '../../historieEreignisse';

/**
 * **Das Detail einer Vorgabe** (UEMS EZ-9) — klappt in der Chronik unter ihrer Zeile auf, wie die Fakten des
 * Abendverkaufs. Es lädt die Vorgabe aus EZ-7 (`GET …/erzeuger/vorgaben/{id}`) und zeigt, was sie belegt: Beginn und
 * Ende, Vorgabe, Ist und verfügbar im Mittel, die geschätzt nicht erzeugte Energie mit ihrer Grundlage, die
 * Zählerstände und die Rohsignale am Beginn und am Ende. Render-only; die Wörter bildet `historieEreignisse.ts`.
 */
export function VorgabeDetail({ id, laden }: { id: string; laden: (id: string) => Promise<ErzeugerVorgabeDetail> }) {
  const [detail, setDetail] = useState<ErzeugerVorgabeDetail | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  // Geladen wird je Vorgabe einmal - nicht bei jedem Neuzeichnen der Seite (der Fokus der Spur zeichnet oft neu).
  const ladenRef = useRef(laden);
  ladenRef.current = laden;
  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    ladenRef.current(id).then(
      (d) => {
        if (aktiv) setDetail(d);
      },
      () => {
        if (aktiv) setFehler(true);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  if (fehler) {
    return (
      <div className="vp-vr-fakten vp-vr-vorgabe-detail" role="status">
        <p className="vp-vr-vorgabe-hinweis">Das Detail dieser Vorgabe konnte nicht geladen werden.</p>
        <button type="button" className="vp-vr-textbtn" onClick={() => setVersuch((n) => n + 1)}>
          Erneut laden
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="vp-vr-fakten vp-vr-vorgabe-detail" role="status" aria-busy="true">
        <p className="vp-vr-vorgabe-hinweis">Rohsignale werden geladen …</p>
      </div>
    );
  }
  const roh = [
    { titel: 'Rohsignale am Beginn', werte: detail.roh_beginn },
    { titel: 'Rohsignale am Ende', werte: detail.roh_ende },
  ].filter((r) => r.werte.length > 0);
  return (
    <div className="vp-vr-fakten vp-vr-vorgabe-detail">
      <dl>
        {vorgabeFakten(detail.vorgabe).map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {roh.map((r) => (
        <section key={r.titel} aria-label={r.titel}>
          <h4 className="vp-vr-vorgabe-titel">{r.titel}</h4>
          <dl>
            {r.werte.map((w) => (
              <div key={w.point_key}>
                <dt>{w.te_nr != null ? `${w.feld} (Einheit ${w.te_nr})` : w.feld}</dt>
                <dd>{rohwertText(w)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="vp-vr-vorgabe-hinweis">
        {detail.signale.length === 0
          ? 'Proben der Rohsignale sind für diesen Zeitraum nicht mehr aufbewahrt.'
          : `${detail.signale.length}${detail.signale_gekuerzt ? ' oder mehr' : ''} Proben der Rohsignale in diesem Zeitraum.`}
      </p>
    </div>
  );
}

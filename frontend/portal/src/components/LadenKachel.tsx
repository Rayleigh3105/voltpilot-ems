import { Icon } from '../../designsystem/components/core/Icon';
import { fmtNum } from '../format';
import type { LadenKachel as LadenKachelView, LadenZeile } from '../ladenKachel';
import { MiniShareBar } from './MiniChart';

import './LadenKachel.css';

/**
 * Die Kachel „Laden" (Konzept `vp-verbraucher-cockpit-k1` §5): der EINE Ort,
 * an dem ohne Klick steht, ob ein Auto steckt und ob es lädt.
 *
 * REINE ANZEIGE (Captain): kein Start, kein Stopp, keine Freigabe. Der Kopf
 * springt auf „Ladevorgänge", jede Zeile auf ihre Geräteseite - die Handlungen
 * wohnen dort, wo sie hingehören.
 *
 * Die Fußzeile IST das bestehende Netzanschluss-Band: der Block `lade-budget`
 * ist mit diesem Baustein aus den Kennzahlen hierher gezogen, damit eine Zahl
 * EINEN Wohnort hat.
 *
 * Thin + render-only - jede Zahl und jedes Wort kommt aus der getesteten
 * {@link ../ladenKachel}.
 */
export function LadenKachel({ view }: { view: LadenKachelView }) {
  const { band } = view;
  return (
    <section className="vp-laden" aria-label="Laden">
      <div className="vp-laden-kopf">
        <div className="vp-laden-kopfblock">
          <span className="vp-laden-label">Laden</span>
          <span className="vp-laden-wert">{view.kopf}</span>
          {view.unterzeile && <span className="vp-laden-sub">{view.unterzeile}</span>}
        </div>
        {view.href && (
          <a className="vp-laden-mehr" href={view.href}>
            Ladevorgänge
            <Icon name="chevron-right" size={14} />
          </a>
        )}
      </div>

      {view.zeilen.length > 0 && (
        <ul className="vp-laden-zeilen">
          {view.zeilen.map((z) => (
            <Zeile key={z.key} zeile={z} />
          ))}
        </ul>
      )}

      {/* E6: die ruhenden Ladepunkte sind EIN Satz, keine Liste. */}
      {view.ruhendText && <p className="vp-laden-ruhend">{view.ruhendText}</p>}

      {/* Ohne gemeldetes Budget gibt es KEINE Fußzeile - eine „0 kW"-Zeile wäre
          eine Behauptung über eine Anlage, die gerade nichts gemeldet hat. */}
      {band && band.headline != null && (
        <div className="vp-laden-fuss">
          <span className="vp-laden-fuss-kopf">
            <span>Ladebudget {band.headline}</span>
            {band.blind && <span className="vp-laden-blind">geschätzt</span>}
          </span>
          <MiniShareBar
            className="vp-laden-band"
            segments={band.segments.map((s) => ({
              key: s.id,
              weight: Math.max(s.kw, 0.001),
              className: `vp-laden-seg is-${s.id}`,
              title: s.label,
            }))}
          />
          <span className="vp-laden-fuss-satz">{band.sourceLine ?? band.line}</span>
        </div>
      )}
    </section>
  );
}

function Zeile({ zeile }: { zeile: LadenZeile }) {
  const inhalt = (
    <>
      <span className={`vp-laden-dot tone-${zeile.tone}`} aria-hidden="true" />
      <span className="vp-laden-name">
        {zeile.label}
        {zeile.note && <span className="vp-laden-note">{zeile.note}</span>}
      </span>
      {/* „Nicht messbar ist nie 0": ohne Messwert trägt das Wort allein. */}
      <span className={`vp-laden-wort tone-${zeile.tone}`}>
        {zeile.word}
        {zeile.kw != null && <b className="vp-laden-kw">{fmtNum(zeile.kw, 'kW')}</b>}
      </span>
    </>
  );
  if (!zeile.href) {
    return <li className="vp-laden-zeile">{inhalt}</li>;
  }
  return (
    <li className="vp-laden-zeile is-link">
      <a className="vp-laden-link" href={zeile.href} aria-label={`${zeile.label} öffnen`}>
        {inhalt}
        <span className="vp-laden-go" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
      </a>
    </li>
  );
}

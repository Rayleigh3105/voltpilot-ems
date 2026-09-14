import { Icon } from '../../designsystem/components/core/Icon';
import type { NurMessenLeerzustand } from '../steuerungArea';
import './NurMessenHinweis.css';

/**
 * Der Leerzustand der Steuerung einer Anlage, die nur misst (UEMS AP-01 IP-8,
 * Konzept §5.5, A8): Grund und nächster Schritt, in zwei Fassungen — Standort
 * ohne und Standort mit „Steuern & Optimieren".
 *
 * ⚠ Er steht ÜBER den Zonen, er ersetzt sie nicht: Steuerart, Regeln und
 * Schutz bleiben die heutigen Wege, bis der Assistent „Steuern & Optimieren"
 * (IP-10a) existiert. Der nächste Schritt ist darum ein benannter Hinweis, kein
 * Knopf — nur „Gerät anbinden" (A8) hat heute schon ein Ziel.
 *
 * Render-only: Fassung, Satz und Schritt entstehen in
 * `steuerungArea.nurMessenLeerzustand`.
 */
export function NurMessenHinweis({
  leer,
  onGeraetAnbinden,
}: {
  leer: NurMessenLeerzustand;
  /** Der heutige Weg zu einer steuerbaren Komponente: Anlage › Komponenten. */
  onGeraetAnbinden?: () => void;
}) {
  return (
    <section
      className="vp-nurmessen"
      data-fassung={leer.fassung}
      aria-labelledby="vp-nurmessen-titel"
      data-testid="nur-messen"
    >
      <span className="vp-nurmessen-icon" aria-hidden="true">
        <Icon name="activity" size={20} />
      </span>
      <div className="vp-nurmessen-text">
        <h2 id="vp-nurmessen-titel">{leer.titel}</h2>
        <p>{leer.satz}</p>
        <p className="vp-nurmessen-schritt">
          <span className="vp-nurmessen-schritt-wort">Nächster Schritt:</span>{' '}
          {leer.weg === 'geraet-anbinden' && onGeraetAnbinden ? (
            <button type="button" className="vp-nurmessen-weg" onClick={onGeraetAnbinden}>
              {leer.schritt}
            </button>
          ) : (
            leer.schritt
          )}
        </p>
      </div>
    </section>
  );
}

import { Icon } from '../../designsystem/components/core/Icon';
import type { BewertungFristBild } from '../bewertungFrist';
import { UEMS_NORMGRENZE } from '../glossar';
import './UebersichtBausteine.css';

/** Titel und Sprung des Bausteins — Wörter aus dem Katalog-Eintrag `bewertung`. */
export const BEWERTUNG_BAUSTEIN_TITEL = 'Energetische Bewertung';
export const BEWERTUNG_BAUSTEIN_OEFFNEN = 'Zur Bewertung';

/**
 * UEMS AP-16 IP-24 (S5/S6): der Übersichts-Baustein „Energetische Bewertung“ am Unternehmen — Stand, Frist, Zahl der
 * wesentlichen Einsätze und offenen Messbedarfe; ist die Überprüfung fällig, nennt ein Satz die Verantwortlichen (keine
 * Nachricht). Alle Sätze kommen aus `bewertungFrist.ts`/`glossar.ts`; hier wird nur gerendert.
 */
export function BewertungBaustein({ bild, onOeffnen }: { bild: BewertungFristBild; onOeffnen: () => void }) {
  return (
    <section className="vp-ub-baustein" aria-labelledby="vp-ub-bewertung" data-testid="baustein-bewertung">
      <div className="vp-ub-kopf">
        <h2 id="vp-ub-bewertung" className="vp-ub-titel">
          {BEWERTUNG_BAUSTEIN_TITEL}
        </h2>
        <button type="button" className="vp-ub-alle" onClick={onOeffnen}>
          {BEWERTUNG_BAUSTEIN_OEFFNEN}
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <p className={`vp-ub-summe${bild.faellig ? ' is-warn' : ''}`} data-testid="bewertung-frist">
        {bild.satz}
      </p>
      <p className="vp-ub-unter" data-testid="bewertung-zahlen">
        {bild.zahlen}
      </p>
      {bild.hinweis && (
        <p className="vp-ub-hinweis" data-testid="bewertung-verantwortliche">
          {bild.hinweis}
        </p>
      )}
      {bild.ohneVerantwortliche && (
        <p className="vp-ub-hinweis" data-testid="bewertung-ohne-verantwortliche">
          {bild.ohneVerantwortliche}
        </p>
      )}
      <p className="vp-ub-hinweis">{UEMS_NORMGRENZE}</p>
    </section>
  );
}

import { useId } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { bannerTitel, KEINE_AENDERUNG, STAND_AM, stichtagAus, ZURUECK_ZU_HEUTE } from '../standAm';
import { VpDatePicker } from './VpDatePicker';
import './StandAm.css';

/**
 * „Stand am …“ (UEMS AP-02 IP-13, Mockup H1): das Banner, solange ein Stichtag
 * gesetzt ist, und darunter das Datumsfeld (Vorgabe heute). Die Fläche, die es
 * trägt, fragt ihre Daten mit dem Stichtag an und blendet ihre Schreibwege aus —
 * heute die Liste „Standorte“ samt der Ortsbäume in ihren Karten; die
 * Standort-Übersicht aus AP-01 nimmt es später unverändert für „Standort › Gebäude“.
 */
export function StandAm({
  heute,
  stichtag,
  onStichtag,
}: {
  heute: string;
  /** `null` = heute. */
  stichtag: string | null;
  onStichtag: (stichtag: string | null) => void;
}) {
  const feldId = `vp-sa-${useId().replace(/:/g, '')}`;
  return (
    <div className="vp-sa" data-testid="stand-am">
      {stichtag && (
        <div className="vp-sa-banner" role="status">
          <span className="vp-sa-icon" aria-hidden="true">
            <Icon name="calendar" size={18} />
          </span>
          <p className="vp-sa-text">
            <b>{bannerTitel(stichtag)}</b>
            {' — '}
            {KEINE_AENDERUNG}{' '}
            {/* Als Verweis im Satz wie in H1: ein Knopf darunter machte das Banner bei 375 px 120 statt 89 px hoch (Vorschau IP-13). */}
            <button
              type="button"
              className="vp-sa-zurueck"
              onClick={() => {
                onStichtag(null);
                // Der Verweis verschwindet mit dem Banner — der Fokus geht an das Datumsfeld, nicht an den Seitenanfang.
                requestAnimationFrame(() => document.getElementById(feldId)?.focus());
              }}
            >
              {ZURUECK_ZU_HEUTE}
            </button>
          </p>
        </div>
      )}
      <VpDatePicker
        id={feldId}
        className="vp-sa-feld"
        label={STAND_AM}
        value={stichtag ?? heute}
        onChange={(wahl) => onStichtag(stichtagAus(wahl, heute))}
      />
    </div>
  );
}

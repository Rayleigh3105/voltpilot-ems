import { Icon } from '../../designsystem/components/core/Icon';
import { kennungWieGedruckt } from '../koppelLink';
import { bandText } from '../koppelBandText';
import './KoppelBand.css';

/**
 * Das Box-Band (Konzept vp-qr-einstieg, M3 bis M7): eine Zeile über Registrierung, Anmeldekarte,
 * Assistent und Aufbau-Blatt, die sagt, dass die Box aus dem QR-Code vorgemerkt ist. Zeigt nur die
 * Kennung, nie etwas vom Server.
 */
export function KoppelBand({ children, zeile }: { children: React.ReactNode; zeile?: React.ReactNode }) {
  return (
    <div className="vp-koppel-band" role="status">
      <span className="vp-koppel-band-symbol" aria-hidden="true">
        <Icon name="cpu" size={16} />
      </span>
      <div className="vp-koppel-band-text">
        <span>{children}</span>
        {zeile && <span className="vp-koppel-band-zeile">{zeile}</span>}
      </div>
    </div>
  );
}

/** M4 · das Band über der Anmeldekarte des Portals (nachgeladen aus `App.tsx`). */
export function AnmeldeBand({ kennung }: { kennung: string }) {
  return <KoppelBand>{bandText('anmeldung', kennungWieGedruckt(kennung))}</KoppelBand>;
}

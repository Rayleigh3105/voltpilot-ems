import { Recht } from './Recht';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import type { OrtAktionen, StandortAmStichtag, StandortAusfall } from '../api';
import { menueEintraege, mitAenderungen, type MenueEintrag } from '../ortArchiv';
import { esFehltSatz, standortZeile } from '../standorte';
import { OrtMenue } from './OrtMenue';
import './StandortKopf.css';
import { standortAusfallSatz } from '../ausfallAnzeige';

/**
 * Der Kopf eines Standorts (UEMS AP-02 IP-6, E6): Name, Kurzzeichen, die Zeile
 * „Adresse · Gebäude · Anlagen · Fläche“ (T1) und „Bearbeiten“. Ein Entwurf sagt,
 * was ihm fehlt, und bietet „Adresse nachtragen“ an (E10) — beides öffnet den
 * Standort-Dialog.
 *
 * Bis die Ebenen-Navigation aus AP-01 steht, trägt ihn jede Zeile der Liste
 * „Standorte“ auf der Übersicht; die Standort-Übersicht nimmt ihn später
 * unverändert als ihren Kopf.
 */
export function StandortKopf({
  standort,
  titelEbene = 'h2',
  onBearbeiten,
  aktionen = null,
  onAktion,
  ausfall = null,
}: {
  standort: StandortAmStichtag;
  titelEbene?: 'h1' | 'h2' | 'h3';
  /** Der Auslöser kommt mit, damit der Fokus nach dem Dialog dorthin zurückkehrt. */
  onBearbeiten?: (standort: StandortAmStichtag, ausloeser: HTMLElement) => void;
  /** IP-15: was man heute mit dem Standort tun kann (aus seinem Ortsbaum) — das Menü „Archivieren …“. */
  aktionen?: OrtAktionen | null;
  onAktion?: (eintrag: MenueEintrag, ausloeser: HTMLElement) => void;
  ausfall?: StandortAusfall | null;
}) {
  const Titel = titelEbene;
  const zeile = standortZeile(standort);
  const fehlt = esFehltSatz(standort);
  const ausfallText = standortAusfallSatz(ausfall);
  return (
    <div className="vp-st-kopf-zeile" data-testid="standort-kopf">
      <div className="vp-st-kopf-text">
        <Titel className="vp-st-name">
          <span className="vp-st-name-text">{standort.name}</span>
          <span className="vp-st-kz">{standort.kurzzeichen}</span>
        </Titel>
        {zeile && <p className="vp-st-zeile">{zeile}</p>}
        {fehlt && <p className="vp-st-fehlt">{fehlt}</p>}
        {ausfallText && <p className="vp-st-fehlt" data-testid="standort-ausfall">{ausfallText}</p>}
      </div>
      {onBearbeiten && (
        <Recht aktion="standort.verwalten"><Button
          variant={fehlt ? 'primary' : 'outline'}
          size="sm"
          iconLeft={<Icon name={fehlt ? 'map-pin' : 'pencil'} size={16} />}
          onClick={(e) => onBearbeiten(standort, e.currentTarget)}
          aria-label={fehlt ? `Adresse nachtragen: ${standort.name}` : `${standort.name} bearbeiten`}
        >
          {fehlt ? 'Adresse nachtragen' : 'Bearbeiten'}
        </Button></Recht>
      )}
      {onAktion && aktionen && (
        <OrtMenue recht="standort.verwalten" name={standort.name} eintraege={mitAenderungen(menueEintraege(aktionen))} onWahl={onAktion} />
      )}
    </div>
  );
}

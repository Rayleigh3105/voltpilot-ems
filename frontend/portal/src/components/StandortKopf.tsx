import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import type { StandortAmStichtag } from '../api';
import { esFehltSatz, standortZeile } from '../standorte';
import './StandortKopf.css';

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
}: {
  standort: StandortAmStichtag;
  titelEbene?: 'h1' | 'h2' | 'h3';
  /** Der Auslöser kommt mit, damit der Fokus nach dem Dialog dorthin zurückkehrt. */
  onBearbeiten?: (standort: StandortAmStichtag, ausloeser: HTMLElement) => void;
}) {
  const Titel = titelEbene;
  const zeile = standortZeile(standort);
  const fehlt = esFehltSatz(standort);
  return (
    <div className="vp-st-kopf-zeile" data-testid="standort-kopf">
      <div className="vp-st-kopf-text">
        <Titel className="vp-st-name">
          <span className="vp-st-name-text">{standort.name}</span>
          <span className="vp-st-kz">{standort.kurzzeichen}</span>
        </Titel>
        {zeile && <p className="vp-st-zeile">{zeile}</p>}
        {fehlt && <p className="vp-st-fehlt">{fehlt}</p>}
      </div>
      {onBearbeiten && (
        <Button
          variant={fehlt ? 'primary' : 'outline'}
          size="sm"
          iconLeft={<Icon name={fehlt ? 'map-pin' : 'pencil'} size={16} />}
          onClick={(e) => onBearbeiten(standort, e.currentTarget)}
          aria-label={fehlt ? `Adresse nachtragen: ${standort.name}` : `${standort.name} bearbeiten`}
        >
          {fehlt ? 'Adresse nachtragen' : 'Bearbeiten'}
        </Button>
      )}
    </div>
  );
}

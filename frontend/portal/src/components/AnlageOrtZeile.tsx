import { Recht } from './Recht';
import { useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { AnlageOrtErgebnis, StandortAmStichtag, StandorteAmStichtag } from '../api';
import { UEMS_STANDORT } from '../glossar';
import { mehrereStandorte, ortZeileText } from '../anlageOrtBerichtigen';
import { AnlageOrtBlatt } from './AnlageOrtBlatt';
import { LocationMap } from './LocationMap';
import './AnlageOrtZeile.css';

/**
 * Die Zeile „Standort" (vp-standort-konzept §6.1/§6.2/E3) in Anlage › Einstellungen › „Meine
 * Anlage" — EINE Zeile mit Adresse und kleiner Karte (58×44 px, E3) statt des Standort-Objekts
 * (Kurzzeichen, „seit", zwei Links) und der getrennten Zeile „Standort auf der Karte". Captain-
 * Korrektur: dieselbe Zeilen-Form wie ihre Nachbarn (`vp-einst-zeile` aus `AnlageTechnik.tsx`,
 * dort nicht exportiert - hier dieselben Klassen statt eines eigenen `vp-kv`-Looks), die kleine
 * Karte ersetzt nur die Symbol-Kachel links, der Pfeil rechts, ganze Zeile tippbar. Ein Tipp
 * öffnet {@link AnlageOrtBlatt}; seit Schritt 2c steht „Gehört zu … · Ändern" dort oben, über der
 * Karte (§6.2/§6.5) — es ersetzt „Anderem Standort zuordnen"/„Zuordnung korrigieren" von heute.
 */
export function AnlageOrtZeile({
  siteId,
  standort,
  antwort,
  onGeaendert,
  onStandorteNeuLaden,
}: {
  siteId: string;
  standort: StandortAmStichtag;
  antwort: StandorteAmStichtag;
  onGeaendert: (ergebnis: AnlageOrtErgebnis) => void;
  /** §6.5: nach „Neuer Standort" im „Gehört zu"-Dialog die Liste neu lesen (B4). */
  onStandorteNeuLaden?: () => void;
}) {
  const [offen, setOffen] = useState(false);
  const ausloeser = useRef<HTMLButtonElement>(null);
  const mehrere = mehrereStandorte(antwort);
  const text = ortZeileText(standort, mehrere);

  function schliesse() {
    setOffen(false);
    requestAnimationFrame(() => {
      if (ausloeser.current?.isConnected) ausloeser.current.focus();
    });
  }

  return (
    <li>
      <Recht aktion="anlage.ort_berichtigen">
        <button
          ref={ausloeser}
          type="button"
          className="vp-einst-zeile vp-ort-zeile"
          aria-label={`${UEMS_STANDORT} bearbeiten: ${text}`}
          aria-haspopup="dialog"
          onClick={() => setOffen(true)}
        >
          <span className="vp-ort-zeile-karte" aria-hidden="true">
            <LocationMap
              lat={standort.lage?.breitengrad ?? null}
              lon={standort.lage?.laengengrad ?? null}
              onChange={() => {}}
              readonly
              kompakt
            />
          </span>
          <span className="vp-einst-lab">
            <b>{UEMS_STANDORT}</b>
            <span className="vp-einst-wert">{text}</span>
          </span>
          <span className="vp-einst-ende">
            <Icon name="chevron-right" size={18} />
          </span>
        </button>
      </Recht>
      {offen && (
        <AnlageOrtBlatt
          siteId={siteId}
          standort={standort}
          antwort={antwort}
          mehrereStandorte={mehrere}
          onStandorteNeuLaden={onStandorteNeuLaden}
          onClose={schliesse}
          onGespeichert={(ergebnis) => {
            schliesse();
            onGeaendert(ergebnis);
          }}
        />
      )}
    </li>
  );
}

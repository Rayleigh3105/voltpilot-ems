import { Recht } from './Recht';
import { useRef, useState, type ReactNode } from 'react';
import type { AnlageOrtErgebnis, StandortAmStichtag, StandorteAmStichtag } from '../api';
import { UEMS_STANDORT } from '../glossar';
import { mehrereStandorte, ortZeileText } from '../anlageOrtBerichtigen';
import { AnlageOrtBlatt } from './AnlageOrtBlatt';
import { LocationMap } from './LocationMap';
import './AnlageOrtZeile.css';

/**
 * Die Zeile „Standort" (vp-standort-konzept §6.1/§6.2/E3) in Anlage › Einstellungen › „Meine
 * Anlage" — EINE Zeile mit Adresse und kleiner Karte (58×44 px, E3) statt des Standort-Objekts
 * (Kurzzeichen, „seit", zwei Links) und der getrennten Zeile „Standort auf der Karte". Ein Tipp
 * öffnet {@link AnlageOrtBlatt}.
 */
export function AnlageOrtZeile({
  siteId,
  standort,
  antwort,
  onGeaendert,
  verweise,
}: {
  siteId: string;
  standort: StandortAmStichtag;
  antwort: StandorteAmStichtag;
  onGeaendert: (ergebnis: AnlageOrtErgebnis) => void;
  /**
   * §6: bis Schritt 2c „Gehört zu" eine eigene Fläche bekommt, bleiben „Anderem Standort
   * zuordnen"/„Zuordnung korrigieren" über diese Zeile erreichbar (`AnlageStandortZeile
   * nurVerweise`) - sonst verlöre ein vollständiger Standort diese Fähigkeit ersatzlos.
   */
  verweise?: ReactNode;
}) {
  const [offen, setOffen] = useState(false);
  const ausloeser = useRef<HTMLButtonElement>(null);
  const mehrere = mehrereStandorte(antwort);

  function schliesse() {
    setOffen(false);
    requestAnimationFrame(() => {
      if (ausloeser.current?.isConnected) ausloeser.current.focus();
    });
  }

  return (
    <div className="vp-kv-row">
      <dt className="vp-kv-k">{UEMS_STANDORT}</dt>
      <dd className="vp-kv-v">
        <Recht aktion="anlage.verwalten">
          <button
            ref={ausloeser}
            type="button"
            className="vp-ort-zeile-knopf"
            aria-label={`${UEMS_STANDORT} bearbeiten: ${ortZeileText(standort, mehrere)}`}
            onClick={() => setOffen(true)}
          >
            <span className="vp-ort-zeile-karte">
              <LocationMap
                lat={standort.lage?.breitengrad ?? null}
                lon={standort.lage?.laengengrad ?? null}
                onChange={() => {}}
                readonly
                kompakt
              />
            </span>
            <span className="vp-ort-zeile-text">{ortZeileText(standort, mehrere)}</span>
          </button>
        </Recht>
        {verweise}
        {offen && (
          <AnlageOrtBlatt
            siteId={siteId}
            standort={standort}
            mehrereStandorte={mehrere}
            onClose={schliesse}
            onGespeichert={(ergebnis) => {
              schliesse();
              onGeaendert(ergebnis);
            }}
          />
        )}
      </dd>
    </div>
  );
}

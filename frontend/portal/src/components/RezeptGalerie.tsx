/**
 * Die REZEPT-GALERIE als Renderer (Einheitsmodell Stufe 5a, Teil 5b.4).
 *
 * Sie hat ZWEI Wohnorte und ist deshalb eine eigene Komponente: hinter
 * „＋ Neue Regel" (die erste der drei Türen) und INLINE in der leeren
 * Regeln-Kapsel — „Was soll Ihre Anlage für Sie erledigen?" statt einer leeren
 * Liste mit einem Knopf. Beide zeigen damit garantiert dieselben Karten.
 *
 * Reiner Renderer über `regeln/rezepte.ts`.
 */
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  GALERIE_FRAGE,
  GALERIE_INTRO,
  KOMPONENTE_ANLEGEN,
  type RezeptGalerie as RezeptGalerieModel,
  type RezeptId,
  type RezeptKarte,
} from '../regeln/rezepte';
import './Regeln.css';

function GalerieKarte({
  karte,
  busy,
  onWaehlen,
}: {
  karte: RezeptKarte;
  busy: boolean;
  onWaehlen: (id: RezeptId) => void;
}) {
  return (
    <li className={`vp-rezept${karte.bald ? ' bald' : ''}${karte.waehlbar ? '' : ' aus'}`}>
      <div className="vp-rezept-text">
        <strong>
          {karte.titel}
          {karte.bald && <span className="vp-rezept-bald">bald verfügbar</span>}
        </strong>
        <p>{karte.ergebnis}</p>
        <p className="vp-rezept-fuss">{karte.fussnote}</p>
        {karte.grund && <p className="vp-rezept-grund">{karte.grund}</p>}
      </div>
      {karte.waehlbar && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onWaehlen(karte.id)}>
          Wählen
        </Button>
      )}
    </li>
  );
}

export function RezeptGalerieView({
  galerie,
  busy,
  showHidden,
  onToggleHidden,
  onWaehlen,
  onKomponenteAnlegen,
  withIntro = true,
}: {
  galerie: RezeptGalerieModel;
  busy: boolean;
  showHidden: boolean;
  onToggleHidden: () => void;
  onWaehlen: (id: RezeptId) => void;
  onKomponenteAnlegen: () => void;
  /** Die Frage + Einleitung darüber (im Dialog ja, in einer Karte mit eigenem Kopf nein). */
  withIntro?: boolean;
}) {
  return (
    <div className="vp-galerie">
      {withIntro && (
        <>
          <h3 className="vp-neuregel-frage">{GALERIE_FRAGE}</h3>
          <p className="vp-neuregel-intro">{GALERIE_INTRO}</p>
        </>
      )}

      {galerie.passend.length === 0 && (
        <p className="vp-neuregel-note">
          Für Ihre Anlage passt derzeit kein Rezept.
          {galerie.brauchtKomponente ? '' : ' Nutzen Sie den Baukasten.'}
        </p>
      )}

      {(galerie.passend.length > 0 || galerie.bald.length > 0) && (
        <ul className="vp-rezepte">
          {galerie.passend.map((k) => (
            <GalerieKarte key={k.id} karte={k} busy={busy} onWaehlen={onWaehlen} />
          ))}
          {galerie.bald.map((k) => (
            <GalerieKarte key={k.id} karte={k} busy={busy} onWaehlen={onWaehlen} />
          ))}
        </ul>
      )}

      {galerie.brauchtKomponente && (
        <div className="vp-neuregel-bridge">
          <p>{KOMPONENTE_ANLEGEN}</p>
          <Button size="sm" disabled={busy} onClick={onKomponenteAnlegen}>
            Komponente anlegen
          </Button>
        </div>
      )}

      {galerie.aufklappZeile && (
        <div className="vp-neuregel-hidden">
          <button
            type="button"
            className="vp-neuauto-disclose"
            aria-expanded={showHidden}
            onClick={onToggleHidden}
          >
            <Icon name={showHidden ? 'chevron-down' : 'chevron-right'} size={14} />
            {galerie.aufklappZeile} — trotzdem zeigen
          </button>
          {showHidden && (
            <ul className="vp-rezepte muted">
              {galerie.ausgeblendet.map((k) => (
                <GalerieKarte key={k.id} karte={k} busy={busy} onWaehlen={onWaehlen} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

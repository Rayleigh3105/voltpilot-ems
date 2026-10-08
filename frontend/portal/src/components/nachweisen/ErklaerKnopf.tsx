import { useState } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import { BEI_IHNEN, NICHT_VERWECHSELN, NORMWORT, type Erklaerung } from './erklaerung';
import { NwBlatt } from './NwBlatt';
import './Nachweisen.css';

/**
 * Der i-Knopf (Konzept Nachweisen n1, Runde 2, Baustein `.ikn`, Entscheid 24): neben einem Titel oder einer
 * Kartenüberschrift; er öffnet das Erklär-Blatt. Erklärt wird nur auf Antippen - unter dem Titel steht höchstens eine
 * Kurzzeile mit vier Wörtern.
 *
 * Sichtbar 28 px (im Kartenkopf `klein` 24 px), die Trefferfläche erweitert ein unsichtbarer Rand auf 44 px. Der Knopf
 * heißt für Vorleser wie die Frage des Blatts („Was ist ein Nachweis?“).
 */
export function ErklaerKnopf({
  erklaerung,
  klein = false,
  testId,
}: {
  erklaerung: Erklaerung;
  /** 24 px statt 28 px: im Kopf einer Karte und in einer Hinweis-Zeile. */
  klein?: boolean;
  testId?: string;
}) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={klein ? 'vp-nw-ikn is-klein' : 'vp-nw-ikn'}
        aria-label={erklaerung.frage}
        aria-haspopup="dialog"
        title={erklaerung.frage}
        onClick={() => setOffen(true)}
        data-testid={testId}
      >
        <Icon name="info" size={klein ? 14 : 15} />
      </button>
      <NwBlatt open={offen} titel={erklaerung.frage} onClose={() => setOffen(false)} testId="erklaer-blatt">
        <ErklaerInhalt erklaerung={erklaerung} />
      </NwBlatt>
    </>
  );
}

/** Der Inhalt des Erklär-Blatts (`.erkl`): Klartext, Bei Ihnen, Nicht verwechseln, zuletzt leise das Normwort. */
export function ErklaerInhalt({ erklaerung: e }: { erklaerung: Erklaerung }) {
  return (
    <div className="vp-nw-erkl">
      <p>{e.klartext}</p>
      {e.beiIhnen && (
        <p className="is-bsp">
          <b>{BEI_IHNEN}</b> {e.beiIhnen}
        </p>
      )}
      {e.nichtVerwechseln && (
        <p className="is-bsp">
          <b>{NICHT_VERWECHSELN}</b> {e.nichtVerwechseln}
        </p>
      )}
      {e.fachwort && (
        <p className="is-fw">
          {NORMWORT} {e.fachwort}
        </p>
      )}
    </div>
  );
}

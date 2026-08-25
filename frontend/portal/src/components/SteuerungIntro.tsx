/**
 * Der ERKLÄRKASTEN der Steuerung (Steuerung Stufe 8, Konzept
 * `data/vp-steuerung-konzept-b3` §3.9 „Erstbegegnung").
 *
 * Render-only: jedes Wort und jede Regel steht in `src/steuerungIntro.ts`.
 * Er lädt seinen „gesehen"-Zustand FAIL-SOFT aus der kunden-weiten Schicht
 * (`scope=tenant`, `layer=eigen`, `surface=cockpit` — der Grund für genau
 * diesen Ort steht im Kopf des reinen Moduls) und rendert, solange die Antwort
 * aussteht, GAR NICHTS: ein Kasten, der nach dem Laden verschwindet, wäre ein
 * Sprung im Layout — und einer, der zu früh erscheint, eine Behauptung über
 * etwas, das der Kunde vielleicht längst weggeklickt hat.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import {
  STEUERUNG_INTRO_SCHLIESSEN,
  STEUERUNG_INTRO_SCHLIESSEN_TITEL,
  STEUERUNG_INTRO_TITEL,
  STEUERUNG_INTRO_ZEILEN,
  introGesehen,
  mitGesehen,
} from '../steuerungIntro';
import type { CockpitLayoutDocument } from '../cockpitLayout';

/** Die eine Schicht, in der die Marke wohnt. */
interface Quelle {
  laden: () => Promise<CockpitLayoutDocument | null>;
  merken: (document: CockpitLayoutDocument) => Promise<unknown>;
}

const ECHTE_QUELLE: Quelle = {
  laden: () => api.tenantCockpitLayout('cockpit').then((r) => r.eigen?.document ?? null),
  merken: (document) => api.saveTenantCockpitLayout('eigen', document, 'cockpit'),
};

export function SteuerungIntro({ quelle = ECHTE_QUELLE }: { quelle?: Quelle }) {
  const [doc, setDoc] = useState<CockpitLayoutDocument | null | undefined>(undefined);
  const [weg, setWeg] = useState(false);

  useEffect(() => {
    let aktiv = true;
    quelle.laden().then(
      (d) => {
        if (aktiv) setDoc(d);
      },
      () => {
        // Fail-soft: ohne Antwort wird NICHTS behauptet - weder „gesehen"
        // noch „ungesehen". Der Kasten bleibt dann aus.
        if (aktiv) setDoc(undefined);
      },
    );
    return () => {
      aktiv = false;
    };
    // Der Zustand hängt am Kunden, nicht an der Anlage - er wird einmal je
    // Montierung geholt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (doc === undefined || weg || introGesehen(doc)) return null;

  const schliessen = () => {
    // Sofort weg - das Merken ist eine Bequemlichkeit, kein Tor. Scheitert es,
    // sieht der Kunde den Kasten beim nächsten Mal wieder; ihn stehen zu
    // lassen, bis der Server geantwortet hat, wäre die schlechtere Antwort auf
    // einen Klick, der „verstanden" sagt.
    setWeg(true);
    void quelle.merken(mitGesehen(doc)).catch(() => undefined);
  };

  return (
    <section className="vp-steuerung-intro" aria-labelledby="vp-steuerung-intro-titel">
      <div className="vp-steuerung-intro-head">
        <Icon name="info" size={18} />
        <h3 id="vp-steuerung-intro-titel">{STEUERUNG_INTRO_TITEL}</h3>
        <button
          type="button"
          className="vp-steuerung-intro-close"
          onClick={schliessen}
          title={STEUERUNG_INTRO_SCHLIESSEN_TITEL}
        >
          {STEUERUNG_INTRO_SCHLIESSEN}
        </button>
      </div>
      <ol className="vp-steuerung-intro-list">
        {STEUERUNG_INTRO_ZEILEN.map((z, i) => (
          <li key={z}>
            <span className="vp-steuerung-intro-num" aria-hidden="true">
              {i + 1}
            </span>
            {z}
          </li>
        ))}
      </ol>
    </section>
  );
}

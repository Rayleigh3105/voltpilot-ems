/**
 * Der ERSTBESUCH-HINWEIS der Verbraucher-Zone (Verbrauchsmanagement v1 P2,
 * Konzept `vp-verbrauchsmgmt-konzept-v1` §7.4).
 *
 * Render-only: jedes Wort und jede Regel steht in `src/steuerartIntro.ts`. Er
 * lädt seinen „gesehen"-Zustand FAIL-SOFT aus der ANLAGEN-Schicht
 * (`layer=eigen`) und rendert, solange die Antwort aussteht, GAR NICHTS — ein
 * Kasten, der nach dem Laden verschwindet, wäre ein Sprung im Layout.
 *
 * Er ist der Zwilling von `SteuerungIntro` mit EINEM Unterschied: dieser hier
 * wird JE ANLAGE gemerkt, weil er die Geräte DIESER Anlage aufzählt.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import type { CockpitLayoutDocument } from '../cockpitLayout';
import {
  STEUERART_INTRO_SCHLIESSEN,
  STEUERART_INTRO_SCHLIESSEN_TITEL,
  STEUERART_INTRO_SCHLUSS,
  STEUERART_INTRO_TITEL,
  introGesehen,
  introZeilen,
  mitGesehen,
  ranglisteSatz,
} from '../steuerartIntro';
import type { SiteVerbraucher } from '../verbraucherZone';

interface Quelle {
  laden: () => Promise<CockpitLayoutDocument | null>;
  merken: (document: CockpitLayoutDocument) => Promise<unknown>;
}

export function SteuerartIntro({ siteId, daten, quelle }: {
  siteId: string;
  daten: SiteVerbraucher | null;
  /** Test-Naht; ohne sie die echte Anlagen-Schicht. */
  quelle?: Quelle;
}) {
  const [doc, setDoc] = useState<CockpitLayoutDocument | null | undefined>(undefined);
  const [weg, setWeg] = useState(false);
  const zeilen = introZeilen(daten);

  useEffect(() => {
    let aktiv = true;
    const q: Quelle = quelle ?? {
      laden: () => api.cockpitLayout(siteId).then((r) => r.eigen?.document ?? null),
      merken: (d) => api.saveCockpitLayout(siteId, 'eigen', d),
    };
    q.laden().then(
      (d) => { if (aktiv) setDoc(d); },
      // Fail-soft: ohne Antwort wird NICHTS behauptet - der Kasten bleibt aus.
      () => { if (aktiv) setDoc(undefined); },
    );
    return () => { aktiv = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  // ⚠ Ohne eine einzige steuerbare Komponente entsteht der Kasten GAR NICHT:
  // „nichts ist verloren gegangen" über eine leere Anlage wäre eine Aussage
  // über nichts.
  if (zeilen.length === 0 || doc === undefined || weg || introGesehen(doc)) return null;

  const rang = ranglisteSatz(daten);
  const schliessen = () => {
    // Sofort weg - das Merken ist eine Bequemlichkeit, kein Tor.
    setWeg(true);
    const q: Quelle = quelle ?? {
      laden: () => api.cockpitLayout(siteId).then((r) => r.eigen?.document ?? null),
      merken: (d) => api.saveCockpitLayout(siteId, 'eigen', d),
    };
    void q.merken(mitGesehen(doc)).catch(() => undefined);
  };

  return (
    <section className="vp-steuerung-intro" aria-labelledby="vp-steuerart-intro-titel">
      <div className="vp-steuerung-intro-head">
        <Icon name="info" size={18} />
        <h3 id="vp-steuerart-intro-titel">{STEUERART_INTRO_TITEL}</h3>
        <button
          type="button"
          className="vp-steuerung-intro-close"
          onClick={schliessen}
          title={STEUERART_INTRO_SCHLIESSEN_TITEL}
        >
          {STEUERART_INTRO_SCHLIESSEN}
        </button>
      </div>
      <ul className="vp-steuerung-intro-list">
        {zeilen.map((z) => (
          <li key={z.entityId}>
            {z.text}
            {z.herkunft && <small> ({z.herkunft})</small>}
          </li>
        ))}
      </ul>
      {rang && <p className="vp-steuerung-intro-rang">{rang}</p>}
      <p className="vp-steuerung-intro-rang"><b>{STEUERART_INTRO_SCHLUSS}</b></p>
    </section>
  );
}

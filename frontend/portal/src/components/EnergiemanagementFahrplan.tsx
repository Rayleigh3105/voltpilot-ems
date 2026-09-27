import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import {
  FAHRPLAN_SATZ,
  FAHRPLAN_TITEL,
  fahrplan,
  fahrplanSchritte,
  fahrplanSteht,
  type FahrplanEingang,
  type Lage,
} from '../fahrplan';
import type { Route } from '../nav';
import { useRollen } from '../rollen';
import { GrenzSatz } from './GrenzSatz';
import './EnergiemanagementFahrplan.css';
import './UebersichtBausteine.css';

/** Eine Abfrage als {@link Lage}: lädt, nicht abrufbar oder da — nur wenn `an`, sonst bleibt sie ungefragt. */
function useLage<T>(an: boolean, laden: () => Promise<T>): Lage<T> {
  const [lage, setLage] = useState<Lage<T>>({ art: 'laedt' });
  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    setLage({ art: 'laedt' });
    // Auch ein Fehler vor der Antwort (etwa ein fehlender Weg) heißt „Nicht abrufbar.“ — nie ein Bruch der Übersicht.
    Promise.resolve()
      .then(laden)
      .then(
        (wert) => aktiv && setLage({ art: 'da', wert }),
        () => aktiv && setLage({ art: 'fehler' }),
      );
    return () => {
      aktiv = false;
    };
    // `laden` ist je Aufruf eine neue Funktion; gefragt wird einmal je `an`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [an]);
  return lage;
}

/**
 * K2 (Konzept „Energiemanagement ohne Fachsprache“, D4): die Karte „Ihr Energiemanagement“ auf der Übersicht des
 * Unternehmens — je Schritt, was hier festgehalten ist, und genau eine nächste Handlung. Die Schritte bildet das reine
 * Modul `fahrplan.ts` aus den Abfragen, die die Bereiche schon haben; hier wird geladen und gerendert. Stehen alle
 * Schritte, zeigt die Karte nichts mehr — dann bleibt „Was steht an“ (D4). Kein Erfüllungsgrad, keine Ampel, keine Zahl
 * über das Ganze (G4). Grenz-Satz und Verantwortungs-Satz stehen im Hinweis der Übersicht.
 */
export function EnergiemanagementFahrplan({
  messendeStandorte,
  onNavigate,
}: {
  /** Die Namen der Standorte, an denen gemessen wird (aus Ebene und Funktionen der Übersicht). */
  messendeStandorte: readonly string[];
  onNavigate: (ziel: Route) => void;
}) {
  const { selbst } = useRollen();
  const sichtbar = fahrplanSchritte(selbst ?? null);
  const bewerten = sichtbar.includes('bewerten');
  const eingang: FahrplanEingang = {
    messendeStandorte,
    rechte: selbst ?? null,
    umfang: useLage(bewerten, () => api.bewertungUmfang()),
    einsaetze: useLage(bewerten, () => api.energieeinsaetze().then((r) => r.energieeinsaetze)),
    berichte: useLage(bewerten || sichtbar.includes('rueckblick'), () => api.berichte().then((r) => r.berichte)),
    kennzahlen: useLage(true, () => api.kennzahlen().then((r) => r.kennzahlen)),
    bezugsbasen: useLage(true, () => api.bezugsbasisUebersicht()),
    verbesserung: useLage(sichtbar.includes('ziele'), () => api.verbesserungUebersicht()),
    verzeichnis: useLage(sichtbar.includes('nachweise'), () => api.energiemanagementVerzeichnis()),
  };
  const schritte = fahrplan(eingang);
  if (fahrplanSteht(schritte)) return null;
  return (
    <section className="vp-ub-baustein vp-fp" aria-labelledby="vp-fp-titel" data-testid="baustein-fahrplan">
      <div className="vp-ub-kopf">
        <h2 id="vp-fp-titel" className="vp-ub-titel">
          {FAHRPLAN_TITEL}
        </h2>
      </div>
      <p className="vp-ub-hinweis">{FAHRPLAN_SATZ}</p>
      <ol className="vp-fp-schritte">
        {schritte.map((s) => {
          const lage = s.festgehalten === true ? 'fest' : s.festgehalten === false ? 'offen' : 'unbekannt';
          return (
            <li key={s.key} className={`vp-fp-schritt is-${lage}`} data-testid={`fahrplan-${s.key}`}>
              <span className="vp-fp-marke" aria-hidden="true">
                {lage === 'fest' ? <Icon name="check" size={14} /> : null}
              </span>
              <div className="vp-fp-text">
                <h3 className="vp-fp-titel">{s.titel}</h3>
                <p className="vp-fp-stand" data-testid={`fahrplan-${s.key}-stand`}>
                  {s.stand}
                </p>
              </div>
              <button
                type="button"
                className="vp-ub-alle vp-fp-handlung"
                onClick={() => onNavigate(s.handlung.ziel)}
                data-testid={`fahrplan-${s.key}-handlung`}
              >
                {s.handlung.text}
                <Icon name="chevron-right" size={16} />
              </button>
            </li>
          );
        })}
      </ol>
      <GrenzSatz className="vp-ub-hinweis" verantwortung />
    </section>
  );
}

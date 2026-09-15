import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type StandortAmStichtag, type StandorteAmStichtag } from '../api';
import { Ortsbaum } from '../components/Ortsbaum';
import { StandAm } from '../components/StandAm';
import { TITEL_GEBAEUDE } from '../ortsbaum';
import { standAmListe } from '../standAm';
import './StandortBereichPage.css';

/** Der Tag konnte nicht gelesen werden — der Baum von heute bleibt, ein Stichtag bekommt „Erneut versuchen“. */
export const STAND_LADEFEHLER = 'Der Stand dieses Tages konnte nicht geladen werden.';

/**
 * „Standort › Gebäude“ (UEMS AP-13 IP-2, E4 = A, Ü6): `#/standort/{id}/gebaeude` — der Ortsbaum aus AP-02 IP-7 mit
 * „Stand am …“ (AP-02 IP-13) für EINEN Standort. Gebäude sind eine Sicht, keine vierte Ebene: keine Leiste und kein
 * Pfad-Glied am Gebäude.
 *
 * ⚠ Die Karte je Gebäude ist die Hülle `Ortsbaum.gebaeudeKarte`; sie klappt erst auf, wenn IP-10 ihre Blöcke
 *   (Energie · Messstellen · Kennzahlen) hineinreicht. Bis dahin reicht diese Seite nichts hinein — ein Aufklapper
 *   ohne Inhalt wäre ein Knopf ohne Ziel.
 * ⚠ EIN Datumsfeld je Seite (AP-02 IP-13): Liste und Baum folgen dem Stichtag, jede Antwort gilt nur für ihren Tag;
 *   gab es den Standort an dem Tag noch nicht, steht der Satz des Servers an seinem Platz, und mit Stichtag gibt es
 *   keinen Schreibweg.
 * ⚠ Ohne Gebäude und Bereiche zeigt der Baum L1 (Z4). Der Bereich „Gebäude“ hat dann keine Kachel — die Adresse gilt
 *   trotzdem, und „Gebäude anlegen“ steht dort.
 */
export function StandortGebaeudePage({
  standort,
  onGeaendert,
}: {
  standort: StandortAmStichtag;
  /** Nach jedem Speichern im Baum — das erste Gebäude lässt den Bereich „Gebäude“ entstehen. */
  onGeaendert?: () => void;
}) {
  const [stichtag, setStichtag] = useState<string | null>(null);
  const [heute, setHeute] = useState<string | null>(null);
  const [liste, setListe] = useState<StandorteAmStichtag | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const anfrage = useRef(0);

  useEffect(() => {
    const nummer = ++anfrage.current;
    setFehler(false);
    (stichtag ? api.standorte(stichtag) : api.standorte()).then(
      (l) => {
        // Eine überholte Antwort (der Tag wurde inzwischen gewechselt) zeigt nichts mehr.
        if (nummer !== anfrage.current) return;
        setListe(l);
        if (!stichtag) setHeute(l.stichtag);
      },
      () => {
        if (nummer === anfrage.current) setFehler(true);
      },
    );
  }, [stichtag, versuch]);

  const aktuell = liste && liste.stichtag === (stichtag ?? heute) ? liste : null;
  const sicht = aktuell ? standAmListe(aktuell, stichtag) : null;
  const eintrag = sicht?.eintraege.find((e) => e.standort.id === standort.id) ?? null;
  const archiv = stichtag ? (sicht?.archiviert.find((a) => a.standort.id === standort.id) ?? null) : null;
  // Heute trägt der Baum den Standort der Seite, bis die Liste da ist; mit Stichtag erst den Standort DIESES Tages.
  const baumStandort = eintrag?.art === 'standort' ? eintrag.standort : stichtag ? null : standort;

  return (
    <section className="vp-sb" aria-labelledby="vp-sb-gebaeude" data-testid="standort-gebaeude">
      <header className="vp-sb-kopf">
        <h1 id="vp-sb-gebaeude">{TITEL_GEBAEUDE}</h1>
        <p>{standort.name}</p>
      </header>

      {heute && <StandAm heute={heute} stichtag={stichtag} onStichtag={setStichtag} />}

      {fehler && stichtag && (
        <div className="vp-sb-karte" role="alert">
          <p className="vp-sb-hinweis">{STAND_LADEFEHLER}</p>
          <Button variant="outline" size="sm" onClick={() => setVersuch((v) => v + 1)}>
            Erneut versuchen
          </Button>
        </div>
      )}
      {!fehler && stichtag && !aktuell && (
        <div className="vp-sb-karte vp-sb-hinweis" aria-busy="true">
          Gebäude werden geladen …
        </div>
      )}
      {eintrag?.art === 'gab_es_noch_nicht' && (
        <div className="vp-sb-karte vp-sb-karte-still" data-testid="gab-es-noch-nicht">
          <p className="vp-sb-hinweis">{eintrag.satz}</p>
        </div>
      )}
      {!eintrag && archiv && (
        <div className="vp-sb-karte vp-sb-karte-still">
          <p className="vp-sb-hinweis">{archiv.satz}</p>
        </div>
      )}
      {baumStandort && (
        <div className="vp-sb-karte">
          <Ortsbaum
            standort={baumStandort}
            stichtag={stichtag}
            titelVersteckt
            onGeaendert={() => {
              setVersuch((v) => v + 1);
              onGeaendert?.();
            }}
          />
        </div>
      )}
    </section>
  );
}

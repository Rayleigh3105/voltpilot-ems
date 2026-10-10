import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type OrtsbaumAmStichtag, type StandortAmStichtag, type StandorteAmStichtag } from '../api';
import { GebaeudeKarte, GebaeudeZeitLeiste, useGebaeudeKarten } from '../components/GebaeudeKarte';
import { Ortsbaum } from '../components/Ortsbaum';
import { StandAm } from '../components/StandAm';
import type { Route } from '../nav';
import { TITEL_GEBAEUDE } from '../ortsbaum';
import { standAmListe } from '../standAm';
import type { Sprung } from '../uemsOberflaechen';
import './StandortBereichPage.css';

/** Der Tag konnte nicht gelesen werden — der Baum von heute bleibt, ein Stichtag bekommt „Erneut versuchen“. */
export const STAND_LADEFEHLER = 'Der Stand dieses Tages konnte nicht geladen werden.';

/**
 * „Standort › Gebäude“ (UEMS AP-13 IP-2, E4 = A, Ü6): `#/standort/{id}/gebaeude` — der Ortsbaum aus AP-02 IP-7 mit
 * „Stand am …“ (AP-02 IP-13) für EINEN Standort. Gebäude sind eine Sicht, keine vierte Ebene: keine Leiste und kein
 * Pfad-Glied am Gebäude.
 *
 * ⚠ Die Karte je Gebäude ist die Hülle `Ortsbaum.gebaeudeKarte`; seit IP-10 reicht diese Seite ihre drei Blöcke
 *   hinein (`components/GebaeudeKarte.tsx`). EIN Zeitraum gilt für alle Karten (Leiste über dem Baum, Ü3), und
 *   geladen wird EINMAL für die Seite — nicht je Karte.
 * ⚠ EIN Datumsfeld je Seite (AP-02 IP-13): Liste und Baum folgen dem Stichtag, jede Antwort gilt nur für ihren Tag;
 *   gab es den Standort an dem Tag noch nicht, steht der Satz des Servers an seinem Platz, und mit Stichtag gibt es
 *   keinen Schreibweg.
 * ⚠ Ohne Gebäude und Bereiche zeigt der Baum L1 (Z4). Der Bereich „Gebäude“ hat dann keine Kachel — die Adresse gilt
 *   trotzdem, und „Gebäude anlegen“ steht dort.
 */
export function StandortGebaeudePage({
  standort,
  onGeaendert,
  onNavigate,
  springe,
}: {
  standort: StandortAmStichtag;
  /** Nach jedem Speichern im Baum — das erste Gebäude lässt den Bereich „Gebäude“ entstehen. */
  onGeaendert?: () => void;
  /** IP-10: die Sprünge der Karte (Anlage › Energiebilanz, Kennzahl-Seite); ohne Wirt bleibt die Karte ohne Sprünge. */
  onNavigate?: (route: Route) => void;
  /** IP-10: der Sprung ins Register MIT Filter Ort — er trägt seine Adresse selbst. */
  springe?: (sprung: Sprung) => void;
}) {
  const [stichtag, setStichtag] = useState<string | null>(null);
  const [heute, setHeute] = useState<string | null>(null);
  const [liste, setListe] = useState<StandorteAmStichtag | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const anfrage = useRef(0);
  // IP-10: die Gebäude des gelesenen Tages — der Baum meldet sie, statt dass die Seite dieselbe Antwort zweimal holt.
  const [orte, setOrte] = useState<readonly { id: string; kurzzeichen: string }[]>([]);
  const nimmAntwort = useCallback(
    (a: OrtsbaumAmStichtag | null) => setOrte(a ? a.gebaeude.map((g) => ({ id: g.id, kurzzeichen: g.kurzzeichen })) : []),
    [],
  );

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
  // Alles, was die Karten brauchen, wird EINMAL für die Seite gelesen (Bilanzen, Register je Gebäude, Kennzahlen).
  const daten = useGebaeudeKarten(standort, orte, standort.anlagen);
  const karten = onNavigate && springe && orte.length > 0;

  return (
    <section className="vp-sb" aria-labelledby="vp-sb-gebaeude" data-testid="standort-gebaeude">
      <header className="vp-sb-kopf">
        <h1 id="vp-sb-gebaeude">{TITEL_GEBAEUDE}</h1>
        <p>{standort.name}</p>
      </header>

      {heute && <StandAm heute={heute} stichtag={stichtag} onStichtag={setStichtag} />}
      {karten && <GebaeudeZeitLeiste daten={daten} />}

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
            onAntwort={nimmAntwort}
            gebaeudeKarte={
              karten
                ? (knoten) => (
                    <GebaeudeKarte
                      knoten={knoten}
                      standort={standort}
                      stichtag={stichtag}
                      daten={daten}
                      onNavigate={onNavigate}
                      springe={springe}
                    />
                  )
                : undefined
            }
            onGeaendert={() => {
              setVersuch((v) => v + 1);
              onGeaendert?.();
              daten.neuLaden();
            }}
          />
        </div>
      )}
    </section>
  );
}

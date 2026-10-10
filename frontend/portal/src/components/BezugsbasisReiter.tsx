import { useEffect, useState } from 'react';
import { GrenzSatz } from './GrenzSatz';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Bezugsbasis, type BezugsbasisFassung, type Kennzahl } from '../api';
import * as B from '../bezugsbasisAnlegen';
import * as Bz from '../bezugsbasisEbene';
import { useRollen } from '../rollen';
import { BezugsbasisAssistent } from './BezugsbasisAssistent';
import { BezugsbasisFassungen, type NeueFassung } from './BezugsbasisFassungen';
import { BezugsbasisModellAnFassung } from './BezugsbasisModell';
import { ErrorState, Skeleton } from './States';
import './Bezugsbasis.css';

/** Was die Kennzahl-Seite über ihre Bezugsbasis weiß — `keine` heißt: die Route sagt, es gibt keine laufende. */
export type BezugsbasisLage =
  | { art: 'laedt' }
  | { art: 'fehler' }
  | { art: 'keine' }
  | {
      art: 'da';
      basis: Bezugsbasis;
      /** Die Fassung am Stichtag - die, die heute gilt (Energieziel setzen, Ebene). */
      fassung: BezugsbasisFassung | null;
      /** Die Fassung am Tag des Urteils (P4), falls eine andere - sie steht neben dem Urteil der Seite. */
      urteilsFassung?: BezugsbasisFassung | null;
    };

/**
 * Liest die laufende Bezugsbasis einer Kennzahl (UEMS AP-17 IP-9) über die EINE Naht `api.kennzahlBezugsbasen` und
 * dazu die Fassung, die die Basis-Zeile nennt (`GET …/fassungen/{n}`) - mit `stichtag` die an diesem Tag geltende bzw.
 * nächste (`fassungAm`). `an = false` fragt nichts ab (Anteil, B2).
 */
export function useBezugsbasis(
  kennzahlId: string,
  an: boolean,
  versuch: number,
  stichtag?: string,
  urteilsTag?: string,
): BezugsbasisLage {
  const [lage, setLage] = useState<BezugsbasisLage>({ art: 'laedt' });
  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    setLage({ art: 'laedt' });
    api
      .kennzahlBezugsbasen(kennzahlId)
      .then(async ({ bezugsbasen }) => {
        const basis = B.laufende(bezugsbasen);
        if (!basis) return aktiv && setLage({ art: 'keine' });
        const kurz = stichtag ? Bz.fassungAm(basis, stichtag) : B.zeilenFassung(basis);
        const fassung = kurz
          ? await api.bezugsbasisFassung(kennzahlId, basis.id, kurz.fassung).catch(() => null)
          : null;
        // Die Fassung des Urteils nur dann eigens lesen, wenn sie eine andere ist (Fassungswechsel am Stichtag).
        const amUrteil = urteilsTag ? Bz.fassungAm(basis, urteilsTag) : kurz;
        const urteilsFassung = amUrteil && amUrteil.fassung !== kurz?.fassung
          ? await api.bezugsbasisFassung(kennzahlId, basis.id, amUrteil.fassung).catch(() => null)
          : fassung;
        if (aktiv) setLage({ art: 'da', basis, fassung, urteilsFassung });
      })
      .catch(() => aktiv && setLage({ art: 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [kennzahlId, an, versuch, stichtag, urteilsTag]);
  return lage;
}

/**
 * Die Bezugsbasis an der Kennzahl (UEMS AP-17 IP-9, §5.1, §6.3) - seit Konzept Auswerten a1 §6.6 der Inhalt der Ebene
 * `…/kennzahlen/{id}/bezugsbasis` (`pages/BezugsbasisEbene.tsx`), die Titel, Status und Antwort trägt.
 * Ohne Basis der leere Zustand (§5.8) — der Knopf „Bezugsbasis anlegen“ nur mit `bezugsbasis.verwalten`, sonst nur der
 * Satz. Mit Basis ihre Fassungen mit Zustand; ein Entwurf wird bearbeitet (Recht `bezugsbasis.verwalten`) und — mit
 * `bezugsbasis.freigeben` — freigegeben bzw. bei Vier-Augen beantragt; einen Antrag gibt eine zweite Person frei oder
 * lehnt ihn ab (die Route prüft, dass es nicht die antragstellende ist). Der Grenz-Satz steht immer (SP3).
 */
export function BezugsbasisReiter({
  kennzahl,
  lage,
  zone,
  onNeu,
  stichtag,
}: {
  kennzahl: Kennzahl;
  lage: BezugsbasisLage;
  zone: string;
  onNeu: () => void;
  /** Der Tag, an dem „seit“, „ab“ und „bis“ der Fassungen gemessen werden; ohne Angabe heute in der Zone. */
  stichtag?: string;
}) {
  const rollen = useRollen();
  const verwalten = rollen.darf('bezugsbasis.verwalten', kennzahl.standort_id);
  const freigeben = rollen.darf('bezugsbasis.freigeben', kennzahl.standort_id);
  const [assistent, setAssistent] = useState<{ basis: Bezugsbasis | null; neu?: NeueFassung } | null>(null);
  const aenderbar = kennzahl.archiviert_am === null;

  return (
    <section className="vp-bb" aria-label={B.REITER_BEZUGSBASIS} data-testid="bezugsbasis-reiter">
      {lage.art === 'laedt' && (
        <div aria-busy="true">
          <Skeleton height={120} />
        </div>
      )}
      {lage.art === 'fehler' && <ErrorState message={B.LADEFEHLER} onRetry={onNeu} />}
      {lage.art === 'keine' && (
        <div className="vp-bb-leer" data-testid="bezugsbasis-leer">
          <p>{B.LEER_SATZ}</p>
          {verwalten && aenderbar && (
            <div className="vp-kz-aktionen">
              <Button size="sm" data-testid="bezugsbasis-anlegen-knopf" onClick={() => setAssistent({ basis: null })}>
                {B.KNOPF_ANLEGEN}
              </Button>
            </div>
          )}
        </div>
      )}
      {lage.art === 'da' && (
        <div className="vp-bb-ebene">
          {/* Konzept Auswerten a1 §6.6: Titel und Status trägt der Kopf der Ebene; hier der Zweck, falls es einen gibt. */}
          {lage.basis.zweck && (
            <p className="vp-kzs-text vp-bb-zweck" data-testid="bezugsbasis-zweck">
              <span className="vp-kz-leise">{Bz.ZWECK}</span> {lage.basis.zweck}
            </p>
          )}
          {lage.basis.fassungen.length === 0 ? (
            <div className="vp-bb-basis">
              <p className="vp-kz-leise">{`Verantwortlich: ${lage.basis.verantwortlich_name}`}</p>
              <p>Noch keine Fassung gebildet.</p>
              {verwalten && aenderbar && (
                <div className="vp-kz-aktionen">
                  <Button size="sm" data-testid="bezugsbasis-fassung-knopf" onClick={() => setAssistent({ basis: lage.basis })}>
                    {B.KNOPF_WEITER_BEARBEITEN}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            // IP-18: Zeitleiste, Anstoß, Frist, Faktoren und die Antworten — eigene Datei, hier nur der Einhängepunkt.
            <BezugsbasisFassungen
              kennzahl={kennzahl}
              basis={lage.basis}
              zone={zone}
              verwalten={verwalten && aenderbar}
              freigeben={freigeben}
              onNeu={onNeu}
              onAssistent={(neu) => setAssistent({ basis: lage.basis, neu: neu ?? undefined })}
              stichtag={stichtag}
            />
          )}
          {/* IP-14: die Fassung der Basis-Zeile im Einzelnen — Modell mit Punkten und Gerade, oder Basiswert und Monate. */}
          {lage.fassung && (
            <section className="vp-kz-block vp-kzs-karte vp-bb-modell-karte" data-testid="bezugsbasis-modell-karte">
              <BezugsbasisModellAnFassung kennzahl={kennzahl} fassung={lage.fassung} />
            </section>
          )}
        </div>
      )}
      <GrenzSatz className="vp-bb-grenze" />
      {assistent && (
        <BezugsbasisAssistent
          kennzahl={kennzahl}
          basis={assistent.basis}
          zone={zone}
          neu={assistent.neu}
          onClose={() => {
            setAssistent(null);
            onNeu();
          }}
        />
      )}
    </section>
  );
}

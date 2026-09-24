import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Bezugsbasis, type BezugsbasisFassung, type Kennzahl } from '../api';
import * as B from '../bezugsbasisAnlegen';
import { UEMS_NORMGRENZE } from '../glossar';
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
  | { art: 'da'; basis: Bezugsbasis; fassung: BezugsbasisFassung | null };

/**
 * Liest die laufende Bezugsbasis einer Kennzahl (UEMS AP-17 IP-9) über die EINE Naht `api.kennzahlBezugsbasen` und
 * dazu die Fassung, die die Basis-Zeile nennt (`GET …/fassungen/{n}`). `an = false` fragt nichts ab (Anteil, B2).
 */
export function useBezugsbasis(kennzahlId: string, an: boolean, versuch: number): BezugsbasisLage {
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
        const kurz = B.zeilenFassung(basis);
        const fassung = kurz
          ? await api.bezugsbasisFassung(kennzahlId, basis.id, kurz.fassung).catch(() => null)
          : null;
        if (aktiv) setLage({ art: 'da', basis, fassung });
      })
      .catch(() => aktiv && setLage({ art: 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [kennzahlId, an, versuch]);
  return lage;
}

/** Die Basis-Zeile oben an der Kennzahl (§5.8) — nur, wenn es eine Fassung gibt. */
export function BezugsbasisZeile({ lage, einheit }: { lage: BezugsbasisLage; einheit: string | null }) {
  if (lage.art !== 'da' || !lage.fassung) return null;
  return (
    <p className="vp-bb-zeile" data-testid="bezugsbasis-zeile">
      {B.basisZeile(lage.basis, lage.fassung, einheit)}
    </p>
  );
}

/**
 * Der Reiter „Bezugsbasis“ an der Kennzahl (UEMS AP-17 IP-9, §5.1, §6.3; AP-13-Ebenen-Regel: eine Fläche, eine Welt).
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
}: {
  kennzahl: Kennzahl;
  lage: BezugsbasisLage;
  zone: string;
  onNeu: () => void;
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
        <div className="vp-bb-basis">
          <h2>
            {B.REITER_BEZUGSBASIS} {lage.basis.kennzeichen}
          </h2>
          <p className="vp-kz-leise">
            Verantwortlich: {lage.basis.verantwortlich_name}
            {lage.basis.zweck ? ` · ${lage.basis.zweck}` : ''}
          </p>
          {lage.basis.fassungen.length === 0 ? (
            <>
              <p>Noch keine Fassung gebildet.</p>
              {verwalten && aenderbar && (
                <div className="vp-kz-aktionen">
                  <Button size="sm" data-testid="bezugsbasis-fassung-knopf" onClick={() => setAssistent({ basis: lage.basis })}>
                    {B.KNOPF_WEITER_BEARBEITEN}
                  </Button>
                </div>
              )}
            </>
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
            />
          )}
          {/* IP-14: die Fassung der Basis-Zeile im Einzelnen — Modell mit Punkten und Gerade, oder Basiswert und Monate. */}
          {lage.fassung && <BezugsbasisModellAnFassung kennzahl={kennzahl} fassung={lage.fassung} />}
        </div>
      )}
      <p className="vp-bb-grenze">{UEMS_NORMGRENZE}</p>
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

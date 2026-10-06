import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Kennzahl } from '../api';
import { kannBezugsbasis } from '../bezugsbasisAnlegen';
import { BezugsbasisReiter, useBezugsbasis } from '../components/BezugsbasisReiter';
import { BezugsbasisVergleich } from '../components/BezugsbasisVergleich';
import { Fehlergrenze } from '../components/Fehlergrenze';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import { ErrorState, Skeleton } from '../components/States';
import * as Bz from '../bezugsbasisEbene';
import { heuteIn, NICHT_GEFUNDEN } from '../kennzahlKarte';
import * as S from '../kennzahlSeite';
import './KennzahlSeite.css';

/**
 * Die Bezugsbasis einer Kennzahl, eine Ebene unter ihrer Seite (Konzept Auswerten a1 §6.6, PR2):
 * `#/portfolio/kennzahlen/{id}/bezugsbasis`. Oben die Antwort - womit verglichen wird und seit wann, wie verlässlich -,
 * darunter die Fassungen mit Freigabe und Prüfsumme, die Überprüfung mit ihren Antworten (die Marke
 * `bezugsbasis_ueberpruefung` der Wiedervorlage steht dort) und der Vergleich je Monat mit freier Wahl von Zeitraum und
 * Bezugsbasis. Gerechnet wird nichts; die Wörter bildet `bezugsbasisEbene.ts`.
 */
export function BezugsbasisEbene({ id, zone, onKennzahl }: { id: string; zone: string; onKennzahl: () => void }) {
  const [k, setK] = useState<Kennzahl | null>(null);
  const [fehler, setFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [versuch, setVersuch] = useState(0);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    // Mit Auswertung: ihr Monat sagt, wie weit der Server ist - danach heißen Fassungen „seit“, „ab“ oder „bis“.
    api.kennzahl(id, 'auswertung').then(
      (x) => aktiv && setK(x),
      (e) => aktiv && setFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);
  const an = k !== null && kannBezugsbasis(k);
  const lage = useBezugsbasis(id, an, versuch, k ? S.stichtag(k.auswertung?.monat, heuteIn(zone, Date.now())) : undefined);

  const zurueck = (
    <button type="button" className="vp-kz-zurueck" onClick={onKennzahl}>
      <Icon name="chevron-left" size={18} />
      {k?.name ?? S.TITEL_BEZUGSBASIS}
    </button>
  );
  if (fehler) {
    return (
      <div className="vp-kz vp-kzs" data-testid="bezugsbasis-ebene">
        {zurueck}
        {fehler === 'fehlt' ? <p className="vp-kz-leer">{NICHT_GEFUNDEN}</p> : <ErrorState message={S.SEITE_LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />}
      </div>
    );
  }
  if (!k) {
    return (
      <div className="vp-kz vp-kzs" data-testid="bezugsbasis-ebene" aria-busy="true">
        {zurueck}
        <Skeleton height={64} />
        <Skeleton height={200} />
      </div>
    );
  }

  const da = lage.art === 'da' ? lage : null;
  const kopf = Bz.ebenenKopf(k, da?.basis ?? null);
  const tag = S.stichtag(k.auswertung?.monat, heuteIn(zone, Date.now()));
  const status = da ? Bz.statusZeile(da.basis, da.fassung, tag) : null;
  const antwort = da?.fassung ? Bz.ebenenAntwort(da.fassung, k.einheit_anzeige) : null;
  const vorlaeufig = da?.fassung ? Bz.vorlaeufigSatz(da.fassung) : null;

  return (
    <GrenzSatzBereich>
      <div className="vp-kz vp-kzs" data-testid="bezugsbasis-ebene">
        {zurueck}
        <header className="vp-kzs-kopf">
          <div className="vp-kzs-kopf-text">
            <h1>
              {kopf.titel} {kopf.kennzeichen && <span className="vp-kz-kennzeichen">{kopf.kennzeichen}</span>}
            </h1>
            <p className="vp-kzs-meta">{kopf.unter}</p>
            {status && (
              <p className="vp-kzs-status" data-testid="bezugsbasis-status">
                <span className={`vp-kzs-punkt is-${status.ton}`} aria-hidden="true" />
                <span>{status.text}</span>
                {status.leise && <span className="vp-kzs-status-leise">{status.leise}</span>}
              </p>
            )}
          </div>
        </header>
        {antwort && (
          <div className="vp-kzs-antwort" data-testid="bezugsbasis-antwort">
            <p className="vp-kzs-satz">{antwort.satz}</p>
            <p className="vp-kzs-formal">{antwort.formal}</p>
          </div>
        )}
        {vorlaeufig && (
          <div className="vp-kzs-hinweis is-warn" data-testid="bezugsbasis-vorlaeufig-hinweis">
            <span className="vp-kzs-hinweis-icon" aria-hidden="true">
              <Icon name="alert-triangle" size={16} />
            </span>
            <div className="vp-kzs-hinweis-text">
              <b>{vorlaeufig.fett}</b> {vorlaeufig.satz}
            </div>
          </div>
        )}
        {an ? (
          <Fehlergrenze key="bezugsbasis">
            <BezugsbasisReiter kennzahl={k} lage={lage} zone={zone} stichtag={tag} onNeu={() => setVersuch((v) => v + 1)} />
          </Fehlergrenze>
        ) : (
          <p className="vp-kz-leise">{Bz.OHNE_BEZUGSBASIS_ANTEIL}</p>
        )}
        {da && da.basis.fassungen.some((f) => f.freigabe_status === 'freigegeben') && (
          <details className="vp-kz-block vp-kzs-karte vp-kzs-aufklapp" data-testid="bezugsbasis-vergleich-aufklapp">
            <summary>
              {Bz.VERGLEICH_JE_MONAT}
              <Icon name="chevron-down" size={18} className="vp-kzs-aufklapp-chev" aria-hidden="true" />
            </summary>
            <Fehlergrenze key="vergleich">
              <BezugsbasisVergleich kennzahlId={k.id} standort={k.standort_id} />
            </Fehlergrenze>
          </details>
        )}
        <GrenzHinweis />
      </div>
    </GrenzSatzBereich>
  );
}

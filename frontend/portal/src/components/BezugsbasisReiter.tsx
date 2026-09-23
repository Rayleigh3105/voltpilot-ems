import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Bezugsbasis, type BezugsbasisFassung, type BezugsbasisFassungKurz, type Kennzahl } from '../api';
import * as B from '../bezugsbasisAnlegen';
import { UEMS_NORMGRENZE } from '../glossar';
import { useRollen } from '../rollen';
import { datumText } from '../uemsOrtsbaum';
import { BezugsbasisAssistent, FreigabeFormular } from './BezugsbasisAssistent';
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
  const [assistent, setAssistent] = useState<{ basis: Bezugsbasis | null } | null>(null);
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
            <ol className="vp-bb-fassungen">
              {[...lage.basis.fassungen]
                .sort((a, b) => b.fassung - a.fassung)
                .map((f) => (
                  <FassungEintrag
                    key={f.fassung}
                    kennzahl={kennzahl}
                    basis={lage.basis}
                    f={f}
                    verwalten={verwalten && aenderbar}
                    freigeben={freigeben}
                    onBearbeiten={() => setAssistent({ basis: lage.basis })}
                    onNeu={onNeu}
                    vieraugen={lage.fassung?.fassung === f.fassung ? (lage.fassung.vieraugen ?? null) : null}
                  />
                ))}
            </ol>
          )}
        </div>
      )}
      <p className="vp-bb-grenze">{UEMS_NORMGRENZE}</p>
      {assistent && (
        <BezugsbasisAssistent
          kennzahl={kennzahl}
          basis={assistent.basis}
          zone={zone}
          onClose={() => {
            setAssistent(null);
            onNeu();
          }}
        />
      )}
    </section>
  );
}

function FassungEintrag({
  kennzahl,
  basis,
  f,
  verwalten,
  freigeben,
  onBearbeiten,
  onNeu,
  vieraugen,
}: {
  kennzahl: Kennzahl;
  basis: Bezugsbasis;
  f: BezugsbasisFassungKurz;
  verwalten: boolean;
  freigeben: boolean;
  onBearbeiten: () => void;
  onNeu: () => void;
  /** Aus der geladenen Fassung, wenn es dieselbe ist — sonst unbekannt (die Route entscheidet). */
  vieraugen: boolean | null;
}) {
  const ton = f.freigabe_status === 'freigegeben' ? 'ok' : f.freigabe_status === 'abgelehnt' ? 'tint' : 'warn';
  return (
    <li className="vp-bb-fassung" data-testid={`bezugsbasis-fassung-${f.fassung}`}>
      <p>
        <strong>Fassung {f.fassung}</strong> · {B.referenzperiodeText(f.referenzperiode)} <Badge variant={ton}>{B.FREIGABE_WORT[f.freigabe_status]}</Badge>
      </p>
      <p>
        {B.methodeWort(f.methode)}
        {f.basiswert ? ` ${B.dezimal(f.basiswert)} ${B.einheitJe(kennzahl.einheit_anzeige)}` : ''}
        {f.datenlage === 'vorlaeufig' ? ' · vorläufig' : ''} · gilt ab {datumText(f.gilt_ab)}
      </p>
      <p className="vp-kz-leise">Prüfsumme {B.pruefsummeKurz(f.pruefsumme)}</p>
      {f.freigabe_status === 'entwurf' && verwalten && (
        <>
          <div className="vp-kz-aktionen">
            <Button variant="outline" size="sm" data-testid="bezugsbasis-bearbeiten-knopf" onClick={onBearbeiten}>
              {B.KNOPF_WEITER_BEARBEITEN}
            </Button>
          </div>
        </>
      )}
      {f.freigabe_status === 'entwurf' && freigeben && (
        <FreigabeFormular kennzahl={kennzahl} basis={basis} fassung={f.fassung} art="entwurf" vieraugen={vieraugen} onFertig={onNeu} />
      )}
      {f.freigabe_status === 'beantragt' && freigeben && (
        <FreigabeFormular kennzahl={kennzahl} basis={basis} fassung={f.fassung} art="antrag" vieraugen={vieraugen} onFertig={onNeu} />
      )}
    </li>
  );
}

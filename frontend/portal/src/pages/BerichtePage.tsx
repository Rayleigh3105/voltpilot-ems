import { useRollen } from '../rollen';
import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bericht } from '../api';
import { ANLEGEN_KNOPF, BEWERTUNG_VORLAGE, darf } from '../berichtDialoge';
import { BerichtAnlegenDialog } from '../components/BerichtAnlegenDialog';
import { ErrorState, Skeleton } from '../components/States';
import {
  amStandort,
  LADEN,
  LEER,
  LEER_STANDORT,
  listenFehler,
  listenKarte,
  sortiert,
  TITEL,
  type ListenKarte,
} from '../berichtSeite';
import { STANDORT_BERICHTE } from '../ebenenNav';
import { useBerichtRechte } from '../useBerichtRechte';
import { BerichtSeite } from './BerichtSeite';
import './BerichtePage.css';

/**
 * „Unternehmen › Berichte“ (UEMS AP-12 IP-13, `#/portfolio/berichte`) und die Berichtsseite
 * (`#/portfolio/berichte/{kennung}`) — seit AP-13 IP-2 auch „Berichte dieses Standorts“
 * (`#/standort/{id}/berichte`, Ü8/K3): dieselbe Liste, nur Berichte mit Geltung genau dieser Standort.
 *
 * Die Liste liest `GET /api/v1/berichte` (nur, was die Person lesen darf, G2) und zeigt je Bericht Vorlage, Geltung,
 * Zeitraum und den Vermerk (R5); jede Ableitung steht im reinen Modul `berichtSeite.ts`. Eine 403 (die Unterstützung
 * liest nie einen Bericht) steht als Satz der Route da, ohne „Erneut versuchen“.
 *
 * AP-12 IP-14: „Bericht anlegen“ steht im Kopf, wenn die Person irgendwo anlegen darf (am Standort: an diesem); der
 * Dialog öffnet nach dem Anlegen die Berichtsseite mit dem frischen Entwurf.
 *
 * ⚠ „letzter Abruf“ kommt mit dem Abruf-Protokoll (IP-10) — vorher keine Spalte ohne Ziel.
 */
export function BerichtePage({
  kennung = null,
  onOeffnen,
  onListe,
  standort = null,
  onBewertung,
}: {
  kennung?: string | null;
  onOeffnen: (kennung: string) => void;
  onListe: () => void;
  /** AP-13 IP-2: „Berichte dieses Standorts“; `null` = das Unternehmen. */
  standort?: { id: string; name: string } | null;
  /** AP-16 IP-25: eine neu angelegte energetische Bewertung öffnet die Seite „Bewertung“ statt der Berichtsseite. */
  onBewertung?: () => void;
}) {
  if (kennung) {
    return (
      <BerichtSeite key={kennung} kennung={kennung} onListe={onListe} zurListe={standort ? STANDORT_BERICHTE : undefined} />
    );
  }
  return <BerichteListe standort={standort} onOeffnen={onOeffnen} onBewertung={onBewertung} />;
}

function BerichteListe({
  standort,
  onOeffnen,
  onBewertung,
}: {
  standort: { id: string; name: string } | null;
  onOeffnen: (kennung: string) => void;
  onBewertung?: () => void;
}) {
  const [liste, setListe] = useState<Bericht[] | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const standortId = standort?.id ?? null;
  const rechte = useBerichtRechte();
  const rollen = useRollen();
  const [anlegen, setAnlegen] = useState(false);
  // Der Knopf erst mit Antwort der Selbstauskunft; eine 403 der Liste (Unterstützung) hat keinen.
  const darfAnlegen =
    rechte !== undefined &&
    !(fehler && !fehler.erneut) &&
    (standortId
      ? darf(rechte, 'anlegen', 'standort', standortId)
      : darf(rechte, 'anlegen', 'standort', null) || darf(rechte, 'anlegen', 'unternehmen', null));

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.berichte().then(
      ({ berichte }) => aktiv && setListe(standortId ? amStandort(berichte, standortId) : berichte),
      (e) => aktiv && setFehler(listenFehler(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch, standortId]);

  return (
    <div className="vp-br" data-testid="berichte">
      <header className="vp-br-kopf vp-br-kopf-liste">
        <div>
          <h1>{standort ? STANDORT_BERICHTE : TITEL}</h1>
          {standort && <p className="vp-br-kopf-ort">{standort.name}</p>}
        </div>
        {!darfAnlegen && rollen.selbst && <p className="vp-muted" role="note">{rollen.grund}</p>}
        {darfAnlegen && (
          <Button size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setAnlegen(true)} data-testid="bericht-anlegen-knopf">
            {ANLEGEN_KNOPF}
          </Button>
        )}
      </header>
      {fehler ? (
        fehler.erneut ? (
          <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
        ) : (
          <p className="vp-br-hinweis" role="status" data-testid="berichte-verwehrt">
            {fehler.satz}
          </p>
        )
      ) : !liste ? (
        <div aria-busy="true" aria-label={LADEN}>
          <Skeleton height={112} />
        </div>
      ) : liste.length === 0 ? (
        <p className="vp-br-leer">{standort ? LEER_STANDORT : LEER}</p>
      ) : (
        <ul className="vp-br-liste">
          {sortiert(liste).map((b) => (
            <li key={b.kennung}>
              <BerichtKarte karte={listenKarte(b)} onOeffnen={() => onOeffnen(b.kennung)} />
            </li>
          ))}
        </ul>
      )}
      {anlegen && (
        <BerichtAnlegenDialog
          open
          onClose={() => setAnlegen(false)}
          rechte={rechte ?? null}
          standortId={standortId}
          onAngelegt={(b) => {
            setAnlegen(false);
            if (b.vorlage === BEWERTUNG_VORLAGE && onBewertung) onBewertung();
            else onOeffnen(b.kennung);
          }}
          onOeffnen={(kennung) => {
            setAnlegen(false);
            onOeffnen(kennung);
          }}
        />
      )}
    </div>
  );
}

function BerichtKarte({ karte, onOeffnen }: { karte: ListenKarte; onOeffnen: () => void }) {
  return (
    <button type="button" className="vp-br-karte" data-testid="bericht-karte" onClick={onOeffnen}>
      <span className="vp-br-karte-kopf">
        <span className="vp-br-kennung">{karte.kennung}</span>
        {karte.archiviert && <Badge variant="tint">{karte.archiviert}</Badge>}
        <span className="vp-br-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </span>
      <span className="vp-br-name">{karte.titel}</span>
      {karte.stand && (
        <span className="vp-br-karte-stand">
          <Badge variant={karte.standTon} data-testid="bericht-stand">
            {karte.stand}
          </Badge>
        </span>
      )}
      <span className="vp-br-unter">{karte.unter}</span>
    </button>
  );
}

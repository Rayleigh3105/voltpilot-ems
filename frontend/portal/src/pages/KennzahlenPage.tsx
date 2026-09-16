import { Recht } from '../components/Recht';
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { KennzahlAnlegenDialog, type KopieVon } from '../components/KennzahlAnlegenDialog';
import { KennzahlKarte, useKennzahlenListe } from '../components/KennzahlListe';
import { ErrorState, Skeleton } from '../components/States';
import { KNOPF_ANLEGEN, LEER_SATZ } from '../kennzahlAnlegen';
import {
  LADEFEHLER,
  LADEN,
  LEER,
  LEER_STANDORT,
  listenKarte,
  TITEL,
} from '../kennzahlKarte';
import { STANDORT_KENNZAHLEN } from '../ebenenNav';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { KennzahlSeite } from './KennzahlSeite';
import './KennzahlenPage.css';

/**
 * „Unternehmen › Kennzahlen“ (UEMS AP-11 IP-13, `#/portfolio/kennzahlen`) und die Kennzahl-Seite
 * (`#/portfolio/kennzahlen/{id}`, §5.3) — eine Portfolio-Welt neben „Standorte“, bis AP-13 die Ebenen-Navigation
 * bringt.
 *
 * Die Liste liest `GET /api/v1/kennzahlen` und je Kennzahl das Fenster des Verlaufs in ihrer Grundperiode
 * (`…/werte`, IP-7) — gezeigt wird der jüngste Schritt mit einer Zeile; jede Ableitung steht im reinen Modul
 * `kennzahlKarte.ts`.
 *
 * AP-11 IP-14: „Kennzahl anlegen“ im Kopf der Liste und „Kopieren“ im Kopf der Seite öffnen denselben Assistenten
 * (`KennzahlAnlegenDialog`) — er gehört der Welt, nicht der Karte; nach dem Anlegen lädt die Liste neu.
 * AP-11 IP-15: „Berechnung ändern ab …“ an der Seite öffnet denselben Assistenten im Modus „ändern“; nach dem Speichern
 * lädt die Seite neu.
 * ⚠ R-A7: antwortet `…/werte` für eine gelistete Kennzahl mit 404, trägt die Karte die Hinweiszeile ohne Wert.
 */
export function KennzahlenPage({
  kennzahlId = null,
  onOeffnen,
  onListe,
  zone = VORGABE_ZEITZONE,
  standort = null,
}: {
  kennzahlId?: string | null;
  onOeffnen: (id: string) => void;
  onListe: () => void;
  /** Die Zeitzone, in der „heute“ liegt. */
  zone?: string;
  /** AP-13 IP-2 (Ü8): „Kennzahlen dieses Standorts“ — die Liste nur mit Geltung im Standort; `null` = das Unternehmen. */
  standort?: { id: string; name: string } | null;
}) {
  const [assistent, setAssistent] = useState<{ quelle: KopieVon | null; aendern?: KopieVon } | null>(null);
  const [neu, setNeu] = useState(0);
  const dialog = assistent && (
    <KennzahlAnlegenDialog
      open
      quelle={assistent.quelle}
      aendern={assistent.aendern ?? null}
      zone={zone}
      onClose={() => setAssistent(null)}
      onAngelegt={() => setNeu((n) => n + 1)}
      onGeaendert={() => setNeu((n) => n + 1)}
      onZurKennzahl={(id) => {
        setAssistent(null);
        onOeffnen(id);
      }}
    />
  );
  if (kennzahlId) {
    return (
      <>
        {/* Nach „Berechnung ändern“ lädt die Seite neu (Schlüssel) — der Dialog daneben bleibt auf „Fertig“ stehen. */}
        <KennzahlSeite
          key={`${kennzahlId}|${neu}`}
          id={kennzahlId}
          zone={zone}
          onListe={onListe}
          zurListe={standort ? STANDORT_KENNZAHLEN : undefined}
          onKopieren={(quelle) => setAssistent({ quelle })}
          onBerechnungAendern={(quelle) => setAssistent({ quelle: null, aendern: quelle })}
        />
        {dialog}
      </>
    );
  }
  return (
    <>
      <KennzahlenListe
        key={neu}
        zone={zone}
        standort={standort}
        onOeffnen={onOeffnen}
        onAnlegen={() => setAssistent({ quelle: null })}
      />
      {dialog}
    </>
  );
}

function KennzahlenListe({
  zone,
  standort,
  onOeffnen,
  onAnlegen,
}: {
  zone: string;
  standort: { id: string; name: string } | null;
  onOeffnen: (id: string) => void;
  onAnlegen: () => void;
}) {
  const [versuch, setVersuch] = useState(0);
  const standortId = standort?.id ?? null;
  const { liste, werte, fehler, ausserhalb } = useKennzahlenListe(zone, standortId, versuch);

  // Archivierte stehen hinten — sonst die Reihenfolge der Route.
  const sortiert = liste ? [...liste].sort((a, b) => Number(a.archiviert_am !== null) - Number(b.archiviert_am !== null)) : [];

  return (
    <div className="vp-kz" data-testid="kennzahlen">
      <header className="vp-kz-kopf vp-kz-kopf-aktion">
        {standort ? (
          <div className="vp-kz-kopf-text">
            <h1>{STANDORT_KENNZAHLEN}</h1>
            <p>{standort.name}</p>
          </div>
        ) : (
          <h1>{TITEL}</h1>
        )}
        <Recht aktion={standortId ? 'kennzahl.standort_definieren' : 'kennzahl.unternehmen_definieren'} standort={standortId}><Button size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={onAnlegen} data-testid="kennzahl-anlegen-knopf">
          {KNOPF_ANLEGEN}
        </Button></Recht>
      </header>
      {ausserhalb && <p className="vp-kz-hinweis" role="note">{ausserhalb}</p>}
      {fehler ? (
        <ErrorState message={LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !liste ? (
        <div aria-busy="true" aria-label={LADEN}>
          <Skeleton height={132} />
        </div>
      ) : liste.length === 0 ? (
        <p className="vp-kz-leer">
          {standort ? LEER_STANDORT : LEER} {LEER_SATZ}
        </p>
      ) : (
        <ul className="vp-kz-liste">
          {sortiert.map((k) => (
            <li key={k.id}>
              <KennzahlKarte karte={listenKarte(k, werte[k.id] ?? { art: 'laedt' })} onOeffnen={() => onOeffnen(k.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * VERSIONEN AM WERT (UEMS AP-08 IP-18): was vorher dastand, wer es geändert
 * hat, wann und warum — für eine Zahl der Tages- oder Monatskarte, die schon
 * einmal geändert wurde.
 *
 * Diese Datei RENDERT nur. Jede Zahl, jedes Wort und jeder Satz kommen aus der
 * reinen `src/uemsWertVersionen.ts` (die Zahl dort über den Ergebnis-Vertrag).
 * Sie LIEST nur — `GET /api/v1/messstellen/{kennzeichen}/werte/versionen` für
 * genau den Schritt der Karte, und nur, wenn er zwei oder mehr Versionen hat.
 *
 * Die Historie steht in einem ZWEITEN, gestapelten `Modal` über dem Dialog der
 * Tages- und Monatswerte: am Telefon ein ganzer Bildschirm für die Versionen,
 * Escape und ✕ führen zurück zur Karte (`docs/agents/root/uems-tageskarte.md`).
 */
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api } from '../api';
import {
  DANACH,
  VERSIONEN_TITEL,
  VORHER,
  historie,
  type EntscheidungAnzeige,
  type Einstieg,
  type HistorieAnzeige,
  type HistorieWert,
  type Urheberschaft,
  type VersionAnzeige,
} from '../uemsWertVersionen';
import { ErrorState, Skeleton } from './States';
import './WertVersionen.css';

/** Der Einstieg unten in der Karte. Der Auslöser nimmt den Fokus ausdrücklich (iOS fokussiert einen Klick nicht). */
export function VersionenEinstieg({ einstieg, onOeffnen }: { einstieg: Pick<Einstieg, 'text' | 'unter'>; onOeffnen: () => void }) {
  return (
    <button
      type="button"
      className="vp-wv-einstieg"
      data-testid="werte-versionen"
      onClick={(e) => {
        e.currentTarget.focus();
        onOeffnen();
      }}
    >
      <Icon name="history" size={18} />
      <span className="vp-wv-einstieg-text">
        <span className="vp-wv-einstieg-titel">{einstieg.text}</span>
        <span className="vp-wv-einstieg-unter">{einstieg.unter}</span>
      </span>
      <Icon name="chevron-right" size={18} />
    </button>
  );
}

export function VersionenDialog({
  open,
  kennzeichen,
  einstieg,
  messstelle,
  periode,
  onClose,
}: {
  open: boolean;
  kennzeichen: string;
  einstieg: Einstieg | null;
  /** „MS-10 · Netzbezug Halle 2“. */
  messstelle: string;
  /** Der Titel der Karte: „Di 03.11.2026“ bzw. „November 2026“. */
  periode: string;
  onClose: () => void;
}) {
  // Der Modal bleibt eingehängt und schließt selbst (Ausblenden, dann Fokus zurück an den Einstieg).
  if (!einstieg) return null;
  const { raster, von, bis } = einstieg.anfrage;
  return (
    <VersionenModal
      open={open}
      objekt={messstelle}
      periode={periode}
      schluessel={`${kennzeichen}|${raster}|${von}|${bis}`}
      laden={() => api.messstelleWerteVersionen(kennzeichen, raster, von, bis).then(historie)}
      onClose={onClose}
    />
  );
}

/**
 * Der gestapelte Dialog mit den Versionen EINER Periode — geteilt von der Messstelle ({@link VersionenDialog}) und
 * der Kennzahl (AP-11 IP-13, `kennzahlKarte.kennzahlHistorie`). Wer lädt und spricht, sagt `laden`; gefragt wird,
 * wenn der Dialog offen ist und `schluessel` (die gemeinte Periode) wechselt.
 */
export function VersionenModal({
  open,
  objekt,
  periode,
  schluessel,
  laden,
  onClose,
}: {
  open: boolean;
  /** „MS-10 · Netzbezug Halle 2“ bzw. „KZ-0001 · Stromeinsatz Montage je Stück — Halle 2“. */
  objekt: string;
  /** Der Titel der Karte: „Di 03.11.2026“ bzw. „November 2026“. */
  periode: string;
  schluessel: string;
  laden: () => Promise<HistorieAnzeige>;
  onClose: () => void;
}) {
  const [geladen, setGeladen] = useState<{ schluessel: string; historie: HistorieAnzeige } | null>(null);
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);
  // `laden` entsteht bei jedem Zeichnen neu — nur Zeichenketten sind Abhängigkeiten.
  const ladenRef = useRef(laden);
  useEffect(() => {
    ladenRef.current = laden;
  });
  const voll = `${schluessel}|${neu}`;

  useEffect(() => {
    if (!open) return;
    let aktiv = true;
    setFehler(false);
    ladenRef
      .current()
      .then((h) => aktiv && setGeladen({ schluessel: voll, historie: h }))
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [open, voll]);

  const aktuell = geladen?.schluessel === voll ? geladen.historie : null;

  return (
    <Modal open={open} onClose={onClose} title={VERSIONEN_TITEL}>
      <div className="vp-wv" data-testid="versionen-dialog">
        <p className="vp-wv-kopf">
          <span className="vp-wv-messstelle">{objekt}</span>
          <span className="vp-wv-periode">{periode}</span>
        </p>
        {fehler ? (
          <ErrorState message="Die Versionen konnten nicht geladen werden." onRetry={() => setNeu((n) => n + 1)} />
        ) : !aktuell ? (
          <div aria-busy="true">
            <Skeleton height={148} />
          </div>
        ) : aktuell.leer ? (
          <p className="vp-wv-leer">{aktuell.leer}</p>
        ) : (
          <ol className="vp-wv-liste">
            {aktuell.versionen.map((v) => (
              <Version key={v.schluessel} v={v} />
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

function Version({ v }: { v: VersionAnzeige }) {
  return (
    <li className="vp-wv-version" data-testid="version">
      <div className="vp-wv-version-kopf">
        <span className="vp-wv-version-titel">{v.titel}</span>
        {v.etikett && <Badge variant="tint">{v.etikett}</Badge>}
      </div>
      <dl className="vp-wv-werte">
        {v.vorher && <Wert name={VORHER} w={v.vorher} alt />}
        <Wert name={v.vorher ? DANACH : null} w={v.danach} />
      </dl>
      {v.gebildet && <p className="vp-wv-gebildet">{v.gebildet}</p>}
      {v.ohneEntscheidung && <p className="vp-wv-ehrlich">{v.ohneEntscheidung}</p>}
      {v.entscheidungen.length > 0 && (
        <ul className="vp-wv-entscheidungen">
          {v.entscheidungen.map((e) => (
            <Entscheidung key={e.schluessel} e={e} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Wert({ name, w, alt = false }: { name: string | null; w: HistorieWert; alt?: boolean }) {
  return (
    <div className={`vp-wv-wert${alt ? ' is-alt' : ''}`} data-testid={alt ? 'wert-alt' : 'wert-neu'}>
      {name && <dt>{name}</dt>}
      <dd className="vp-wv-zahl">{w.zahl}</dd>
      {w.info && <dd className={`vp-wv-info is-${w.ton}`}>{w.info}</dd>}
    </div>
  );
}

function Entscheidung({ e }: { e: EntscheidungAnzeige }) {
  return (
    <li className="vp-wv-entscheidung" data-testid="entscheidung">
      <span className="vp-wv-vorgang">{e.vorgang}</span>
      {e.was && <p className="vp-wv-was">{e.was}</p>}
      {e.fehlt && <p className="vp-wv-ehrlich">{e.fehlt}</p>}
      {e.fassung && <Wer u={e.fassung} />}
      {e.angelegt && (
        <div className="vp-wv-angelegt" data-testid="angelegt">
          <Wer u={e.angelegt} />
        </div>
      )}
    </li>
  );
}

function Wer({ u }: { u: Urheberschaft }) {
  return (
    <>
      <p className="vp-wv-wer">
        {u.wer}
        {u.wann && (
          <>
            {' · '}
            <span className="vp-wv-wann">{u.wann}</span>
          </>
        )}
      </p>
      <p className={u.warumFehlt ? 'vp-wv-ehrlich' : 'vp-wv-warum'} data-testid="warum">
        {u.warum}
      </p>
      {u.beleg && <p className="vp-wv-was">{u.beleg}</p>}
    </>
  );
}

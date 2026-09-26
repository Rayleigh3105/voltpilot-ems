/**
 * Der VERLAUF als Fläche (Geräteseiten Stufe 2, Konzept §6) - EIN Modul für
 * DREI Wirte: die anlagenweite Befehle-Seite, die Geräteseite und die Box.
 *
 * **Zwei Verlaufs-Formen wären zwei Wahrheiten** (Captain-Entscheid D4a),
 * deshalb rendert hier genau ein Bauteil die Liste, und ein Haken lädt sie: die
 * Seiten-Mechanik (Fenster, Cursor, stiller Takt) gibt es nur einmal, statt
 * dreimal daneben zu liegen.
 *
 * Diese Datei RENDERT und LÄDT nur - jede Regel und jeder Satz kommt aus der
 * reinen `src/befehleVerlauf.ts` bzw. `src/befehle.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type CommandHistory } from '../api';
import {
  AKTIONSZEILE_LABEL,
  neuesteZuerst,
  SEITE,
  verlaufFenster,
  type VerlaufAktion,
  type VerlaufView,
} from '../befehleVerlauf';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { ErrorState, Skeleton } from './States';
import '../pages/Befehle.css';

/** Was der Haken einem Wirt gibt. */
export interface VerlaufState {
  view: VerlaufView;
  /** Die JÜNGSTE Seite - für Kopfsätze, Live-Zeile und Fußnote. */
  history: CommandHistory | null;
  /** Die Bezugszeit der jüngsten Antwort (die `liveness.ts`-Regel). */
  now: number;
  error: string | null;
  laedtMehr: boolean;
  ladeMehr: () => void;
  reload: () => void;
}

/**
 * Lädt den Verlauf EINES Ziels: die neuesten {@link SEITE} Zeilen der
 * Aufbewahrungs-Spanne, „Ältere laden" über den Server-Cursor.
 *
 * ⚠ Zustand und Bezugszeit werden ZUSAMMEN gesetzt (die `liveness.ts`-Lehre) -
 * ein Fehlschlag des stillen Takts lässt beides unberührt stehen.
 */
export function useBefehleVerlauf(opts: {
  siteId: string;
  /** Die gewählte Komponente; null = keine. */
  entityId?: string | null;
  /**
   * Das gewählte GERÄT; null = keins. Es SCHLIESST `entityId` aus - der Server
   * lehnt beides zusammen mit 400 ab, deshalb gewinnt hier die engere Frage und
   * das Gerät reist gar nicht erst mit.
   */
  geraetRef?: string | null;
  /** Der stille Takt in ms; 0 = aus (ein Wirt, der schon selbst pollt). */
  pollMs?: number;
}): VerlaufState {
  const { siteId, entityId = null, pollMs = 0 } = opts;
  const geraet = entityId ? null : opts.geraetRef ?? null;
  const [history, setHistory] = useState<CommandHistory | null>(null);
  const [mehr, setMehr] = useState<CommandHistory[]>([]);
  const [laedtMehr, setLaedtMehr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Das Fenster ist die AUFBEWAHRUNG, nicht „heute": der Verlauf ist eine
  // Liste, keine Tages-Ansicht. Der Berliner Kalendertag wandert mit `now`,
  // damit ein über Mitternacht offener Tab nicht auf gestern sitzen bleibt.
  const fenster = useMemo(() => verlaufFenster(now), [now]);
  const fensterKey = `${fenster.from}:${fenster.to}`;

  useEffect(() => {
    let active = true;
    setHistory(null);
    setMehr([]);
    setError(null);
    api
      .commandHistory(siteId, { entity: entityId, device: geraet, ...fenster, limit: SEITE })
      .then(
        (h) => {
          if (!active) return;
          setHistory(h);
          setNow(Date.now());
        },
        (e) => active && setError(e instanceof ApiError ? e.message : 'Verlauf nicht abrufbar.'),
      );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, entityId, geraet, fensterKey, reloadKey]);

  /**
   * „Ältere laden": eine Seite weiter zurück.
   *
   * ⚠ Der Server vergleicht `<=`, die Grenzzeile kommt also ZWEIMAL - lieber
   * doppelt als lautlos verloren. Gemischt wird über die `id` (in
   * `neuesteZuerst`).
   */
  const ladeMehr = useCallback(() => {
    const cursor = (mehr.length > 0 ? mehr[mehr.length - 1] : history)?.nextBefore;
    if (!cursor || laedtMehr) return;
    setLaedtMehr(true);
    api
      .commandHistory(siteId, {
        entity: entityId, device: geraet, ...fenster, limit: SEITE, before: cursor,
      })
      .then(
        (h) => setMehr((prev) => [...prev, h]),
        () => {},
      )
      .finally(() => setLaedtMehr(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, entityId, geraet, fensterKey, history, mehr, laedtMehr]);

  useFreshnessPoll(
    () => {
      api
        .commandHistory(siteId, { entity: entityId, device: geraet, ...fenster, limit: SEITE })
        .then(
          (h) => {
            setHistory(h);
            setNow(Date.now());
          },
          () => {},
        );
    },
    pollMs > 0 ? pollMs : 60_000,
    pollMs > 0,
  );

  const view = useMemo(
    () => neuesteZuerst([history, ...mehr], now, {
      gefiltert: entityId != null || geraet != null,
    }),
    [history, mehr, now, entityId, geraet],
  );

  return {
    view,
    history,
    now,
    error,
    laedtMehr,
    ladeMehr,
    reload: () => setReloadKey((k) => k + 1),
  };
}

/**
 * Die Liste: neueste Zeile oben, Datumszeile bei jedem Tageswechsel, „Ältere
 * laden" nur mit Server-Cursor.
 *
 * <p>Der Roh-Blick ist für ALLE Kunden aufklappbar (Captain-Entscheid F1 der
 * Kommando-Transparenz) - die Transparenz IST das Produktversprechen.
 */
export function BefehleVerlauf({
  state,
  /** Das Strom-Etikett je Zeile - ohne gewählte Komponente mischen sich Wege. */
  zeigeStrom = true,
  onRetry,
  max,
}: {
  state: VerlaufState;
  zeigeStrom?: boolean;
  onRetry?: () => void;
  /**
   * Die KURZFORM (Baustein „Aktivität" der Geräteseite): nur die jüngsten
   * `max` Befehle, ohne Bilanz und ohne „Ältere laden" - der ganze Verlauf
   * steht einen Klick weiter auf der Befehle-Seite. Dieselben Zeilen, dieselbe
   * Grammatik (Befehl · Antwort · Wirkung), nur weniger davon.
   */
  max?: number;
}) {
  const { view, error, laedtMehr, ladeMehr, history } = state;
  const kurz = max != null;
  const eintraege = kurz ? kuerzen(view.eintraege, max) : view.eintraege;
  return (
    <>
      {!kurz && view.bilanz && <p className="vp-note vp-verlauf-bilanz">{view.bilanz}</p>}
      {error && <ErrorState message={error} onRetry={onRetry ?? state.reload} />}
      {!error && !history && <Skeleton height={kurz ? 64 : 120} />}
      {!error && history && view.leer && <p className="vp-muted">{view.leer}</p>}
      {!error && view.zeilen > 0 && (
        <ol className={`vp-befehle-film${kurz ? ' is-kurz' : ''}`}>
          {eintraege.map((e) =>
            e.art === 'tag' ? (
              <li key={e.key} className="vp-verlauf-tag" aria-hidden="true">
                {e.text}
              </li>
            ) : (
              <li
                key={e.key}
                className={`vp-befehl is-${e.zeile.ton}${e.zeile.laufend ? ' is-jetzt' : ''}`}
              >
                <span className="vp-befehl-zeit">{e.zeile.zeit}</span>
                <div className="vp-befehl-body">
                  {zeigeStrom && e.zeile.strom && (
                    <span className="vp-befehl-strom">{e.zeile.strom}</span>
                  )}
                  <p className="vp-befehl-satz">{e.zeile.satz}</p>
                  <span className="vp-befehl-meta">
                    {e.zeile.urteil && <span className="vp-befehl-urteil">{e.zeile.urteil}</span>}
                    {e.zeile.herkunft && <span className="vp-note">{e.zeile.herkunft}</span>}
                  </span>
                  {e.zeile.roh.length > 0 && (
                    <details className="vp-befehl-roh">
                      <summary>
                        <Icon name="chevron-right" size={12} /> Technische Details
                      </summary>
                      <dl>
                        {e.zeile.roh.map((r) => (
                          <div key={r.label}>
                            <dt>{r.label}</dt>
                            <dd>{r.wert}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      {/* „Ältere laden" wird NIE angeboten, wo es nichts mehr gibt - der Server
          sagt mit `nextBefore`, ob eine Seite dahinter liegt. */}
      {!kurz && !error && view.mehrMoeglich && (
        <button type="button" className="vp-befehle-mehr" onClick={ladeMehr} disabled={laedtMehr}>
          <Icon name="chevron-down" size={14} />
          {laedtMehr ? 'Wird geladen …' : 'Ältere laden'}
        </button>
      )}
      {!kurz && view.deckel && <p className="vp-note">{view.deckel}</p>}
    </>
  );
}

/**
 * Die ersten `max` BEFEHLS-Zeilen samt ihren Datumszeilen - eine Datumszeile
 * ohne Befehl darunter fällt weg.
 */
function kuerzen(eintraege: VerlaufView['eintraege'], max: number): VerlaufView['eintraege'] {
  const out: VerlaufView['eintraege'] = [];
  let zeilen = 0;
  let tag: VerlaufView['eintraege'][number] | null = null;
  for (const e of eintraege) {
    if (e.art === 'tag') {
      tag = e;
      continue;
    }
    if (zeilen >= max) break;
    if (tag) {
      out.push(tag);
      tag = null;
    }
    out.push(e);
    zeilen += 1;
  }
  return out;
}

/**
 * Die AKTIONSZEILE über der Liste (§6.2): „Befehl an dieses Gerät ▾".
 *
 * ⚠ Sie LÖST nur aus - der Wirt öffnet seinen BESTEHENDEN Dialog. Ohne
 * Handlung, die der Zustand hergibt, rendert sie GAR NICHTS (ein Knopf, der
 * strukturell nichts bewirken kann, wird nicht angeboten).
 */
export function BefehleAktionszeile({
  aktionen,
  label = AKTIONSZEILE_LABEL,
  disabled,
  onAktion,
}: {
  aktionen: readonly VerlaufAktion[];
  /** Vorgabe: die eine Haus-Beschriftung `AKTIONSZEILE_LABEL`. */
  label?: string;
  disabled?: boolean;
  onAktion: (aktion: VerlaufAktion) => void;
}) {
  const [offen, setOffen] = useState(false);
  if (aktionen.length === 0) return null;
  return (
    <div className={`vp-verlauf-aktionen${offen ? ' is-offen' : ''}`}>
      <button
        type="button"
        className="vp-verlauf-aktion-btn"
        aria-expanded={offen}
        disabled={disabled}
        onClick={() => setOffen((v) => !v)}
      >
        <Icon name="zap" size={14} /> {label}
        <Icon name={offen ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
      {offen && (
        <ul className="vp-verlauf-aktion-liste">
          {aktionen.map((a) => (
            <li key={a.key}>
              <button
                type="button"
                onClick={() => {
                  setOffen(false);
                  onAktion(a);
                }}
              >
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

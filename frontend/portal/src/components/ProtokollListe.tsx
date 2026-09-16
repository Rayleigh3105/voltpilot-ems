/**
 * Das ÄNDERUNGSPROTOKOLL als Fläche (UEMS AP-04 IP-21) — EIN Bauteil für ZWEI
 * Wirte: die Messstelle und das Gerät.
 *
 * **Zwei Protokoll-Formen wären zwei Wahrheiten** (die Lehre des Befehls-Verlaufs,
 * Captain-Entscheid D4a), deshalb rendert hier genau ein Bauteil die Liste, und
 * ein Haken lädt sie: die Seiten-Mechanik gibt es nur einmal, statt zweimal
 * daneben zu liegen.
 *
 * Diese Datei RENDERT und LÄDT nur — jede Regel und jeder Satz kommt aus der
 * reinen `src/uemsProtokoll.ts` bzw. vom Server. Kein eigenes Gestaltungssystem:
 * sie trägt die Klassen des Befehls-Verlaufs (`pages/Befehle.css`).
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Protokoll, type ProtokollAbfrage } from '../api';
import { protokollListe, SEITE, type ProtokollView } from '../uemsProtokoll';
import { ErrorState, Skeleton } from './States';
import '../pages/Befehle.css';

/** Welches Protokoll geladen wird — die drei Lesewege des Servers. */
export type ProtokollZiel =
  | { art: 'messstelle'; id: string }
  | { art: 'geraet'; id: string }
  | { art: 'anlage'; id: string }
  | { art: 'unternehmen' };

/** Was der Haken einem Wirt gibt. */
export interface ProtokollState {
  view: ProtokollView;
  /** Die jüngste Seite — null, solange nichts geladen ist. */
  seite: Protokoll | null;
  now: number;
  error: string | null;
  laedtMehr: boolean;
  ladeMehr: () => void;
  reload: () => void;
}

function lade(ziel: ProtokollZiel, f: ProtokollAbfrage): Promise<Protokoll> {
  if (ziel.art === 'messstelle') return api.messstelleAenderungen(ziel.id, f);
  if (ziel.art === 'geraet') return api.geraetAenderungen(ziel.id, f);
  if (ziel.art === 'anlage') return api.anlageAenderungen(ziel.id, f);
  return api.unternehmenAenderungen(f);
}

/**
 * Lädt das Protokoll EINES Ziels: die jüngsten {@link SEITE} Zeilen, „Ältere
 * laden" über den Fortsetzungszeiger des Servers.
 *
 * ⚠ Zustand und Bezugszeit werden ZUSAMMEN gesetzt — ein Fehlschlag lässt beides
 * unberührt stehen, statt eine halbe Liste mit neuer Uhr zu zeigen.
 */
export function useProtokoll(
  ziel: ProtokollZiel | null,
  opts: { achse?: ProtokollAbfrage['achse']; mitBezug?: boolean } = {},
): ProtokollState {
  const { achse, mitBezug = false } = opts;
  const schluessel = ziel ? `${ziel.art}:${'id' in ziel ? ziel.id : ''}` : '';
  const [seite, setSeite] = useState<Protokoll | null>(null);
  const [mehr, setMehr] = useState<Protokoll[]>([]);
  const [laedtMehr, setLaedtMehr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let aktiv = true;
    setSeite(null);
    setMehr([]);
    setError(null);
    if (!ziel) return () => undefined;
    lade(ziel, { limit: SEITE, achse })
      .then((p) => {
        if (!aktiv) return;
        setSeite(p);
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        if (!aktiv) return;
        setError(e instanceof ApiError ? e.message : 'Das Protokoll ist gerade nicht abrufbar.');
      });
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, achse, reloadKey]);

  const ladeMehr = useCallback(() => {
    const letzte = mehr.length ? mehr[mehr.length - 1] : seite;
    const weiter = letzte?.weiter ?? null;
    if (!ziel || !weiter || laedtMehr) return;
    setLaedtMehr(true);
    lade(ziel, { limit: SEITE, achse, nach: weiter })
      .then((p) => setMehr((m) => [...m, p]))
      .catch(() => setError('Ältere Einträge sind gerade nicht abrufbar.'))
      .finally(() => setLaedtMehr(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, achse, seite, mehr, laedtMehr]);

  return {
    view: protokollListe([seite, ...mehr], now, { mitBezug }),
    seite,
    now,
    error,
    laedtMehr,
    ladeMehr,
    reload: () => setReloadKey((k) => k + 1),
  };
}

/**
 * Die Liste: jüngste Zeile oben, Datumszeile bei jedem Tageswechsel, „Ältere
 * laden" nur mit Fortsetzungszeiger.
 *
 * Jede Zeile nennt BEIDE Zeitpunkte — wann die Änderung gilt und wann sie
 * eingetragen wurde. Genau daran hängt dieses Paket: ein rückwirkender
 * Zählerwechsel gilt um 10:40 und wurde um 11:05 eingetragen.
 */
export function ProtokollListe({ state }: { state: ProtokollState }) {
  const { view, error, laedtMehr, ladeMehr, seite } = state;
  return (
    <>
      <p className="vp-note vp-verlauf-bilanz">{view.achseSatz}</p>
      {error && <ErrorState message={error} onRetry={state.reload} />}
      {!error && !seite && <Skeleton height={120} />}
      {!error && seite && view.leer && <p className="vp-muted">{view.leer}</p>}
      {!error && view.zeilen > 0 && (
        <ol className="vp-befehle-film">
          {view.eintraege.map((e) =>
            e.art === 'tag' ? (
              <li key={e.key} className="vp-verlauf-tag" aria-hidden="true">
                {e.text}
              </li>
            ) : (
              <li key={e.key} className={`vp-befehl is-${e.zeile.marke ? 'warn' : 'info'}`}>
                <span className="vp-befehl-zeit">{e.zeile.zeit}</span>
                <div className="vp-befehl-body">
                  {e.zeile.bezug && <span className="vp-befehl-strom">{e.zeile.bezug}</span>}
                  <p className="vp-befehl-satz">{e.zeile.satz}</p>
                  <span className="vp-befehl-meta">
                    {e.zeile.marke && <span className="vp-befehl-urteil">{e.zeile.marke}</span>}
                    <span className="vp-note">{e.zeile.giltAb}</span>
                    <span className="vp-note">{e.zeile.eingetragen}</span>
                    <span className="vp-note">{e.zeile.urheber}</span>
                  </span>
                  {e.zeile.grund && <p className="vp-note">Begründung: {e.zeile.grund}</p>}
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      {/* „Ältere laden" wird NIE angeboten, wo es nichts mehr gibt — der Server
          sagt mit `weiter`, ob eine Seite dahinter liegt. */}
      {!error && view.mehrMoeglich && (
        <button type="button" className="vp-befehle-mehr" onClick={ladeMehr} disabled={laedtMehr}>
          <Icon name="chevron-down" size={14} />
          {laedtMehr ? 'Wird geladen …' : 'Ältere laden'}
        </button>
      )}
    </>
  );
}

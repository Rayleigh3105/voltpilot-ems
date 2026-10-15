import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  anlageAusHash,
  meldungenApi,
  type Meldung,
  type UeberwachungsRegel,
  SCHWERE_WORT,
  sortiereJetzt,
  sortiereVerlauf,
  wertartSatzname,
  WORT_GESEHEN,
} from '../meldungen';
import { datumZeit } from '../rechteTexte';
import './MeldungenPage.css';

type Reiter = 'jetzt' | 'verlauf' | 'regeln';

/**
 * Das Meldungs-Center (Alerting Scheibe 1, Konzept §6.8, Entscheid 4A): `#/meldungen` mit den
 * Reitern Jetzt · Verlauf · Überwachungen. Öffnet nur über die Glocke im Kopf oder einen Link
 * (`#/meldungen?anlage=<id>` aus der Zustands-Anzeige einer Anlage) - kein Eintrag in der Leiste.
 */
export function MeldungenPage() {
  const [reiter, setReiter] = useState<Reiter>('jetzt');
  const [meldungen, setMeldungen] = useState<Meldung[] | null>(null);
  const [regeln, setRegeln] = useState<UeberwachungsRegel[] | null>(null);
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const anlageFilter = anlageAusHash(window.location.hash);

  useEffect(() => {
    let aktiv = true;
    setFehler('');
    const laden =
      reiter === 'regeln'
        ? meldungenApi.regeln().then((r) => {
            if (aktiv) setRegeln(r);
          })
        : (reiter === 'jetzt' ? meldungenApi.jetzt() : meldungenApi.verlauf()).then((m) => {
            if (aktiv) setMeldungen(m);
          });
    laden.catch(() => {
      if (aktiv) setFehler('Die Meldungen konnten nicht geladen werden. Bitte versuchen Sie es erneut.');
    });
    return () => {
      aktiv = false;
    };
  }, [reiter]);

  const gefiltert = (meldungen ?? []).filter((m) => !anlageFilter || m.anlageId === anlageFilter);
  const liste = reiter === 'verlauf' ? sortiereVerlauf(gefiltert) : sortiereJetzt(gefiltert);

  async function gesehen(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      const aktualisiert = await meldungenApi.gesehen(id);
      setMeldungen((liste) => liste?.map((m) => (m.id === id ? aktualisiert : m)) ?? liste);
    } catch {
      setFehler('"Gesehen" konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="vp-meldungen" data-testid="meldungen-seite">
      <h1>Meldungen</h1>
      <div className="vp-bereich-tabs" role="tablist" aria-label="Meldungen">
        {(
          [
            ['jetzt', 'Jetzt'],
            ['verlauf', 'Verlauf'],
            ['regeln', 'Überwachungen'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={reiter === key}
            className={`vp-bereich-tab${reiter === key ? ' active' : ''}`}
            data-testid={`meldungen-reiter-${key}`}
            onClick={() => setReiter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {fehler && <p role="alert">{fehler}</p>}

      {reiter === 'regeln' ? (
        <RegelListe regeln={regeln} />
      ) : (
        <MeldungListe
          meldungen={meldungen === null ? null : liste}
          reiter={reiter}
          busy={busy}
          onGesehen={gesehen}
        />
      )}
    </div>
  );
}

function MeldungListe({
  meldungen,
  reiter,
  busy,
  onGesehen,
}: {
  meldungen: Meldung[] | null;
  reiter: Reiter;
  busy: string | null;
  onGesehen: (id: string) => void;
}) {
  if (meldungen === null) return <p>Wird geladen …</p>;
  if (meldungen.length === 0) {
    return (
      <p className="vp-meldungen-leer">
        {reiter === 'jetzt' ? 'Alles ruhig. Keine offenen Meldungen.' : 'Noch keine erledigten Meldungen.'}
      </p>
    );
  }
  return (
    <ul className="vp-meldungen-liste">
      {meldungen.map((m) => (
        <li key={m.id} className={`vp-meldung schwere-${m.schwere}`}>
          <span className="vp-meldung-dot" aria-hidden="true" />
          <div className="vp-meldung-inhalt">
            <div className="vp-meldung-kopf">
              <span className="vp-meldung-schwere">{SCHWERE_WORT[m.schwere]}</span>
              <span className="vp-meldung-seit">seit {datumZeit(m.ausgeloestAm)}</span>
            </div>
            <p className="vp-meldung-satz">
              {wertartSatzname(m.wertart)}
              {m.anlageName ? ` der Anlage ${m.anlageName}` : ''}
            </p>
            <p className="vp-meldung-kennzeichen">{m.kennzeichen}</p>
            {m.gesehenVon && (
              <p className="vp-meldung-gesehen">
                Gesehen von {m.gesehenVon}
                {m.gesehenAm ? `, ${datumZeit(m.gesehenAm)}` : ''}
              </p>
            )}
          </div>
          {reiter === 'jetzt' && !m.gesehenVon && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy === m.id}
              onClick={() => onGesehen(m.id)}
            >
              {WORT_GESEHEN}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RegelListe({ regeln }: { regeln: UeberwachungsRegel[] | null }) {
  if (regeln === null) return <p>Wird geladen …</p>;
  if (regeln.length === 0) return <p className="vp-meldungen-leer">Noch keine Überwachung eingeschaltet.</p>;
  return (
    <ul className="vp-meldungen-liste">
      {regeln.map((r) => (
        <li key={r.id} className="vp-regel">
          <Icon name="bell" size={18} />
          <div className="vp-meldung-inhalt">
            <p className="vp-meldung-satz">{r.name ?? wertartSatzname(r.wertart)}</p>
            <p className="vp-meldung-kennzeichen">
              {SCHWERE_WORT[r.schwere]} · {r.herkunft === 'ab_werk' ? 'ab Werk' : 'Vorschlag'}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

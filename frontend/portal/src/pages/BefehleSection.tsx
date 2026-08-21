import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type CommandHistory, type Site } from '../api';
import {
  ANLAGENWEITE_BEFEHLE,
  GERAETE_BEFEHLE,
  aufzeichnungSeit,
  deckelSatz,
  film,
  fussnote,
  geraetKopfSatz,
  kopfSatz,
  leerSatz,
  NUR_LESEN,
  type BefehlZeile,
} from '../befehle';
import {
  abfrage,
  ausUrl,
  inUrl,
  leerMitFilter,
  mehrMoeglich,
  suche,
  sucheHinweis,
  trefferSatz,
  type BefehlFilter,
} from '../befehleFilter';
import { BefehleFilterLeiste } from '../components/BefehleFilterLeiste';
import { technicalDeviceName } from '../entityLabel';
import { ControlStrip } from '../components/ControlStrip';
import { ErrorState, Skeleton } from '../components/States';
import { controlStrip } from '../control';
import { exportGuardView } from '../curtailment';
import { useFreshnessPoll } from '../useFreshnessPoll';
import './Befehle.css';

/**
 * Die BEFEHLE-Seite (`#/anlage/{id}/befehle?komponente=…`, Kommando-Transparenz
 * V1, Konzept `vp-kommando-transparenz-k3` §2). Sie beantwortet die Frage, die
 * in Pilsting/Herzogau zwei Untersuchungsrunden gekostet hat - „was schickt
 * VoltPilot wirklich an mein Gerät?" - und zwar für den Kunden selbst.
 *
 * Aufbau von oben nach unten (§2.2): Kopf (Komponente · Gerät · Schreibweg +
 * „Aufzeichnung seit") → „Gerade jetzt" → „Grenzen &amp; Wächter" → der
 * Tages-Film → die Fußnote der Ehrlichkeit.
 *
 * <b>Sie beobachtet nur.</b> Es gibt hier kein Bedienelement, das etwas an der
 * Anlage ändert - nur Zeitraum, Filter und Suche; Wünsche → Arbitrierung →
 * Schutzgrenzen → Executor bleiben unangetastet.
 *
 * <b>Die SUCHE (Geräteseiten Revision B §6, Captain-Punkt 4)</b> teilt sich
 * sauber: STRUKTUR (Zeitraum · Befehlsart · Herkunft · Ergebnis) entscheidet der
 * Server, der FREITEXT läuft hier über die ANGEZEIGTEN Sätze - eine
 * Server-Suche fände nur Rohfelder und widerspräche dem, was der Kunde liest.
 * Der Zustand lebt in der URL, ein Support-Link trägt ihn also mit.
 *
 * <b>Sie erfindet keinen Satz.</b> Die Live-Zeile ist wörtlich dieselbe
 * `controlStrip()`-Ableitung wie im Cockpit, das Wächter-Panel wörtlich
 * dieselbe `exportGuardView()` - so können die zwei Flächen über dieselbe
 * Sekunde nie Verschiedenes behaupten. Alles Übrige kommt aus der reinen
 * `src/befehle.ts`.
 */
export function BefehleSection({
  site,
  entityId,
  geraetRef = null,
}: {
  site: Site;
  /** Die gewählte Komponente; null = die ganze Anlage. */
  entityId: string | null;
  /**
   * Das gewählte GERÄT (Anlagen-Zentrale Stufe 1, `?geraet=`); null = keins.
   * Es schliesst `entityId` aus - der Server lehnt beides mit 400 ab, deshalb
   * gewinnt hier die Komponente und das Gerät reist gar nicht erst mit.
   */
  geraetRef?: string | null;
}) {
  // Der Filter lebt in der URL (§6: „ein Support-Link trägt den Filter") - hier
  // steht nur seine gelesene Form. `replaceState` schreibt ihn zurück, damit ein
  // Klick keinen Verlauf-Eintrag erzeugt (das `?ansicht=`-Muster).
  const [filter, setFilterState] = useState<BefehlFilter>(() => ausUrl(window.location.hash));
  const [history, setHistory] = useState<CommandHistory | null>(null);
  const [mehr, setMehr] = useState<CommandHistory[]>([]);
  const [laedtMehr, setLaedtMehr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [geraetName, setGeraetName] = useState<string | null>(null);
  // Ein Gerät und eine Komponente sind zwei verschiedene Fragen; der Server
  // lehnt beides zusammen ab, also gewinnt hier die engere.
  const geraet = entityId ? null : geraetRef;

  // Der NAME des Geräts kommt aus dem gemeldeten Einrichtungs-Stand, nicht aus
  // der Verlaufs-Antwort: sie trägt bewusst keinen (ein zweiter Namensbildner
  // wäre ein Zwilling, der abdriften kann). Fail-soft - ohne ihn steht die
  // Adresse da, nie ein geratener Name.
  useEffect(() => {
    if (!geraet) {
      setGeraetName(null);
      return;
    }
    let active = true;
    api.siteEntities(site.id).then(
      (e) => {
        if (!active) return;
        const setup = (e.localSetup ?? []).find((l) => l.id === geraet);
        setGeraetName(setup
          ? technicalDeviceName({
              edgeLabel: setup.label ?? null,
              brand: setup.brand ?? null,
              model: setup.model ?? null,
            })
          : null);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, geraet]);

  // Der laufende Berliner Kalendertag - der Bezug, gegen den „gestern"
  // gerechnet wird. Er wandert mit `now`, damit ein über Mitternacht offener
  // Tab nicht auf dem gestrigen Anker sitzen bleibt.
  const heute = useMemo(
    () => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }),
    [now],
  );
  const q = useMemo(() => abfrage(filter, heute), [filter, heute]);
  // Die Abfrage als stabiler Schlüssel: sie ist der EINE Auslöser des Ladens.
  const qKey = JSON.stringify(q);

  const setFilter = useCallback(
    (f: BefehlFilter) => {
      setFilterState(f);
      const ziel = inUrl(window.location.hash, f);
      if (ziel !== window.location.hash) {
        window.history.replaceState(null, '', ziel);
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    setHistory(null);
    setMehr([]);
    setError(null);
    api.commandHistory(site.id, { entity: entityId, device: geraet, ...q }).then(
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
  }, [site.id, entityId, geraet, qKey, reloadKey]);

  /**
   * „Ältere laden": eine Seite weiter zurück.
   *
   * ⚠ Der Server vergleicht `<=`, die Grenzzeile kommt also ZWEIMAL - lieber
   * doppelt als lautlos verloren. Gemischt wird deshalb über die `id`.
   */
  const ladeMehr = useCallback(() => {
    const cursor = (mehr.length > 0 ? mehr[mehr.length - 1] : history)?.nextBefore;
    if (!cursor || laedtMehr) return;
    setLaedtMehr(true);
    api
      .commandHistory(site.id, { entity: entityId, device: geraet, ...q, before: cursor })
      .then(
        (h) => setMehr((prev) => [...prev, h]),
        () => {},
      )
      .finally(() => setLaedtMehr(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, entityId, geraet, qKey, history, mehr, laedtMehr]);

  // Der Verlauf altert: der stille Takt holt ihn nach, und der Zustand wird
  // ZUSAMMEN mit seiner Bezugszeit gesetzt (die `liveness.ts`-Lehre) - ein
  // Fehlschlag lässt beides unberührt stehen.
  useFreshnessPoll(() => {
    api.commandHistory(site.id, { entity: entityId, device: geraet, ...q }).then(
      (h) => {
        setHistory(h);
        setNow(Date.now());
      },
      () => {},
    );
  }, 30_000);

  // Die geladenen Seiten als EINE Zeitachse: ältere Seiten kommen davor, und
  // eine Zeile, die an der Seitengrenze doppelt kam, gewinnt genau einmal.
  const alleZeilen = useMemo(() => {
    const gesehen = new Set<number>();
    const out: BefehlZeile[] = [];
    [...[...mehr].reverse(), ...(history ? [history] : [])].forEach((h) => {
      film(h, now).forEach((z) => {
        if (gesehen.has(z.id)) return;
        gesehen.add(z.id);
        out.push(z);
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, mehr, now]);
  const zeilen = useMemo(() => suche(alleZeilen, filter.q), [alleZeilen, filter.q]);
  // Die zwei Live-Ableitungen nehmen ein Date - dieselben, die das Cockpit
  // benutzt, damit hier keine zweite Wahrheit entsteht.
  const jetzt = useMemo(() => new Date(now), [now]);
  const live = controlStrip(history?.control ?? null, jetzt);
  const guard = exportGuardView(history?.curtailment ?? null, jetzt);

  return (
    <div className="vp-befehle">
      <Card padding="lg" radius="lg">
        <span className="vp-card-label">Befehle an dieses Gerät</span>
        {/* Der Kopf nennt die Komponente und den SCHREIBWEG. Ein Gerätename
            steht bewusst NICHT darin: diese Antwort trägt ihn nicht, und ein
            geratener wäre schlimmer als keiner. */}
        <p className="vp-befehle-kopf">
          {geraet
            ? geraetKopfSatz({
                geraet: geraetName ?? geraet,
                // Box oder Gerät dahinter ist ein SERVER-Fakt (`deviceIsBox`) -
                // ein älteres Backend meldet ihn nicht, dann wird nichts
                // behauptet und der neutrale Satz steht da.
                box: history?.deviceIsBox === true,
                pfad: schreibweg(history),
              })
            : kopfSatz({
                komponente: history?.entityLabel ?? null,
                geraet: null,
                pfad: schreibweg(history),
              })}
        </p>
        <p className="vp-note">{aufzeichnungSeit(history?.recordingSince ?? null)}</p>
        {/* F4: die Herzogau-Antwort. Sie kostet fast nichts und beantwortet
            „drosselt ihr?" für jedes Gerät der Anlage. */}
        {/* Die Grenze wird ERKLÄRT, nicht nur gezogen: eine anlagenweite
            Abregelung gehört der Box, nicht einem von mehreren Geräten. */}
        {history?.deviceIsBox === false && (
          <p className="vp-note">{ANLAGENWEITE_BEFEHLE}</p>
        )}
        {/* Und die Gegenrichtung auf der Box: sie ÜBERBRINGT, ausgeführt wird
            am Gerät - dort steht der Befehl seit der Ziel-Attribution auch. */}
        {history?.deviceIsBox === true && <p className="vp-note">{GERAETE_BEFEHLE}</p>}
        {history && (entityId || geraet) && !history.writes && (
          <p className="vp-befehle-readonly">
            <Icon name="shield" size={15} /> {NUR_LESEN}
          </p>
        )}
      </Card>

      {/* „Gerade jetzt" + „Grenzen & Wächter" - beide aus den BESTEHENDEN
          Ableitungen, damit hier keine zweite Wahrheit entsteht. */}
      <ControlStrip view={live} guard={guard} />

      <Card padding="lg" radius="lg">
        <div className="vp-befehle-head">
          <span className="vp-card-label">Was geschickt wurde</span>
        </div>

        {/* Die Suche (Geräteseiten Revision B §6): Struktur filtert der Server,
            der Freitext läuft über die ANGEZEIGTEN Sätze - und die Leiste sagt,
            worin sie sucht. */}
        <BefehleFilterLeiste
          filter={filter}
          onChange={setFilter}
          hinweis={sucheHinweis(history, alleZeilen.length)}
          treffer={trefferSatz(history, filter, zeilen.length)}
        />

        {error && <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />}
        {!error && !history && <Skeleton height={120} />}
        {!error && history && zeilen.length === 0 && (
          <p className="vp-muted">
            {/* Ein Filter, der nichts trifft, ist NICHT dasselbe wie ein leerer
                Zeitraum - und der Satz sagt, wie viele Zeilen daneben liegen. */}
            {leerMitFilter(history, filter)
              ?? leerSatz(history, entityId != null || geraet != null)}
          </p>
        )}
        {!error && history && zeilen.length > 0 && (
          <ol className="vp-befehle-film">
            {zeilen.map((z) => (
              <li key={z.id} className={`vp-befehl is-${z.ton}${z.laufend ? ' is-jetzt' : ''}`}>
                <span className="vp-befehl-zeit">{z.zeit}</span>
                <div className="vp-befehl-body">
                  {/* Ohne gewählte Komponente mischen sich drei Schreibwege -
                      dann sagt jede Zeile, um welchen es geht. */}
                  {!entityId && z.strom && <span className="vp-befehl-strom">{z.strom}</span>}
                  <p className="vp-befehl-satz">{z.satz}</p>
                  <span className="vp-befehl-meta">
                    {z.urteil && <span className="vp-befehl-urteil">{z.urteil}</span>}
                    {z.herkunft && <span className="vp-note">{z.herkunft}</span>}
                  </span>
                  {/* Der Roh-Blick ist für ALLE Kunden aufklappbar
                      (Captain-Entscheid F1) - die Transparenz IST das
                      Produktversprechen, nicht eine Admin-Zugabe. */}
                  {z.roh.length > 0 && (
                    <details className="vp-befehl-roh">
                      <summary>
                        <Icon name="chevron-right" size={12} /> Technische Details
                      </summary>
                      <dl>
                        {z.roh.map((r) => (
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
            ))}
          </ol>
        )}
        {/* „Mehr laden" wird NIE angeboten, wo es nichts mehr gibt - der
            Server sagt mit `nextBefore`, ob eine Seite dahinter liegt. */}
        {!error && mehrMoeglich(mehr.length > 0 ? mehr[mehr.length - 1] : history) && (
          <button type="button" className="vp-befehle-mehr" onClick={ladeMehr}
              disabled={laedtMehr}>
            <Icon name="chevron-down" size={14} />
            {laedtMehr ? 'Wird geladen …' : 'Ältere laden'}
          </button>
        )}
        {deckelSatz(history) && <p className="vp-note">{deckelSatz(history)}</p>}
      </Card>

      <Card padding="lg" radius="lg">
        <span className="vp-card-label">Was hier aufbewahrt wird</span>
        <ul className="vp-befehle-fuss">
          {fussnote(history?.accuracySeconds ?? 15).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/**
 * Der zuletzt gemeldete Schreibweg der Anlage - er beschreibt, WIE geschrieben
 * wird. Ohne eine einzige Zeile, die ihn nennt, bleibt der Kopf ohne ihn.
 */
function schreibweg(history: CommandHistory | null): string | null {
  if (!history) return null;
  for (let i = history.entries.length - 1; i >= 0; i -= 1) {
    const p = history.entries[i].path;
    if (p) return p;
  }
  return null;
}

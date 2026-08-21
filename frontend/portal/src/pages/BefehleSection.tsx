import { useEffect, useMemo, useState } from 'react';
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
} from '../befehle';
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
 * <b>Sie beobachtet nur.</b> Es gibt hier kein Bedienelement außer Zeitraum
 * und Tiefe; Wünsche → Arbitrierung → Schutzgrenzen → Executor bleiben
 * unangetastet.
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
  const [range, setRange] = useState<'day' | 'week'>('day');
  const [history, setHistory] = useState<CommandHistory | null>(null);
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

  useEffect(() => {
    let active = true;
    setHistory(null);
    setError(null);
    api.commandHistory(site.id, { entity: entityId, device: geraet, range }).then(
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
  }, [site.id, entityId, geraet, range, reloadKey]);

  // Der Verlauf altert: der stille Takt holt ihn nach, und der Zustand wird
  // ZUSAMMEN mit seiner Bezugszeit gesetzt (die `liveness.ts`-Lehre) - ein
  // Fehlschlag lässt beides unberührt stehen.
  useFreshnessPoll(() => {
    api.commandHistory(site.id, { entity: entityId, device: geraet, range }).then(
      (h) => {
        setHistory(h);
        setNow(Date.now());
      },
      () => {},
    );
  }, 30_000);

  const zeilen = useMemo(() => film(history, now), [history, now]);
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
          <div className="vp-seg vp-seg-compact" role="tablist" aria-label="Zeitraum">
            <button
              type="button"
              role="tab"
              aria-selected={range === 'day'}
              className={range === 'day' ? 'active' : ''}
              onClick={() => setRange('day')}
            >
              Heute
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={range === 'week'}
              className={range === 'week' ? 'active' : ''}
              onClick={() => setRange('week')}
            >
              Diese Woche
            </button>
          </div>
        </div>

        {error && <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />}
        {!error && !history && <Skeleton height={120} />}
        {!error && history && zeilen.length === 0 && (
          <p className="vp-muted">{leerSatz(history, entityId != null || geraet != null)}</p>
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

import { useEffect, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type CommandHistory, type Site } from '../api';
import {
  ANLAGENWEITE_BEFEHLE,
  GERAETE_BEFEHLE,
  aufzeichnungSeit,
  fussnote,
  geraetKopfSatz,
  kopfSatz,
  NUR_LESEN,
} from '../befehle';
import { BefehleVerlauf, useBefehleVerlauf } from '../components/BefehleVerlauf';
import { technicalDeviceName } from '../entityLabel';
import { ControlStrip } from '../components/ControlStrip';
import { controlStrip } from '../control';
import { exportGuardView } from '../curtailment';
import './Befehle.css';

/**
 * Die BEFEHLE-Seite (`#/anlage/{id}/befehle?komponente=…`, Kommando-Transparenz
 * V1, Konzept `vp-kommando-transparenz-k3` §2). Sie beantwortet die Frage, die
 * in Pilsting/Herzogau zwei Untersuchungsrunden gekostet hat - „was schickt
 * VoltPilot wirklich an mein Gerät?" - und zwar für den Kunden selbst.
 *
 * Aufbau von oben nach unten (§2.2): Kopf (Komponente · Gerät · Schreibweg +
 * „Aufzeichnung seit") → „Gerade jetzt" → „Grenzen &amp; Wächter" → der VERLAUF
 * → die Fußnote der Ehrlichkeit.
 *
 * <b>Ein VERLAUF, keine Recherche-Fläche</b> (Geräteseiten Stufe 2, §6.1;
 * Captain-Entscheid D4a): neueste Zeile oben, {@code SEITE} Zeilen, „Ältere
 * laden" bis zur Aufbewahrungsgrenze - <b>keine Filter, keine Suche, kein
 * Treffer-Zähler</b>. Wer nachsieht, was zuletzt geschickt wurde, sucht nicht;
 * und wer doch sucht, hat den Browser (Strg+F über die geladenen Zeilen). Die
 * Liste ist DASSELBE Bauteil wie auf der Geräteseite - zwei Verlaufs-Formen
 * wären zwei Wahrheiten.
 *
 * <b>Sie beobachtet nur.</b> Es gibt hier kein Bedienelement, das etwas an der
 * Anlage ändert; Wünsche → Arbitrierung → Schutzgrenzen → Executor bleiben
 * unangetastet. Das Absetzen neuer Befehle wohnt an der GERÄTESEITE, wo das
 * Ziel feststeht.
 *
 * <b>Sie erfindet keinen Satz.</b> Die Live-Zeile ist wörtlich dieselbe
 * `controlStrip()`-Ableitung wie im Cockpit, das Wächter-Panel wörtlich
 * dieselbe `exportGuardView()` - so können die zwei Flächen über dieselbe
 * Sekunde nie Verschiedenes behaupten. Alles Übrige kommt aus der reinen
 * `src/befehle.ts` bzw. `src/befehleVerlauf.ts`.
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
  const [geraetName, setGeraetName] = useState<string | null>(null);
  // Ein Gerät und eine Komponente sind zwei verschiedene Fragen; der Server
  // lehnt beides zusammen ab, also gewinnt hier die engere.
  const geraet = entityId ? null : geraetRef;
  const state = useBefehleVerlauf({
    siteId: site.id, entityId, geraetRef: geraet, pollMs: 30_000,
  });
  const { history, now } = state;

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

  // Die zwei Live-Ableitungen nehmen ein Date - dieselben, die das Cockpit
  // benutzt, damit hier keine zweite Wahrheit entsteht.
  const jetzt = new Date(now);
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
        <BefehleVerlauf state={state} zeigeStrom={!entityId} />
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

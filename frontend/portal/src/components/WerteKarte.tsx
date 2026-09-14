/**
 * Die TAGES- und MONATSKARTE einer Messstelle mit ihrer Liste (UEMS AP-08
 * IP-11) — die erste Fläche, auf der ein Kunde liest, wie belastbar seine
 * Zahl ist.
 *
 * Diese Datei RENDERT nur. Jede Zahl, jedes Zustandswort, der Verlauf, die
 * Kennzeichen, die Beschriftung der Stunden und die Tagesdauer kommen aus der
 * reinen `src/uemsWerteKarte.ts` — und dort aus dem Ergebnis-Vertrag bzw. von
 * der Route. Kein Satz wird hier formuliert, keine Zahl gerundet.
 *
 * Mobil zuerst (375 px): die Zahl steht groß, Zustand und Verlauf daneben als
 * Abzeichen, die sich umbrechen; ein Kennzeichen wird nie gekürzt.
 */
import { Badge } from '../../designsystem/components/core/Badge';
import { TRENNER } from '../uemsErgebnis';
import type { Karte, Zeile } from '../uemsWerteKarte';
import './WerteKarte.css';

export function WerteKarte({ karte }: { karte: Karte }) {
  return (
    <section className="vp-wk-karte" aria-label={karte.titel} data-testid="werte-karte">
      <div className="vp-wk-kopf">
        <span className="vp-wk-titel">{karte.titel}</span>
        {karte.tagesdauer && <Badge variant="tint">{karte.tagesdauer}</Badge>}
      </div>
      <div className="vp-wk-zahl">{karte.zahl}</div>
      {(karte.zustand || karte.abdeckung) && (
        <div className="vp-wk-abzeichen">
          {karte.zustand && <Badge variant={karte.zustandTon}>{karte.zustand}</Badge>}
          {karte.abdeckung && <Badge variant={karte.abdeckungTon}>{karte.abdeckung}</Badge>}
        </div>
      )}
      <Kennzeichen saetze={karte.kennzeichen} />
    </section>
  );
}

export function WerteListe({ titel, zeilen }: { titel: string; zeilen: Zeile[] }) {
  return (
    <section className="vp-wk-liste" aria-label={titel}>
      <h4 className="vp-wk-liste-titel">{titel}</h4>
      <ol>
        {zeilen.map((z) => (
          <li key={z.schluessel} className="vp-wk-zeile" data-testid="werte-zeile">
            <span className="vp-wk-zeile-name">{z.beschriftung}</span>
            <span className="vp-wk-zeile-zahl">{z.zahl}</span>
            {(z.zustand || z.abdeckung || z.tagesdauer) && (
              <span className={`vp-wk-zeile-info is-${z.zustandTon}`}>
                {[z.zustand, z.abdeckung, z.tagesdauer].filter((t): t is string => t !== null).join(TRENNER)}
              </span>
            )}
            <Kennzeichen saetze={z.kennzeichen} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Kennzeichen({ saetze }: { saetze: string[] }) {
  if (saetze.length === 0) return null;
  return (
    <ul className="vp-wk-kennzeichen">
      {saetze.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

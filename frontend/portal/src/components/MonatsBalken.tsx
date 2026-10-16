import type { KachelTon } from './kacheln/Kachel';
import type { Balken } from '../messstelleSeite';
import { WertZeile } from './WertZeile';
import './MonatsBalken.css';

/** „Überwachen" am zuletzt abgeschlossenen Monat (Alerting Scheibe 5, §6.3: `messstelle.monat_unvollstaendig`). */
export interface MonatsBalkenUeberwachung {
  ueberwacht?: string | null;
  onUeberwachen: () => void;
}

/**
 * Die Monate einer Messstelle als Balken auf EINER Skala (Konzept Messen m1, §6.4 Punkt 5): je Monat ein Balken in der
 * Rolle der Messstelle, der gewählte kräftig, ein Monat ohne Wert ohne Balken (nie eine 0). Jeder Balken ist ein Knopf,
 * der seinen Monat wählt; das Modell (`messstelleSeite.balken`) rechnet nichts, es skaliert nur die Mengen der Route.
 */
export function MonatsBalken({
  balken,
  ton,
  onWahl,
  label,
  ueberwachung,
}: {
  balken: readonly Balken[];
  ton: KachelTon;
  /** Ohne Wahl (das Jahr) sind die Balken nur Bild und Beschriftung. */
  onWahl?: (monat: string) => void;
  label: string;
  /** „Überwachen" an der Vollständigkeit des zuletzt abgeschlossenen Monats (Alerting Scheibe 5, §6.3). */
  ueberwachung?: MonatsBalkenUeberwachung;
}) {
  return (
    <div className={`vp-mb ton-${ton}`} role="group" aria-label={label} data-testid="monatsbalken">
      <div className="vp-mb-flaeche" style={{ gridTemplateColumns: `repeat(${balken.length}, minmax(0, 1fr))` }}>
        {balken.map((b) => {
          const titel = `${b.titel}: ${b.zahl}${b.zustand ? ` · ${b.zustand}` : ''}`;
          const saeule = (
            <span
              className={`vp-mb-saeule${b.hoehe === null ? ' is-leer' : ''}${b.negativ ? ' is-negativ' : ''}`}
              style={b.hoehe === null ? undefined : { height: `${Math.max(2, Math.round(b.hoehe * 100))}%` }}
            />
          );
          return onWahl ? (
            <button
              key={b.monat}
              type="button"
              className={`vp-mb-balken${b.gewaehlt ? ' is-gewaehlt' : ''}`}
              aria-pressed={b.gewaehlt}
              aria-label={titel}
              title={titel}
              onClick={() => onWahl(b.monat)}
            >
              {saeule}
            </button>
          ) : (
            <span key={b.monat} className="vp-mb-balken" role="img" aria-label={titel} title={titel}>
              {saeule}
            </span>
          );
        })}
      </div>
      <div className="vp-mb-achse" style={{ gridTemplateColumns: `repeat(${balken.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {balken.map((b) => (
          <span key={b.monat} className={b.gewaehlt ? 'is-gewaehlt' : undefined}>
            {b.kurz}
          </span>
        ))}
      </div>
      {ueberwachung && (
        <WertZeile
          className="vp-mb-ueberwachen"
          label="Monat unvollständig"
          ueberwacht={ueberwachung.ueberwacht}
          onUeberwachen={ueberwachung.onUeberwachen}
        />
      )}
    </div>
  );
}

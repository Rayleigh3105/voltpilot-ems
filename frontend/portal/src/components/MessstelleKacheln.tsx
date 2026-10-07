import { Gross, Kachel, Marke } from './kacheln/Kachel';
import { pfad } from './portfolio/kurveGeometrie';
import {
  NAECHSTE_ABLESUNG,
  ZAEHLERSTAND,
  type AblesungKachel,
  type LeitKachel,
  type StandKachel,
} from '../messstelleSeite';
import './MessstelleKacheln.css';

/**
 * Die Kacheln oben auf der Seite einer Messstelle (Konzept Messen m1, §6.4 Punkt 4): die Leitkachel mit der Menge des
 * letzten vollständigen Monats in der Rolle der Messstelle, daneben der Zählerstand und - bei einem Ablesezähler - die
 * nächste Ablesung. Dieselbe Kachel-Hülle wie die Übersicht (`kacheln/Kachel`), dieselbe Kurven-Geometrie
 * (`portfolio/kurveGeometrie`); was darin steht, entscheidet `messstelleSeite.ts`.
 */
export function MessstelleKacheln({
  leit,
  stand,
  ablesung,
  laedt,
  onAblesen,
}: {
  /** `null` = die Hauptgröße hat keine Menge je Monat (eine Leistung) - dann führt der Zählerstand bzw. nichts. */
  leit: LeitKachel | null;
  stand: StandKachel | null;
  ablesung: AblesungKachel | null;
  laedt: boolean;
  /** Der Schritt der Leitkachel, wenn der Monat ohne Ablesung ist. */
  onAblesen?: () => void;
}) {
  if (!leit && !stand && !ablesung) return null;
  const neben = [stand, ablesung].filter(Boolean).length;
  return (
    <div className={`vp-msk vp-kraster is-${neben}`} data-testid="messstelle-kacheln">
      {laedt ? (
        <div className="vp-k-platz is-breit">
          <div className="vp-k vp-msk-skelett" aria-busy="true" />
        </div>
      ) : (
        leit && <Leit leit={leit} onAblesen={onAblesen} />
      )}
      {stand && (
        <Kachel id="ms-zaehlerstand" name={ZAEHLERSTAND} icon="trending-up" ton="neutral">
          <Gross wert={stand.wert} einheit={stand.einheit || undefined} />
          <p className="vp-k-sub">{stand.unter}</p>
        </Kachel>
      )}
      {ablesung && (
        <Kachel id="ms-naechste-ablesung" name={NAECHSTE_ABLESUNG} icon="calendar" ton="neutral">
          <span className="vp-k-gross">
            {ablesung.tag}
            <span className="vp-k-einheit">{ablesung.jahr}</span>
          </span>
          <Marke art={ablesung.marke.ton}>{ablesung.marke.text}</Marke>
          <p className="vp-k-sub">{ablesung.satz}</p>
        </Kachel>
      )}
    </div>
  );
}

function Leit({ leit, onAblesen }: { leit: LeitKachel; onAblesen?: () => void }) {
  return (
    <Kachel id="ms-leit" name={leit.name} icon="activity" ton={leit.ton} groesse="breit" className="vp-msk-leit">
      <Gross wert={leit.wert} einheit={leit.einheit || undefined} xl />
      {leit.marke && (
        <div className="vp-msk-marken">
          <Marke art={leit.marke.ton}>{leit.marke.text}</Marke>
        </div>
      )}
      {leit.fehlt && (
        <p className="vp-msk-fehlt">
          <span>{leit.fehlt.satz}</span>
          {leit.fehlt.schritt && onAblesen && (
            <button type="button" className="vp-msk-weg" onClick={onAblesen}>
              {leit.fehlt.schritt} ›
            </button>
          )}
        </p>
      )}
      <Verlauf werte={leit.verlauf} />
      <p className="vp-k-sub">{leit.unter}</p>
    </Kachel>
  );
}

/**
 * Die zwölf Monate als Linie - jede Lücke bricht sie, nie eine 0 (dieselbe Geometrie wie die Spark der Übersicht).
 * Eine Spark zeigt die Form: die Skala reicht vom kleinsten zum größten Monat (mit Rand), nicht von null - die Zahl
 * selbst steht groß darüber.
 */
function Verlauf({ werte }: { werte: readonly (number | null)[] }) {
  const da = werte.filter((v): v is number => v !== null);
  if (da.length < 2) return null;
  const W = 400;
  const H = 44;
  const boden = H - 4;
  const min = Math.min(...da);
  const max = Math.max(...da);
  const rand = (max - min) * 0.6 || Math.abs(max) * 0.1 || 1;
  // Ein negativer Monat (saldiert) liegt unter der Null - dann reicht die Achse dorthin, statt ihn abzuschneiden.
  const unten = min >= 0 ? Math.max(0, min - rand) : min - rand;
  const verschoben = werte.map((v) => (v === null ? null : v - unten));
  const n = werte.length;
  return (
    <svg className="vp-msk-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Verlauf der letzten zwölf Monate">
      <path className="linie" d={pfad(verschoben, max - unten, n - 1, boden, W, n)} />
    </svg>
  );
}

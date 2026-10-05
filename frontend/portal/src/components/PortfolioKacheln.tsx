import { Gross, Kachel, Marke } from './kacheln/Kachel';
import type { LeitKachel, PortfolioKachelRaster, SpitzeKachel, Trend, VergleichKachel } from '../portfolioKacheln';
import './PortfolioKacheln.css';

/**
 * DAS KACHELRASTER der UEMS-Übersicht (Konzept `data/vp-portfolio-konzept2-p2`
 * §4.2): Leitkennzahl (EnPI gegen Ziel, mit Stern), Energieverbrauch, Lastspitze
 * und Energiekosten - in der Kachel-Familie des Cockpits ({@link Kachel}), mit den
 * Rollen-Tönen (Netz-Petrol, Verbrauch-Violett, Geld-Navy).
 *
 * **Render-only.** Welche Zahl, welcher Vergleich und welcher ehrliche Leersatz je
 * Kachel steht, entscheidet das reine {@link PortfolioKachelRaster}-Modell
 * (`portfolioKacheln.ts`); diese Komponente rendert es nur. Lade-, Fehler- und
 * Datenlage-Zustände bleiben ehrlich (Konzept §5.3).
 */
export interface PortfolioKachelnProps {
  raster: PortfolioKachelRaster | null;
  laedt: boolean;
  fehler: string | null;
  onErneut: () => void;
  /** Für den Datenlage-Fallback, wenn keine Leitkennzahl hinterlegt ist. */
  messstellen?: { mit: number; gesamt: number } | null;
}

/**
 * Der Vorjahres-/Vormonatspfeil. `gewertet` färbt ihn nach Richtung: bei
 * Verbrauch, Kosten und EnPI ist weniger besser, also ist „runter" ok (grün)
 * und „rauf" eine Warnung (bernstein). Ungewertet bleibt er neutral.
 */
function Pfeil({ trend, gewertet = false }: { trend: Trend; gewertet?: boolean }) {
  const art = gewertet ? (trend.richtung === 'runter' ? 'ok' : 'warn') : 'neutral';
  return (
    <Marke art={art}>
      <span aria-hidden="true">{trend.richtung === 'runter' ? '▼' : '▲'}</span> {trend.prozent} % {trend.bezug}
    </Marke>
  );
}

function Leit({ leit, messstellen }: { leit: LeitKachel | null; messstellen?: { mit: number; gesamt: number } | null }) {
  if (!leit) {
    // Datenlage-Fallback (Konzept §5.3): keine Leitkennzahl gegen Ziel hinterlegt.
    return (
      <Kachel id="pk-datenlage" name="Datenlage" icon="activity" ton="neutral" groesse="breit" lead>
        {messstellen ? (
          <>
            <Gross wert={String(messstellen.mit)} einheit={`von ${messstellen.gesamt}`} />
            <p className="vp-k-sub">Messstellen liefern Daten</p>
          </>
        ) : (
          <p className="vp-k-sub">Noch keine Leitkennzahl gegen ein Ziel hinterlegt.</p>
        )}
      </Kachel>
    );
  }
  return (
    <Kachel id="pk-leit" name={leit.name} icon="activity" ton="neutral" groesse="breit" lead>
      <Gross wert={leit.wert} einheit={leit.einheit || undefined} />
      {leit.ziel && <p className="vp-k-sub">{leit.ziel}</p>}
      <p className="vp-k-sub">{leit.stand}</p>
      <div className="vp-pk-marken">
        {leit.urteil && <Marke art={leit.urteil.ton}>{leit.urteil.wort}</Marke>}
        {leit.trend && <Pfeil trend={leit.trend} />}
      </div>
    </Kachel>
  );
}

function Vergleich({
  id,
  name,
  icon,
  ton,
  kachel,
}: {
  id: string;
  name: string;
  icon: 'pole' | 'euro';
  ton: 'grid' | 'geld';
  kachel: VergleichKachel;
}) {
  return (
    <Kachel id={id} name={name} icon={icon} ton={ton}>
      <Gross wert={kachel.wert} einheit={kachel.einheit || undefined} />
      {/* Punkt 4: jede Kachel trägt einen Vergleich — der gefärbte Pfeil oder
          der ehrliche Ersatzsatz, nie nur die nackte Zahl. */}
      {(kachel.trend || kachel.vergleich) && (
        <div className="vp-pk-marken">
          {kachel.trend ? <Pfeil trend={kachel.trend} gewertet /> : <Marke art="neutral">{kachel.vergleich}</Marke>}
        </div>
      )}
      {kachel.satz && <p className="vp-k-sub">{kachel.satz}</p>}
    </Kachel>
  );
}

function Spitze({ kachel }: { kachel: SpitzeKachel }) {
  return (
    <Kachel id="pk-lastspitze" name="Lastspitze" icon="trending-up" ton="load">
      <Gross wert={kachel.wert} einheit={kachel.einheit || undefined} />
      {kachel.fuellProzent != null && (
        <span className="vp-k-spur vp-pk-spur" aria-hidden="true">
          <i style={{ width: `${kachel.fuellProzent}%` }} />
        </span>
      )}
      <p className="vp-k-sub">{kachel.satz}</p>
    </Kachel>
  );
}

function Skelett() {
  return (
    <div className="vp-kraster vp-pk-raster" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="vp-k-platz is-klein">
          <div className="vp-k ton-neutral vp-pk-skelett" />
        </div>
      ))}
    </div>
  );
}

export function PortfolioKacheln({ raster, laedt, fehler, onErneut, messstellen }: PortfolioKachelnProps) {
  if (fehler) {
    return (
      <div className="vp-pk-fehler" role="alert">
        <p>Die Kennzahlen konnten nicht geladen werden.</p>
        <button type="button" onClick={onErneut}>
          Erneut versuchen
        </button>
      </div>
    );
  }
  if (laedt || !raster) {
    return <Skelett />;
  }
  return (
    // lang="de" (Punkt 3): erlaubt die deutsche Silbentrennung (`hyphens:auto`)
    // für lange Kennzahl-Namen wie „Stromeinsatz Spritzguss je kg".
    <section className="vp-pk" aria-label="Kennzahlen Ihrer Anlagen" lang="de">
      <div className="vp-kraster vp-pk-raster">
        <Leit leit={raster.leit} messstellen={messstellen} />
        {/* Kürzere Titel (Punkt 3): „Verbrauch"/„Kosten"/„Lastspitze" brechen am
            Handy nicht mehr mitten im Wort. Der Bezugszeitraum steht je Kachel. */}
        <Vergleich id="pk-verbrauch" name="Verbrauch" icon="pole" ton="grid" kachel={raster.verbrauch} />
        <Spitze kachel={raster.lastspitze} />
        <Vergleich id="pk-kosten" name="Kosten" icon="euro" ton="geld" kachel={raster.kosten} />
      </div>
    </section>
  );
}

import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { AnlageEnergie, AnlageKurve, EnergieStat } from '../anlageEnergie';
import { UEMS_ENERGIEBILANZ } from '../glossar';
import { useStaffel } from '../staffel';
import { flaeche, pfad } from './portfolio/kurveGeometrie';
import './AnlagenEnergie.css';

/**
 * DIE ANLAGEN-ENERGIE-KARTEN der UEMS-Übersicht („Anlagen nach Standort",
 * Konzept `data/vp-portfolio-konzept2-p2` Runde 4). Je Anlage eine Karte mit
 * ihren wichtigsten ENERGIEDATEN in den Rollen-Farben des Flusses (Verbrauch,
 * Erzeugung, Netz, Speicher) statt einer Kennzahl — die Kennzahl liegt eine
 * Ebene tiefer (Anlage · Auswerten).
 *
 * **Render-only.** Welche Energiedaten je Anlagentyp stehen und wie sie ehrlich
 * lauten, entscheidet das reine {@link AnlageEnergie}-Modell (`anlageEnergie.ts`);
 * diese Komponente rendert es nur. Die ganze Karte ist der Absprung auf die
 * Anlage; am Telefon stapeln die Karten, am Rechner stehen die Energiedaten in
 * einer Reihe — kein Querscrollen, keine breite Tabelle.
 */
export interface AnlagenEnergieGruppe {
  key: string;
  kopf: ReactNode;
  karten: AnlageEnergie[];
  /** Der Satz, wenn die Gruppe keine Anlage hat; null = sie hat welche. */
  leer: string | null;
}

export interface AnlagenEnergieProps {
  /** Nach Standorten gruppiert (Unternehmensebene); je Gruppe ein Kopf. */
  gruppen?: AnlagenEnergieGruppe[] | null;
  /** Ungruppiert (Standortebene). */
  karten?: AnlageEnergie[];
  onOeffnen: (siteId: string) => void;
  /** AP-13 IP-8: Anlagen mit Hauptzähler in der Stellung tragen den Weg „Energiebilanz". */
  energiebilanz?: ReadonlySet<string> | null;
  onEnergiebilanz?: (siteId: string) => void;
}

function Stat({ s }: { s: EnergieStat }) {
  return (
    <div className="vp-ae-stat">
      <span className="vp-ae-stat-l">
        <i className={`vp-ae-key is-${s.rolle}`} aria-hidden="true" />
        {s.label} · {s.zeit}
      </span>
      <span className={`vp-ae-stat-v${s.dim ? ' is-dim' : ''}${s.leer ? ' is-leer' : ''}`}>
        {s.wert}
        {s.einheit && <small> {s.einheit}</small>}
      </span>
    </div>
  );
}

/**
 * Die kleine Tages-Verlaufskurve der Anlage in Rollen-Farben: PV-Fläche + -Linie
 * (orange) und Verbrauch (violett). Rendert mit der GEMEINSAMEN Kurvengeometrie
 * ({@link flaeche}/{@link pfad}, dieselbe wie die große Tageskurve der Kunden-
 * übersicht) und schneidet rechts bei „jetzt" ab — rechts davon ist nichts
 * gemessen (AGENTS.md „veraltete Daten nicht als aktuell zeigen").
 */
function Spark({ kurve }: { kurve: AnlageKurve }) {
  const alle = [...kurve.pv, ...kurve.load].filter((v): v is number => v != null);
  const max = Math.max(0, ...alle) * 1.1;
  if (max <= 0) return null;
  return (
    <svg
      className="vp-ae-spark"
      viewBox="0 0 96 28"
      preserveAspectRatio="none"
      role="img"
      aria-label="Tagesverlauf von Erzeugung und Verbrauch"
    >
      <line className="achse" x1={0} x2={96} y1={27} y2={27} />
      <path className="pv-a" d={flaeche(kurve.pv, max, kurve.jetzt, 27, 96)} />
      <path className="pv-l" d={pfad(kurve.pv, max, kurve.jetzt, 27, 96)} />
      <path className="ld-l" d={pfad(kurve.load, max, kurve.jetzt, 27, 96)} />
    </svg>
  );
}

function Karte({
  k,
  onOeffnen,
  energiebilanz,
  onEnergiebilanz,
}: {
  k: AnlageEnergie;
  onOeffnen: (siteId: string) => void;
  energiebilanz?: ReadonlySet<string> | null;
  onEnergiebilanz?: (siteId: string) => void;
}) {
  const weg = onEnergiebilanz && energiebilanz?.has(k.id);
  return (
    <article className="vp-ae" onClick={() => onOeffnen(k.id)}>
      <div className="vp-ae-kopf">
        <button
          type="button"
          className="vp-ae-open"
          aria-label={`Anlage ${k.name} öffnen`}
          onClick={(e) => {
            e.stopPropagation();
            onOeffnen(k.id);
          }}
        >
          <span className={`vp-ae-dot is-${k.zustand.ton}`} aria-hidden="true" />
          <span className="vp-ae-name">{k.name}</span>
        </button>
        <span className="vp-ae-chev" aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
        <span className="vp-ae-chips">
          {k.nichtZugeordnet && <span className="vp-ae-unzugeordnet">noch nicht zugeordnet</span>}
          <span className="vp-ae-typ">{k.typ}</span>
        </span>
      </div>
      {/* Statuszeile nur bei Abweichung SICHTBAR — im Normalfall genügt der Punkt
          (Status-Variante A). Für Screenreader bleibt der Zustand immer lesbar. */}
      <p className={`vp-ae-satz is-${k.zustand.ton}${k.zustand.ton === 'ok' ? ' vp-sr-only' : ''}`}>
        {k.zustand.wort}
        {k.zustand.alter ? ` · ${k.zustand.alter}` : ''}
      </p>
      {k.speicherOhneGeraet && (
        <span className="vp-ae-warn">
          <Icon name="alert-triangle" size={12} />
          Speicher ohne Gerät
        </span>
      )}
      <div className={`vp-ae-body${k.kurve ? ' has-spark' : ''}`}>
        <div className="vp-ae-stats" data-count={k.stats.length}>
          {k.stats.map((s) => (
            <Stat key={s.label} s={s} />
          ))}
        </div>
        {k.kurve && <Spark kurve={k.kurve} />}
      </div>
      {weg && (
        <div className="vp-ae-fuss">
          <button
            type="button"
            className="vp-ae-weg"
            onClick={(e) => {
              e.stopPropagation();
              onEnergiebilanz?.(k.id);
            }}
          >
            {UEMS_ENERGIEBILANZ}
          </button>
        </div>
      )}
    </article>
  );
}

export function AnlagenEnergie({ gruppen, karten, onOeffnen, energiebilanz, onEnergiebilanz }: AnlagenEnergieProps) {
  const staffel = useStaffel('portfolio-anlagen');
  const liste = staffel ? `vp-ae-liste ${staffel}` : 'vp-ae-liste';
  const eine = (k: AnlageEnergie) => (
    <Karte key={k.id} k={k} onOeffnen={onOeffnen} energiebilanz={energiebilanz} onEnergiebilanz={onEnergiebilanz} />
  );
  if (gruppen) {
    return (
      <div className="vp-ae-gruppen">
        {gruppen.map((g) => (
          <section key={g.key} className="vp-ae-gruppe" data-testid="anlagen-gruppe">
            {g.kopf}
            {g.karten.length === 0 && g.leer ? (
              <p className="vp-ae-leer">{g.leer}</p>
            ) : (
              <div className={liste}>{g.karten.map(eine)}</div>
            )}
          </section>
        ))}
      </div>
    );
  }
  if (!karten || karten.length === 0) return null;
  return <div className={liste}>{karten.map(eine)}</div>;
}

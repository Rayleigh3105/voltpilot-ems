import type { BereichTab } from '../anlageNav';
import type { AnlagenSub } from '../nav';
import './BereichTabs.css';

/**
 * Die REITER eines Anlagen-Bereichs (Navigations-Runde „zwei Ebenen",
 * Konzept `data/vp-portfolio-konzept-r2` §5.5, Captain-Entscheid E3).
 *
 * Sie ersetzen die früheren Nav-Einträge: „Messwerte", „Erlöse", „Marktpreise",
 * „Lastspitzen", „Prognose" standen einzeln in der Seitenleiste (14 Einträge in
 * 3 Gruppen, zwei davon DOPPELT auf zwei Ebenen) und sind jetzt Reiter der
 * Seite, auf der sie gemeint sind.
 *
 * ⚠ Sie kommen FERTIG von `anlageNav.tabsFor` — die Fläche leitet keine
 * Reiter ab. `tabsFor` gibt bei höchstens EINEM Reiter eine leere Liste
 * zurück, also rendert dieser Baustein dann gar nichts: eine Leiste mit einem
 * Reiter behauptete eine Wahl, die es nicht gibt.
 */
export function BereichTabs({
  tabs,
  active,
  label,
  onOpen,
}: {
  tabs: BereichTab[];
  /** Die offene Unterseite; `null` = keiner der Reiter ist aktiv. */
  active: AnlagenSub | null;
  /** Zugänglicher Name der Leiste („Reiter des Bereichs Verlauf"). */
  label: string;
  onOpen: (sub: AnlagenSub) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="vp-bereich-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => {
        const ist = t.sub === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={ist}
            className={`vp-bereich-tab${ist ? ' active' : ''}`}
            onClick={() => onOpen(t.sub)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

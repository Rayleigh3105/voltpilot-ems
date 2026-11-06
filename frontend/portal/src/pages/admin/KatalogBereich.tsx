import { useEffect, useRef, type ReactNode } from 'react';
import { KATALOG_TABS, parseSektion, sektionHash, type KatalogSektion } from '../../nav';
import { VorlagenPage } from './VorlagenPage';
import { SteuerungsFreigabePage } from './SteuerungsFreigabePage';
import { KomponentenFlottePage } from './KomponentenFlottePage';

/**
 * Plattform › Katalog (Konzept `vp-adminview-konzept-k1` §4.3, Umzugstabelle
 * §4.7): EIN Ort für Gerätevorlagen, die steuerbaren Modelle (das Register der
 * Steuerungs-Freigabe) und die Komponenten-Welt der Flotte - drei bestehende
 * Seiten, ungeändert, hinter einem gemeinsamen Unter-Reiter.
 *
 * `?sektion=` wählt den Unter-Reiter (Default „Vorlagen"); `geraetetypen`
 * bleibt als WERT gültig (die alte Sektion der Steuerungs-Freigabe) und zeigt
 * dabei den Reiter „Steuerungs-Freigabe" - die Seite selbst liest denselben
 * Parameter für ihren Anker.
 */
export function KatalogBereich({ tabs }: { tabs?: ReactNode } = {}) {
  const sektion = parseSektion(window.location.hash);
  const aktiv: KatalogSektion = sektion === 'komponenten'
    ? 'komponenten'
    : sektion === 'modelle' || sektion === 'geraetetypen'
      ? 'modelle'
      : 'vorlagen';

  const innenTabs = <KatalogTabs active={aktiv} />;
  return (
    <>
      {tabs}
      {innenTabs}
      {aktiv === 'vorlagen' && <VorlagenPage />}
      {aktiv === 'modelle' && <SteuerungsFreigabePage />}
      {aktiv === 'komponenten' && <KomponentenFlottePage />}
    </>
  );
}

function KatalogTabs({ active }: { active: KatalogSektion }) {
  const gewaehlt = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const knopf = gewaehlt.current;
    const leiste = knopf?.parentElement;
    if (!knopf || !leiste || leiste.scrollWidth <= leiste.clientWidth) return;
    const links = knopf.getBoundingClientRect().left - leiste.getBoundingClientRect().left + leiste.scrollLeft;
    leiste.scrollLeft = Math.max(0, links - (leiste.clientWidth - knopf.offsetWidth) / 2);
  }, [active]);
  return (
    <div className="vp-seg vp-bereich-tabs vp-katalog-tabs" role="tablist" aria-label="Katalog">
      {KATALOG_TABS.map((t) => (
        <button
          key={t.id}
          ref={active === t.id ? gewaehlt : undefined}
          role="tab"
          aria-selected={active === t.id}
          className={active === t.id ? 'active' : ''}
          onClick={() => {
            window.location.hash = sektionHash('katalog', t.id);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

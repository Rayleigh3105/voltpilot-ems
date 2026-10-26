import { useEffect, useRef } from 'react';
import { GERAETE_BEREICH, pageRoute, type PageId, type Route } from '../../nav';
import { GeraeteRegistryPage } from './GeraeteRegistryPage';
import { EdgeUpdatesPage } from './EdgeUpdatesPage';
import { FernwartungPage } from './FernwartungPage';
import { WerkstattPage } from './WerkstattPage';

/** Geräte opens on Updates: version overview and rollout actions. Registration
 * is the secondary tab, Fernwartung (Wartungstunnel, E5) the third, Werkstatt
 * (Boxen vor dem Versand, 26.10.2026) the fourth. All existing routes and
 * device deep links survive. */
export function GeraeteBereich({
  page,
  onNavigate,
  onJumpToTenant,
}: {
  page: PageId;
  onNavigate: (target: Route | PageId) => void;
  onJumpToTenant?: (tenantId: string, route: Route) => void;
}) {
  const tabs = (
    <GeraeteTabs active={page} onSelect={(id) => onNavigate(pageRoute(id))} />
  );

  if (page === 'fernwartung') return <FernwartungPage tabs={tabs} />;
  if (page === 'werkstatt') return <WerkstattPage tabs={tabs} />;
  return page === 'edge-updates' ? (
    <EdgeUpdatesPage onNavigate={(r) => onNavigate(r)} onJumpToTenant={onJumpToTenant} tabs={tabs} />
  ) : (
    <GeraeteRegistryPage onJumpToTenant={onJumpToTenant} tabs={tabs} />
  );
}

/**
 * Die Tab-Leiste des Bereichs - das Haus-Segment (`.vp-seg`, dieselbe Form wie
 * der Zeitraum-Umschalter der Historie), damit die Konsole keine zweite
 * Umschalt-Sprache lernt.
 */
export function GeraeteTabs({
  active,
  onSelect,
}: {
  active: PageId;
  onSelect: (id: PageId) => void;
}) {
  // Vier Reiter passen am Telefon nicht nebeneinander; die Leiste scrollt in sich. Der gewählte
  // Reiter steht beim Öffnen im sichtbaren Teil, sonst ist „Werkstatt“ halb verdeckt.
  const gewaehlt = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const zeigen = () => {
      const knopf = gewaehlt.current;
      const leiste = knopf?.parentElement;
      if (!knopf || !leiste || leiste.scrollWidth <= leiste.clientWidth) return;
      const links = knopf.getBoundingClientRect().left - leiste.getBoundingClientRect().left + leiste.scrollLeft;
      leiste.scrollLeft = Math.max(0, links - (leiste.clientWidth - knopf.offsetWidth) / 2);
    };
    zeigen();
    // Die Breiten stehen erst mit der geladenen Schrift fest.
    let aktiv = true;
    void document.fonts?.ready.then(() => aktiv && zeigen());
    return () => {
      aktiv = false;
    };
  }, [active]);
  return (
    <div className="vp-seg vp-bereich-tabs" role="tablist" aria-label="Geräte-Bereich">
      {GERAETE_BEREICH.tabs.map((t) => (
        <button
          key={t.id}
          ref={active === t.id ? gewaehlt : undefined}
          role="tab"
          aria-selected={active === t.id}
          className={active === t.id ? 'active' : ''}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

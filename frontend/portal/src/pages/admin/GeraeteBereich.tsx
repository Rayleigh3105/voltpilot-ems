import { GERAETE_BEREICH, pageRoute, type PageId, type Route } from '../../nav';
import { GeraeteRegistryPage } from './GeraeteRegistryPage';
import { EdgeUpdatesPage } from './EdgeUpdatesPage';

/** Geräte opens on Updates: version overview and rollout actions. Registration
 * is the secondary tab. Both existing routes and device deep links survive. */
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
  return (
    <div className="vp-seg vp-bereich-tabs" role="tablist" aria-label="Geräte-Bereich">
      {GERAETE_BEREICH.tabs.map((t) => (
        <button
          key={t.id}
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

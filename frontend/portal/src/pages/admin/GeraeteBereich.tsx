import { GERAETE_BEREICH, pageRoute, type PageId, type Route } from '../../nav';
import { GeraeteRegistryPage } from './GeraeteRegistryPage';
import { EdgeUpdatesPage } from './EdgeUpdatesPage';

/**
 * Plattform → **Geräte**: EIN Bereich, zwei Tabs (Admin-Umbau Stufe 3
 * „Zusammenwachsen", Konzept `vp-admin-neu-konzept-a9` §3.2, Captain-Entscheid
 * F3).
 *
 * Der Captain-Schmerz war, dass ein GERÄT über drei Flächen verstreut lag,
 * obwohl seine Daten längst in einer Zeile liegen. Stufe 2 gab ihm seine
 * Detailseite; diese Stufe gibt seinen zwei Arbeits-Flächen EINEN Ort:
 * **Inventar** (der Lebenszyklus je Box: Funnel, Tabelle, „wartet auf
 * Zuordnung") und **Updates** (die Rollout-Kampagne: Handeln-Karte, Wellen,
 * Releases, Verlauf).
 *
 * **Die zwei FLÄCHEN sind unangetastet** - `vp-admin-geraete-ux-k2` §4 hatte
 * die Voll-Fusion abgelehnt („zwei Job-Familien mit verschiedener Kadenz auf
 * einer Fläche" ergäbe eine Tabellen-Wand), und dieses Argument gilt weiter:
 * es richtet sich gegen EINE SEITE, nicht gegen EINEN ORT. Deshalb ist dieser
 * Wirt bewusst dünn - er reicht nur die Tab-Leiste als Knoten durch, und jede
 * Seite entscheidet selbst, WO sie sie zeigt (die Detailseite eines Geräts
 * zeigt sie gar nicht: sie ist eine Ebene tiefer).
 *
 * **Beide Routen bleiben ECHTE `PageId`s** - ein Lesezeichen auf
 * `#/edge-updates` landet auf dem Tab Updates, und der programmatische Sprung
 * des Flotten-Pulses funktioniert unverändert.
 */
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

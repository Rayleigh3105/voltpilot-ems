import { useEffect, useRef, type ReactNode } from 'react';
import type { Tenant } from '../../admin/adminApi';
import { GeraeteAktePage } from './GeraeteAktePage';
import { GeraeteListePage } from './GeraeteListePage';
import { EdgeUpdatesPage } from './EdgeUpdatesPage';
import { FernwartungPage } from './FernwartungPage';
import { WerkstattPage } from './WerkstattPage';
import {
  GERAETE_BEREICH, geraeteAkteRoute, pageRoute,
  type AnlageWerkzeug, type GeraeteAkteReiter, type PageId, type Route,
} from '../../nav';

/**
 * Der Raum „Geräte" (§4.2, Scheiben S2/S3; umgehängt mit dem Captain-Entscheid
 * „Ich finde auch das bei den Geräten … viel sinnvoller wäre"): EINE
 * gemeinsame Reiterleiste über vier bestehenden Seiten - die Geräte-Liste
 * (ohne Box-Referenz die GERÄTE-LISTE, mit Referenz die GERÄTEAKTE), Software,
 * Werkstatt und Fernwartung. Dieselbe Reiterleiste wie der Raum „Plattform"
 * trägt (`PlattformBereich`), nur mit den gerätebezogenen Flächen statt der
 * geräteübergreifenden.
 */
export function GeraeteBereich({
  page,
  geraeteAkte,
  onNavigate,
  onJumpToTenant,
  tenants,
}: {
  page: PageId;
  geraeteAkte?: { ref: string; reiter: GeraeteAkteReiter | null; werkzeug?: AnlageWerkzeug | null } | null;
  onNavigate: (target: Route | PageId) => void;
  /** Reiter „Anlage" (S3): „Wie der Kunde es sieht"-Werkzeuge (Prognose, Gemeinsame Steuerung). */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  tenants?: Tenant[];
}) {
  const tabs = <GeraeteTabs active={page} onSelect={(id) => onNavigate(pageRoute(id))} />;

  if (page === 'fernwartung') return <FernwartungPage tabs={tabs} />;
  if (page === 'werkstatt') return <WerkstattPage tabs={tabs} />;
  if (page === 'edge-updates') {
    return <EdgeUpdatesPage onNavigate={(r) => onNavigate(r)} tabs={tabs} />;
  }
  return (
    <GeraeteRegistryPage
      geraeteAkte={geraeteAkte}
      onNavigate={(r) => onNavigate(r)}
      onJumpToTenant={onJumpToTenant}
      tenants={tenants}
      tabs={tabs}
    />
  );
}

/** Die Tab-Leiste des Raums - das Haus-Segment (`.vp-seg`), wie der Raum „Plattform". */
function GeraeteTabs({
  active,
  onSelect,
}: {
  active: PageId;
  onSelect: (id: PageId) => void;
}) {
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
    let aktiv = true;
    void document.fonts?.ready.then(() => aktiv && zeigen());
    return () => {
      aktiv = false;
    };
  }, [active]);
  return (
    <div className="vp-seg vp-bereich-tabs vp-geraete-tabs" role="tablist" aria-label="Geräte">
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

/**
 * Ohne Box-Referenz die GERÄTE-LISTE (jede Box in jedem Lebensabschnitt), mit
 * Referenz die GERÄTEAKTE - ein Ort je Box statt der früheren
 * Registrierungs-Seite und einem zweiten Fenster. Der Dateiname/Exportname
 * bleibt (Lesezeichen, `pageChunks.ts`).
 */
export function GeraeteRegistryPage({
  geraeteAkte,
  onNavigate,
  onJumpToTenant,
  tenants,
  tabs,
}: {
  geraeteAkte?: { ref: string; reiter: GeraeteAkteReiter | null; werkzeug?: AnlageWerkzeug | null } | null;
  onNavigate?: (target: Route) => void;
  /** Reiter „Anlage" (S3): „Wie der Kunde es sieht"-Werkzeuge (Prognose, Gemeinsame Steuerung). */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  tenants?: Tenant[];
  tabs?: ReactNode;
} = {}) {
  if (geraeteAkte) {
    return (
      <>
        {tabs}
        <GeraeteAktePage boxRef={geraeteAkte.ref} reiter={geraeteAkte.reiter} werkzeug={geraeteAkte.werkzeug ?? null}
          onNavigate={onNavigate} onJumpToTenant={onJumpToTenant} tenants={tenants ?? []} />
      </>
    );
  }
  return (
    <>
      {tabs}
      <GeraeteListePage
        onOpen={(ref, werkzeug) => onNavigate?.(geraeteAkteRoute(ref, werkzeug ? 'anlage' : null, werkzeug ?? null))}
      />
    </>
  );
}

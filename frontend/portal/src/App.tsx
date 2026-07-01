import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Card } from '../designsystem/components/core/Card';
import logoUrl from '../designsystem/assets/voltpilot-logo.png';
import { isPlatformAdmin, login } from './auth';
import { api, ApiError, setTenantOverride, type Device, type Site } from './api';
import { adminApi, type Tenant } from './admin/adminApi';
import { AppShell } from './shell/AppShell';
import { hashForPage, pageFromHash, PLATFORM_PAGES, type PageId } from './nav';
import { UebersichtPage } from './pages/UebersichtPage';
import { StandortePage } from './pages/StandortePage';
import { GeraetePage } from './pages/GeraetePage';
import { FahrplanPage, MarktpreisePage, WetterPage } from './pages/DataPages';
import { HistoriePage } from './pages/HistoriePage';
import { MandantenPage } from './pages/admin/MandantenPage';
import { BenutzerPage } from './pages/admin/BenutzerPage';

export default function App({
  initialAuth,
  authError = false,
}: {
  initialAuth: boolean;
  authError?: boolean;
}) {
  if (!initialAuth) return <LoginScreen authError={authError} />;
  // ONE app for both roles (unified shell): a Portal-Admin gets the same
  // customer pages via the tenant switcher plus the additive "Plattform" nav
  // group. The backend enforces the role split (403 / header-gated tenant
  // override) - the UI only adapts the surface.
  return <UnifiedPortal />;
}

function LoginScreen({ authError }: { authError: boolean }) {
  return (
    <div className="vp-login">
      <Card padding="lg" radius="lg" className="vp-login-card">
        <img src={logoUrl} alt="VoltPilot" />
        <h1>VoltPilot EMS</h1>
        <p>Energiemanagement-Portal - melden Sie sich an, um Ihre Standorte und Telemetrie zu sehen.</p>
        <Button variant="primary" size="lg" fullWidth onClick={login}>
          Anmelden mit Keycloak
        </Button>
        {authError && (
          <div className="vp-alert vp-alert-err">
            Keycloak ist nicht erreichbar. Läuft der lokale Stack (docker compose up)?
          </div>
        )}
      </Card>
    </div>
  );
}

function UnifiedPortal() {
  const isAdmin = useMemo(() => isPlatformAdmin(), []);
  const [page, setPage] = useState<PageId>(() => {
    const p = pageFromHash();
    return !isAdmin && PLATFORM_PAGES.some((d) => d.id === p) ? 'uebersicht' : p;
  });

  // Admin tenant context (the switcher). Customers never have an override -
  // their tenant comes from the JWT and the backend ignores the header anyway.
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const [sites, setSites] = useState<Site[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the module-level API header in sync BEFORE any tenant-scoped fetch.
  setTenantOverride(isAdmin ? tenantId : null);

  const navigate = useCallback(
    (p: PageId) => {
      if (!isAdmin && PLATFORM_PAGES.some((d) => d.id === p)) p = 'uebersicht';
      window.location.hash = hashForPage(p);
      setPage(p);
    },
    [isAdmin],
  );

  // Hash routing: back/forward + direct edits.
  useEffect(() => {
    const onHash = () => {
      const p = pageFromHash();
      setPage(!isAdmin && PLATFORM_PAGES.some((d) => d.id === p) ? 'uebersicht' : p);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [isAdmin]);

  const reloadTenants = useCallback(
    (selectId?: string) => {
      if (!isAdmin) return;
      adminApi
        .listTenants()
        .then((t) => {
          setTenants(t);
          if (selectId) setTenantId(selectId);
        })
        .catch((e) =>
          setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler'),
        );
    },
    [isAdmin],
  );

  useEffect(() => {
    reloadTenants();
  }, [reloadTenants]);

  // Tenant-scoped data. For an admin without a selected tenant this yields
  // empty lists (backend default-deny) - the pages show a pick-a-tenant hint.
  const tenantReady = !isAdmin || tenantId != null;
  const reload = useCallback(
    async (selectSiteId?: string) => {
      if (!tenantReady) {
        setSites([]);
        setDevices([]);
        setSelectedSite(null);
        return;
      }
      try {
        const [s, d] = await Promise.all([api.listSites(), api.listDevices()]);
        setSites(s);
        setDevices(d);
        setSelectedSite((cur) =>
          selectSiteId ?? (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null),
        );
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
      }
    },
    [tenantReady],
  );

  useEffect(() => {
    void reload();
  }, [reload, tenantId]);

  const changeTenant = (id: string | null) => {
    setTenantId(id);
    setSelectedSite(null);
  };

  const jumpToTenant = (id: string, target: PageId) => {
    changeTenant(id);
    navigate(target);
  };

  const customerProps = {
    sites,
    devices,
    selectedSite,
    onSelectSite: setSelectedSite,
    onReload: (selectSiteId?: string) => void reload(selectSiteId),
  };

  const needsTenantPick = isAdmin && tenantId == null && !isPlatformPage(page);

  return (
    <AppShell
      page={page}
      onNavigate={navigate}
      isAdmin={isAdmin}
      counts={{
        sites: tenantReady ? sites.length : null,
        devices: tenantReady ? devices.length : null,
      }}
      tenants={tenants}
      tenantOverride={tenantId}
      onTenantChange={changeTenant}
    >
      {error && <div className="vp-alert vp-alert-err" style={{ marginBottom: 'var(--vp-space-4)' }}>{error}</div>}

      {needsTenantPick ? (
        <PickTenantNotice tenants={tenants} onPick={changeTenant} />
      ) : (
        <>
          {page === 'uebersicht' && (
            <UebersichtPage {...customerProps} onNavigate={navigate} />
          )}
          {page === 'standorte' && <StandortePage {...customerProps} />}
          {page === 'geraete' && (
            <GeraetePage sites={sites} devices={devices} onReload={() => void reload()} />
          )}
          {page === 'marktpreise' && (
            <MarktpreisePage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'wetter' && (
            <WetterPage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'fahrplan' && (
            <FahrplanPage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'historie' && (
            <HistoriePage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'mandanten' && isAdmin && (
            <MandantenPage
              tenants={tenants}
              onReloadTenants={reloadTenants}
              onJumpToTenant={jumpToTenant}
            />
          )}
          {page === 'benutzer' && isAdmin && (
            <BenutzerPage tenants={tenants} tenantOverride={tenantId} />
          )}
        </>
      )}
    </AppShell>
  );
}

function isPlatformPage(page: PageId): boolean {
  return PLATFORM_PAGES.some((d) => d.id === page);
}

/** Admin on a customer page without a tenant context: never a dead-end. */
function PickTenantNotice({
  tenants,
  onPick,
}: {
  tenants: Tenant[];
  onPick: (tenantId: string) => void;
}) {
  return (
    <Card padding="lg" radius="lg">
      <div className="vp-empty">
        <h3>Mandanten-Kontext wählen</h3>
        <p>
          Diese Seite zeigt Kundendaten. Wählen Sie oben im Kontext-Umschalter einen
          Mandanten (oder hier direkt), um dessen Portal-Ansicht zu sehen.
        </p>
        <div style={{ display: 'flex', gap: 'var(--vp-space-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
          {tenants.slice(0, 6).map((t) => (
            <Button key={t.id} variant="outline" size="sm" onClick={() => onPick(t.id)}>
              {t.name}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  );
}

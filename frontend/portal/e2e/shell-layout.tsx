/** Real shared shell, deterministic names and states; no API or device writes. */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MobileStickyHead } from '../src/components/CockpitBlocks';
import { AppShell } from '../src/shell/AppShell';
import { anlageSidebar } from '../src/ebenenNav';
import { anlageSurface } from '../src/surface';
import { keycloak } from '../src/auth';
import { healthBadge } from '../src/health';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const isAdmin = params.has('admin');
const sites = [
  { id: 'sonnenhof', name: params.has('long') ? 'Solarpark Sonnenhof am südlichen Gewerbegebiet' : 'Sonnenhof' },
  { id: 'werkstatt', name: 'Werkstatt am Bach' },
];
Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: [isAdmin ? 'platform-admin' : 'operator'] } } });
const surface = anlageSurface({ entities: [{ id: 'battery', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } }], config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch' } });
const tenants = [{ id: 'beispiel', name: 'Stadtwerke Musterstadt Energieversorgung', segment: 'CI', plan: 'basic', betriebsart: null, betriebsartEffective: 'betreiber' as const, createdAt: '2026-01-01T00:00:00Z' }];
const health = params.has('unknown') ? null : healthBadge({ devices: { deviceCount: 1, onlineCount: params.has('ok') ? 1 : 0, waitingCount: 0 } });

function Fixture() {
  const [selected, setSelected] = useState(sites[0].id);
  const [tenant, setTenant] = useState<string | null>('beispiel');
  const [fleet, setFleet] = useState(params.has('fleet'));
  const site = sites.find(s => s.id === selected)!;
  return <AppShell page={fleet ? 'portfolio' : 'anlagen'} onNavigate={() => setFleet(true)} isAdmin={isAdmin}
    showOverview={false} showPortfolio showAddAnlage={false} onAddAnlage={() => {}}
    counts={{ sites: sites.length, devices: 2 }} tenants={tenants} tenantOverride={tenant} onTenantChange={setTenant}
    anlage={fleet ? null : { siteId: site.id, siteName: site.name, sites, sidebar: anlageSidebar(surface, 0),
      activeKey: 'cockpit', onSelectSite: setSelected, onOpenSub: () => {}, onOpenPage: () => setFleet(true),
      onOpenFleet: () => setFleet(true), health }}>
    <div className="vp-page-head"><div className="titles"><h1>{fleet ? 'Portfolio' : site.name}</h1><p>Ihre Energie im Überblick</p></div></div>
    <div className="vp-card"><h2>Layoutprüfung</h2><p>Die Kopfzeile und Navigation sind die Original-Komponenten des Portals.</p></div>
    <MobileStickyHead head={{ value: '2,40 €', label: 'heute', status: 'Offline', tone: 'warn' }} shown />
    <div style={{ height: '120vh' }} />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

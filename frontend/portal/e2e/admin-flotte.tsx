import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { PlattformUebersichtPage } from '../src/pages/admin/PlattformUebersichtPage';
import { fleetApi, type AdminFleetSite } from '../src/admin/fleetApi';
import { adminApi } from '../src/admin/adminApi';
import { keycloak } from '../src/auth';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const now = new Date().toISOString();
const vorZehnMinuten = new Date(Date.now() - 10 * 60_000).toISOString();

function site(over: Partial<AdminFleetSite>): AdminFleetSite {
  return {
    siteId: 's1', siteName: 'Werk Ahrenberg', tenantId: 't1', tenantName: 'Kunststoffwerk Ahrenberg',
    plantKind: 'eigenverbrauch', netzladenErlaubt: false, tarifArt: 'fest',
    deviceCount: 2, onlineCount: 1, waitingCount: 0, worstStatus: 'stale', lastSeenAt: now,
    lastPlanGeneratedAt: vorZehnMinuten, hasStorage: true, batteryWithoutDevice: false,
    sources: { total: 3, ok: 2, stale: 1, never: 0 }, edge: null, update: null,
    control: null, curtailment: null,
    kwp: { configuredKwp: 420, observedPeakKw: 402, buckets: 1200, verdict: 'ok', reason: 'Plausibel.' },
    forecast: [], pflege: [], boxes: [], ...over,
  };
}

const sites: AdminFleetSite[] = [
  site({
    boxes: [
      {
        deviceId: 'd1', externalRef: 'VP-BOX-AH-01', name: 'Box Leitstand', fuehrtAnlage: true,
        lastSeenAt: now, edge: { coreVersion: 'edge-2026.09.0', paletteVersion: '0.9.0', reportedAt: now },
        update: { version: 'edge-2026.09.0', backend: 'compose', current: 'edge-2026.09.0', target: null, state: 'idle', reason: null, lastKnownGood: null, reportedAt: now },
      },
      {
        deviceId: 'd2', externalRef: 'VP-BOX-AH-02', name: 'Box Halle 2', fuehrtAnlage: false,
        lastSeenAt: vorZehnMinuten, edge: { coreVersion: 'edge-2026.08.0', paletteVersion: '0.8.0', reportedAt: vorZehnMinuten },
        update: null,
      },
    ],
  }),
  site({
    siteId: 's2', siteName: 'Werk Lindach', deviceCount: 1, onlineCount: 0, waitingCount: 1,
    worstStatus: 'waiting', lastSeenAt: null, lastPlanGeneratedAt: null, hasStorage: false,
    sources: null,
    boxes: [{
      deviceId: 'd3', externalRef: 'VP-BOX-LI-01', name: null, fuehrtAnlage: true,
      lastSeenAt: null, edge: null, update: null,
    }],
  }),
];

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});
Object.assign(fleetApi, {
  fleet: async () => ({
    sites,
    releases: [
      { releaseSeq: 2, version: 'edge-2026.09.0' },
      { releaseSeq: 1, version: 'edge-2026.08.0' },
    ],
    unterstuetzungBis: { t1: '2026-09-30T18:00:00Z' },
    unterstuetzungStandorte: [],
  }),
});
Object.assign(adminApi, {
  edgeUpdates: async () => { throw new Error('Auf dieser Bühne nicht geladen'); },
});

function Fixture() {
  return (
    <AppShell page="plattform-uebersicht" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 2, devices: 3 }} tenants={[]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <PlattformUebersichtPage onJumpToTenant={() => undefined} onNavigate={() => undefined} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

/** Real admin components with fictional data; all API calls stay in memory. */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteBereich';
import { adminApi } from '../src/admin/adminApi';
import { keycloak } from '../src/auth';
import { type EdgeUpdates, type FleetRow } from '../src/adminEdgeUpdates';
import { type PageId } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const now = new Date().toISOString();
const base: FleetRow = {
  deviceId: 'd1', label: 'VP-BOX-1001', externalRef: 'VP-BOX-1001', siteId: 's1',
  siteName: 'Solarpark Sonnenhof', tenantId: 't1', tenantName: 'Stadtwerke Musterstadt',
  ist: 'edge-2026.09.10-a18b472eab90', soll: 'edge-2026.09.10', sollSeq: 42,
  state: 'bestaetigt', reason: null, since: now, reportedAt: now, rolloutId: null,
  trust: { rootKeyIds: ['root'], trustSetKeyIds: ['release'], trustSetGeneratedAt: now, trustSetError: null },
};
const fleet: FleetRow[] = [
  base,
  { ...base, deviceId: 'd2', externalRef: 'edge-abcdefj', label: 'Box Werkstatt', siteName: 'Werkstatt am Bach',
    ist: 'edge-2026.09.02-73486bab2980', state: 'laedt', reason: 'Das Update wird heruntergeladen.' },
  { ...base, deviceId: 'd3', externalRef: 'VP-BOX-1003', label: 'VP-BOX-1003', siteName: 'Gewerbepark West',
    tenantName: 'Muster Solar GmbH', ist: 'edge-2026.09.02-73486bab2980', state: 'blockiert',
    blocker: 'platte', reason: 'Zu wenig freier Speicherplatz auf der Box.' },
  { ...base, deviceId: 'd4', externalRef: 'VP-BOX-1004', label: 'VP-BOX-1004', siteName: 'Hof Lindenallee',
    tenantName: 'Familie Beispiel', state: 'offline_holt_nach', ist: 'edge-2026.09.02-73486bab2980',
    reportedAt: new Date(Date.now() - 4 * 3600_000).toISOString(), reason: 'Die Box meldet sich gerade nicht.' },
  { ...base, deviceId: 'd5', externalRef: 'VP-BOX-1005', label: 'VP-BOX-1005', siteName: 'Neubau am Feldrain',
    tenantName: 'Familie Beispiel', ist: null, soll: null, sollSeq: null, reportedAt: null,
    state: 'unbekannt', reason: 'Diese Box hat noch keine Version gemeldet.' },
];
const data: EdgeUpdates = {
  fleet, rollouts: [], journal: [],
  releases: [
    { releaseSeq: 42, version: 'edge-2026.09.10', targetCommit: 'a18b472e', signed: true,
      signingKeyId: 'release', createdAt: now, runningOnDevices: 1, notes: 'Verbesserte Verbindungsstabilität und zuverlässigere Updates.' },
    { releaseSeq: 41, version: 'edge-2026.09.02', targetCommit: '73486bab', signed: true,
      signingKeyId: 'release', createdAt: '2026-09-02T12:00:00Z', runningOnDevices: 3, notes: null },
  ],
  kpi: { known: 4, upToDate: 1, unknown: 1, inRollout: 1, failed: 0, newestRelease: 'edge-2026.09.10' },
};
Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
Object.assign(adminApi, {
  edgeUpdates: async () => data,
  listDevices: async () => fleet.map((d) => ({ ...d, provisioned: true, provisionedAt: now, kind: 'inverter', note: null })),
  listPendingEnrollments: async () => [{ externalRef: 'edge-xyz234q', deviceInfo: 'Box im Lager', csrUpdatedAt: now, everIssued: false, issuedAt: null }],
  createRollout: async () => { throw new Error('Vorschau: Es werden keine Updates an echte Boxen gesendet.'); },
  setUpdateTarget: async () => { throw new Error('Vorschau: Es werden keine Updates an echte Boxen gesendet.'); },
  revertUpdateTarget: async () => { throw new Error('Vorschau: Keine Änderung an echten Boxen.'); },
  provisionDevice: async () => { throw new Error('Vorschau: Es wird keine Geräte-ID registriert.'); },
  deleteProvisionedDevice: async () => { throw new Error('Vorschau: Es wird keine Geräte-ID gelöscht.'); },
});

function Fixture() {
  const [page, setPage] = useState<PageId>('edge-updates');
  return <AppShell page={page} onNavigate={setPage} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: 5, devices: 5 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <GeraeteBereich page={page} onNavigate={(r) => setPage(typeof r === 'string' ? r : r.page)} />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

/**
 * Software (Raum „Geräte", vormals „Geräte & Updates") mit fiktiven Daten:
 * beide Linien (Docker-Box und Edge Light), eine Box, die Aufmerksamkeit
 * braucht, und ein gefülltes Verlauf-Journal - der Mobil-Durchgang
 * (`vp-adminview-mobile-rework`) braucht den WORST CASE, nicht den Leerlauf.
 */
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteRegistryPage';
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

const now = Date.now();
const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});

Object.assign(adminApi, {
  edgeUpdates: async () => ({
    releases: [
      { releaseSeq: 15, version: 'edge-2026.10.1', targetCommit: '3bf8c038', notes: null, signed: true, signingKeyId: 'rel-a', createdAt: iso(-7 * 86_400_000), runningOnDevices: 2, boxArt: 'docker' },
      { releaseSeq: 14, version: 'edge-2026.09.0', targetCommit: '665d59b8', notes: null, signed: true, signingKeyId: 'rel-a', createdAt: iso(-37 * 86_400_000), runningOnDevices: 3, boxArt: 'docker' },
      { releaseSeq: 9, version: 'edge-light-2026.11.1', targetCommit: null, notes: null, signed: true, signingKeyId: 'rel-a', createdAt: iso(-3 * 86_400_000), runningOnDevices: 1, boxArt: 'light' },
    ],
    rollouts: [{
      id: 'r1', releaseVersion: 'edge-2026.10.1', releaseSeq: 15, state: 'active', createdBy: 'admin', createdAt: iso(-3_600_000),
      total: 2, confirmed: 1, failed: 1,
      devices: [
        { deviceId: 'd1', label: 'edge-a1', siteName: 'Pilsting', tenantName: 'Kunststoffwerk Ahrenberg GmbH', state: 'bestaetigt', reason: null, since: iso(-1_800_000) },
        { deviceId: 'd2', label: 'edge-b2', siteName: 'Auernheim', tenantName: 'Beispiel GmbH', state: 'fehlgeschlagen', reason: 'Image-Download fehlgeschlagen (Platz).', since: iso(-900_000) },
      ],
    }],
    fleet: [
      {
        deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting', tenantId: 't1',
        tenantName: 'Kunststoffwerk Ahrenberg GmbH', ist: 'edge-2026.10.1', soll: 'edge-2026.10.1', sollSeq: 15,
        state: 'bestaetigt', reason: null, since: iso(-1_800_000), reportedAt: iso(-30_000), rolloutId: 'r1',
        boxArt: 'docker', linie: 'docker', lastSeenAt: iso(-30_000), stufe1: false, stand: 'aktuell',
        istRelease: 'edge-2026.10.1', releasesDahinter: 0,
      },
      {
        deviceId: 'd2', label: 'edge-b2', externalRef: 'edge-b2', siteId: 's2', siteName: 'Auernheim', tenantId: 't2',
        tenantName: 'Beispiel GmbH', ist: 'edge-2026.09.0', soll: 'edge-2026.10.1', sollSeq: 15,
        state: 'fehlgeschlagen', reason: 'Image-Download fehlgeschlagen (Platz).', since: iso(-900_000), reportedAt: iso(-60_000), rolloutId: 'r1',
        boxArt: 'docker', linie: 'docker', lastSeenAt: iso(-60_000), stufe1: false, stand: 'aelter',
        istRelease: 'edge-2026.09.0', releasesDahinter: 1,
      },
      {
        deviceId: 'd3', label: 'edge-tgjn9gd', externalRef: 'edge-tgjn9gd', siteId: 's3', siteName: 'Zuhause', tenantId: 't3',
        tenantName: 'Mustermann', ist: 'edge-light-2026.11.1', soll: 'edge-light-2026.11.1', sollSeq: 9,
        state: 'bestaetigt', reason: null, since: iso(-5_000_000), reportedAt: iso(-45_000), rolloutId: null,
        boxArt: 'light', linie: 'light', lastSeenAt: iso(-45_000), stufe1: false, stand: 'aktuell',
        istRelease: 'edge-light-2026.11.1', releasesDahinter: 0,
      },
    ],
    journal: [
      { id: 3, at: iso(-900_000), actor: 'system', event: 'device_state', rolloutId: 'r1', deviceId: 'd2', detail: 'fehlgeschlagen' },
      { id: 2, at: iso(-1_800_000), actor: 'system', event: 'device_state', rolloutId: 'r1', deviceId: 'd1', detail: 'bestaetigt' },
      { id: 1, at: iso(-3_600_000), actor: 'admin', event: 'rollout_created', rolloutId: 'r1', deviceId: null, detail: 'edge-2026.10.1' },
    ],
    kpi: { known: 3, upToDate: 2, unknown: 0, inRollout: 1, failed: 1, newestRelease: 'edge-2026.10.1' },
  }),
  listDevices: async () => [],
  boxVerlauf: async () => ({ deviceId: 'd2', eintraege: [] }),
  edgeRelease: async (seq: number) => ({
    releaseSeq: seq, version: seq === 9 ? 'edge-light-2026.11.1' : 'edge-2026.10.1', boxArt: seq === 9 ? 'light' : 'docker',
    signed: true, signingKeyId: 'rel-a', createdAt: iso(-7 * 86_400_000), targetCommit: null, notes: null,
    aenderungen: [], erlaubtRueckschritt: false, minFromSeq: null, inhalt: [], laeuftAuf: [], boxenDerLinie: 1, verteilt: [],
    programme: seq === 9 ? [{ arch: 'mt76x8', groesse: 4_800_000, empfangen: 4_800_000, fertig: true }] : [],
  }),
  edgeEignung: async () => ({ releaseSeq: 15, version: 'edge-2026.10.1', boxArt: 'docker', andereLinie: 0, boxen: [] }),
  createRollout: async () => ({}),
  setUpdateTarget: async () => ({}),
  revertUpdateTarget: async () => ({}),
});

function Fixture() {
  return (
    <AppShell page="edge-updates" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 3, devices: 3 }} tenants={[]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <GeraeteBereich page="edge-updates" onNavigate={() => undefined} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

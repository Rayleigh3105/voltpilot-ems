/**
 * Plattform › Katalog mit fiktiven Daten auf allen drei Unter-Reitern
 * (Gerätevorlagen, Steuerungs-Freigabe, Prognosemodelle) - der Mobil-Durchgang
 * (`vp-adminview-mobile-rework`) braucht mehrere Zeilen je Register, nicht den
 * Leerlauf. `?sektion=` wählt den Unter-Reiter wie die echte Seite.
 */
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { PlattformBereich } from '../src/pages/admin/PlattformBereich';
import { adminApi } from '../src/admin/adminApi';
import { keycloak } from '../src/auth';
import { type PageId } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});

function vorlage(over: Record<string, unknown> = {}) {
  return {
    templateRef: 'certified:acme:relais', kind: 'certified', version: 1, brand: 'acme', brandLabel: 'ACME',
    model: 'relais', modelLabel: 'Relais 16', communication: 'modbus_tcp', communicationLabel: 'Modbus TCP',
    transportSchema: [{ key: 'ip' }], channels: null, writes: null, certificationStatus: 'certified', usedByComponents: 0,
    ...over,
  };
}

Object.assign(adminApi, {
  listComponentTemplates: async () => [
    vorlage({ usedByComponents: 3 }),
    vorlage({
      templateRef: 'builtin:deye:sun-30k', kind: 'builtin', brand: 'deye', brandLabel: 'Deye',
      model: 'sun-30k', modelLabel: 'SUN-30K', certificationStatus: 'builtin', usedByComponents: 12,
    }),
    vorlage({
      templateRef: 'certified:kaco:bp', brand: 'kaco', brandLabel: 'KACO', model: 'blueplanet',
      modelLabel: 'blueplanet 10.0 TL3', communication: 'sunspec', communicationLabel: 'SunSpec',
      certificationStatus: 'withdrawn', usedByComponents: 1,
    }),
  ],
  controlCertifications: async () => [
    { brand: 'deye', model: 'SUN-30K', family: 'hybrid_3p', controlPath: null, invertControlSign: null, firmwareNote: null, note: null, certifiedAt: '2026-01-01T00:00:00Z' },
  ],
  controlCandidates: async () => [
    { deviceId: '1', tenantId: 't', siteId: 's-1', siteName: 'Werk Nord', tenantName: 'Kunststoffwerk Ahrenberg GmbH', externalRef: 'edge-a1', activated: true, platformCertVerdict: null, platformCertModel: null, certSource: 'platform', activatedAt: null, activatedBy: null },
    { deviceId: '2', tenantId: 't2', siteId: 's-2', siteName: 'Halle Süd', tenantName: 'Beispiel GmbH', externalRef: 'edge-b2', activated: false, platformCertVerdict: 'bereit', platformCertModel: 'SUN-30K', certSource: null, activatedAt: null, activatedBy: null },
  ],
  consumerDeviceTypes: async () => [
    { type: 'wallbox', label: 'Wallbox', certificationStatus: 'simulator_only', certifiedAt: null, certificationNotes: null, connectedCount: 2 },
    { type: 'heatpump', label: 'Wärmepumpe', certificationStatus: 'certified', certifiedAt: '2026-02-01T00:00:00Z', certificationNotes: null, connectedCount: 5 },
  ],
  forecastModels: async () => ({
    kinds: [
      { kind: 'load', activeModel: 'load-persistence', source: 'env', envDefault: 'load-persistence', setByName: null, setAt: null, selectable: ['load-persistence', 'load-xgb'] },
      { kind: 'pv', activeModel: 'pv-physical', source: 'env', envDefault: 'pv-physical', setByName: null, setAt: null, selectable: ['pv-physical', 'pv-residual-xgb'] },
    ],
    history: [],
  }),
});

window.location.hash = `#/plattform/katalog${new URLSearchParams(window.location.search).get('sektion') ? `?sektion=${new URLSearchParams(window.location.search).get('sektion')}` : ''}`;

function Fixture() {
  return (
    <AppShell page="katalog" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 2, devices: 2 }} tenants={[]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <PlattformBereich page={'katalog' as PageId} onNavigate={() => undefined} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

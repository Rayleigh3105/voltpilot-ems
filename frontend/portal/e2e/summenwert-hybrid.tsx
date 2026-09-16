import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { GeraetSummenwerte } from '../src/components/GeraetSummenwerte';
import { geraetSeite, summenwertEinstieg } from '../src/geraetSeite';
import { plantModel } from '../src/komponenten';
import type { Device, EntityLocalSetup, SiteEntity, SiteSource } from '../src/api';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne für Fix (b) (Konzept vp-agg-konzept3-r8): der reproduzierte
 * Captain-Fall - ein Deye SUN-30K, dessen `battery-hybrid`-Entität ihren
 * `pv_power_kw`-Kanal verloren hat, also KEINEN PV-Aspekt mehr bildet, aber live
 * Solarstrom meldet. Die Karte „PV-Produktion dieses Geräts" muss trotzdem
 * erscheinen (nie „gar kein Knopf" für genau ein erzeugendes Gerät). Sie rendert
 * durch den ECHTEN Wirt-Gate: `geraetSeite()` baut die Sicht, `summenwertEinstieg`
 * leitet die Träger-Entität ab, erst dann erscheint `GeraetSummenwerte`.
 */
const NOW = Date.parse('2026-09-12T09:45:00Z');
const ISO = new Date(NOW).toISOString();

const BOX: Device = {
  id: 'd1',
  siteId: 'site-e2e',
  externalRef: 'edge-e2e',
  kind: 'inverter',
  name: 'VoltPilot-Box',
  status: 'active',
  lastSeenAt: ISO,
  createdAt: null,
};

// Der Speicher OHNE `pv_power_kw` - der Schaden, der den PV-Aspekt verschwinden
// lässt. Der Alias spiegelt zugleich Befund 2 (falscher Name), stört den Test aber
// nicht.
const DAMAGED_HYBRID: SiteEntity = {
  id: 'inv',
  entityType: 'battery-hybrid',
  typeLabel: 'Batteriespeicher',
  role: 'storage',
  label: 'Wallbox Tesla',
  control: true,
  deviceId: 'd1',
  capabilities: { measure: [{ channel: 'soc_pct' }, { channel: 'battery_power_kw' }], actuate: [{ command: 'setpoint_kw' }] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
};

const LOCAL_SETUP: EntityLocalSetup[] = [
  { id: 'inverter', kind: 'inverter', role: null, brand: 'deye', model: 'SUN-30K-SG01HP3-EU', label: null, reportedAt: ISO, adoptedEntityId: null },
];

// Der Deye echot live 2,9 kW PV - genau der Beleg „meldet Erzeugung".
const SOURCES: SiteSource[] = [
  { deviceId: 'd1', sourceId: 'inverter', kind: 'primary', role: null, label: null, brand: 'deye', model: 'SUN-30K-SG01HP3-EU', pvKw: 2.9, powerKw: -9.7, loadKw: 1.7, health: 'ok', readAt: ISO, reportedAt: ISO },
];

function Fixture() {
  const view = geraetSeite({
    ref: 'edge-e2e',
    geraetId: 'inverter',
    siteName: 'E2E',
    devices: [BOX],
    devicesFetchedAt: NOW,
    entities: [DAMAGED_HYBRID],
    localSetup: LOCAL_SETUP,
    sources: SOURCES,
    components: null,
    control: null,
    curtailment: null,
    edgeVersions: null,
    charging: null,
    strategies: null,
    model: plantModel([DAMAGED_HYBRID], null, LOCAL_SETUP, SOURCES),
    now: NOW,
  });
  const entityId = summenwertEinstieg(view);
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 24, display: 'grid', gap: 16 }}>
      <h2>Deye SUN-30K · ohne PV-Aspekt</h2>
      {/* Kein PV-Aspekt in den Komponenten (der Schaden), aber der Einstieg bleibt. */}
      <p data-testid="pv-aspekt">{view.komponenten.some((c) => c.role === 'pv') ? 'mit PV-Aspekt' : 'ohne PV-Aspekt'}</p>
      {entityId ? (
        <GeraetSummenwerte geraetId="inverter" siteId="site-e2e" deviceId={BOX.id} entityId={entityId} geraetName={view.kopf.titel} />
      ) : (
        <p data-testid="kein-einstieg">kein Einstieg</p>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

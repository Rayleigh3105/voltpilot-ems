import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { api, type Device } from '../src/api';
import { LadesaeuleAnbinden } from '../src/components/LadesaeuleAnbinden';
import type { ChargingConfig, SiteCharging } from '../src/ladepunkte';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const siteId = 'anlage-halle-2';
const boxes = [
  {
    id: 'box-halle-1', siteId, externalRef: 'VP-BOX-HALLE-1', name: 'Box Halle 1',
    lanHost: '192.168.10.21:8484', kind: 'gateway', status: 'online', lastSeenAt: null,
    createdAt: null,
  },
  {
    id: 'box-halle-2', siteId, externalRef: 'VP-BOX-HALLE-2', name: 'Box Halle 2',
    lanHost: '192.168.10.31:8484', kind: 'gateway', status: 'online', lastSeenAt: null,
    createdAt: null,
  },
] satisfies Device[];

// `?nie-verbunden` (Audit vp-ocpp-haushalt W-04): die Kennung ist eingetragen und die Box
// führt sie in ihrer Liste - aber unter ihr hat nie eine Wallbox angerufen.
const nieVerbunden = new URLSearchParams(location.search).has('nie-verbunden');
let config: ChargingConfig = { gridLimitKw: null, priorityChargePointIds: [], chargePoints: nieVerbunden
  ? [{ chargePointId: 'wallbox-garage', label: 'Wallbox Garage', ratedKw: 11 }]
  : [] };
const charging: SiteCharging = {
  budget: null,
  budgets: [
    { deviceId: boxes[0].id, connectorCount: 0, ocppPort: 8887, ocppUrlPath: '/ocpp' },
    { deviceId: boxes[1].id, connectorCount: 0, ocppPort: 8890, ocppUrlPath: '/ocpp' },
  ],
  chargers: nieVerbunden
    ? [{ deviceId: boxes[0].id, chargePointId: 'wallbox-garage', label: 'Wallbox Garage', priority: false, connected: false,
      ready: false, lastSeen: null, reportedAt: new Date().toISOString(), note: 'Diese Ladesäule hat sich noch nicht gemeldet.', connectors: [] }]
    : [],
};

Object.assign(api, {
  chargingConfig: async () => structuredClone(config),
  siteChargers: async () => structuredClone(charging),
  admitChargePoint: async (_siteId: string, body: { chargePointId: string; label?: string; ratedKw?: number }) => {
    config = {
      ...config,
      chargePoints: [{ chargePointId: body.chargePointId, label: body.label ?? null, ratedKw: body.ratedKw ?? null }],
    };
    return structuredClone(config);
  },
  removeChargePoint: async () => structuredClone(config),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="vp-ladepark-box-buehne">
    <header>
      <p className="vp-kicker">Werk Ahrenberg · Halle 2</p>
      <h1>Ladesäule anbinden</h1>
    </header>
    <LadesaeuleAnbinden siteId={siteId} devices={boxes} />
  </main>,
);

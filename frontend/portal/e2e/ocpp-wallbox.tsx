import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { OcppWallboxPage } from '../src/pages/OcppWallboxPage';
import { keycloak } from '../src/auth';
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

const parameter = new URLSearchParams(window.location.search);
const edgeOnly = parameter.has('edge-only');
// Audit vp-ocpp-haushalt (nur mit `edge-only`): `?ohne-grenzen` - die Säule hat ihr
// Sicherheitsprofil abgelehnt (W-05) · `?werk` - die Box ist ab Werk nicht freigegeben (W-01).
const ohneGrenzen = parameter.has('ohne-grenzen');
const werk = parameter.has('werk');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ width: 'min(1180px, 100%)', margin: '0 auto', padding: 'clamp(12px, 3vw, 32px)' }}>
    <OcppWallboxPage siteId="site-e2e" chargePointId="CP-CARPORT" fallbackTitle="Wallbox Carport" backHref="#back"
      charger={edgeOnly ? {
        deviceId: 'device-1', chargePointId: 'CP-CARPORT', priority: false, connected: true, ready: !ohneGrenzen,
        note: ohneGrenzen ? 'Ladesäule nicht eingerichtet: das Sicherheitsprofil wurde abgelehnt (NotSupported)' : null,
        lastSeen: new Date().toISOString(), reportedAt: new Date().toISOString(),
        connectors: [{ connectorId: 1, status: 'Charging', charging: true }],
      } : null}
      budget={ohneGrenzen || werk
        ? { deviceId: 'device-1', enabled: true, controlEnabled: !werk, connectorCount: 1, surplusActive: true }
        : null} />
  </div>,
);

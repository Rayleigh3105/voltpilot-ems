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

const edgeOnly = new URLSearchParams(window.location.search).has('edge-only');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ width: 'min(1180px, 100%)', margin: '0 auto', padding: 'clamp(12px, 3vw, 32px)' }}>
    <OcppWallboxPage siteId="site-e2e" chargePointId="CP-CARPORT" fallbackTitle="Wallbox Carport" backHref="#back"
      charger={edgeOnly ? {
        deviceId: 'device-1', chargePointId: 'CP-CARPORT', priority: false, connected: true, ready: true,
        lastSeen: new Date().toISOString(), reportedAt: new Date().toISOString(),
        connectors: [{ connectorId: 1, status: 'Charging', charging: true }],
      } : null} />
  </div>,
);

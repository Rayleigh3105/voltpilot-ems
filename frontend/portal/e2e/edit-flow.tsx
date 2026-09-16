import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AnlegenFlow } from '../src/components/AnlegenFlow';
import type { SiteComponentRow } from '../src/api';
import { keycloak } from '../src/auth';
import '../src/index.css';

// Der Browser-Harness ersetzt nur die OIDC-Sitzung; HTTP und React-Komponenten
// bleiben echt und werden im Spec am Netzrand abgefangen.
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

const row: SiteComponentRow = {
  id: '20000000-0000-0000-0000-000000000001',
  role: 'battery-hybrid',
  entityType: 'battery-hybrid',
  label: 'Speicher Scheune',
  brand: 'deye',
  model: 'sun-12k',
  family: 'deye-sg04lp3',
  communication: 'solarman-v5',
  connection: { ip: '192.168.1.20', port: 8899, serial: '4711', password: '••••••••' },
  sourceKind: 'builtin',
  templateRef: 'builtin:deye:sun-12k',
  templateVersion: 1,
  definitionVersion: 7,
  syncStatus: 'in_sync',
};

function Harness() {
  const [saved, setSaved] = React.useState(false);
  return saved ? <p role="status">E2E gespeichert</p> : (
    <AnlegenFlow
      siteId="10000000-0000-0000-0000-000000000001"
      bearbeiten={row}
      onClose={() => undefined}
      onSaved={() => setSaved(true)}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);

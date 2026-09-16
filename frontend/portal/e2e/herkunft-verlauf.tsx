import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BeobachteteRegister } from '../src/components/BeobachteteRegister';
import { keycloak } from '../src/auth';
import '../src/index.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="vp-main" style={{ maxWidth: 920, margin: '0 auto', padding: 16 }}>
    <h1>Komponente Z-5a</h1>
    <BeobachteteRegister
      deviceId="box-halle-2"
      siteId="werk-ahrenberg"
      entityId="zaehler-z5"
      familien={['multi-meter']}
      geraetName="Multi-Zähler-Gateway"
      boxNamen={{ 'box-halle-2': 'Box Halle 2' }}
    />
  </main>,
);

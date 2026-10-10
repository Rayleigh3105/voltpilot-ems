import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { SteuernAssistent } from '../src/components/SteuernAssistent';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
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

function Buehne() {
  const [offen, setOffen] = useState(true);
  return <div className="vp-content">
    <header className="vp-topbar"><div className="crumbs">Werk Ahrenberg › Halle 2 › Steuerung</div></header>
    <main className="vp-main"><h1>Steuerung</h1>{!offen && <p>Einrichtung gespeichert — Steuerung noch nicht gestartet.</p>}</main>
    {offen && <SteuernAssistent standortId={FIXTURE_IDS.st1} anlageId={FIXTURE_IDS.an2} onClose={() => setOffen(false)} />}
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Buehne /></React.StrictMode>);

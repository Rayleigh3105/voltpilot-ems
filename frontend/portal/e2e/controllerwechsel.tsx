import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { GeraetHerkunft } from '../src/components/GeraetHerkunft';
import { RechteStandort } from '../src/rollen';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import { c1 } from '../src/test/geraetHerkunftFixtures';
import { CONTROLLER_AM } from '../src/test/controllerwechselFixtures';
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
ReactDOM.createRoot(document.getElementById('root')!).render(<div className="vp-content">
  <header className="vp-topbar"><div className="crumbs">Kunststoffwerk Ahrenberg · Halle 2</div></header>
  <main className="vp-main"><RechteStandort.Provider value={FIXTURE_IDS.st2}>
    <GeraetHerkunft siteId={FIXTURE_IDS.an2} komponenten={c1().komponenten.map((k, i) => ({ entityId: k.entity_id, label: `EK-${i + 1}` }))} jetzt={CONTROLLER_AM} />
  </RechteStandort.Provider></main>
</div>);

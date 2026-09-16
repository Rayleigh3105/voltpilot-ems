import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { GeraetHerkunft } from '../src/components/GeraetHerkunft';
import { MessstelleSeite } from '../src/pages/MessstelleSeite';
import { RechteStandort } from '../src/rollen';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import { MS_IDS } from '../src/test/messstelleSeiteFixtures';
import { vorherGeraet, WECHSEL_JETZT } from '../src/test/zaehlerwechselFixtures';
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
const geraet = new URLSearchParams(location.search).get('einstieg') === 'geraet';
ReactDOM.createRoot(document.getElementById('root')!).render(<div className="vp-content">
  <header className="vp-topbar"><div className="crumbs">Kunststoffwerk Ahrenberg · Werk Ahrenberg</div></header>
  <main className="vp-main"><RechteStandort.Provider value={FIXTURE_IDS.st1}>
    {geraet ? <GeraetHerkunft siteId={FIXTURE_IDS.an1} komponenten={vorherGeraet().komponenten.map(k => ({ entityId: k.entity_id, label: 'Unterzähler Spritzguss SG01–SG06' }))} jetzt={WECHSEL_JETZT} />
      : <MessstelleSeite id={MS_IDS.ms06} onListe={() => undefined} />}
  </RechteStandort.Provider></main>
</div>);

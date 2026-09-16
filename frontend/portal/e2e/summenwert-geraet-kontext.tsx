import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { GeraetSeiteSection } from '../src/pages/GeraetSeiteSection';
import type { Device, Site } from '../src/api';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
const site: Site = { id: 'site-e2e', name: 'Laboranlage', biddingZone: 'DE-LU', latitude: null,
  longitude: null, plantKind: 'eigenverbrauch', anzulegenderWertCtKwh: null,
  tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null };
const box: Device = { id: 'd1', siteId: site.id, externalRef: 'edge-e2e', name: 'Laborbox',
  kind: 'inverter', status: 'active', lastSeenAt: null, createdAt: null };
// Echte Geräteseite; ausschließlich fiktive Antworten aus dem Playwright-Test.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <GeraetSeiteSection site={site} devices={[box]} boxRef={box.externalRef} geraetId="inverter" />,
);

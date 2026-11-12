import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { TechnikSection } from '../src/pages/AnlageTechnik';
import type { Site } from '../src/api';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Auth ist in der Bühne gestellt (wie die anderen E2E-Bühnen), damit `request`
// keinen Login-Umweg fährt und die per `page.route` verdrahtete Cloud erreicht.
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Anlage › Einstellungen" (S3, vp-mastr-mehrere-einheiten-konzept):
 * die ECHTE Seite im Inhaltsrahmen der Schale, gegen per `page.route`
 * verdrahtete Routen - die Anlage (Haus oder Gewerbe) kommt per `?anlage=`.
 */
const site: Site = {
  id: '00000000-0000-0000-0000-00000000a001',
  name: 'Hof Sonnenfeld',
  biddingZone: 'DE-LU',
  latitude: 48.14,
  longitude: 11.58,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">Anlage › Einstellungen</div>
      </header>
      <main className="vp-main">
        <TechnikSection
          site={site}
          devices={[]}
          sites={[site]}
          onReload={() => undefined}
          onSiteSaved={() => undefined}
          onSiteDeleted={() => undefined}
        />
      </main>
    </div>
  </React.StrictMode>,
);

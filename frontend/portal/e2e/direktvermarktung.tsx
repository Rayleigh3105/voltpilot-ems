import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { DirektvermarktungSection } from '../src/pages/DirektvermarktungSection';
import type { Site } from '../src/api';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Auth ist in der Bühne gestellt (Muster anlage-technik.tsx), damit `request` keinen Login-Umweg fährt und die
// per `page.route` verdrahtete Cloud erreicht.
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Direktvermarktung" (Konzept vp-direktvermarktung-konzept d2, Stufe 3 ohne Zustellung): die ECHTE
 * Seite im Inhaltsrahmen der Schale, gegen per `page.route` verdrahtete Routen (PS-D18).
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
        {/* Die echte Schale zeigt hier den Anlagen-Umschalter ("Portfolio › {Name} ▾"), nicht den Seitenpfad -
            der ist Sache der eigenen Brotkrume der Seite (eigenerRueckweg, Muster GeraetBrotkrume). */}
        <div className="crumbs">Portfolio › {site.name} ▾</div>
      </header>
      <main className="vp-main">
        <DirektvermarktungSection site={site} />
      </main>
    </div>
  </React.StrictMode>,
);

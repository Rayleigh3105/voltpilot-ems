import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { StandortePage } from '../src/pages/StandortePage';
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
 * E2E-Bühne „Unternehmen › Standorte“ (UEMS AP-02 IP-6): die ECHTE Seite unter
 * den ECHTEN Reitern der Übersicht, im Inhaltsrahmen der Schale (`vp-main`),
 * gegen die per `page.route` verdrahteten Routen mit den Antworten des
 * Referenzunternehmens Ahrenberg (`src/test/standorteFixtures.ts`).
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      {/* Die Kopfzeile der Schale steht mit ihrer echten Höhe da: die Reiter
          kleben am Telefon bei 68 px darunter (BereichTabs.css). */}
      <header className="vp-topbar">
        <div className="crumbs">Portfolio</div>
      </header>
      <main className="vp-main">
        <PortfolioTabs page="portfolio-standorte" showErloese fleetLabel="Portfolio" onNavigate={() => undefined} />
        <StandortePage />
      </main>
    </div>
  </React.StrictMode>,
);

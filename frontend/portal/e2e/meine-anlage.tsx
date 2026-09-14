import React from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import type { Site } from '../src/api';
import { TechnikSection } from '../src/pages/AnlageTechnik';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
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
 * E2E-Bühne „Anlage › Einstellungen › Meine Anlage“ (UEMS AP-02 IP-8, T6a): die
 * ECHTE `TechnikSection` im Inhaltsrahmen der Schale, gegen per `page.route`
 * verdrahtete Routen. `?fall=ahrenberg` ist Halle 2 des Referenzunternehmens
 * (Standort ST-1), `?fall=entwurf` Halle 1 mit dem automatisch angelegten
 * Standort ohne Adresse, `?fall=ohne` ein Einzel-Anlagen-Kunde ohne Standort-Objekt.
 */
const fall = new URLSearchParams(window.location.search).get('fall') ?? 'ahrenberg';

const basis: Site = {
  id: FIXTURE_IDS.an2,
  name: 'Werk Ahrenberg – Halle 2',
  biddingZone: 'DE-LU',
  latitude: 48.2612,
  longitude: 11.4355,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

const site: Site =
  fall === 'entwurf'
    ? { ...basis, id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' }
    : fall === 'ohne'
      ? { ...basis, id: 's-1', name: 'Hof Sonnenfeld' }
      : basis;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">{site.name}</div>
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

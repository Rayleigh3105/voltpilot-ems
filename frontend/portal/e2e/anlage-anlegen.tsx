import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { steuerGeldWoerter } from '../src/anlegeNurMessen';
import { AnlageAnlegenDrawer } from '../src/components/AnlageAnlegenDrawer';
import { hashForRoute } from '../src/nav';
import { OnboardingWizard } from '../src/Onboarding';
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
 * E2E-Bühne des Anlege-Flusses (Modus „nur messen", Steuern-Regel 15.09.2026): der
 * ECHTE Drawer „Anlage anlegen" über einem Inhaltsrahmen — oder mit `?wirt=assistent`
 * der Einrichtungs-Assistent —, gegen die per `page.route` verdrahtete Cloud mit den
 * Standorten und Funktionen des Referenzunternehmens Ahrenberg. Was der Wirt nach dem
 * Schließen erfährt, steht in `[data-testid=gemeldet]`.
 *
 * `window.steuerGeldWoerterDerSeite()` prüft den ganzen lesbaren Text der Seite samt
 * Beschriftungen und Platzhaltern gegen DIESELBE Wortliste wie die Vitest-Fälle.
 */
const wirt = new URLSearchParams(window.location.search).get('wirt');

(window as unknown as { steuerGeldWoerterDerSeite: () => string[] }).steuerGeldWoerterDerSeite = () => {
  const merkmale = [...document.body.querySelectorAll('[aria-label],[placeholder],[title],[alt]')].flatMap((el) =>
    ['aria-label', 'placeholder', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''),
  );
  return steuerGeldWoerter([document.body.textContent ?? '', ...merkmale].join('\n'));
};

function Buehne() {
  const [offen, setOffen] = useState(true);
  const [gemeldet, setGemeldet] = useState<string | null>(null);
  if (wirt === 'assistent') {
    return (
      <div className="vp-content">
        <main className="vp-main">
          <OnboardingWizard
            sites={[]}
            onDone={(ziel) => setGemeldet(ziel ? hashForRoute(ziel) : 'ohne Ziel')}
            onSkip={() => setGemeldet('übersprungen')}
          />
          {gemeldet && <p data-testid="gemeldet">{gemeldet}</p>}
        </main>
      </div>
    );
  }
  return (
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">Unternehmen › Übersicht</div>
      </header>
      <main className="vp-main">
        <h1>Übersicht</h1>
        {!offen && <p data-testid="gemeldet">{gemeldet ?? 'geschlossen'}</p>}
      </main>
      <AnlageAnlegenDrawer
        open={offen}
        onClose={() => setOffen(false)}
        onChanged={(id, ziel) => setGemeldet(`${id} → ${ziel ? hashForRoute(ziel) : 'Anlage'}`)}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Buehne />
  </React.StrictMode>,
);

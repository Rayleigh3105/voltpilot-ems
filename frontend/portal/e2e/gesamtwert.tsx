import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { Site } from '../src/api';
import { keycloak } from '../src/auth';
import { GesamtwertDialog } from '../src/components/GesamtwertDialog';
import { GesamtwertKarten } from '../src/components/GesamtwertKarten';
import { VerlaufExplorer } from '../src/components/VerlaufExplorer';
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
 * E2E-Bühne des Gesamtwert-Assistenten (Konzept `vp-helfer-konzept-h1`). Die
 * echten Bausteine (Assistent, Cockpit-Karten, Verlauf-Ast) rendern gegen die
 * per `page.route` verdrahtete Cloud — so lässt sich der Ankerfall SUN-30K
 * durchspielen und der fertige Wert in Übersicht UND Verlauf prüfen.
 */
const site = { id: 'site-e2e', name: 'Spritzguss-Halle', biddingZone: 'DE-LU' } as Site;

function Fixture() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 24, display: 'grid', gap: 32 }}>
      <button type="button" onClick={() => setOpen(true)}>
        Gesamtwert anlegen
      </button>

      <section aria-label="Übersicht">
        <h2>Meine Anlage</h2>
        <GesamtwertKarten siteId={site.id} version={version} onNeu={() => setOpen(true)} />
      </section>

      <section aria-label="Verlauf">
        <h2>Verlauf</h2>
        {/* remount bei neuer Version, damit der frische Ast erscheint */}
        <VerlaufExplorer
          key={version}
          site={site}
          range="day"
          anchor={new Date('2026-09-12T12:00:00Z')}
          initialTargets={[]}
        />
      </section>

      {/* Wie die echten Wirte (`MesswerteSection`, `KennzahlAnlegenDialog`): `onGespeichert`
          lädt nur die Anzeige neu und schließt NICHT. Schloss die Bühne hier, blendete das
          Modal im selben Frame aus, in dem „ist angelegt" erschien — der Abschluss-Schritt
          stand nur ~180 ms, und die Spec wurde zum Zeitrennen. Zu geht es über „Fertig". */}
      <GesamtwertDialog
        open={open}
        siteId={site.id}
        onClose={() => setOpen(false)}
        onGespeichert={() => setVersion((v) => v + 1)}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

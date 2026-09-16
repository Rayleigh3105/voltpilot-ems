import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { MessstelleDialog } from '../src/components/MessstelleDialog';
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
 * E2E-Bühne des Messstellen-Dialogs (UEMS AP-04 IP-6). Der echte Dialog rendert gegen die per
 * `page.route` verdrahtete Cloud (Referenzunternehmen Ahrenberg, 20.10.2026 09:00). Geöffnet wie
 * aus „Werk Ahrenberg › Messstellen“ — der Standort ist die Vorgabe des Orts. `?fall=bearbeiten`
 * öffnet die gespeicherte Messstelle `ms-neu`.
 */
const bearbeiten = new URLSearchParams(window.location.search).get('fall') === 'bearbeiten';

function Buehne() {
  const [open, setOpen] = useState(true);
  return (
    <main style={{ padding: 24 }}>
      <button type="button" onClick={() => setOpen(true)}>
        Messstelle anlegen
      </button>
      <MessstelleDialog
        open={open}
        messstelleId={bearbeiten ? 'ms-neu' : null}
        standortId="5a1d0000-0000-4000-8000-000000000001"
        heute="2026-10-20"
        jetzt="2026-10-20T09:00:00+02:00"
        onClose={() => setOpen(false)}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Buehne />);

import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { WerteDialog } from '../src/components/WerteDialog';
import type { KartenArt } from '../src/uemsWerteKarte';
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
 * E2E-Bühne der Tages- und Monatskarte (UEMS AP-08 IP-11): der ECHTE Dialog
 * gegen die per `page.route` verdrahtete Route „Werte je Messstelle“ mit den
 * Antworten des Referenzunternehmens Ahrenberg (`src/test/werteKarteFixtures.ts`).
 * `?ms=MS-10&name=…&art=tag&wert=2026-11-03` wählt, was öffnet.
 */
const q = new URLSearchParams(location.search);
const ms = q.get('ms') ?? 'MS-10';
const art = (q.get('art') ?? 'tag') as KartenArt;
const wert = q.get('wert') ?? '2026-11-03';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WerteDialog
      open
      kennzeichen={ms}
      titel={`${ms} · ${q.get('name') ?? 'Messstelle'}`}
      anfang={{ art, wert }}
      heute="2027-04-01"
      onClose={() => undefined}
    />
  </React.StrictMode>,
);

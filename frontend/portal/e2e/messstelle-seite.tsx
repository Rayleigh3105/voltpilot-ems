import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { MessstelleSeite } from '../src/pages/MessstelleSeite';
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
 * E2E-Bühne der Messstellen-Seite (UEMS AP-04 IP-8). Die echte Seite rendert gegen die per
 * `page.route` verdrahtete Cloud (Referenzunternehmen Ahrenberg, heute = 20.10.2026 laut Register).
 * `?id=` ist die Messstelle (MS-06 oder MS-08); geöffnet wie aus „Unternehmen › Messstellen“.
 */
const id = new URLSearchParams(window.location.search).get('id') ?? '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 1180, margin: '0 auto' }}>
    <MessstelleSeite id={id} onListe={() => undefined} />
  </main>,
);

import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { keycloak } from '../src/auth';
// Dasselbe CSS-Set wie `src/main.tsx` - damit der Harness den echten Lader zeigt
// (Marken-Schriften, Tokens wie `--vp-surface`), nicht eine token-lose Fassung.
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Der Browser-Harness ersetzt nur die OIDC-Sitzung; HTTP und React bleiben echt
// und werden im Spec am Netzrand abgefangen (`page.route`). `initialAuth` heisst:
// die Anmeldung ist durch, jetzt startet der DATEN-Boot der Schale
// (`/tenant-context`, `/sites`, `/devices`) - genau der Abschnitt, in dem der
// falsche „Noch keine Anlage"-Blitz sass.
const params = new URLSearchParams(window.location.search);
const roles = params.get('admin') === '1' ? ['platform-admin'] : [];
(keycloak as unknown as { token: string; tokenParsed: unknown; updateToken: () => Promise<boolean> }).token =
  'e2e-token';
(keycloak as unknown as { tokenParsed: unknown }).tokenParsed = { realm_access: { roles } };
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

// Ein Admin braucht einen gewählten Mandanten, sonst steht die
// „Mandanten wählen"-Karte statt des Lade-/Leer-Zustands.
const tenant = params.get('tenant');
if (tenant) sessionStorage.setItem('vp-tenant-override', tenant);

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);

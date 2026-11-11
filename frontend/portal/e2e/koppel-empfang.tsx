import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { keycloak } from '../src/auth';
import { bootOutcome } from '../src/boot';
import { koppelEmpfang, koppelLinkAnnehmen } from '../src/koppelLink';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Der Start OHNE Sitzung, wie `src/main.tsx` ihn fährt: Direktlink annehmen, dann die Weiche
// `bootOutcome` - nur ohne Keycloak. Die Anmeldung zählt der Harness, statt wegzunavigieren.
const w = window as unknown as { __anmeldungen: number };
w.__anmeldungen = 0;
(keycloak as unknown as { login: () => Promise<void> }).login = async () => {
  w.__anmeldungen += 1;
};

const annahme = koppelLinkAnnehmen(window.location, (url) => window.history.replaceState(window.history.state, '', url));
const ausgang = bootOutcome({
  authenticated: false,
  registerRoute: window.location.hash === '#register',
  guardWasSet: false,
  rateLimited: false,
  koppel: koppelEmpfang(annahme)?.art ?? null,
});
const ansicht =
  ausgang.kind === 'koppel' ? (ausgang.lesbar ? 'koppel' : 'koppel-unlesbar') : ausgang.kind === 'register' ? 'register' : 'login';

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth={false} initialView={ansicht} />);

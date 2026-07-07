import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Design-system tokens (CSS custom properties) - loaded once, app-wide.
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
// Core component styles (Button / Card / Skeleton affordance + focus rings).
import '../designsystem/components/core/core.css';
// Shell primitives (NavItem / Drawer / KpiCard) styles.
import '../designsystem/components/shell/shell.css';
import './index.css';

import { initAuth, keycloak, login, wasSessionExpired } from './auth';
import { isRegisterRoute } from './nav';

// Keep the access token fresh in the background.
keycloak.onTokenExpired = () => {
  void keycloak.updateToken(30);
};

function render(app: React.ReactElement) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>{app}</React.StrictMode>,
  );
}

// Loop guard for the automatic login redirect: set right before redirecting to
// Keycloak, cleared on an authenticated boot. If a boot finds it STILL set and
// unauthenticated (browser back from Keycloak, a refused/failed code exchange),
// the portal shows the manual login card instead of bouncing to Keycloak again -
// Keycloak's own error pages stay visible, never an infinite redirect loop.
const AUTO_LOGIN_GUARD = 'vp.auth.autoLoginRedirect';

initAuth()
  .then((authenticated) => {
    if (authenticated) {
      sessionStorage.removeItem(AUTO_LOGIN_GUARD);
      render(<App initialAuth sessionExpired={wasSessionExpired()} />);
      return;
    }
    // Self-registration lives in the portal, not Keycloak - its route must
    // render without the redirect (the Keycloak login page links here).
    if (isRegisterRoute()) {
      render(<App initialAuth={false} initialView="register" />);
      return;
    }
    if (!sessionStorage.getItem(AUTO_LOGIN_GUARD)) {
      // No session, no stored tokens: go STRAIGHT to the Keycloak login instead
      // of a "Jetzt anmelden" pre-step. The card behind stays as a fallback in
      // case the navigation is interrupted.
      sessionStorage.setItem(AUTO_LOGIN_GUARD, '1');
      render(<App initialAuth={false} redirecting />);
      login();
      return;
    }
    sessionStorage.removeItem(AUTO_LOGIN_GUARD);
    render(<App initialAuth={false} sessionExpired={wasSessionExpired()} />);
  })
  .catch((err) => {
    // Never leave a blank page if Keycloak is unreachable.
    // eslint-disable-next-line no-console
    console.error('Keycloak init failed', err);
    render(<App initialAuth={false} authError />);
  });

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

import { initAuth, keycloak, login, wasRateLimited, wasSessionExpired } from './auth';
import { BOOT_TIMEOUT_MS, BootTimeoutError, bootOutcome, withTimeout } from './boot';
import { BootErrorBoundary, BootSplash } from './components/Boot';
import { isRegisterRoute } from './nav';

// Keep the access token fresh in the background.
keycloak.onTokenExpired = () => {
  void keycloak.updateToken(30);
};

// ONE root, re-rendered as the boot progresses (splash -> outcome). The error
// boundary wraps every render so an exception anywhere lands on a German
// recovery card, never a blank page.
const root = ReactDOM.createRoot(document.getElementById('root')!);

function render(app: React.ReactElement) {
  root.render(
    <React.StrictMode>
      <BootErrorBoundary>{app}</BootErrorBoundary>
    </React.StrictMode>,
  );
}

// Loop guard for the automatic login redirect: set right before redirecting to
// Keycloak, cleared on an authenticated boot. If a boot finds it STILL set and
// unauthenticated (browser back from Keycloak, a refused/failed code exchange),
// the portal shows the manual login card instead of bouncing to Keycloak again -
// Keycloak's own error pages stay visible, never an infinite redirect loop.
const AUTO_LOGIN_GUARD = 'vp.auth.autoLoginRedirect';

// White-page fix, part 1: something is on screen from the first frame on -
// whatever initAuth() does afterwards can only ever REPLACE this splash.
render(<BootSplash />);

// White-page fix, part 2: the whole auth bootstrap is bounded. keycloak-js
// contains unbounded iframe/postMessage waits (a Keycloak/proxy error page
// inside a hidden iframe never answers), so a hard ceiling here is the only
// reliable guarantee that the boot always settles into a rendered state.
Promise.resolve()
  .then(() => withTimeout(initAuth(), BOOT_TIMEOUT_MS))
  .then((authenticated) => {
    const outcome = bootOutcome({
      authenticated,
      registerRoute: isRegisterRoute(),
      guardWasSet: sessionStorage.getItem(AUTO_LOGIN_GUARD) !== null,
      rateLimited: wasRateLimited(),
    });
    switch (outcome.kind) {
      case 'app':
        sessionStorage.removeItem(AUTO_LOGIN_GUARD);
        render(<App initialAuth sessionExpired={wasSessionExpired()} />);
        return;
      case 'register':
        // Self-registration lives in the portal, not Keycloak - its route must
        // render without the redirect (the Keycloak login page links here).
        render(<App initialAuth={false} initialView="register" />);
        return;
      case 'autoLogin':
        // No session, no stored tokens: go STRAIGHT to the Keycloak login
        // instead of a "Jetzt anmelden" pre-step. The card behind stays as a
        // fallback if the navigation is interrupted.
        sessionStorage.setItem(AUTO_LOGIN_GUARD, '1');
        render(<App initialAuth={false} redirecting />);
        login();
        return;
      case 'login':
        sessionStorage.removeItem(AUTO_LOGIN_GUARD);
        render(
          <App
            initialAuth={false}
            sessionExpired={wasSessionExpired()}
            rateLimited={wasRateLimited()}
          />,
        );
        return;
    }
  })
  .catch((err) => {
    // Never leave a blank page, whatever failed.
    // eslint-disable-next-line no-console
    console.error('Keycloak init failed', err);
    if (err instanceof BootTimeoutError) {
      // The init hung (hidden-iframe error page, stalled proxy, ...). Fall to
      // the manual card WITHOUT wiping stored state - "Anmelden" does a clean
      // full-page login() that works even when the silent iframes are broken.
      render(<App initialAuth={false} authTimeout rateLimited={wasRateLimited()} />);
      return;
    }
    render(<App initialAuth={false} authError />);
  });

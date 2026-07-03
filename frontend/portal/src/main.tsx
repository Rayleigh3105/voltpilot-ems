import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Design-system tokens (CSS custom properties) - loaded once, app-wide.
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
// Shell primitives (NavItem / Drawer / KpiCard) styles.
import '../designsystem/components/shell/shell.css';
import './index.css';

import { initAuth, keycloak, wasSessionExpired } from './auth';

// Keep the access token fresh in the background.
keycloak.onTokenExpired = () => {
  void keycloak.updateToken(30);
};

initAuth()
  .then((authenticated) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App initialAuth={authenticated} sessionExpired={wasSessionExpired()} />
      </React.StrictMode>,
    );
  })
  .catch((err) => {
    // Never leave a blank page if Keycloak is unreachable.
    // eslint-disable-next-line no-console
    console.error('Keycloak init failed', err);
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App initialAuth={false} authError />
      </React.StrictMode>,
    );
  });

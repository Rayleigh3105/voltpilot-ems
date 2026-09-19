import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { keycloak } from '../src/auth';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Nur die Anmeldung ist Bühnen-Infrastruktur. Jede Portalantwort kommt aus der
// MockMvc-Aufzeichnung; die Produktions-App und ihre API-Aufrufe bleiben echt.
Object.assign(keycloak, {
  token: 'buehne-kunden-jwt',
  refreshToken: 'buehne-refresh',
  authenticated: true,
  tokenParsed: {
    sub: 'jonas',
    preferred_username: 'jonas',
    name: 'Jonas Wendlinger',
    tenant_id: 'wird-vom-aufzeichnungsfall-bestimmt',
    realm_access: { roles: ['admin'] },
  },
  updateToken: async () => true,
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App initialAuth />
  </React.StrictMode>,
);

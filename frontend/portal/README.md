# frontend/portal - Web Portal

**Language:** TypeScript / React 18 + Vite
**Responsibility:** Responsive web portal (architecture section 4/19). Auth, device claiming, telemetry & schedule views, economic KPIs.

## Run / build / test

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check (tsc) + production build to dist/
npm run preview
```

Env (all optional, defaults match the compose stack): `VITE_API_BASE` (default `http://localhost:8090`), `VITE_KEYCLOAK_URL`, `VITE_KEYCLOAK_REALM`, `VITE_KEYCLOAK_CLIENT_ID`.

Deps install from **public npm** (`.npmrc` in this folder); override it if you build behind a corporate mirror.

## Design system

`designsystem/` holds the shared VoltPilot design system - CSS tokens (`tokens/*.css`), core/form components (`.jsx` + `.d.ts` + `.prompt.md`) and guideline cards. Tokens are imported once in `src/main.tsx`; build new UI on these components, not hand-rolled ones.

## Status

Implemented: Keycloak OIDC login/logout (`voltpilot-frontend` public client, PKCE), token-authenticated API calls, and the post-login view - the tenant's sites/devices and a telemetry chart (ECharts) + device-claim form, all built on the design system. Telemetry is loaded via REST (live WS/SSE deferred). Schedule/KPI views are future work.

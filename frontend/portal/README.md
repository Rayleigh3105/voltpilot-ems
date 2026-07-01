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

Charting library (`echarts`) is declared for later use. `VITE_API_BASE` overrides the API base URL (default `http://localhost:8090`).

## Status

Skeleton: a single placeholder page that builds. Auth (Keycloak `voltpilot-frontend` public client, PKCE) and the real views are future work.

// Placeholder portal page. The MVP portal surface (auth, device claiming,
// telemetry & schedule views, economic KPIs - architecture section 4) is built
// against docs/contracts/openapi.yaml. Charting (ECharts/uPlot) is declared but
// not yet used.

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8090";

export default function App() {
  return (
    <main className="app">
      <header>
        <h1>Voltpilot-EMS</h1>
        <p className="tagline">Energy Management System - Portal (dev skeleton)</p>
      </header>

      <section className="card">
        <h2>Status</h2>
        <p>
          This is a placeholder page. It confirms the React + Vite toolchain
          builds. The portal will talk to the API at <code>{API_BASE}</code>.
        </p>
        <ul>
          <li>Auth via Keycloak (OIDC, realm <code>voltpilot</code>)</li>
          <li>Device claiming</li>
          <li>Telemetry &amp; schedule views (ECharts/uPlot)</li>
          <li>Economic KPIs (self-consumption, savings)</li>
        </ul>
      </section>
    </main>
  );
}

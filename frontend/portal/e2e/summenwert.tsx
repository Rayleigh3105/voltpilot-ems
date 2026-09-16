import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { GeraetSummenwerte } from '../src/components/GeraetSummenwerte';
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
 * E2E-Bühne des geräteseitigen Summenwert-Assistenten (Konzept
 * vp-agg-konzept3-r8). Die echte Ergebnis-Karte + der echte Assistent rendern
 * gegen die per `page.route` verdrahtete Cloud - der Ankerfall Deye SUN-30K
 * (PV 1-3 + Gen-Port) lässt sich so aus allen Registern zusammenstellen und der
 * Rolle PV-Produktion zuordnen.
 */
function Fixture() {
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 24, display: 'grid', gap: 16 }}>
      <h2>Deye SUN-30K</h2>
      <GeraetSummenwerte geraetId="inverter" siteId="site-e2e" deviceId="d1" entityId="inv" geraetName="Deye SUN-30K" />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);

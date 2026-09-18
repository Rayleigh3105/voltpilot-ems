import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { WagoKarte } from '../src/components/WagoKarte';
import { WerteSektion } from '../src/components/WerteSektion';
import { RechteStandort } from '../src/rollen';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * E2E-Bühne AP-05 IP-11: der Verlauf mit den Karten-Ereignissen (allgemein, jede Box) und die
 * Energiekarte mit ihrem Hebel und dem Dialog „Karte getauscht“ (nur wo es eine WAGO-Karte gibt).
 * Die Cloud ist per `page.route` gestellt; die Fläche ist die echte.
 */
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

const TAG = '2027-01-15';
const KOMPONENTE = '0c4b9e1f-0000-4000-8000-000000000005';

ReactDOM.createRoot(document.getElementById('root')!).render(<div className="vp-content">
  <header className="vp-topbar"><div className="crumbs">Kunststoffwerk Ahrenberg · Halle 2</div></header>
  <main className="vp-main"><RechteStandort.Provider value={FIXTURE_IDS.st2}>
    <section className="vp-mss-werte">
      <WerteSektion
        kennzeichen="MS-12"
        messstelle="MS-12 · Montage Linie M1"
        kopf={<h2>Werte</h2>}
        anfang={{ art: 'tag', wert: TAG }}
        heute={TAG}
        standortName="Halle 2"
      />
    </section>
    <WagoKarte
      anlageId={FIXTURE_IDS.an2}
      standortId={FIXTURE_IDS.st2}
      entityId={KOMPONENTE}
      zone="Europe/Berlin"
      einheit="kWh"
      jetzt={`${TAG}T15:00:00+01:00`}
    />
  </RechteStandort.Provider></main>
</div>);

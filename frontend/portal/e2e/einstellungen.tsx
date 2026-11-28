import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { EinstellungenPage } from '../src/pages/EinstellungenPage';
import { zustellwegeFixture } from './zustellwege-fixture';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Einstellungen Scheibe 1 (Konzept `vp-einstellungen-konzept-e1`) - Bühne der echten
 * `EinstellungenPage` mit gestellten Routen, wie `gemeinsame-steuerung.tsx`. Parameter:
 * `fall=voll|leer|unbestaetigt` (Anhang-A-Fälle der Bühne des Konzepts), `anmeldeAdresse=`.
 */
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

const p = new URLSearchParams(location.search);
const fall = p.get('fall') ?? 'voll';
// Kunden-Alarmierung P3 (KA-6 A): „So erreichen wir Sie“/Ruhezeit wohnen seit #1861 hinter der Glocke
// (`ansicht="meldungen"`, hier Vorgabe - fast alle Fälle dieser Bühne drehen sich um die Wege);
// `ansicht=konto` zeigt die Vorgabe-Ansicht hinter `#/einstellungen` (Konto, Gerät, Zeiger auf Meldungen).
const ansicht = p.get('ansicht') === 'konto' ? 'konto' : 'meldungen';
// `anmeldeAdresse=`: die Adresse der Anmeldung im Token (Kunden-Alarmierung B3, Vorbelegung des E-Mail-Wegs).
const anmeldeAdresse = p.get('anmeldeAdresse');
if (anmeldeAdresse) {
  (keycloak as unknown as { tokenParsed: Record<string, unknown> }).tokenParsed = { name: 'Ines Kaltenbach', email: anmeldeAdresse };
}

const echtesFetch = window.fetch.bind(window);
const zustellwege = zustellwegeFixture({ fall, ruhezeitAktiv: p.get('ruhezeitAktiv') === '1' });
window.fetch = async (input, init) => (await zustellwege(input, init)) ?? echtesFetch(input, init);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div className="vp-content">
    <header className="vp-topbar">
      <div className="crumbs">Ahrenberg · Einstellungen</div>
    </header>
    <main className="vp-main">
      <EinstellungenPage ansicht={ansicht} />
    </main>
  </div>,
);

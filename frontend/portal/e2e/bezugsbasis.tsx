import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { KennzahlenPage } from '../src/pages/KennzahlenPage';
import { setSelbstauskunft } from '../src/rollen';
import { BB_IDS, bezugsbasisBuehne } from '../src/test/bezugsbasisFixtures';
import { rechteSeed } from '../src/test/rollenFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Bühne des Reiters „Bezugsbasis“ (UEMS AP-17 IP-9): die ECHTE `KennzahlenPage` mit der ECHTEN Kennzahl-Seite von
 * KZ-0004 Spritzguss je kg (R1). Die Routen von IP-7 (Anlegen, Entwurf) und IP-8 (Liste der Basen, freigeben) spielt
 * `bezugsbasisBuehne` (`src/test/bezugsbasisFixtures.ts`) — Ahrenberg hat kein Vier-Augen, „Freigeben“ wirkt sofort.
 * Jeder Locator der Spec ist gegen dieselbe Fläche in `src/bezugsbasisSpecLocatoren.test.tsx` gezählt.
 *
 * Adresse: `?person=IK|CB` (Vorgabe IK, Ines Kaltenbach) · `&lage=keine|freigegeben|modell` (Vorgabe keine; `modell` ist
 * BB-0001 Fassung 2 nach R12/R4/R9, IP-14) · `&seite=register` zeigt das Register statt der Kennzahl. Eigene Bühne, keine
 * geteilte Datei wird angefasst. Ein Entwurf mit einer Methode ≠ Verhältnis antwortet mit dem Modell von R12 (IP-10);
 * die zweite Variable lehnt die Bühne wie der Server ab, wenn BZ-3 gewählt ist (G4).
 */
const params = new URLSearchParams(location.search);
const me = rechteSeed(params.get('person') ?? 'IK').me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };

const lage = params.get('lage');
Object.assign(api, bezugsbasisBuehne(lage === 'freigegeben' || lage === 'modell' ? lage : 'keine'));

function Ansicht() {
  const register = params.get('seite') === 'register';
  return (
    <main className="vp-main" style={{ padding: 16 }}>
      <KennzahlenPage
        kennzahlId={register ? null : BB_IDS.kz4}
        onOeffnen={() => undefined}
        onListe={() => undefined}
        zone="Europe/Berlin"
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

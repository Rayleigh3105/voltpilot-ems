import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { KennzahlenPage } from '../src/pages/KennzahlenPage';
import { setSelbstauskunft } from '../src/rollen';
import { SEITE_IDS, seitenBuehne, type SeitenLage } from '../src/test/kennzahlSeiteFixtures';
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
 * Bühne der Seite einer Kennzahl (Konzept Auswerten a1 §6.5, §6.6; PR2): die ECHTE `KennzahlenPage` mit der Welt des
 * Konzepts zur Bühnen-Uhr 30.04.2029 (`src/test/kennzahlSeiteFixtures.ts`), die Routen im Speicher.
 *
 * Adresse: `?kz=4|24` (Vorgabe 4: KZ-0004 Spritzguss gegen BB-0001; 24: Netzbezug Halle 1 ohne Bezugsbasis) ·
 * `&lage=ueber|besser|noch_kein_vergleich` · `&ebene=bezugsbasis` öffnet die Ebene darunter · `&person=IK|CB`.
 * „Bezugsbasis ansehen“ und der Rückweg wechseln die Ebene in der Bühne selbst.
 */
const params = new URLSearchParams(location.search);
const me = rechteSeed(params.get('person') ?? 'IK').me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };

const lage = (params.get('lage') ?? 'ueber') as SeitenLage;
Object.assign(api, seitenBuehne(lage));
const kennzahlId = params.get('kz') === '24' ? SEITE_IDS.kz24 : SEITE_IDS.kz4;

function Ansicht() {
  const [ebene, setEbene] = useState<'bezugsbasis' | null>(params.get('ebene') === 'bezugsbasis' ? 'bezugsbasis' : null);
  return (
    <main className="vp-main" style={{ padding: 16 }}>
      <KennzahlenPage
        kennzahlId={kennzahlId}
        ebene={ebene}
        onOeffnen={(_id, e) => setEbene(e ?? null)}
        onListe={() => undefined}
        zone="Europe/Berlin"
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

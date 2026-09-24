import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { benutzerApi } from '../src/benutzer';
import { heute } from '../src/bewertung';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { ebenenAktiv, ebenenBereiche, ebenenLeiste, ebenenTitel, type EbenenLesemodell } from '../src/ebenenNav';
import { darfAnsehen } from '../src/energieziele';
import { darfAnsehen as darfBewertungSehen } from '../src/bewertung';
import {
  energieeinsatzRoute,
  energiezielRoute,
  hashForRoute,
  kennzahlRoute,
  massnahmeRoute,
  pageRoute,
  parseRoute,
  verbesserungRoute,
  type Route,
} from '../src/nav';
import { BewertungPage } from '../src/pages/BewertungPage';
import { VerbesserungBereich } from '../src/pages/VerbesserungBereich';
import { setSelbstauskunft, teilansichtKopf } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { bewertungBuehne } from '../src/test/bewertungFixtures';
import { bezugsbasisBuehne } from '../src/test/bezugsbasisFixtures';
import { energiezielBuehne } from '../src/test/energiezielFixtures';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../src/test/kennzahlenFixtures';
import { EZ_IDS } from '../src/test/energiezielFixtures';
import { kontenAhrenberg, M_IDS, massnahmeBuehne, type MassnahmeLage } from '../src/test/massnahmeFixtures';
import { rechteSeed } from '../src/test/rollenFixtures';
import { werkAhrenberg, werkLindach } from '../src/test/standorteFixtures';
import { unterstuetzungApi } from '../src/unterstuetzung';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Bühne des Reiters „Maßnahmen“ (UEMS AP-18 IP-13): die ECHTE `AppShell` mit den ECHTEN Reitern und darin der ECHTE
 * `VerbesserungBereich` (Register, Maßnahmen-Seite, Energieziel-Seite mit „Maßnahme anlegen“) bzw. die ECHTE Seite des
 * Energieeinsatzes EE-3 Druckluft mit „Maßnahme anlegen“. Die Routen spielen `massnahmeBuehne`
 * (`src/test/massnahmeFixtures.ts`, R3/R7/R9), `energiezielBuehne`, `bezugsbasisBuehne('modell')` und `bewertungBuehne`.
 * Der Tag der Routen ist der Tag der Uhr (Playwright `page.clock`).
 *
 * Adresse: `?lage=leer|geplant|r9` (Vorgabe r9) · `&m=1|2` öffnet M-2028-0001/-0002 · `&ez=1` öffnet EZ-2028-0001 ·
 * `&seite=einsatz` öffnet EE-3. Eigene Bühne, keine geteilte Datei wird angefasst.
 */
const params = new URLSearchParams(location.search);
const LAGEN: MassnahmeLage[] = ['leer', 'geplant', 'r9'];
const lage = LAGEN.find((l) => l === params.get('lage')) ?? 'r9';
const tag = heute();
const me = rechteSeed('IK').me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
Object.assign(unterstuetzungApi, { liste: async () => [], anfragen: async () => [], hinweise: async () => [] });
Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
Object.assign(
  api,
  bewertungBuehne('voll', 'IK', tag),
  bezugsbasisBuehne('modell'),
  energiezielBuehne('juli', false, me.kennung!, me.name!),
  massnahmeBuehne(lage, tag, me.name!),
  { standorte: async () => ({ stichtag: tag, standorte: [] }) },
);

const lesemodell: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(),
  kennzahlen: ahrenbergKennzahlen(),
  verbesserung: darfAnsehen(me),
  bewertung: darfBewertungSehen(me),
};
const UNTERNEHMEN = { art: 'unternehmen' } as const;

if (!location.hash.startsWith('#/portfolio/')) {
  const m = params.get('m');
  const ziel =
    params.get('seite') === 'einsatz'
      ? energieeinsatzRoute(M_IDS.ee3)
      : params.get('ez') === '1'
        ? energiezielRoute(EZ_IDS.ez1)
        : m
          ? massnahmeRoute(m === '2' ? M_IDS.m2 : M_IDS.m1)
          : verbesserungRoute('massnahmen');
  history.replaceState(null, '', hashForRoute(ziel));
}

function Ansicht() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const weiter = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', weiter);
    return () => window.removeEventListener('hashchange', weiter);
  }, []);
  useEffect(() => {
    document.body.dataset.route = location.hash;
  }, [route]);
  const navigate = (ziel: Route) => {
    location.hash = hashForRoute(ziel);
  };
  const kacheln = ebenenLeiste(UNTERNEHMEN, lesemodell);
  const bereiche = ebenenBereiche(UNTERNEHMEN, lesemodell).map((b) => b.key);
  return (
    <AppShell
      teilansicht={teilansichtKopf(me)}
      ebenen={{
        titel: ebenenTitel(UNTERNEHMEN, lesemodell, 'Kunststoffwerk Ahrenberg GmbH'),
        kacheln,
        aktiv: ebenenAktiv(route.page),
        onOpen: navigate,
      }}
      page={route.page}
      onNavigate={(p) => navigate(pageRoute(p))}
      isAdmin={false}
      showOverview={false}
      showPortfolio
      fleetLabel="Unternehmen"
      counts={{ sites: 3, devices: 3 }}
      tenants={[]}
      tenantOverride={null}
      onTenantChange={() => undefined}
      showAddAnlage={false}
      onAddAnlage={() => undefined}
    >
      <PortfolioTabs
        page={route.page}
        showErloese={false}
        showMessstellen={bereiche.includes('messstellen')}
        showBezugsgroessen={bereiche.includes('bezugsgroessen')}
        showKennzahlen={bereiche.includes('kennzahlen')}
        showBerichte={bereiche.includes('berichte')}
        showBewertung={bereiche.includes('bewertung')}
        showVerbesserung={bereiche.includes('verbesserung')}
        leiste={kacheln.map((k) => k.key)}
        fleetLabel="Unternehmen"
        onNavigate={(p) => navigate(pageRoute(p))}
      />
      {route.page === 'portfolio-verbesserung' ? (
        <VerbesserungBereich
          reiter={route.verbesserungReiter ?? 'energieziele'}
          energiezielId={route.energiezielId ?? null}
          massnahmeId={route.massnahmeId ?? null}
          onReiter={(r) => navigate(verbesserungRoute(r))}
          onOeffnen={(id) => navigate(energiezielRoute(id))}
          onListe={() => navigate(verbesserungRoute())}
          onKennzahl={(id) => navigate(kennzahlRoute(id))}
          onMassnahme={(id) => navigate(massnahmeRoute(id))}
        />
      ) : route.page === 'portfolio-bewertung' && route.energieeinsatzId ? (
        <BewertungPage
          einsatzId={route.energieeinsatzId}
          onOeffnen={(id) => navigate(energieeinsatzRoute(id))}
          onListe={() => navigate(pageRoute('portfolio-bewertung'))}
        />
      ) : (
        <p>Diese Bühne zeigt nur Maßnahmen und den Energieeinsatz EE-3.</p>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

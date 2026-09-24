import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { ebenenAktiv, ebenenBereiche, ebenenLeiste, ebenenTitel, type EbenenLesemodell } from '../src/ebenenNav';
import { darfAnsehen } from '../src/energieziele';
import { energiezielRoute, hashForRoute, kennzahlRoute, pageRoute, parseRoute, verbesserungRoute, type Route } from '../src/nav';
import { KennzahlenPage } from '../src/pages/KennzahlenPage';
import { VerbesserungBereich } from '../src/pages/VerbesserungBereich';
import { setSelbstauskunft, teilansichtKopf } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { BB_IDS, bezugsbasisBuehne } from '../src/test/bezugsbasisFixtures';
import { EZ_IDS, energiezielBuehne, type EnergiezielLage } from '../src/test/energiezielFixtures';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../src/test/kennzahlenFixtures';
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
 * Bühne des Bereichs „Ziele und Maßnahmen“ (UEMS AP-18 IP-8): die ECHTE `AppShell` mit der ECHTEN Leiste und den
 * ECHTEN Reitern (`PortfolioTabs`) — dieselben reinen Funktionen wie `App.tsx` — und darin der ECHTE
 * `VerbesserungBereich` bzw. die ECHTE Kennzahl-Seite von KZ-0004 (BB-0001 Fassung 2 freigegeben, `bezugsbasisBuehne`
 * Lage `modell`) mit „Energieziel setzen“. Die Routen spielt `energiezielBuehne` (`src/test/energiezielFixtures.ts`).
 *
 * Adresse: `?person=IK|JW|CB` (Vorgabe IK) · `&lage=leer|juli|faellig|beantragt|bewertet` (Vorgabe leer) ·
 * `&vieraugen=1` (bewerten wird ein Antrag) · `&seite=kennzahl` öffnet KZ-0004 · `&ez=1` öffnet EZ-2028-0001.
 * Eigene Bühne, keine geteilte Datei wird angefasst.
 */
const params = new URLSearchParams(location.search);
const person = params.get('person') ?? 'IK';
const LAGEN: EnergiezielLage[] = ['leer', 'juli', 'faellig', 'beantragt', 'bewertet'];
const lage = LAGEN.find((l) => l === params.get('lage')) ?? 'leer';
const me = rechteSeed(person).me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
Object.assign(unterstuetzungApi, { liste: async () => [], anfragen: async () => [], hinweise: async () => [] });
Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne(lage, params.get('vieraugen') === '1', me.kennung!, me.name!));

const lesemodell: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(),
  kennzahlen: ahrenbergKennzahlen(),
  verbesserung: darfAnsehen(me),
};
const UNTERNEHMEN = { art: 'unternehmen' } as const;

if (!location.hash.startsWith('#/portfolio/')) {
  const ziel =
    params.get('seite') === 'kennzahl'
      ? kennzahlRoute(BB_IDS.kz4)
      : params.get('ez') === '1'
        ? energiezielRoute(EZ_IDS.ez1)
        : verbesserungRoute();
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
        showVerbesserung={bereiche.includes('verbesserung')}
        leiste={kacheln.map((k) => k.key)}
        fleetLabel="Unternehmen"
        onNavigate={(p) => navigate(pageRoute(p))}
      />
      {route.page === 'portfolio-verbesserung' ? (
        <VerbesserungBereich
          reiter={route.verbesserungReiter ?? 'energieziele'}
          energiezielId={route.energiezielId ?? null}
          onReiter={(r) => navigate(verbesserungRoute(r))}
          onOeffnen={(id) => navigate(energiezielRoute(id))}
          onListe={() => navigate(verbesserungRoute())}
          onKennzahl={(id) => navigate(kennzahlRoute(id))}
        />
      ) : route.page === 'portfolio-kennzahlen' ? (
        <KennzahlenPage
          kennzahlId={route.kennzahlId ?? null}
          onOeffnen={(id) => navigate(kennzahlRoute(id))}
          onListe={() => navigate(pageRoute('portfolio-kennzahlen'))}
          zone="Europe/Berlin"
        />
      ) : (
        <p>Diese Bühne zeigt nur Ziele und Maßnahmen.</p>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

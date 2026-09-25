import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { ebenenAktiv, ebenenBereiche, ebenenLeiste, ebenenTitel, type EbenenLesemodell } from '../src/ebenenNav';
import { darfAnsehen } from '../src/energiemanagementPortal';
import { dokumentRoute, energiemanagementRoute, hashForRoute, pageRoute, parseRoute, personRoute, type Route } from '../src/nav';
import { EnergiemanagementBereich } from '../src/pages/EnergiemanagementBereich';
import { setSelbstauskunft, teilansichtKopf } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { EM_IDS, energiemanagementBuehne, type EnergiemanagementLage } from '../src/test/energiemanagementFixtures';
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
 * Bühne des Bereichs „Energiemanagement“ (UEMS AP-19 IP-9, IP-13): die ECHTE `AppShell` mit der ECHTEN Leiste und den ECHTEN
 * Reitern (`PortfolioTabs`) — dieselben reinen Funktionen wie `App.tsx` — und darin der ECHTE
 * `EnergiemanagementBereich`. Die Routen von IP-6/IP-7/IP-8 spielt `energiemanagementBuehne`
 * (`src/test/energiemanagementFixtures.ts`); jeder Schreib-Körper steht in `window.__emGesendet` (Netzwerk-Probe).
 *
 * Adresse: `?person=IK|JW|CB|RF` (Vorgabe IK; RF = Robert Falk mit der Rolle „Einsicht“, IP-13) · `&lage=start|ahrenberg`
 * (Vorgabe start) · `&dok=1|2|3` öffnet D-0001 … D-0003 der Lage `ahrenberg` · `&seite=dokumente|aufgaben|verantwortung|zuschnitt`
 * · `&ps=RF|IK|…` öffnet die Seite dieser Person (IP-13). Die Uhr stellt die Spec (`page.clock`).
 * Eigene Bühne, keine geteilte Datei wird angefasst.
 */
const params = new URLSearchParams(location.search);
const person = params.get('person') ?? 'IK';
const LAGEN: EnergiemanagementLage[] = ['start', 'ahrenberg'];
const lage = LAGEN.find((l) => l === params.get('lage')) ?? 'start';
const me = rechteSeed(person).me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
Object.assign(unterstuetzungApi, { liste: async () => [], anfragen: async () => [], hinweise: async () => [] });
const buehne = energiemanagementBuehne(lage, { kennung: me.kennung!, name: me.name! });
Object.assign(api, buehne.routen);
(window as unknown as { __emGesendet: unknown }).__emGesendet = buehne.gesendet;

const lesemodell: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(),
  kennzahlen: ahrenbergKennzahlen(),
  energiemanagement: darfAnsehen(me),
};
const UNTERNEHMEN = { art: 'unternehmen' } as const;
const DOK: Record<string, string> = { '1': EM_IDS.d1, '2': EM_IDS.d2, '3': EM_IDS.d3 };

if (!location.hash.startsWith('#/portfolio/')) {
  const seite = params.get('seite');
  const dok = DOK[params.get('dok') ?? ''];
  const ps = EM_IDS[(params.get('ps') ?? '') as keyof typeof EM_IDS];
  const ziel = dok
    ? dokumentRoute(dok)
    : ps
      ? personRoute(ps)
      : seite === 'dokumente' || seite === 'zuschnitt' || seite === 'aufgaben' || seite === 'verantwortung'
        ? energiemanagementRoute(seite)
        : energiemanagementRoute();
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
        showEnergiemanagement={bereiche.includes('energiemanagement')}
        leiste={kacheln.map((k) => k.key)}
        fleetLabel="Unternehmen"
        onNavigate={(p) => navigate(pageRoute(p))}
      />
      {route.page === 'portfolio-energiemanagement' ? (
        <EnergiemanagementBereich
          reiter={route.energiemanagementReiter ?? 'verzeichnis'}
          dokumentId={route.dokumentId ?? null}
          personId={route.personId ?? null}
          onReiter={(r) => navigate(energiemanagementRoute(r))}
          onDokument={(id) => navigate(dokumentRoute(id))}
          onPerson={(id) => navigate(personRoute(id))}
        />
      ) : (
        <p>Diese Bühne zeigt nur das Energiemanagement.</p>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

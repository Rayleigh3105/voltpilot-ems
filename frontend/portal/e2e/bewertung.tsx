import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { benutzerApi } from '../src/benutzer';
import { darfAnsehen } from '../src/bewertung';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { ebenenAktiv, ebenenBereiche, ebenenLeiste, ebenenTitel, type EbenenLesemodell } from '../src/ebenenNav';
import { hashForRoute, parseRoute, pageRoute, energieeinsatzRoute, type Route } from '../src/nav';
import { BewertungPage } from '../src/pages/BewertungPage';
import { setSelbstauskunft, teilansichtKopf } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { benutzerFixture } from '../src/test/benutzerFixtures';
import { bewertungBuehne } from '../src/test/bewertungFixtures';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { ahrenbergBezugsgroessen, ahrenbergProzesse } from '../src/test/kennzahlAnlegenFixtures';
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
 * Bühne der Welt „Bewertung“ (UEMS AP-16 IP-6): die ECHTE `AppShell` mit der ECHTEN Leiste (`ebenenLeiste`) und den
 * ECHTEN Reitern (`PortfolioTabs`) — dieselben reinen Funktionen wie `App.tsx` — und darin die ECHTE `BewertungPage`.
 * Die Routen spielt `bewertungBuehne` aus `src/test/bewertungFixtures.ts` (Referenzunternehmen Ahrenberg 1.6).
 *
 * Adresse: `?person=IK|PH|JW` (Vorgabe IK, Ines Kaltenbach) · `&stand=leer|voll` (Vorgabe leer: kein Umfang, kein
 * Einsatz — R11) · `&ee=EE-2` öffnet die Seite dieses Einsatzes. Eigene Bühne, damit `startansicht` (25 Specs) unberührt
 * bleibt.
 */
const params = new URLSearchParams(location.search);
const person = params.get('person') ?? 'IK';
const stand = params.get('stand') === 'voll' ? 'voll' : 'leer';
const vieraugen = params.get('vieraugen') === '1';
const historieR13 = params.get('historie') === 'r13';
const me = rechteSeed(person).me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
Object.assign(unterstuetzungApi, { liste: async () => [], anfragen: async () => [], hinweise: async () => [] });

const buehne = bewertungBuehne(stand, person, stand === 'leer' ? '2026-11-04' : '2026-11-20', vieraugen, historieR13);
Object.assign(api, buehne, {
  prozesse: async () => ({ stichtag: null, prozesse: ahrenbergProzesse() }),
  bezugsgroessen: async () => ahrenbergBezugsgroessen(),
});
benutzerApi.liste = async () => benutzerFixture();

const lesemodell: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(),
  kennzahlen: ahrenbergKennzahlen(),
  bewertung: darfAnsehen(me),
};
const UNTERNEHMEN = { art: 'unternehmen' } as const;

const ee = params.get('ee');
if (!location.hash.startsWith('#/portfolio/bewertung')) {
  const ziel = ee ? energieeinsatzRoute(`ee000000-0000-4000-8000-0000000000${ee.slice(3).padStart(2, '0')}`) : pageRoute('portfolio-bewertung');
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
    >
      <PortfolioTabs
        page={route.page}
        showErloese={false}
        showMessstellen={bereiche.includes('messstellen')}
        showBezugsgroessen={bereiche.includes('bezugsgroessen')}
        showKennzahlen={bereiche.includes('kennzahlen')}
        showBerichte={bereiche.includes('berichte')}
        showBewertung={bereiche.includes('bewertung')}
        leiste={kacheln.map((k) => k.key)}
        fleetLabel="Unternehmen"
        onNavigate={(p) => navigate(pageRoute(p))}
      />
      {route.page === 'portfolio-bewertung' ? (
        <BewertungPage
          einsatzId={route.energieeinsatzId ?? null}
          onOeffnen={(id) => navigate(energieeinsatzRoute(id))}
          onListe={() => navigate(pageRoute('portfolio-bewertung'))}
        />
      ) : (
        <p>Diese Bühne zeigt nur die Bewertung.</p>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

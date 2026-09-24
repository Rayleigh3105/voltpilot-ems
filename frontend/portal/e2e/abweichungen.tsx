import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { benutzerApi } from '../src/benutzer';
import { heute } from '../src/bewertung';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { ebenenAktiv, ebenenBereiche, ebenenLeiste, ebenenTitel, type EbenenLesemodell } from '../src/ebenenNav';
import { darfAnsehen } from '../src/energieziele';
import {
  abweichungRoute,
  energiezielRoute,
  hashForRoute,
  kennzahlRoute,
  massnahmeRoute,
  pageRoute,
  parseRoute,
  verbesserungRoute,
  type Route,
} from '../src/nav';
import { KennzahlenPage } from '../src/pages/KennzahlenPage';
import { VerbesserungBereich } from '../src/pages/VerbesserungBereich';
import { setSelbstauskunft, teilansichtKopf } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { abweichungBuehne, AW_IDS, type AbweichungLage } from '../src/test/abweichungFixtures';
import { BB_IDS, bezugsbasisBuehne } from '../src/test/bezugsbasisFixtures';
import { energiezielBuehne } from '../src/test/energiezielFixtures';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../src/test/kennzahlenFixtures';
import { kontenAhrenberg, massnahmeBuehne, vergleichKz4 } from '../src/test/massnahmeFixtures';
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
 * Bühne der Auffälligkeiten und Abweichungen (UEMS AP-18 IP-18): die ECHTE `AppShell` mit den ECHTEN Reitern und darin
 * die ECHTE Kennzahl-Seite von KZ-0004 (Reiter „Vergleich mit Bezugsbasis“ mit der Vermerk-Zeile) bzw. der ECHTE
 * `VerbesserungBereich` (Register „Abweichungen“, Abweichungs-Seite, von dort „Maßnahme anlegen“ und die
 * Maßnahmen-Seite). Die Routen spielen `abweichungBuehne` (`src/test/abweichungFixtures.ts`, R1/R2/R8/R11),
 * `massnahmeBuehne('leer')` (die neue Maßnahme), `energiezielBuehne` und `bezugsbasisBuehne('modell')`; der Vergleich
 * zeigt November 2027 bis Februar 2028 (R2). Der Tag der Routen ist der Tag der Uhr (Playwright `page.clock`).
 *
 * Adresse: `?lage=vermerk|offen|register|leer` (Vorgabe vermerk) · `&seite=kennzahl` öffnet KZ-0004 · `&aw=1|2026`
 * öffnet AW-2028-0001 bzw. AW-2026-0001 · sonst das Register. Eigene Bühne, keine geteilte Datei wird angefasst.
 */
const params = new URLSearchParams(location.search);
const LAGEN: AbweichungLage[] = ['leer', 'vermerk', 'offen', 'register'];
const lage = LAGEN.find((l) => l === params.get('lage')) ?? 'vermerk';
const tag = heute();
const me = rechteSeed('IK').me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
Object.assign(unterstuetzungApi, { liste: async () => [], anfragen: async () => [], hinweise: async () => [] });
Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
Object.assign(
  api,
  bezugsbasisBuehne('modell'),
  energiezielBuehne('juli', false, me.kennung!, me.name!),
  massnahmeBuehne('leer', tag, me.name!),
  abweichungBuehne(lage, tag, me.name!),
  {
    standorte: async () => ({ stichtag: tag, standorte: [] }),
    // R2: der Reiter liest ohne Wahl November 2027 bis Februar 2028; die Vorschau „Ausgangslage“ die gewählten Monate.
    bezugsbasisVergleich: async (_id: string, wahl: { von?: string; bis?: string } = {}) =>
      vergleichKz4(wahl.von ?? '2027-11', wahl.bis ?? (wahl.von ? wahl.von : '2028-02')),
  },
);

const lesemodell: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(),
  kennzahlen: ahrenbergKennzahlen(),
  verbesserung: darfAnsehen(me),
};
const UNTERNEHMEN = { art: 'unternehmen' } as const;

if (!location.hash.startsWith('#/portfolio/')) {
  const aw = params.get('aw');
  const ziel =
    params.get('seite') === 'kennzahl'
      ? kennzahlRoute(BB_IDS.kz4)
      : aw
        ? abweichungRoute(aw === '2026' ? AW_IDS.aw2026 : AW_IDS.aw1)
        : verbesserungRoute('abweichungen');
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
          massnahmeId={route.massnahmeId ?? null}
          abweichungId={route.abweichungId ?? null}
          onReiter={(r) => navigate(verbesserungRoute(r))}
          onOeffnen={(id) => navigate(energiezielRoute(id))}
          onListe={() => navigate(verbesserungRoute())}
          onKennzahl={(id) => navigate(kennzahlRoute(id))}
          onMassnahme={(id) => navigate(massnahmeRoute(id))}
          onAbweichung={(id) => navigate(abweichungRoute(id))}
        />
      ) : route.page === 'portfolio-kennzahlen' ? (
        <KennzahlenPage
          kennzahlId={route.kennzahlId ?? null}
          onOeffnen={(id) => navigate(kennzahlRoute(id))}
          onListe={() => navigate(pageRoute('portfolio-kennzahlen'))}
          zone="Europe/Berlin"
        />
      ) : (
        <p>Diese Bühne zeigt nur Kennzahlen, Ziele und Maßnahmen.</p>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

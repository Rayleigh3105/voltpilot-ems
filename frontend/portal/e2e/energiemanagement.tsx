import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { benutzerApi } from '../src/benutzer';
import { keycloak } from '../src/auth';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { ebenenAktiv, ebenenBereiche, ebenenLeiste, ebenenTitel, type EbenenLesemodell } from '../src/ebenenNav';
import { darfAnsehen } from '../src/energiemanagementPortal';
import {
  auditRoute,
  dokumentRoute,
  energiemanagementRoute,
  feststellungRoute,
  hashForRoute,
  managementbewertungRoute,
  pageRoute,
  parseRoute,
  personRoute,
  type Route,
} from '../src/nav';
import { EnergiemanagementBereich } from '../src/pages/EnergiemanagementBereich';
import { MassnahmeSeite } from '../src/pages/MassnahmeSeite';
import { setSelbstauskunft, teilansichtKopf } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { AF_IDS, auditFeststellungBuehne, R10_MASSNAHME, type AuditLage } from '../src/test/auditFeststellungFixtures';
import { EM_IDS, energiemanagementBuehne, type EnergiemanagementLage } from '../src/test/energiemanagementFixtures';
import { MB_KENNUNG, managementbewertungBuehne, type MbLage } from '../src/test/managementbewertungFixtures';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../src/test/kennzahlenFixtures';
import { kontenAhrenberg, massnahmeBuehne } from '../src/test/massnahmeFixtures';
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
 * IP-20: `&al=leer|r10|r11` spielt dazu die Routen des internen Audits und der Feststellung (`auditFeststellungBuehne`)
 * und die der Maßnahme (`massnahmeBuehne`, AP-18), die Konten der Maßnahme und die Maßnahmen-Seite unter
 * `#/portfolio/verbesserung/massnahmen/{id}`; `&seite=audits|feststellungen` · `&au=1` öffnet AU-2029-0001 · `&fs=1`
 * F-2029-0001 · `&m=1` die Maßnahme aus F-2029-0001 · `&vieraugen=1`. Ohne `al` bleibt die Bühne, wie sie war.
 * IP-24: `&mb=leer|r13|r13f` spielt die Berichte-Routen der Managementbewertung und die Wiedervorlage R12
 * (`managementbewertungBuehne`, Körper in `window.__mbGesendet`); `&seite=wiedervorlage|managementbewertung` · `&br=1`
 * öffnet BR-2029-0001. Ohne `mb` bleibt die Bühne, wie sie war.
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

// IP-20: Audits, Feststellungen und die Maßnahme aus AP-18 — nur mit `al`, sonst bleibt die Bühne byte-gleich.
const AUDIT_LAGEN: AuditLage[] = ['leer', 'r10', 'r11'];
const auditLage = AUDIT_LAGEN.find((l) => l === params.get('al')) ?? null;
let massnahmeR10: Promise<string | null> = Promise.resolve(null);
if (auditLage) {
  const jetzt = () => new Date().toISOString();
  const tag = jetzt().slice(0, 10);
  Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
  Object.assign(api, massnahmeBuehne('leer', tag, me.name!, { sub: me.kennung! }), {
    kennzahlen: async () => ({ kennzahlen: [] }),
    energieeinsaetze: async () => ({ energieeinsaetze: [] }),
    energieziele: async () => ({ energieziele: [] }),
  });
  const af = auditFeststellungBuehne(auditLage, { kennung: me.kennung!, name: me.name! }, jetzt, async () => (await api.massnahmen()).massnahmen, {
    vieraugen: params.get('vieraugen') === '1',
  });
  Object.assign(api, af.routen);
  (window as unknown as { __afGesendet: unknown }).__afGesendet = af.gesendet;
  // R10/R11: M-2029-0001 über die echte Maßnahmen-Route der Bühne, umgesetzt am 01.03.2029 (R11).
  if (auditLage !== 'leer') {
    massnahmeR10 = api
      .massnahmeAnlegen({
        titel: R10_MASSNAHME, verantwortlich: 'JW', termin: '2029-02-28', herkunft: 'nichtkonformitaet', herkunft_kennung: 'F-2029-0001',
        erwartete_wirkung_wortlaut: 'Zuständigkeit festgelegt; jede Freigabe einer Bezugsbasis nennt die zuständige Person und ihre Vertretung.',
      })
      .then(async (m) => {
        if (tag >= '2029-03-01') {
          await api.massnahmeUmgesetzt(m.id, { am: '2029-03-01', begruendung: 'Aufgabe seit 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger.' });
        }
        return m.id;
      });
  }
}

// IP-24: Managementbewertung und Wiedervorlage — nur mit `mb`, sonst bleibt die Bühne byte-gleich.
const MB_LAGEN: MbLage[] = ['leer', 'r13', 'r13f'];
const mbLage = MB_LAGEN.find((l) => l === params.get('mb')) ?? null;
if (mbLage) {
  // Namen, Leitung am Tag und Folge-Objekte liest die Bühne über die Routen, die hier schon gespielt werden.
  const mb = managementbewertungBuehne(mbLage, () => new Date().toISOString(), {
    name: async (id) => (await api.energiemanagementPersonen()).personen.find((p) => p.id === id)?.name ?? null,
    leitungAm: async (tag) => (await api.energiemanagementAufgaben(tag)).leitung.map((p) => p.id),
    objekt: async (art, objekt) => {
      if (art === 'dokument') {
        const [kz, nr] = objekt.split('/');
        const d = (await api.energiemanagementDokumente()).dokumente.find((x) => x.kennzeichen === kz && String(x.gueltige_fassung) === nr);
        return d ? { zustand: 'freigegeben', angabe: d.titel } : null;
      }
      if (art === 'audit') {
        const a = (await api.energiemanagementAudits().catch(() => ({ audits: [] as { kennzeichen: string; zustand: string; titel: string }[] }))).audits.find((x) => x.kennzeichen === objekt);
        return a ? { zustand: a.zustand, angabe: a.titel } : null;
      }
      if (art === 'aufgabe') {
        const z = (await api.energiemanagementAufgaben()).zuordnungen.find((x) => x.id === objekt);
        return z ? { zustand: z.zustand, angabe: z.person.name } : null;
      }
      return null;
    },
    massnahmen: auditLage ? async () => (await api.massnahmen()).massnahmen : undefined,
  });
  Object.assign(api, mb.routen);
  (window as unknown as { __mbGesendet: unknown }).__mbGesendet = mb.gesendet;
}

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
      : params.get('au') === '1'
        ? auditRoute(AF_IDS.au1)
        : params.get('fs') === '1'
          ? feststellungRoute(AF_IDS.f1)
          : params.get('br') === '1'
            ? managementbewertungRoute(MB_KENNUNG)
            : seite === 'dokumente' || seite === 'zuschnitt' || seite === 'aufgaben' || seite === 'verantwortung' || seite === 'audits' ||
                seite === 'feststellungen' || seite === 'wiedervorlage' || seite === 'managementbewertung'
              ? energiemanagementRoute(seite)
              : energiemanagementRoute();
  history.replaceState(null, '', hashForRoute(ziel));
  if (params.get('m') === '1') {
    void massnahmeR10.then((id) => {
      if (id) location.hash = `#/portfolio/verbesserung/massnahmen/${id}`;
    });
  }
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
          auditId={route.auditId ?? null}
          feststellungId={route.feststellungId ?? null}
          managementbewertungKennung={route.managementbewertungKennung ?? null}
          onReiter={(r) => navigate(energiemanagementRoute(r))}
          onDokument={(id) => navigate(dokumentRoute(id))}
          onPerson={(id) => navigate(personRoute(id))}
          onAudit={(id) => navigate(auditRoute(id))}
          onFeststellung={(id) => navigate(feststellungRoute(id))}
          onManagementbewertung={(kennung) => navigate(managementbewertungRoute(kennung))}
          onSprung={navigate}
        />
      ) : auditLage && route.massnahmeId ? (
        <MassnahmeSeite id={route.massnahmeId} onListe={() => history.back()} />
      ) : (
        <p>Diese Bühne zeigt nur das Energiemanagement.</p>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);

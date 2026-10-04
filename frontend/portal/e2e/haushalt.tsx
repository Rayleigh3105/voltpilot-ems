import './erloese-minus-uhr';
import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/shell/Shell.css';
import '../src/components/Historie.css';
import '../src/components/Erloese.css';
import '../src/components/SoVerdient.css';
import '../src/components/Verlauf.css';
import '../src/components/BereichTabs.css';
import '../src/components/SteuerungFormel.css';
import { api, ApiError, type History, type Site, type SiteEarnings } from '../src/api';
import { keycloak } from '../src/auth';
import FIXTURES from '../src/erloeseFixtures.json';
import { foerderweg, type FoerderwegWert } from '../src/mispelFoerderweg';
import { mispelApi, type FoerderwegAnsicht, type PauschalVormerken, type PauschalVormerkung } from '../src/mispelFoerderwegApi';
import { mispelCheckApi, type MispelCheckAnsicht } from '../src/mispelCheck';
import type { MispelJahr, MispelMonat } from '../src/mispelMengen';
import { mispelPauschalApi, type PauschalJahr } from '../src/mispelPauschal';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { TechnikSection } from '../src/pages/AnlageTechnik';
import checkFixtures from './mispel-check-fixtures.json';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * **Bühne „Haushalt mit der Pauschaloption“** (MiSpeL MP-27, BK-27 Variante A, abgestimmt am 04.10.2026): Haus Kröger
 * (fiktiv) — Dach 9,2 kWp, Speicher 10 kWh, heute in der Einspeisevergütung.
 *
 * - `?seite=einstellungen` (Vorgabe): die echte `TechnikSection` mit der Zeile „Förderweg“ und dem Dialog
 *   „Förderweg ändern“ — die Pauschaloption mit Voraussetzungen, Pauschalgrenzen und „vormerken, Termin offen“
 *   (Vertrag Förderweg 1.3 § 5a) gegen ein Gedächtnis; der Check Haushalt (MP-29) aus der Fixture `c1`. Heute ist der
 *   20.10.2026 (vor der EU-Genehmigung). `?pv=32.4` zeigt den Fall über 30 kWp.
 * - `?seite=erloese&z=jahr|monat&at=2028-09-15&stand=foerderfaehig|indifferent|saldierungsfaehig|rumpfjahr`: die echte
 *   `ErloeseSection` mit der Karte „MiSpeL · Jahresstand nach Anlage 2“; der Jahresstand hat die Form der Route
 *   `GET …/mispel/pauschal/jahre/{jahr}` (Haus Kröger: (P1) 5.000, (P3) 500, (P4) 5.500 kWh). Kennzahlleiste und
 *   Abrechnung stammen aus der Konzept-Fixture `ev-monat`/`dv-monat` (nicht Teil von MP-27).
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seite kennt die Bühne nicht.
 */
const params = new URLSearchParams(window.location.search);
const seite = params.get('seite') ?? 'einstellungen';
const HEUTE = '2026-10-20';
const PV = Number(params.get('pv') ?? '9.2');

const SITE: Site = {
  id: 's-kroeger',
  name: 'Haus Kröger',
  biddingZone: 'DE-LU',
  latitude: 53.5511,
  longitude: 9.9937,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18.9,
  netzladenErlaubt: false,
  maxFeedInKw: null,
} as Site;

// ------------------------------------------------------------------ Einstellungen · Förderweg-Dialog

let vormerkung: PauschalVormerkung | null = null;
const HEUTE_WEG: FoerderwegWert = 'einspeiseverguetung';

function ansicht(): FoerderwegAnsicht {
  const b = foerderweg(HEUTE_WEG);
  return {
    site_id: SITE.id,
    am: HEUTE,
    quelle: 'bestand',
    foerderweg: HEUTE_WEG,
    begriff: b.begriff,
    rechtsgrundlage: b.rechtsgrundlage,
    formelsatz: null,
    formelsatz_gebunden_bis: null,
    einverstaendnis: null,
    gueltig_ab: null,
    netzladen: { moeglich: false, heute: false },
    fassungen: [],
    aw_regel: null,
    vormerkung: null,
    direktvermarkter: null,
    bilanzkreis_gesondert: null,
    pauschal_vormerkung: vormerkung,
    pauschaloption_ab: null,
  };
}

function nein(status: number, code: string, fakten: Record<string, unknown>): never {
  throw new ApiError(status, code, { code, message: code, ...fakten });
}

Object.assign(mispelApi, {
  foerderweg: async () => ansicht(),
  pauschalVormerken: async (_id: string, a: PauschalVormerken) => {
    if (!a.ein_betreiber) nein(422, 'voraussetzung_unbestaetigt', { feld: 'ein_betreiber' });
    if (a.steckersolar_kwp > 0 && !a.steckersolar_direktvermarktung) nein(422, 'voraussetzung_unbestaetigt', { feld: 'steckersolar_direktvermarktung' });
    if (PV > 30) nein(422, 'ueber_30_kwp', { solarleistung_kwp: PV, grenze_kwp: 30 });
    const jetzt = `${HEUTE}T10:00:00Z`;
    vormerkung = {
      id: 'pv-1',
      foerderweg: 'marktpraemie_pauschal',
      begriff: 'Marktprämie mit Pauschaloption',
      rechtsgrundlage: '§ 19 Abs. 3c EEG; Tenor Ziff. 4, Anlage 2',
      termin: null,
      steckersolar_kwp: a.steckersolar_kwp,
      ein_betreiber_bestaetigt_am: jetzt,
      steckersolar_direktvermarktung_bestaetigt_am: a.steckersolar_kwp > 0 ? jetzt : null,
      direktvermarkter: a.direktvermarkter,
      bilanzkreis_gesondert: a.bilanzkreis_gesondert,
      vorgemerkt_am: jetzt,
    };
    return ansicht();
  },
  vormerkungZuruecknehmen: async () => {
    if (!vormerkung) nein(404, 'keine_vormerkung', { heute: HEUTE });
    vormerkung = null;
    return ansicht();
  },
});

const CHECKS = checkFixtures as unknown as Record<string, MispelCheckAnsicht>;
Object.assign(mispelCheckApi, {
  lesen: async (siteId: string): Promise<MispelCheckAnsicht> => ({ ...CHECKS[params.get('check') ?? 'c1'], site_id: siteId }),
});

// ------------------------------------------------------------------ Erlöse · Jahresstand

interface Fixture {
  id: string;
  money: SiteEarnings;
}
const geld = (FIXTURES as unknown as { fixtures: Fixture[] }).fixtures.find((f) => f.id === 'dv-monat')!;

const STAENDE: Record<string, Record<string, number>> = {
  foerderfaehig: { '(P14)': 3900, '(P15)': 3900, '(P7)': 4030, '(P8)': 0, '(P9)': 1480, '(P10)': 0, '(P11)': 1480 },
  indifferent: { '(P14)': 5120, '(P15)': 5000, '(P7)': 5120, '(P8)': 0, '(P9)': 1890, '(P10)': 0, '(P11)': 1890 },
  saldierungsfaehig: { '(P14)': 6600, '(P15)': 5000, '(P7)': 6800, '(P8)': 1300, '(P9)': 1900, '(P10)': 1300, '(P11)': 600 },
};

function pauschalJahr(jahr: number): PauschalJahr {
  const welcher = params.get('stand') ?? 'foerderfaehig';
  const rumpf = welcher === 'rumpfjahr';
  const grenzen = { '(P1)': 5000, '(P2)P1': 0.1, '(P3)': 500, '(P4)': 5500 };
  return {
    site_id: SITE.id,
    jahr,
    anwendbar_ab: '2027-07-01',
    schaetzung: null,
    staende: [
      {
        tag_von: rumpf ? `${jahr}-07-01` : `${jahr}-01-01`,
        tag_bis: `${jahr}-12-31`,
        rumpfjahr: rumpf,
        fassung: 3,
        formelsatz: 'P1',
        basisfall: 'P1',
        stand: 'vorlaeufig',
        stand_gruende: ['zeitraum_offen'],
        wertequelle: 'geraet',
        viertelstunden_erwartet: 35136,
        viertelstunden_gerechnet: 23424,
        gerechnet_am: `${jahr}-08-31T22:00:00Z`,
        stammdaten: { Pinst: 10, SKinst: 10 },
        jahreswerte: rumpf
          ? { ...grenzen, '(P1)R': 2513.661, '(P3)R': 252.055, '(P4)R': 2765.716, '(P14)': 1200, '(P15)': 1200, '(P7)': 1260, '(P9)': 640, '(P10)': 0, '(P11)': 640 }
          : { ...grenzen, ...STAENDE[welcher] },
      },
    ],
  };
}

api.siteEarnings = (async () => ({ ...geld.money, series: [] }) as unknown as SiteEarnings) as typeof api.siteEarnings;
api.history = (async () =>
  ({ range: 'month', from: geld.money.from, to: geld.money.to, bucketMinutes: 15, buckets: [], protocol: [], plan: [], totals: {} }) as unknown as History) as typeof api.history;
api.mispelMonat = (async (_s: string, monat: string) =>
  ({ monat, foerderweg: 'marktpraemie_pauschal', foerderwegBegriff: 'Marktprämie mit Pauschaloption', mispel: true, abgrenzung: false, stand: null, gruende: [], giltAlsNachweis: false, teile: [], wert: null }) as unknown as MispelMonat) as typeof api.mispelMonat;
api.mispelJahr = (async (_s: string, jahr: number) =>
  ({ jahr, mispel: true, abgrenzung: false, monate: [], wert: null, mitteilungBis: `${jahr + 1}-05-31`, giltAlsNachweis: false }) as unknown as MispelJahr) as typeof api.mispelJahr;
Object.assign(mispelPauschalApi, { jahr: async (_s: string, jahr: number) => pauschalJahr(jahr) });

Object.assign(api, {
  siteAssets: async () => [
    { id: 'a-pv', type: 'pv', pvCapacityKwp: PV, capacityKwh: null, deviceId: null, speicherschonung: null },
    { id: 'a-1', type: 'battery', capacityKwh: 10, maxChargeKw: 5, maxDischargeKw: 5, roundtripEfficiencyPct: 90, deviceId: 'd-1', speicherschonung: null },
  ],
  siteDeletionPreview: async () => {
    throw new Error('Vorschau');
  },
  supplyPrice: async () => null,
  schedule: async () => {
    throw new Error('kein Plan');
  },
  updateSite: async (_id: string, body: Site) => ({ ...SITE, ...body }),
});

function Einstellungen() {
  const [s, setS] = useState(SITE);
  return (
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">Anlage {s.name} › Einstellungen</div>
      </header>
      <main className="vp-main">
        <TechnikSection site={s} devices={[]} sites={[s]} onReload={() => undefined} onSiteSaved={setS} onSiteDeleted={() => undefined} />
      </main>
    </div>
  );
}

if (seite === 'erloese') {
  window.location.hash = `#/anlage/${SITE.id}/erloese?z=${params.get('z') ?? 'jahr'}&at=${params.get('at') ?? '2028-09-15'}`;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {seite === 'erloese' ? (
      <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
        <main className="vp-main" data-buehne="haushalt" style={{ padding: '16px', minWidth: 0 }}>
          <ErloeseSection site={SITE} />
        </main>
      </div>
    ) : (
      <Einstellungen />
    )}
  </React.StrictMode>,
);

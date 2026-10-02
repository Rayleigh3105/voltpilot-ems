import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type Site } from '../src/api';
import { keycloak } from '../src/auth';
import { foerderweg, naechsterMonatserster, type FoerderwegWert } from '../src/mispelFoerderweg';
import { mispelApi, type FoerderwegAendern, type FoerderwegAnsicht, type ZaehlerrolleAnsicht } from '../src/mispelFoerderwegApi';
import { TechnikSection } from '../src/pages/AnlageTechnik';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Anlage › Einstellungen › Förderweg“ (MiSpeL MP-17, BK-17 Variante A): die ECHTE `TechnikSection` mit
 * der Zeile „Förderweg“ und dem Dialog „Förderweg ändern“, gegen ein Gedächtnis, das die Regeln des Vertrags
 * `mispel-foerderweg.md` 1.2 nachspielt, die die Fläche erreichen kann: Wechsel nur zum Monatsersten (vorgemerkt,
 * § 5), Einverständnis bis 30.09.2027, Formelsatz Pflicht in der Abgrenzung. Heute ist der 20.10.2026.
 * `?fall=` ist der Bestand der Anlage: `ausschliesslichkeit` (Vorgabe), `einspeiseverguetung`, `ungefoerdert`.
 */
const HEUTE = '2026-10-20';
const FAELLE: Record<string, FoerderwegWert> = {
  ausschliesslichkeit: 'marktpraemie_ausschliesslichkeit',
  einspeiseverguetung: 'einspeiseverguetung',
  ungefoerdert: 'ungefoerdert',
};
const fall: FoerderwegWert = FAELLE[new URLSearchParams(window.location.search).get('fall') ?? 'ausschliesslichkeit'];

const site: Site = {
  id: 's-ahrenberg',
  name: 'Werk Ahrenberg',
  biddingZone: 'DE-LU',
  latitude: 48.2612,
  longitude: 11.4355,
  plantKind: fall === 'einspeiseverguetung' ? 'eigenverbrauch' : 'direktvermarktung',
  anzulegenderWertCtKwh: fall === 'einspeiseverguetung' ? null : 8.11,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 17.4,
  netzladenErlaubt: fall === 'ungefoerdert',
  maxFeedInKw: null,
};

interface Fassung {
  antrag: FoerderwegAendern;
  aufgehoben: boolean;
}
const fassungen: Fassung[] = [];

function ansicht(am: string): FoerderwegAnsicht {
  const wirksam = fassungen.filter((f) => !f.aufgehoben);
  const amTag = [...wirksam].reverse().find((f) => f.antrag.gueltig_ab <= am) ?? null;
  const vormerkung = wirksam.find((f) => f.antrag.gueltig_ab > HEUTE) ?? null;
  const w: FoerderwegWert = amTag?.antrag.foerderweg ?? fall;
  const b = foerderweg(w);
  return {
    site_id: site.id,
    am,
    quelle: amTag ? 'fassung' : 'bestand',
    foerderweg: w,
    begriff: b.begriff,
    rechtsgrundlage: b.rechtsgrundlage,
    formelsatz: amTag?.antrag.formelsatz ?? null,
    formelsatz_gebunden_bis: null,
    einverstaendnis: amTag ? amTag.antrag.einverstaendnis : null,
    gueltig_ab: amTag?.antrag.gueltig_ab ?? null,
    netzladen: { moeglich: b.netzladenMoeglich, heute: site.netzladenErlaubt },
    fassungen: [],
    aw_regel: amTag?.antrag.aw_regel ?? null,
    vormerkung: vormerkung
      ? {
          id: 'v-1',
          foerderweg: vormerkung.antrag.foerderweg,
          begriff: foerderweg(vormerkung.antrag.foerderweg).begriff,
          rechtsgrundlage: foerderweg(vormerkung.antrag.foerderweg).rechtsgrundlage,
          formelsatz: vormerkung.antrag.formelsatz,
          einverstaendnis: vormerkung.antrag.einverstaendnis,
          gueltig_ab: vormerkung.antrag.gueltig_ab,
          aw_regel: vormerkung.antrag.aw_regel,
          direktvermarkter: vormerkung.antrag.direktvermarkter,
          bilanzkreis_gesondert: vormerkung.antrag.bilanzkreis_gesondert,
        }
      : null,
    direktvermarkter: amTag?.antrag.direktvermarkter ?? null,
    bilanzkreis_gesondert: amTag?.antrag.bilanzkreis_gesondert ?? null,
  };
}

function nein(status: number, code: string, fakten: Record<string, unknown>): never {
  throw new ApiError(status, code, { code, message: code, ...fakten });
}

const ZP = { Z1: 'DE00033740000000000000000001234567'.slice(0, 33), Z2: 'DE00033740000000000000000001234589'.slice(0, 33) };
const register = [
  { id: 'ms-01', kennzeichen: 'MS-01', name: 'Hauptzähler Bezug', richtung: 'Bezug', rolle: 'Z1' as const },
  { id: 'ms-02', kennzeichen: 'MS-02', name: 'Hauptzähler Einspeisung', richtung: 'Abgabe', rolle: 'Z1' as const },
  { id: 'ms-14', kennzeichen: 'MS-14', name: 'Speicher Laden', richtung: 'Laden', rolle: 'Z2' as const },
  { id: 'ms-15', kennzeichen: 'MS-15', name: 'Speicher Entladen', richtung: 'Entladen', rolle: 'Z2' as const },
];

function rolle(id: string): ZaehlerrolleAnsicht {
  const m = register.find((x) => x.id === id)!;
  return {
    messstelle_id: m.id,
    messstelle: m.kennzeichen,
    am: HEUTE,
    anlage: site.id,
    rolle: {
      rolle: m.rolle,
      zaehlpunkt: ZP[m.rolle],
      messstellenbetreiber: 'Stadtwerke Ahrenberg',
      eichstatus: 'eichrechtskonform',
      eichfrist_bis: '2031-12-31',
      wertequelle: 'messstellenbetreiber',
      gueltig_ab: '2026-10-01',
    },
    festlegungsgroesse: null,
    urteil: 'tauglich',
    befunde:
      m.rolle === 'Z2'
        ? [
            {
              code: 'dc_kopplung_erzeugung',
              schwere: 'hinweis',
              messstelle: m.kennzeichen,
              betroffen: null,
              fundstelle: 'Tenor S. 31–32',
              satz: 'Hängen PV-Module gleichstromseitig am Speicher-Wechselrichter, ist eine geeichte DC-Messung nötig.',
            },
          ]
        : [],
  };
}

Object.assign(mispelApi, {
  foerderweg: async () => ansicht(HEUTE),
  foerderwegSetzen: async (_id: string, a: FoerderwegAendern) => {
    const alt = ansicht(HEUTE).foerderweg;
    const vormerkbar = naechsterMonatserster(HEUTE);
    if (a.gueltig_ab > HEUTE && a.gueltig_ab !== vormerkbar) nein(422, 'gueltig_ab_in_zukunft', { heute: HEUTE, naechster_monatserster: vormerkbar });
    if (a.foerderweg === 'marktpraemie_abgrenzung' && !a.formelsatz) nein(422, 'formelsatz_fehlt', { foerderweg: a.foerderweg });
    if (a.foerderweg === 'marktpraemie_abgrenzung' && !a.einverstaendnis) nein(422, 'einverstaendnis_fehlt', { bis: '2027-09-30' });
    if (alt !== a.foerderweg && !a.gueltig_ab.endsWith('-01')) nein(422, 'wechsel_nur_zum_monatsersten', { naechster_monatserster: vormerkbar });
    fassungen.filter((f) => f.antrag.gueltig_ab === a.gueltig_ab).forEach((f) => (f.aufgehoben = true));
    fassungen.push({ antrag: a, aufgehoben: false });
    return ansicht(a.gueltig_ab);
  },
  vormerkungZuruecknehmen: async () => {
    const v = fassungen.find((f) => !f.aufgehoben && f.antrag.gueltig_ab > HEUTE);
    if (!v) nein(404, 'keine_vormerkung', { heute: HEUTE });
    v.aufgehoben = true;
    return ansicht(HEUTE);
  },
  zaehlerrolle: async (id: string) => rolle(id),
  zaehlerrolleSetzen: async (id: string) => rolle(id),
});

Object.assign(api, {
  siteAssets: async () => [
    {
      id: 'a-1', kind: 'battery', capacityKwh: 500, maxChargeKw: 250, maxDischargeKw: 250, roundtripEfficiencyPct: 90,
      deviceId: 'd-1', speicherschonung: null,
    },
  ],
  siteDeletionPreview: async () => { throw new Error('Vorschau'); },
  supplyPrice: async () => null,
  schedule: async () => { throw new Error('kein Plan'); },
  updateSite: async (_id: string, body: Site) => ({ ...site, ...body }),
  messstellenRegister: async () => ({
    messstellen: [],
    register: register.map((m) => ({
      id: m.id, kennzeichen: m.kennzeichen, name: m.name, art: 'gemessen', medium: 'Strom', lebenszyklus: 'aktiv',
      hauptgroesse: { groesse: 'Wirkenergie', richtung: m.richtung, einheit: 'kWh', wertart: 'Zählerstand' },
    })),
    stichtag: HEUTE, zeitpunkt: `${HEUTE}T10:00:00Z`, teilansicht: false, aggregat: null,
  }),
});

function Buehne() {
  const [s, setS] = useState(site);
  return (
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">Anlage {s.name} › Einstellungen</div>
      </header>
      <main className="vp-main">
        <TechnikSection
          site={s}
          devices={[]}
          sites={[s]}
          onReload={() => undefined}
          onSiteSaved={setS}
          onSiteDeleted={() => undefined}
        />
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Buehne />
  </React.StrictMode>,
);

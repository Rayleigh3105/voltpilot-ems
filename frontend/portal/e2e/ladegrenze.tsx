import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { api, type ChargingConfig } from '../src/api';
import { LadeparkRahmenKarte } from '../src/components/LadeparkRahmenKarte';
import { RechteStandort } from '../src/rollen';
import { ahrenbergNetzanschluesse } from '../src/test/netzanschlussFixtures';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const ungebunden = params.get('fall') === 'ungebunden';
const site = { id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' };
const config: ChargingConfig = {
  gridLimitKw: 180,
  priorityChargePointIds: [],
  chargePoints: [],
  frame: { houseReserveKw: 30, maxHouseLoadKw: 96.5 },
};

Object.assign(api, {
  chargingConfig: async () => structuredClone(config),
  siteDetail: async () => ({ ...site, standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1' } }),
  netzanschluesse: async () => ({
    standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1' },
    stichtag: '2026-10-20',
    kennzeichen_vorschlag: 'NA-3',
    netzanschluesse: ungebunden ? [] : ahrenbergNetzanschluesse(),
  }),
  saveCustomerChargingFrame: async () => structuredClone(config),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="vp-ladegrenze-buehne">
    <RechteStandort.Provider value={FIXTURE_IDS.st1}>
      <LadeparkRahmenKarte site={site as never} rahmen={null} />
    </RechteStandort.Provider>
  </main>,
);

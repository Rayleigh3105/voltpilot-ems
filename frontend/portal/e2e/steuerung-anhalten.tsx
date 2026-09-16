import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import type { Site } from '../src/api';
import { keycloak } from '../src/auth';
import { FunktionenKarte } from '../src/components/FunktionenKarte';
import { SteuerungSection } from '../src/pages/SteuerungSection';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { FIXTURE_IDS, werkAhrenberg } from '../src/test/standorteFixtures';
import { funktionenKarte } from '../src/uebersicht';
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

const site: Site = {
  id: FIXTURE_IDS.an1,
  name: 'Werk Ahrenberg – Halle 1',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'fest',
  tarifParamCtKwh: 28,
  netzladenErlaubt: false,
  maxFeedInKw: 550,
  leistungspreisEurKw: 120,
  peakReserveSocPct: 30,
};

function Buehne() {
  const ansicht = new URLSearchParams(location.search).get('ansicht');
  if (ansicht === 'standort') {
    return <div className="vp-content">
      <header className="vp-topbar"><div className="crumbs">Kunststoffwerk Ahrenberg › Werk Ahrenberg</div></header>
      <main className="vp-main">
        <h1>Werk Ahrenberg</h1>
        <FunktionenKarte
          abschnitte={funktionenKarte({ art: 'standort', standort: werkAhrenberg() }, angehalten())}
          onSteuernAktion={async () => undefined}
        />
      </main>
    </div>;
  }
  return <div className="vp-content">
    <header className="vp-topbar"><div className="crumbs">Werk Ahrenberg › Halle 1 › Steuerung</div></header>
    <main className="vp-main"><h1>Steuerung</h1><SteuerungSection site={site} /></main>
  </div>;
}

function angehalten() {
  const f = structuredClone(ahrenbergFunktionen());
  const standort = f.standorte[0];
  const teilnahme = standort.steuern.anlagen[0].teilnahme;
  teilnahme.zustand = 'angehalten';
  teilnahme.seit = '2026-11-03T14:10:00+01:00';
  teilnahme.text = 'Angehalten seit 03.11.2026 14:10';
  teilnahme.aktionen = ['fortsetzen', 'beenden'];
  standort.steuern.zustand = 'angehalten';
  standort.steuern.seit = teilnahme.seit;
  standort.steuern.text = 'Angehalten seit 03.11.2026 14:10';
  standort.steuern.aktionen = ['fortsetzen', 'beenden'];
  f.unternehmen.steuern = { laeuft_an: 0, standorte: 2, text: 'Steuern & Optimieren läuft an 0 von 2 Standorten' };
  return f;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Buehne /></React.StrictMode>);

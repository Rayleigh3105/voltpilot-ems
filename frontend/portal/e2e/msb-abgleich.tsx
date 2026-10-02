import './erloese-minus-uhr';

import React from 'react';
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
import '../src/pages/MessstelleSeite.css';

import { api, type History, type Site, type SiteEarnings } from '../src/api';
import FIXTURES from '../src/erloeseFixtures.json';
import MISPEL from './mispel-mengen-fixtures.json';
import type { MispelMonat } from '../src/mispelMengen';
import { abgleichApi, type AbgleichMonat, type MessstelleAbgleich, type Wirkung } from '../src/mispelAbgleich';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { MsbAbgleichKarte } from '../src/components/erloese/MsbAbgleich';
import { setSelbstauskunft } from '../src/rollen';
import type { Selbstauskunft } from '../src/api';

/**
 * **Bühne „Abgleich Gerät ↔ Messstellenbetreiber“** (MiSpeL MP-15, BK-15 Variante A) — die echte `ErloeseSection`
 * mit der Monatskarte von MP-18 (Fixture aus `MispelMengenApiTest`) und die echte `MsbAbgleichKarte` der Messstelle.
 * Die Abgleich-Antworten sind der Beispielmonat November 2026 des Bedienkonzepts BK-15 (Gerät gegen
 * Messstellenbetreiber je Zählrichtung); die Wirkung in € ist die Änderung der MP-18-Fixture (Vorschau → endgültig).
 * Die Zahlen der Ampel rechnet `MsbAbgleichApiTest` gegen die Datenbank nach.
 *
 * `?flaeche=monat` (Verlauf › Erlöse) · `?flaeche=messstelle` (Messstelle MS-15 mit Tabelle und Import).
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seiten kennen die Bühne nicht.
 */
interface Fixture {
  id: string;
  money: SiteEarnings;
}
const fall = (FIXTURES as unknown as { fixtures: Fixture[] }).fixtures.find((f) => f.id === 'dv-monat')!;
const FX = MISPEL as unknown as Record<string, unknown>;
const params = new URLSearchParams(window.location.search);
const ZP = 'DE0003374000000000000000001234589';

const zaehler = (groesse: string, rolle: string, richtung: string, ms: string, geraet: number, msb: number, ampel: 'gruen' | 'gelb' | 'rot') => ({
  groesse, rolle, richtung, messstelleId: ms, messstelle: ms, zaehlpunkt: ZP, messstellenbetreiber: 'Stadtwerke Ahrenberg',
  abgleich: { geraetKwh: geraet, msbKwh: msb, unterschiedKwh: geraet - msb,
    abweichungProzent: Math.round(((geraet - msb) / msb) * 1000) / 10, ampel, grund: null },
});
const nov11 = (FX['monat-2026-11'] as MispelMonat).teile[0];
const WIRKUNG: Wirkung = {
  schluessel: '2026-11', vorherFassung: 1, vorherWertequelle: 'geraet',
  farben: [
    { farbe: 'gruen', formel: '(26)', begriff: 'Strommenge grün', vorherKwh: 1371.2, nachherKwh: 1388.8 },
    { farbe: 'gelb', formel: '(31)', begriff: 'Strommenge gelb', vorherKwh: 1120.5, nachherKwh: 1114.931 },
    { farbe: 'rot', formel: '(16)', begriff: 'Strommenge rot', vorherKwh: 815.9, nachherKwh: 805.069 },
  ],
  saldierungVorherEur: nov11.aenderung?.vorherSummeEur ?? null,
  saldierungNachherEur: (nov11.aenderung?.vorherSummeEur ?? 0) + (nov11.aenderung?.differenzEur ?? 0),
  differenzEur: nov11.aenderung?.differenzEur ?? null,
};
const SCHWELLEN = { gruenBisProzent: 2, gelbBisProzent: 5 };
const NOV: AbgleichMonat = {
  monat: '2026-11',
  zaehler: [
    zaehler('Z1NB', 'Z1', 'Bezug', 'ms-01', 31180, 31500, 'gruen'),
    zaehler('Z1NE', 'Z1', 'Einspeisung', 'ms-02', 26410, 26300, 'gruen'),
    zaehler('Z2V', 'Z2', 'Laden', 'ms-14', 9950, 9800, 'gruen'),
    zaehler('Z2E', 'Z2', 'Entladen', 'ms-15', 9120, 8820, 'gelb'),
  ],
  groessteAbweichung: 'Z2E',
  wirkung: WIRKUNG,
  schwellen: SCHWELLEN,
};
const MS15: MessstelleAbgleich = {
  messstelleId: 'ms-15', messstelle: 'MS-15', rolle: 'Z2', festlegungsgroesse: 'Z2E', richtung: 'abgabe', zaehlpunkt: ZP,
  messstellenbetreiber: 'Stadtwerke Ahrenberg', wertequelle: 'messstellenbetreiber', anlage: 'simulator-anlage',
  monate: [
    { monat: '2026-12', zaehlpunkt: ZP, abgleich: { geraetKwh: 2340, msbKwh: null, unterschiedKwh: null, abweichungProzent: null, ampel: 'grau', grund: 'keine_msb_werte' }, wirkung: null },
    { monat: '2026-11', zaehlpunkt: ZP, abgleich: NOV.zaehler[3].abgleich, wirkung: WIRKUNG },
    { monat: '2026-10', zaehlpunkt: ZP, abgleich: { geraetKwh: 8710, msbKwh: 8695, unterschiedKwh: null, abweichungProzent: null, ampel: 'grau', grund: 'luecke' }, wirkung: null },
  ],
  importe: [{ id: 'i1', dateiname: 'msb-2026-11-z2.csv', viertelstunden: 5760, ersetzt: 0, von: '2026-10-31T23:00:00Z', bis: '2026-11-30T23:00:00Z', importiertAm: '2026-12-08T09:12:00Z', importiertVon: 'Mara Test' }],
  schwellen: SCHWELLEN,
};
const eingelesen: unknown[] = [];
(window as unknown as { __eingelesen: unknown[] }).__eingelesen = eingelesen;

api.siteEarnings = (async () => ({ ...fall.money, series: [] }) as unknown as SiteEarnings) as typeof api.siteEarnings;
api.history = (async () =>
  ({ range: 'month', from: fall.money.from, to: fall.money.to, bucketMinutes: 15, buckets: [], protocol: [], plan: [], totals: {} }) as unknown as History) as typeof api.history;
api.mispelMonat = (async (_s: string, monat: string) => FX[`monat-${monat}`] as MispelMonat) as typeof api.mispelMonat;
abgleichApi.monat = (async () => NOV) as typeof abgleichApi.monat;
abgleichApi.messstelle = (async () => MS15) as typeof abgleichApi.messstelle;
abgleichApi.einlesen = (async (_id: string, f: File) => {
  eingelesen.push(f.name);
  return { importDatei: { ...MS15.importe[0], dateiname: f.name, viertelstunden: 5952 }, neu: true, zaehlpunkte: [ZP], richtungen: ['bezug', 'abgabe'] };
}) as typeof abgleichApi.einlesen;

const SITE: Site = {
  id: 'simulator-anlage',
  name: 'Simulator-Anlage',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 6.85,
  tarifArt: fall.money.tarifArt,
  tarifParamCtKwh: fall.money.tarifParamCtKwh ?? null,
  netzladenErlaubt: true,
  maxFeedInKw: null,
} as Site;

// Eine Person mit „Messstelle bearbeiten“ — nur sie sieht den Import.
setSelbstauskunft({ zustand: 'aktiv', konto: 'benutzer', zugang: 'konto', rollen: ['energiemanager'],
  unternehmen_rechte: ['messstelle.ansehen', 'messstelle.bearbeiten'], standorte: [] } as unknown as Selbstauskunft);

const flaeche = params.get('flaeche') ?? 'monat';
if (flaeche === 'monat') window.location.hash = `#/anlage/${SITE.id}/erloese?z=monat&at=2026-11-15`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
      <main className="vp-main" data-buehne="msb-abgleich" style={{ padding: '16px', minWidth: 0 }}>
        {flaeche === 'monat' ? (
          <ErloeseSection site={SITE} />
        ) : (
            <div className="vp-mss">
              <header className="vp-mss-kopf"><div className="vp-mss-kopf-text"><span className="vp-mss-kz">MS-15</span><h1>Speicher Entladen</h1><p>Strom · Wirkenergie · Abgabe · Zählerstand · aktiv</p></div></header>
              <MsbAbgleichKarte messstelleId="ms-15" />
            </div>
        )}
      </main>
    </div>
  </React.StrictMode>,
);

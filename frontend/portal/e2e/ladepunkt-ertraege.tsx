import './rollen-fixture';
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

import { api, type History, type Site, type SiteEarnings } from '../src/api';
import FIXTURES from '../src/erloeseFixtures.json';
import MISPEL from './mispel-mengen-fixtures.json';
import LADEPUNKT from './ladepunkt-ertraege-fixtures.json';
import type { MispelJahr, MispelMonat } from '../src/mispelMengen';
import type { LadepunktAnsicht, LadepunktErtraege } from '../src/ladepunktErtraege';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { LadepunktFaehigkeitDialog } from '../src/components/LadepunktFaehigkeitDialog';

/**
 * **Bühne „Ladepunkt · Erträge im Monat“** (MiSpeL MP-41a, BK-41) — die echte `ErloeseSection` der Simulator-Anlage aus
 * der MP-18-Bühne mit der MiSpeL-Karte (Fixture `mispel-mengen-fixtures.json`) und darunter der Karte des
 * bidirektionalen Ladepunkts (Haus Albers aus BK-41, Formelsatz A2). `?messlatte=mit|ohne` wählt die Antwort mit bzw.
 * ohne den Vergleich „das Auto lädt nur“ (die Messlatte liefert MP-33d; heute antwortet die Route „ohne“).
 * `?ansicht=aufbau` zeigt stattdessen den echten Dialog „Was kann dieser Ladepunkt?“ aus Anlage › Aufbau (V2H + V2G).
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seite kennt die Bühne nicht.
 */
interface Fixture {
  id: string;
  money: SiteEarnings;
}
const fall = (FIXTURES as unknown as { fixtures: Fixture[] }).fixtures.find((f) => f.id === 'dv-monat')!;
const FX = MISPEL as unknown as Record<string, unknown>;
const LP = LADEPUNKT as unknown as Record<string, unknown>;
const params = new URLSearchParams(window.location.search);
const gesendet: unknown[] = [];
(window as unknown as { __gesendet: unknown[] }).__gesendet = gesendet;

api.siteEarnings = (async () => ({ ...fall.money, series: [] }) as unknown as SiteEarnings) as typeof api.siteEarnings;
api.history = (async () =>
  ({ range: 'month', from: fall.money.from, to: fall.money.to, bucketMinutes: 15, buckets: [], protocol: [], plan: [], totals: {} }) as unknown as History) as typeof api.history;
api.mispelMonat = (async (_s: string, monat: string) => FX[`monat-${monat}`] as MispelMonat) as typeof api.mispelMonat;
api.mispelJahr = (async () => FX['jahr-2026'] as MispelJahr) as typeof api.mispelJahr;
api.mispelNachweis = (async () => undefined) as typeof api.mispelNachweis;
api.ladepunktErtraege = (async () =>
  LP[params.get('messlatte') === 'mit' ? 'ertrag-mit' : 'ertrag-ohne'] as LadepunktErtraege) as typeof api.ladepunktErtraege;
api.ladepunktFaehigkeitSetzen = (async (...args: unknown[]) => {
  gesendet.push(args);
  return LP['ladepunkt-v2h-v2g'] as LadepunktAnsicht;
}) as typeof api.ladepunktFaehigkeitSetzen;

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

const aufbau = params.get('ansicht') === 'aufbau';
if (!aufbau) window.location.hash = `#/anlage/${SITE.id}/erloese?z=monat&at=2026-11-15`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
      <main className="vp-main" data-buehne="ladepunkt-ertraege" style={{ padding: '16px', minWidth: 0 }}>
        {aufbau ? (
          <LadepunktFaehigkeitDialog
            siteId={SITE.id}
            ladepunkt={LP['ladepunkt-v2h-v2g'] as LadepunktAnsicht}
            heute="2026-11-15"
            onClose={() => {}}
            onGespeichert={() => {}}
          />
        ) : (
          <ErloeseSection site={SITE} />
        )}
      </main>
    </div>
  </React.StrictMode>,
);

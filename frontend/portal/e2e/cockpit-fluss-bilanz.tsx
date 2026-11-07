/**
 * Prüfbühne „Der Fluss geht auf“ (`flussBilanz`): das Cockpit der fiktiven Anlage „Hof Erlenbach“ mit dem
 * Aufbau und den Zahlen von Schramm „Zuhause“ am 07.11.2026, 14:20 (`src/test/flussBilanzFixtures.ts`).
 *
 * Aufruf: `/e2e/cockpit-fluss-bilanz.html?fall=zuordnung` (die PV-Zuordnung nennt nur den PIKO),
 * `?fall=veraltet` (ein KACO meldet sich nicht), `?fall=teilverbrauch` (ein zugeordneter Teilverbrauch).
 */
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { CockpitHero } from '../src/components/CockpitHero';
import { EB_SITE_NAME, EB_STAND, ebStand, type EbFall } from '../src/test/flussBilanzFixtures';
import { verbrauchKomposition } from '../src/verbrauchKomposition';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

const FAELLE: Record<string, EbFall> = {
  zuordnung: {},
  veraltet: { veraltet: ['eb-kaco-west'] },
  teilverbrauch: { teilverbrauch: true },
};
const fall = FAELLE[new URLSearchParams(location.search).get('fall') ?? 'zuordnung'] ?? {};
const s = ebStand(fall);
// „Verbrauch im Detail“ wie im Cockpit: UV Halle, UV Keller und der übrige Haushalt aus dem Haus der Box.
const verbrauch = verbrauchKomposition({ topology: s.topology, chargers: [], ladenKachelSichtbar: false, profil: 'privat' });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 1120, margin: '0 auto', padding: 16 }}>
    <h1>{EB_SITE_NAME}</h1>
    <CockpitHero
      topology={s.topology}
      snapshot={s.snapshot}
      sources={s.sources}
      pins={s.pins}
      pvRollen={s.pvRollen}
      verbrauchRollen={s.verbrauchRollen}
      onOpenSub={() => {}}
      showRail={false}
      buehne={{
        betrieb: 'eigenverbrauch',
        tag: null,
        zielKw: null,
        verbrauch,
        planKind: 'eigenverbrauch',
        isPhone: innerWidth < 700,
        now: new Date(EB_STAND),
      }}
    />
  </main>,
);

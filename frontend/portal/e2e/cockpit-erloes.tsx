import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/SteuerungFormel.css';

import { Card } from '../designsystem/components/core/Card';
import type { SiteEarnings } from '../src/api';
import { MobileMoneyCard } from '../src/components/CockpitBlocks';
import { CockpitErgebnis } from '../src/components/erloese/CockpitErgebnis';
import type { CockpitHeroView, HeroRing } from '../src/cockpitWidgets';
import { signedEuro } from '../src/erloesKomposition';
import FIXTURES from '../src/erloeseFixtures.json';
import { speicherAussage } from '../src/speicherAussage';

/**
 * **Die Fixture-Harness der Cockpit-Erlöskarte** (Paket P5, Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.7 + §3.10 (7)).
 *
 * Sie rendert GENAU das Bauteil, das Telefon und Bühne tragen, mit den Zahlen
 * des Mockups (`rvC-375-cockpit.png`, Fixture `dv-tag-laufend`) — damit ist
 * der Browser-Beweis bei 375 und 1440 ohne Docker, ohne Anmeldung und ohne
 * Simulator zu fahren: `npm run dev` und `/e2e/cockpit-erloes.html`.
 *
 * Kein Produktiv-Pfad — nichts hier importiert das Cockpit, und das Cockpit
 * importiert nichts hiervon.
 */

interface Fixture {
  id: string;
  now: string;
  savedSpeicherEur: number | null;
  money: SiteEarnings;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];

const RINGE: HeroRing[] = [
  { id: 'autarkie', label: 'Autarkie · Heute', pct: 82, valueText: '82 %', hue: 'var(--vp-flow-pv)' },
  {
    id: 'eigenverbrauch',
    label: 'Eigenverbrauch · Heute',
    pct: 21,
    valueText: '21 %',
    hue: 'var(--vp-flow-batt)',
  },
];

/** Das Zeitraum-Segment in der Form, die das Cockpit rendert (`PeriodTabs variant="seg"`). */
function Segment() {
  return (
    <div className="vp-seg vp-seg-compact" role="tablist" aria-label="Zeitraum">
      {['Heute', 'Monat', 'Jahr', 'Gesamt'].map((t, i) => (
        <button key={t} type="button" role="tab" aria-selected={i === 0} className={i === 0 ? 'active' : ''}>
          {t}
        </button>
      ))}
    </div>
  );
}

function view(id: string): CockpitHeroView {
  const f = FX.find((x) => x.id === id)!;
  const stur = f.savedSpeicherEur;
  const money: SiteEarnings = {
    ...f.money,
    savedSpeicherEur: stur,
    savedSteuerungEur: stur == null || f.money.savedEur == null ? null : f.money.savedEur - stur,
    steuerungSplitReason: stur == null ? 'no_battery_data' : null,
  };
  const speicher = speicherAussage(money, { now: new Date(f.now) });
  const netto = 63.23;
  return {
    rings: RINGE,
    ringsNote: null,
    planSentence: null,
    money: {
      label: 'Unterm Strich · Heute',
      value: signedEuro(netto),
      kosten: netto < 0,
      speicher: speicher?.hatAussage ? speicher : null,
      attribution: speicher?.kurz ?? null,
      // Der Aufklapper „Wie wird das berechnet?" — im echten Cockpit hängt er
      // an derselben Stelle, also gehört er in die Messung.
      formel: {
        tarifArt: money.tarifArt ?? null,
        tarifParamCtKwh: money.tarifParamCtKwh ?? null,
        tarifPriced: money.tarifPriced ?? null,
        exportVerguetungPriced: money.exportVerguetungPriced ?? null,
        bezugspreisCtKwh: money.bezugspreisCtKwh ?? null,
        plantKind: money.plantKind ?? null,
        marktpraemieEur: money.marktpraemieEur ?? null,
        anzulegenderWertCtKwh: money.anzulegenderWertCtKwh ?? null,
        marketValueSolarCtKwh: money.marketValueSolarCtKwh ?? null,
        bestandSichtbar: true,
        savedEur: money.savedEur ?? null,
        savedSpeicherEur: money.savedSpeicherEur ?? null,
        savedSteuerungEur: money.savedSteuerungEur ?? null,
      },
    },
  };
}

const V = view('dv-tag-laufend');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 12, maxWidth: 1160, margin: '0 auto', minWidth: 0 }}>
    {/* Telefon: die EINE Geld-Karte unter dem Fluss. */}
    <div data-frame="cockpit-telefon" style={{ maxWidth: 375, minWidth: 0 }}>
      <MobileMoneyCard view={V} periodSeg={<Segment />} nachtragHref="#/anlage/demo/technik" />
    </div>

    {/* Schreibtisch: derselbe Block, in der Breite der Bilanz-Leiste. */}
    <div style={{ height: 24 }} />
    <div data-frame="cockpit-leiste" style={{ maxWidth: 360, minWidth: 0 }}>
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <CockpitErgebnis
          money={V.money!}
          periodSeg={<Segment />}
          rings={V.rings}
          ringsNote={V.ringsNote}
          nachtragHref="#/anlage/demo/technik"
        />
      </Card>
    </div>
  </div>,
);

/**
 * Beweis-Harness für **Bewegungs-Programm P3** (Konzept
 * `data/vp-motion-konzept-m1/report.md` §5 Zeilen E–H, §6 „Zahlenwechsel").
 *
 * ⚠ SIE EXISTIERT, WEIL DIE DEMO-ANLAGEN KEINEN ENERGIEFLUSS ZEIGEN. Der
 *   Konzept-Bericht hat das gemessen (§2.2: „mit Demo-Daten leer, 0
 *   `.vp-flow-line`") — der Signaturmoment Nr. 1 wäre am laufenden Portal
 *   also gar nicht zu beweisen. Hier stehen drei Lastfälle nebeneinander und
 *   ein Knopf springt von 2 auf 8 kW.
 *
 * ⚠ SIE IST WEGWERF. Kein Test hängt an ihr, kein Bündel enthält sie (sie
 *   liegt in `e2e/`, das der Bau nicht einliest); sie fälscht `api.prices`,
 *   damit die Preisleiste ohne Backend rendert.
 *
 * Was sie zeigt, in dieser Reihenfolge:
 *   1 Energiefluss × 3 Lastfälle (PV-Überschuss 8 kW · Bezug 2 kW · Nacht 0)
 *   2 Energiefluss mit dem Sprung 2 → 8 kW (Tempo gleitet)
 *   3 Hero-Ringe mit Wertwechsel
 *   4 Mini-Flächen (Balken · Linie · Anteil)
 *   5 Preisleiste
 *   6 Fahrplan-Zeile (dieselben Mini-Balken, 24 Stunden)
 */
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
import '../src/components/MiniChart.css';
import '../src/components/StrompreisStrip.css';
import '../src/components/erloese/ErgebnisKarte.css';

import { api, type PriceSeries } from '../src/api';
import { EnergyFlow } from '../src/components/EnergyFlow';
import { ErgebnisRing } from '../src/components/erloese/CockpitErgebnis';
import { MiniBarSpark, MiniLineSpark, MiniShareBar } from '../src/components/MiniChart';
import { StrompreisStrip } from '../src/components/StrompreisStrip';
import { SwapNumber } from '../src/components/SwapNumber';
import type { LiveSnapshot } from '../src/live';
import type { MiniPoint } from '../src/miniChart';

/* --- Lastfälle ----------------------------------------------------------- */

/** PV-Überschuss: 8 kW Sonne, 1,4 kW Haus, Rest lädt und speist ein. */
const SONNE: LiveSnapshot = {
  pvKw: 8,
  loadKw: 1.4,
  gridKw: -3.6,
  battKw: 3,
  socPct: 64,
  socAt: null,
};
/** Bezug: kein PV, 2 kW Haus, alles aus dem Netz. */
const BEZUG: LiveSnapshot = {
  pvKw: 0,
  loadKw: 2,
  gridKw: 2,
  battKw: 0,
  socPct: 41,
  socAt: null,
};
/** Nacht: alles unter dem Totband — es darf sich NICHTS bewegen. */
const NACHT: LiveSnapshot = {
  pvKw: 0,
  loadKw: 0,
  gridKw: 0,
  battKw: 0,
  socPct: 18,
  socAt: null,
};

/** Der Sprung: dieselbe Anlage, nur mehr Leistung. */
const SPRUNG_KLEIN: LiveSnapshot = { ...BEZUG, loadKw: 2, gridKw: 2 };
const SPRUNG_GROSS: LiveSnapshot = { ...BEZUG, loadKw: 8, gridKw: 8 };

/* --- Preisleiste: gefälschte Reihe --------------------------------------- */

function preisReihe(): PriceSeries {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const points = Array.from({ length: 96 }, (_, i) => {
    const ts = new Date(start.getTime() + i * 15 * 60000);
    const end = new Date(ts.getTime() + 15 * 60000);
    // Eine Tagesform mit Mittagstal und Abendspitze — und ein echtes Loch.
    const h = i / 4;
    const v = 120 + 90 * Math.sin(((h - 6) / 24) * 2 * Math.PI) - 70 * Math.exp(-((h - 13) ** 2) / 6);
    return {
      ts: ts.toISOString(),
      end: end.toISOString(),
      priceEurMwh: i === 40 || i === 41 ? null : Math.round(v * 10) / 10,
    };
  });
  return { biddingZone: 'DE-LU', resolution: 'PT15M', points } as PriceSeries;
}

api.prices = (async () => preisReihe()) as unknown as typeof api.prices;

/* --- Mini-Daten ---------------------------------------------------------- */

function balken(seed: number): MiniPoint[] {
  return Array.from({ length: 24 }, (_, i) => ({
    key: `h${i}`,
    label: `${i} Uhr`,
    value: Math.round((Math.sin((i + seed) / 3) * 6 + Math.cos(i / 5 + seed) * 3) * 10) / 10,
  }));
}

/* --- Die Seite ----------------------------------------------------------- */

function Zeile({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section style={{ margin: '0 0 var(--vp-space-6)' }}>
      <h2 style={{ font: 'var(--vp-text-h4)', margin: '0 0 var(--vp-space-3)' }}>{titel}</h2>
      {children}
    </section>
  );
}

function Harness() {
  const [gross, setGross] = React.useState(false);
  const [ringHoch, setRingHoch] = React.useState(false);
  const [seed, setSeed] = React.useState(0);

  const ring = (id: 'autarkie' | 'eigenverbrauch', pct: number) => ({
    id,
    label: id === 'autarkie' ? 'Autarkie' : 'Eigenverbrauch',
    pct,
    valueText: `${pct} %`,
    hue: id === 'autarkie' ? 'var(--vp-flow-pv)' : 'var(--vp-flow-batt)',
  });

  return (
    <main
      style={{
        padding: 'var(--vp-space-3)',
        maxWidth: 1200,
        margin: '0 auto',
        background: 'var(--vp-bg)',
      }}
    >
      <h1 style={{ font: 'var(--vp-text-h3)' }}>Bewegung · P3 — Beweis</h1>

      <Zeile titel="1 · Energiefluss, drei Lastfälle">
        <div style={{ display: 'flex', gap: 'var(--vp-space-4)', flexWrap: 'wrap' }}>
          <div data-fall="sonne" style={{ width: 320, maxWidth: '100%' }}>
            <EnergyFlow snapshot={SONNE} />
            <p className="vp-note">PV-Überschuss 8 kW</p>
          </div>
          <div data-fall="bezug" style={{ width: 320, maxWidth: '100%' }}>
            <EnergyFlow snapshot={BEZUG} />
            <p className="vp-note">Bezug 2 kW</p>
          </div>
          <div data-fall="nacht" style={{ width: 320, maxWidth: '100%' }}>
            <EnergyFlow snapshot={NACHT} />
            <p className="vp-note">Nacht 0 kW — nichts bewegt sich</p>
          </div>
        </div>
      </Zeile>

      <Zeile titel="2 · Der Sprung 2 → 8 kW (Tempo gleitet)">
        <button type="button" id="sprung" onClick={() => setGross((v) => !v)}>
          {gross ? 'zurück auf 2 kW' : 'auf 8 kW'}
        </button>
        <div data-fall="sprung" style={{ width: 360, maxWidth: '100%', marginTop: 'var(--vp-space-3)' }}>
          <EnergyFlow snapshot={gross ? SPRUNG_GROSS : SPRUNG_KLEIN} />
        </div>
      </Zeile>

      <Zeile titel="3 · Hero-Ringe + Zahlenwechsel">
        <button type="button" id="ring-wechsel" onClick={() => setRingHoch((v) => !v)}>
          Wert wechseln
        </button>
        <div
          data-fall="ringe"
          style={{
            display: 'flex',
            gap: 'var(--vp-space-5)',
            marginTop: 'var(--vp-space-3)',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <ErgebnisRing ring={ring('autarkie', ringHoch ? 82 : 37)} />
          <ErgebnisRing ring={ring('eigenverbrauch', ringHoch ? 64 : 21)} />
          <p style={{ font: 'var(--vp-text-h2)', margin: 0 }} id="swap-hero">
            <SwapNumber value={ringHoch ? '301,46 €' : '27,04 €'} />
          </p>
        </div>
      </Zeile>

      <Zeile titel="4 · Mini-Flächen">
        <button type="button" id="mini-wechsel" onClick={() => setSeed((s) => s + 1)}>
          Daten wechseln
        </button>
        <div
          data-fall="minis"
          style={{
            display: 'grid',
            gap: 'var(--vp-space-4)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            marginTop: 'var(--vp-space-3)',
          }}
        >
          <MiniBarSpark points={balken(seed)} ariaLabel="Balken" />
          <MiniLineSpark points={balken(seed + 1)} ariaLabel="Linie" />
          <MiniShareBar
            segments={[
              { key: 'a', weight: 3 + seed, color: 'var(--vp-flow-pv)' },
              { key: 'b', weight: 2, color: 'var(--vp-flow-batt)' },
              { key: 'c', weight: 1, color: 'var(--vp-flow-grid)' },
            ]}
            ariaLabel="Anteil"
          />
        </div>
      </Zeile>

      <Zeile titel="5 · Preisleiste">
        <div data-fall="preis" style={{ maxWidth: 640 }}>
          <StrompreisStrip
            siteId="harness"
            isDv={false}
            tarifArt="dynamisch"
            kind="eigenverbrauch"
            slots={[]}
            slotMinutes={15}
            activeSlot={null}
            onOpenMarktpreise={() => {}}
          />
        </div>
      </Zeile>

      <Zeile titel="6 · Fahrplan-Zeile (24 Stunden)">
        <div data-fall="fahrplan" style={{ maxWidth: 640 }}>
          <MiniBarSpark points={balken(seed + 2)} size="streifen" ariaLabel="Fahrplan-Zeile" />
        </div>
      </Zeile>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);

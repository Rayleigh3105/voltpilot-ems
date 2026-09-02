/**
 * FIXTURE-HARNESS für den Browser-Beweis des Speicher-Blocks (Erlöse-Konzept
 * `vp-erloese-seite-konzept-e2` §5, Beweis-Pflicht 3). Kein Teil der App:
 * `tsconfig.json` schließt alles außerhalb von `src/` aus, `vite build`
 * bündelt nur `index.html`.
 *
 * Sie rendert die Lagen aus §3.5 nebeneinander, damit die Messung
 * (`scrollWidth === innerWidth` bei 375/768/1440) alle Zustände in EINEM
 * Durchgang trifft — es braucht dafür weder Backend noch Simulator.
 */
import ReactDOM from 'react-dom/client';

import '../../designsystem/tokens/fonts.css';
import '../../designsystem/tokens/colors.css';
import '../../designsystem/tokens/typography.css';
import '../../designsystem/tokens/spacing.css';
import '../../designsystem/tokens/effects.css';
import '../../designsystem/components/core/core.css';
import '../../src/index.css';

import { SpeicherBlock } from '../../src/components/SpeicherBlock';
import { SteuerungFormel } from '../../src/components/SteuerungFormel';
import { speicherAussage, type SpeicherEingabe } from '../../src/speicherAussage';

const NOW = new Date('2026-09-01T12:00:00Z');

const FAELLE: { titel: string; money: SpeicherEingabe; geplantEur?: number }[] = [
  {
    titel: 'abgeschlossen · beide positiv',
    money: {
      savedEur: 12.4,
      savedSpeicherEur: 9.3,
      savedSteuerungEur: 3.1,
      range: 'day',
      to: '2026-08-31T22:00:00Z',
    },
    geplantEur: 9.4,
  },
  {
    titel: 'laufend · gesamt unter Null (der Screenshot-Fall)',
    money: {
      savedEur: -2.67,
      savedSpeicherEur: -4.12,
      savedSteuerungEur: 1.45,
      range: 'day',
      to: '2026-09-01T22:00:00Z',
      speicherDeltaKwh: 35.8,
      speicherWertCtKwh: 24.8,
      speicherWertEur: 8.87,
      speicherWertBasis: 'plan',
    },
  },
  {
    titel: 'abgeschlossen · Steuerung liegt hinten',
    money: {
      savedEur: 9.0,
      savedSpeicherEur: 9.3,
      savedSteuerungEur: -0.3,
      range: 'month',
      to: '2026-08-31T22:00:00Z',
    },
  },
  {
    titel: 'abgeschlossen · unter Null',
    money: { savedEur: -0.4, range: 'day', to: '2026-08-31T22:00:00Z' },
  },
  {
    titel: 'ohne Batterie-Stammdaten (kein Split)',
    money: {
      savedEur: 12.4,
      steuerungSplitReason: 'no_battery_data',
      range: 'month',
      to: '2026-08-31T22:00:00Z',
    },
  },
  {
    titel: 'gleichauf · sehr lange Zahlen',
    money: {
      savedEur: 1234.56,
      savedSpeicherEur: 1234.56,
      savedSteuerungEur: 0,
      range: 'all',
      to: '2026-08-31T22:00:00Z',
    },
  },
];

function Harness() {
  return (
    <div style={{ maxWidth: 1160, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: '1.1rem' }}>Speicher-Block · Fixture-Harness</h1>
      {FAELLE.map((f) => {
        const a = speicherAussage(f.money, { now: NOW, geplantEur: f.geplantEur ?? null });
        return (
          <section key={f.titel} style={{ margin: '16px 0' }}>
            <h2 style={{ fontSize: '0.8rem', color: '#6c757d', margin: 0 }}>{f.titel}</h2>
            {a && (
              <SpeicherBlock aussage={a} nachtragHref="#/anlage/s-1/technik">
                <SteuerungFormel
                  input={{
                    tarifArt: 'fest',
                    tarifParamCtKwh: 30,
                    savedEur: f.money.savedEur ?? null,
                    savedSpeicherEur: f.money.savedSpeicherEur ?? null,
                    savedSteuerungEur: f.money.savedSteuerungEur ?? null,
                  }}
                />
              </SpeicherBlock>
            )}
          </section>
        );
      })}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);

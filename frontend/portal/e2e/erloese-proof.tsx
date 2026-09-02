import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/Historie.css';
import '../src/components/Erloese.css';
import '../src/components/SteuerungFormel.css';

import { Card } from '../designsystem/components/core/Card';
import { KartenKopf } from '../src/components/HistorieWelt';
import type { SiteEarnings } from '../src/api';
import FIXTURES from '../src/erloeseFixtures.json';
import { ebene1, ebene2, speicherSchritte } from '../src/erloesEbenen';
import { ergebnisZeilen } from '../src/erloesZeilen';
import { ErgebnisZeilen } from '../src/components/ErgebnisZeilen';
import { Ebene1Panel, Ebene2Panel } from '../src/components/ErloesEbenen';
import { SpeicherSchritte } from '../src/components/SteuerungFormel';
import { SpeicherBlock } from '../src/components/SpeicherBlock';
import { speicherAussage } from '../src/speicherAussage';

/**
 * **Die Fixture-Harness des Browser-Beweises** (Konzept
 * `vp-erloese-seite-konzept-e2` §5, Beweis-Pflicht der Pakete P3/P4).
 *
 * Sie rendert die neue Ergebnis-Karte in ALLEN 15 Zuständen des Konzepts mit
 * genau den Zahlen, aus denen die abgenommenen Mockups entstanden sind
 * (`src/erloeseFixtures.json` = die eingefrorene `derived.json`). Damit ist der
 * Beweis bei 375/768/1440 ohne Docker, ohne Simulator und ohne Anmeldung zu
 * fahren: `npm run dev` und `/e2e/erloese-proof.html`.
 *
 * Kein Produktiv-Pfad — nichts hier importiert die Seite, und die Seite
 * importiert nichts hiervon.
 */

interface Fixture {
  id: string;
  titel: string;
  range: 'day' | 'week' | 'month' | 'year';
  label: string;
  laeuft: boolean;
  now: string;
  savedSpeicherEur: number | null;
  geplantEur: number | null;
  money: SiteEarnings;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];

/** Die Wortzählung des Konzepts (§3.12): ein Wort trägt Buchstabe oder Ziffer. */
function woerter(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-zÄÖÜäöüß0-9]/.test(w)).length;
}

/** Ebene 0 EINER Fixture — inklusive der Wortzahl, die §3.12 begrenzt. */
function ebene0Woerter(f: Fixture): number {
  const view = ergebnisZeilen({
    money: f.money,
    periodLabel: f.label,
    laeuft: f.laeuft,
    range: f.range,
  });
  const teile = [
    'Ergebnis',
    'Bewertet',
    view.hero?.text ?? '',
    view.satz,
    ...view.zeilen.flatMap((z) => [z.name, z.text, z.chip?.text ?? '']),
    'Preise & Vergütung',
  ];
  return woerter(teile.join(' '));
}

function Karte({ f }: { f: Fixture }) {
  const view = ergebnisZeilen({
    money: f.money,
    periodLabel: f.label,
    laeuft: f.laeuft,
    range: f.range,
  });
  // Die Aufteilung (#591) liegt in den Fixtures NEBEN der Kassen-Antwort; der
  // echte Endpunkt liefert sie IN ihr. Hier wird sie deshalb eingesetzt - so
  // fährt die Harness genau die Daten, die die Seite bekommt.
  const stur = f.savedSpeicherEur;
  const steuerung = stur == null || f.money.savedEur == null ? null : f.money.savedEur - stur;
  const money: SiteEarnings = {
    ...f.money,
    savedSpeicherEur: stur,
    savedSteuerungEur: steuerung,
    steuerungSplitReason: stur == null ? 'no_battery_data' : null,
  };
  const schritteInput = {
    money,
    sturEur: stur,
    steuerungEur: steuerung,
    geplantEur: f.geplantEur,
  };
  const schritte = speicherSchritte(schritteInput);
  // Der ECHTE Speicher-Block (P1+P5) an der Einbaustelle der Karte - Props sind
  // wörtlich das Ergebnis von `speicherAussage()`, wie auf der Seite.
  const speicher = speicherAussage(money, { now: new Date(f.now) });
  return (
    <section className="vp-section" data-fixture={f.id} style={{ marginBottom: 20 }}>
      <p
        style={{
          margin: '0 0 6px',
          fontSize: '0.72rem',
          fontWeight: 700,
          color: '#718096',
          overflowWrap: 'anywhere',
        }}
      >
        {f.titel}
        <span data-woerter={ebene0Woerter(f)} style={{ marginLeft: 8 }}>
          · Ebene 0: {ebene0Woerter(f)} Wörter
        </span>
      </p>
      <Card padding="lg" radius="lg">
        <KartenKopf icon="euro" category="primary" titel={`Ergebnis · ${f.label}`} art="bewertet" />
        <ErgebnisZeilen
          view={view}
          ebene1={(id) => {
            const e1 = ebene1(f.money, view, id);
            return e1 ? <Ebene1Panel ebene1={e1} /> : null;
          }}
          ebene2={<Ebene2Panel ebene2={ebene2({ money: f.money })} />}
          speicher={
            speicher && speicher.hatAussage ? (
              <SpeicherBlock aussage={speicher} nachtragHref="#/anlage/demo/technik">
                {schritte.length > 0 && <SpeicherSchritte input={schritteInput} />}
              </SpeicherBlock>
            ) : null
          }
        />
      </Card>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 12, maxWidth: 1160, margin: '0 auto', minWidth: 0 }}>
    {FX.map((f) => (
      <Karte key={f.id} f={f} />
    ))}
  </div>,
);

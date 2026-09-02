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
import { api, type History, type Site } from '../src/api';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { anlageSurface } from '../src/surface';

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

/* ---------------------------------------------------------------------------
 * P6 · die GANZE Seite: vier Karten in der Reihenfolge der Frage-Leiter
 *
 * Konzept §3.1 (E1/E5/E6/E11). Die echte `ErloeseSection` rendert hier gegen
 * die Fixture-Zahlen; `api.siteEarnings`/`api.history` sind auf sie umgebogen,
 * damit der Beweis ohne Docker, ohne Simulator und ohne Anmeldung läuft.
 * ------------------------------------------------------------------------ */

const PROOF_HISTORY: History = {
  range: 'day',
  from: '',
  to: '',
  bucketMinutes: 15,
  buckets: [],
  totals: {
    consumptionKwh: 154.7,
    pvGenerationKwh: 500,
    gridImportKwh: 6.3,
    gridExportKwh: 345.2,
    gridCostEur: 1.59,
    tarifArt: 'fest',
    batterySavingsPlannedEur: 9.4,
    autarkiePct: 0.96,
    eigenverbrauchPct: 0.31,
  },
  protocol: [],
  plan: [],
};

/** Welche Fixture welche Anlage bespielt — eine je Anlagenart (E11). */
const SEITEN = [
  { id: 'dv-tag-laufend', titel: 'Direktvermarktung · laufender Tag' },
  { id: 'eeg-tag-abgeschlossen', titel: 'EEG (feste Vergütung) · abgeschlossener Tag' },
  // Befund B8: ohne hinterlegten Tarif ist der Wert des Eigenverbrauchs in
  // JEDEM Eimer null — er zeichnet nichts und darf deshalb auch nicht in der
  // Legende stehen.
  { id: 'eeg-ohne-tarif', titel: 'EEG ohne Stromtarif · der B8-Fall' },
] as const;

function fixtureOf(id: string): Fixture {
  const f = FX.find((x) => x.id === id);
  if (!f) throw new Error(`Fixture ${id} fehlt`);
  return f;
}

/**
 * Ein Stunden-Raster für den Geld-Verlauf. Die 15 Konzept-Fixtures tragen
 * bewusst KEINE `series` (sie beweisen die Ergebnis-Karte, nicht das Bild) —
 * für den Seiten-Beweis braucht Karte 3 aber Eimer, sonst rendert sie ihren
 * ehrlichen Leer-Zustand und der K1-Satz hätte nichts zu sagen. Die Summe der
 * Eimer trifft das Netto der Fixture, damit die kumulierte Linie stimmt.
 */
function raster(nettoGesamt: number, tagBeginnUtc: string, mitEigenverbrauch = true) {
  const anteile = [0.02, 0.06, 0.12, 0.2, 0.24, 0.2, 0.12, 0.04];
  const t0 = new Date(tagBeginnUtc).getTime();
  return anteile.map((a, i) => {
    const netto = nettoGesamt * a;
    return {
      start: new Date(t0 + (7 + i) * 3600_000).toISOString(),
      einspeiseErloesEur: netto * 0.45,
      eigenverbrauchsWertEur: mitEigenverbrauch ? netto * 0.6 : null,
      stromkostenEur: netto * 0.05,
      nettoEur: netto,
    };
  });
}

// ⚠ Nur in der Harness: die zwei Lesepfade der Seite liefern die Fixture-Zahlen.
//   Die Seite selbst kennt die Harness nicht.
const ECHT_EARNINGS = api.siteEarnings;
api.siteEarnings = (async (siteId: string) => {
  const f = fixtureOf(String(siteId).replace(/^proof-/, ''));
  const stur = f.savedSpeicherEur;
  const steuerung = stur == null || f.money.savedEur == null ? null : f.money.savedEur - stur;
  return {
    ...f.money,
    savedSpeicherEur: stur,
    savedSteuerungEur: steuerung,
    steuerungSplitReason: stur == null ? 'no_battery_data' : null,
    series: raster(f.money.nettoErgebnisEur ?? 0, f.money.from, f.money.eigenverbrauchsWertEur != null),
  };
}) as typeof ECHT_EARNINGS;
api.history = (async () => PROOF_HISTORY) as typeof api.history;

function SeitenBeweis() {
  return (
    <>
      {SEITEN.map(({ id, titel }) => {
        const f = fixtureOf(id);
        const site: Site = {
          id: `proof-${id}`,
          name: titel,
          biddingZone: 'DE-LU',
          latitude: null,
          longitude: null,
          plantKind: f.money.plantKind,
          anzulegenderWertCtKwh: f.money.anzulegenderWertCtKwh ?? null,
          tarifArt: f.money.tarifArt,
          tarifParamCtKwh: f.money.tarifParamCtKwh ?? null,
          netzladenErlaubt: false,
          maxFeedInKw: null,
        };
        return (
          <div key={id} data-seite={id} style={{ marginBottom: 32, minWidth: 0 }}>
            <p style={{ margin: '0 0 6px', fontSize: '0.72rem', fontWeight: 700, color: '#718096' }}>
              P6 · GANZE SEITE — {titel}
            </p>
            <ErloeseSection
              site={site}
              surface={anlageSurface({
                entities: [
                  {
                    id: 'batt',
                    entityType: 'battery-hybrid',
                    capabilities: { measure: [{ channel: 'soc_pct' }] },
                  },
                ],
                config: { plantKind: f.money.plantKind, tarifArt: f.money.tarifArt },
              })}
              onOpenWelt={() => {}}
            />
          </div>
        );
      })}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 12, maxWidth: 1160, margin: '0 auto', minWidth: 0 }}>
    <SeitenBeweis />
    {FX.map((f) => (
      <Karte key={f.id} f={f} />
    ))}
  </div>,
);

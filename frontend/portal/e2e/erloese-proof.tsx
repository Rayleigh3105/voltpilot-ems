import { useEffect } from 'react';
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

import type { SiteEarnings } from '../src/api';
import FIXTURES from '../src/erloeseFixtures.json';
import { ebene1, ebene2, speicherSchritte } from '../src/erloesEbenen';
import { ergebnisZeilen } from '../src/erloesZeilen';
import { ErgebnisZeilen } from '../src/components/ErgebnisZeilen';
import { Ebene1Panel } from '../src/components/ErloesEbenen';
import { SpeicherSchritte } from '../src/components/SteuerungFormel';
import { SpeicherKarte } from '../src/components/erloese/SpeicherKarte';
import { PreiseZeile } from '../src/components/erloese/PreiseZeile';
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

/**
 * **Das Textbudget wird AUS DEM GERENDERTEN HTML gezählt** (§3.12 wörtlich),
 * nicht aus einer nachgebauten Wortliste — sonst zählt der Beweis etwas
 * anderes, als der Kunde liest. P7 hat genau das behoben: die frühere
 * Nachbildung ließ die Zeilen-Werte und den Speicher-Block aus und meldete für
 * JEDE Fixture 23 Wörter, also ein Budget, das nie greifen konnte.
 *
 * Gezählt wird Ebene 0 = die Karte MIT geschlossenen Aufklappern; ein offenes
 * `<details>` gehört zu Ebene 1/2 und hat sein eigenes Budget.
 */
function domWoerter(el: HTMLElement | null): number {
  if (!el) return 0;
  const klon = el.cloneNode(true) as HTMLElement;
  klon.querySelectorAll('details[open]').forEach((d) => d.removeAttribute('open'));
  // `innerText` einer losgelösten Kopie ist leer — deshalb `textContent` der
  // sichtbaren Ebene 0: der Inhalt eines geschlossenen `<details>` steht zwar
  // im DOM, wird aber hier über die `summary`-Grenze abgeschnitten.
  klon.querySelectorAll('details').forEach((d) => {
    const sum = d.querySelector('summary');
    d.replaceChildren(...(sum ? [sum] : []));
  });
  return woerter(klon.textContent ?? '');
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
          color: 'var(--vp-text-gray, #66717C)',
          overflowWrap: 'anywhere',
        }}
      >
        {f.titel}
        <span data-woerter-slot={f.id} style={{ marginLeft: 8 }} />
      </p>
      {/* ⚠ Anatomie C (§3.10): KEINE Karte und kein `KartenKopf` mehr — die
          Fläche besteht aus Statement (rahmenlos) + Kontoauszug + Speicher +
          Preise, jedes mit seinem eigenen Rahmen. Ein Kartenrahmen darum wäre
          „Fläche in der Fläche". */}
      <ErgebnisZeilen
        view={view}
        label={`Ergebnis · ${f.label}`}
        provenienz="bewertet"
        ebene1={(id) => {
          const e1 = ebene1(f.money, view, id);
          return e1 ? <Ebene1Panel ebene1={e1} /> : null;
        }}
        hrefFor={() => '#/anlage/demo/technik'}
        speicher={
          speicher && speicher.hatAussage ? (
            <SpeicherKarte aussage={speicher} nachtragHref="#/anlage/demo/technik">
              {schritte.length > 0 && <SpeicherSchritte input={schritteInput} />}
            </SpeicherKarte>
          ) : null
        }
        preise={<PreiseZeile ebene2={ebene2({ money: f.money })} />}
      />
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
  // P7: zwei Seiten-Formen, die die drei oben NICHT abdecken — ein
  // Nicht-Tages-Zeitraum (Karte „Der Tag im Bild" entfällt, „So verdient Ihre
  // Anlage" trägt den Monatsmarktwert) und eine Anlage ohne Batterie-Stammdaten
  // (der Speicher-Block schrumpft auf Zeile 1 + Nachtrag-Link — genau der
  // Chip, dessen Trefferfläche bei 375 zu klein war).
  { id: 'dv-monat', titel: 'Direktvermarktung · Monat (kein Tagesbild)' },
  { id: 'dv-kein-split', titel: 'Direktvermarktung · keine Batterie-Stammdaten' },
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
            <p style={{ margin: '0 0 6px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--vp-text-gray, #66717C)' }}>
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

/**
 * Stempelt nach dem Rendern je Fixture die GEMESSENE Wortzahl der Ebene 0 an
 * ihren Platzhalter — der Browser-Beweis liest sie über `[data-woerter]`.
 */
/**
 * Das Budget je Anlagenart (Runde 1 §3.12, für Variante C auf die gemessenen
 * Mockup-Zahlen gesetzt — u3 §3.10/§5): 49 Wörter Direktvermarktung, 46 Wörter
 * feste Einspeisevergütung. Es steht HIER, damit der Browser-Beweis die
 * Überschreitung SIEHT statt sie zu verschweigen.
 *
 * ⚠ GEMESSEN (03.09.2026, Variante C): Direktvermarktung höchstens 47 — das
 *   Budget hält. Drei EEG-Sonderzustände liegen mit 49/49/50 darüber, und der
 *   Grund ist eine ENTSCHIEDENE Änderung: E6 = (a) hat die HANDLUNG aus dem
 *   Chip in die Sekundärzeile geholt („kein Stromtarif hinterlegt ·
 *   Stromtarif hinterlegen ›" = 6 Wörter statt „Tarif fehlt ›" = 3), und bei
 *   `eeg-woche` nennt der Wochen-Zeitraum sich zweimal (Label + Satz, beide
 *   vom Konzept wörtlich festgelegt). Die Zahl wird deshalb GEZEIGT statt
 *   gesenkt — eine Kürzung wäre neuer Text, und den setzt das Konzept.
 */
const WORT_BUDGET = { direktvermarktung: 49, eigenverbrauch: 46 } as const;

function budgetFuer(id: string): number {
  const f = FX.find((x) => x.id === id);
  return f?.money.plantKind === 'direktvermarktung'
    ? WORT_BUDGET.direktvermarktung
    : WORT_BUDGET.eigenverbrauch;
}

/**
 * **Das SKALEN-Budget der Ergebnis-Fläche (P7, Konzept §3.10/§4).** Es sind die
 * bei der Abnahme in echtem Chrome bei 1440 / 768 / 375 GEMESSENEN Werte — an
 * allen drei Breiten identisch, weil die Fläche ihre Skala nicht mit der Breite
 * wechselt (nur die Leitzahl springt 48 ↔ 36).
 *
 * ⚠ Es steht HIER und nicht in einem Unit-Test, weil es nur im Browser
 *   messbar ist: eine fünfte Schriftgröße, ein dritter Chip, eine zweite
 *   Fläche oder eine Schrift unter 12 px entstehen aus KASKADIERTEM CSS, das
 *   jsdom nicht rechnet. Der Beweis SIEHT die Überschreitung, statt sie zu
 *   verschweigen — dasselbe Muster wie das Wortbudget darüber.
 *
 * ⚠ `textColors` = 4 plus den WARNTON: `eeg-ohne-tarif` und `eeg-ohne-mastr`
 *   tragen zusätzlich `--vp-c-warn-fg` (#9A3412) und messen deshalb 5. Das ist
 *   die im Konzept vorgesehene Ausnahme, kein Verstoß.
 */
const SKALA_BUDGET = {
  fontSizes: 4,
  textColors: 5,
  backgrounds: 1,
  chips: 3,
  smallestPx: 12,
} as const;

/** Die im Browser gemessene Inventur EINER Fläche — ohne Fremdbibliothek. */
function inventur(root: HTMLElement): {
  fontSizes: number;
  textColors: number;
  backgrounds: number;
  chips: number;
  smallestPx: number;
} {
  const sizes = new Set<string>();
  const colors = new Set<string>();
  const bgs = new Set<string>();
  let chips = 0;
  let smallest = 99;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (w.nextNode()) {
    const el = w.currentNode as HTMLElement;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const bg = cs.backgroundColor;
    if (bg && !/rgba\(0, 0, 0, 0\)/.test(bg) && bg !== 'rgb(255, 255, 255)') bgs.add(bg);
    if (/chip|badge|pill/i.test(String(el.className)) && el.children.length <= 2) chips += 1;
    let hasText = false;
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 3 && (c.textContent ?? '').trim().length > 0) {
        hasText = true;
        break;
      }
    }
    if (!hasText) continue;
    const fs = parseFloat(cs.fontSize);
    sizes.add(fs.toFixed(1));
    colors.add(cs.color);
    if (fs < smallest) smallest = fs;
  }
  return {
    fontSizes: sizes.size,
    textColors: colors.size,
    backgrounds: bgs.size,
    chips,
    smallestPx: smallest === 99 ? 0 : +smallest.toFixed(1),
  };
}

function WortBudget() {
  useEffect(() => {
    for (const slot of document.querySelectorAll<HTMLElement>('[data-woerter-slot]')) {
      // ⚠ Anatomie C: die Ergebnis-Fläche ist keine Karte mehr, sondern der
      //   Verbund `.vp-c` (Statement + Kontoauszug + Speicher + Preise).
      //   `.vp-card` gäbe es hier gar nicht mehr — die Messung wäre still 0.
      const karte = slot.closest('[data-fixture]')?.querySelector<HTMLElement>('.vp-c');
      const n = domWoerter(karte ?? null);
      const id = slot.getAttribute('data-woerter-slot') ?? '';
      const budget = budgetFuer(id);
      slot.setAttribute('data-woerter', String(n));
      slot.setAttribute('data-budget', String(budget));
      slot.setAttribute('data-ueber', n > budget ? '1' : '0');
      // P7: dieselbe Sicht auf die SKALA — gemessen, gestempelt, sichtbar.
      const inv = karte ? inventur(karte) : null;
      const verstoss = inv
        ? [
            inv.fontSizes > SKALA_BUDGET.fontSizes ? `${inv.fontSizes} Schriftgr\u00f6\u00dfen` : '',
            inv.textColors > SKALA_BUDGET.textColors ? `${inv.textColors} Textfarben` : '',
            inv.backgrounds > SKALA_BUDGET.backgrounds ? `${inv.backgrounds} Fl\u00e4chen` : '',
            inv.chips > SKALA_BUDGET.chips ? `${inv.chips} Chips` : '',
            inv.smallestPx < SKALA_BUDGET.smallestPx ? `${inv.smallestPx} px` : '',
          ].filter(Boolean)
        : [];
      if (inv) {
        slot.setAttribute('data-skala', `${inv.fontSizes}/${inv.textColors}/${inv.backgrounds}/${inv.chips}/${inv.smallestPx}`);
        slot.setAttribute('data-skala-ueber', verstoss.length ? '1' : '0');
      }
      const skalaTxt = inv
        ? ` \u00b7 Skala ${inv.fontSizes}\u00d7Gr\u00f6\u00dfe ${inv.textColors}\u00d7Farbe ${inv.backgrounds}\u00d7Fl\u00e4che ${inv.chips}\u00d7Chip min ${inv.smallestPx}px${verstoss.length ? ` \u26a0 ${verstoss.join(', ')}` : ''}`
        : '';
      slot.textContent = ` \u00b7 Ebene 0: ${n}/${budget} W\u00f6rter${n > budget ? ' \u26a0' : ''}${skalaTxt}`;
    }
  });
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 12, maxWidth: 1160, margin: '0 auto', minWidth: 0 }}>
    <SeitenBeweis />
    {FX.map((f) => (
      <Karte key={f.id} f={f} />
    ))}
    <WortBudget />
  </div>,
);

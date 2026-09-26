import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { savedProvenance } from './anlage';
import { handelBlock } from './cockpit';
import {
  steeringAttributionNote,
  steeringChip,
  steuerungFormel,
  type SteuerungFormelInput,
} from './erloesKomposition';
import { speicherSchritte } from './erloesEbenen';
import { fleetDailySaved, savedOnDay, siteEarnText, sparkDays, tagesSteuerung } from './fleet';
import { speicherAussage, type SpeicherEingabe } from './speicherAussage';
import type { EarningsDaily, EarningsSite, SiteEarnings } from './api';

/**
 * ⚠ **DER WÄCHTER ÜBER DIE MESSLATTE** (Captain 04.09.2026, wörtlich zum
 * Screenshot der Live-Anlage Pilsting/Herzogau: „Das ist doch Quatsch, du
 * musst Anlage immer mit Speicher berechnen, einer halt ohne smart
 * Steuerung.").
 *
 * Jede KUNDEN-Fläche misst seither gegen DENSELBEN Speicher ohne smarte
 * Steuerung (`savedSteuerungEur`). `savedEur`/`savedSpeicherEur`/`baselineEur`
 * messen gegen eine Anlage GANZ OHNE Speicher — sie bleiben in der Antwort und
 * auf den ADMIN-Flächen (Plattform-Optimizer, Flotten-Admin), aber sie dürfen
 * in keinem Kundensatz und in keiner Kundenzahl mehr auftauchen.
 *
 * Der Wächter hat ZWEI Hälften, und beide sind nötig:
 *
 *  1. **verhaltensbasiert** — jede Ableitung bekommt eine GIFT-Zahl als
 *     `savedEur`, die nirgends im erzeugten Text stehen darf. Das fängt auch
 *     einen Pfad, den ein Text-Grep nie sähe (eine Zahl, die über drei
 *     Funktionen wandert).
 *  2. **textbasiert** — die Kunden-Ableitungsdateien dürfen die Wörter der
 *     alten Messlatte nicht mehr in einen String setzen. Das fängt die
 *     Rückkehr der WORTE, auch wenn die Zahl stimmt.
 *
 * ⚠ **RATSCHE:** die Zahl der erlaubten Verstöße ist 0 und wird nie erhöht.
 * Wer eine Datei hinzunimmt, trägt sie in {@link KUNDEN_ABLEITUNGEN} ein.
 */

/** Eine Zahl, die in KEINEM Kundensatz stehen darf. */
const GIFT_SAVED = 987.65;
const GIFT_TEXT = '987,65';
/** Der Wert der sturen Vergleichsanlage — ebenfalls tabu. */
const GIFT_STUR = 900.0;
const GIFT_STUR_TEXT = '900,00';
/** Die EINE Zahl, die eine Kundenfläche zeigen darf. */
const STEUERUNG = 87.65;

const NOW = new Date('2026-09-02T12:19:00+02:00');

const MONEY = {
  savedEur: GIFT_SAVED,
  savedSpeicherEur: GIFT_STUR,
  savedSteuerungEur: STEUERUNG,
  steuerungSplitReason: null,
  baselineEur: -GIFT_SAVED,
  actualEur: -24.549,
  arbitrageEur: null,
  einspeiseErloesEur: 12.5,
  eigenverbrauchsWertEur: null,
  anzulegenderWertCtKwh: null,
  plantKind: 'direktvermarktung',
  tarifPriced: false,
  range: 'month',
  to: '2026-09-01T22:00:00Z',
} as unknown as SiteEarnings;

function textOf(v: unknown): string {
  return JSON.stringify(v ?? null);
}

describe('Messlatte · keine Kundenfläche zeigt die Zahl gegen „ohne Speicher"', () => {
  it('speicherAussage() trägt nur den Steuerungs-Mehrwert', () => {
    const a = speicherAussage(MONEY as unknown as SpeicherEingabe, {
      now: NOW,
      steuerungGeplantEur: 12.8,
    });
    const text = textOf(a);
    expect(text).not.toContain(GIFT_TEXT);
    expect(text).not.toContain(GIFT_STUR_TEXT);
    expect(a?.wert).toContain('87,65');
  });

  it('steeringAttributionNote()/steeringChip() zeigen den Steuerungs-Mehrwert', () => {
    expect(textOf(steeringAttributionNote(MONEY.savedSteuerungEur))).not.toContain(GIFT_TEXT);
    expect(textOf(steeringChip(MONEY.savedSteuerungEur, false))).not.toContain(GIFT_TEXT);
    expect(steeringAttributionNote(MONEY.savedSteuerungEur)).toContain('87,65');
  });

  it('steuerungFormel() erklärt die Steuerung, nicht den ganzen Speicher', () => {
    const f = steuerungFormel({
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 8,
      plantKind: 'direktvermarktung',
      savedSteuerungEur: STEUERUNG,
    } as unknown as SteuerungFormelInput);
    const text = textOf(f);
    expect(text).not.toContain(GIFT_TEXT);
    expect(text).not.toContain(GIFT_STUR_TEXT);
    expect(text).not.toMatch(/ohne Speicher\b/);
    expect(text).toContain('ohne smarte Steuerung');
  });

  it('speicherSchritte() rechnet gegen den sturen Speicher', () => {
    const zeilen = speicherSchritte({
      money: MONEY,
      steuerungEur: STEUERUNG,
      steuerungGeplantEur: 12.8,
    });
    const text = textOf(zeilen);
    expect(text).not.toContain(GIFT_TEXT);
    expect(text).not.toMatch(/ohne Speicher\b/);
    expect(text).not.toContain('Speicher gesamt');
  });

  it('savedProvenance() nennt die neue Messlatte', () => {
    const satz = savedProvenance(MONEY as unknown as EarningsSite);
    expect(satz).not.toContain(GIFT_TEXT);
    expect(satz).not.toMatch(/ungeregelt/i);
    expect(satz).toContain('ohne smarte Steuerung');
  });

  it('die Handel-Kachel des Cockpits liest den Steuerungs-Mehrwert', () => {
    const tiles = handelBlock({
      money: MONEY,
      slots: [],
      now: NOW,
      periodLabel: 'September',
    }).tiles;
    expect(textOf(tiles)).not.toContain(GIFT_TEXT);
    expect(textOf(tiles)).toContain('87,65');
  });

  it('die Tages-Reihe der Flotte liest nur `savedSteuerungEur`', () => {
    const tag: EarningsDaily = { day: '2026-09-02', savedEur: GIFT_SAVED, savedSteuerungEur: 3.5 };
    expect(tagesSteuerung(tag)).toBe(3.5);
    expect(savedOnDay([tag], '2026-09-02')).toBe(3.5);
    expect(sparkDays([tag], NOW, 1)).toEqual([{ day: '2026-09-02', savedEur: 3.5 }]);
    expect(siteEarnText('eigenverbrauch', savedOnDay([tag], '2026-09-02'))).not.toContain(GIFT_TEXT);
  });

  it('ein Tag OHNE Steuerungs-Anteil fällt aus — nie ein Rückfall auf `savedEur`', () => {
    const ohne: EarningsDaily = { day: '2026-09-02', savedEur: GIFT_SAVED };
    expect(tagesSteuerung(ohne)).toBeNull();
    expect(savedOnDay([ohne], '2026-09-02')).toBeNull();
    expect(siteEarnText('eigenverbrauch', savedOnDay([ohne], '2026-09-02'))).toBeNull();
    // Und die Flotten-Reihe lässt den ganzen Tag weg statt eine Teil-Summe zu zeigen.
    const sites = [
      { dailySaved: [{ day: '2026-09-02', savedEur: 1, savedSteuerungEur: 1 }] },
      { dailySaved: [ohne] },
    ] as unknown as EarningsSite[];
    expect(fleetDailySaved(sites)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * Die TEXT-Hälfte: die Wörter der alten Messlatte
 * ------------------------------------------------------------------------ */

/**
 * Die Dateien, in denen KUNDEN-Sätze über Geld entstehen. ADMIN-Ableitungen
 * (`optimizer.ts`, `pages/admin/*`) stehen bewusst NICHT hier — dort bleiben
 * `savedEur` und die Anlage ohne Speicher die richtige Frage.
 *
 * ⚠ Die FAHRPLAN-Welt (`schedule.ts`) steht ebenfalls nicht hier: ihre Sätze
 * beschreiben die Plan-Baseline DES OPTIMIERERS je Slot (`baselineCostEur`),
 * nicht die gemessene Kasse — sie sagen ihre Messlatte ausdrücklich und sind
 * damit ehrlich.
 */
const KUNDEN_ABLEITUNGEN = [
  'src/speicherAussage.ts',
  'src/erloesEbenen.ts',
  'src/erloesKomposition.ts',
  'src/anlage.ts',
  'src/cockpit.ts',
  'src/cockpitWidgets.ts',
  'src/fleet.ts',
  'src/portfolioCockpit.ts',
  'src/portfolioHistorie.ts',
  'src/steuerungArea.ts',
  'src/erloeseSeite.ts',
  'src/components/erloese/ErloeseKarten.tsx',
  'src/components/erloese/SpeicherKarte.tsx',
  'src/pages/PortfolioErloese.tsx',
];

/** Die verbotenen Wörter — sie beschreiben alle die ALTE Messlatte. */
const VERBOTEN = [
  /ohne Speicher\b/,
  /Speicher gesamt/,
  /ungeregelt/i,
  /stur(er|en)? Speicher/,
  /Ihr Speicher hat/,
];

/**
 * Nur ZEICHENKETTEN werden geprüft — Kommentare dürfen (und sollen) die alte
 * Messlatte beim Namen nennen, sonst kann niemand mehr nachlesen, was hier
 * warum gestrichen wurde.
 */
function stringLiterale(quelle: string): string[] {
  const ohneBlockKommentare = quelle.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const ohneZeilenKommentare = ohneBlockKommentare.replace(/^[ \t]*\/\/.*$/gm, ' ');
  const treffer = ohneZeilenKommentare.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g);
  return treffer ?? [];
}

/**
 * Die BENANNTEN Ausnahmen — je Datei die Literale, die dort bleiben DÜRFEN,
 * mit ihrem Grund. Eine Zahl allein würde nicht sagen, WELCHE Zeile gemeint
 * ist; so fällt eine NEUE Verletzung weiterhin durch, auch wenn eine alte
 * daneben steht.
 *
 * ⚠ **RATSCHE: diese Liste wird nur KÜRZER.** Wer sie verlängert, hat den
 * Wächter abgeschafft, nicht bestanden.
 */
const AUSNAHMEN: Record<string, { literal: string; grund: string }[]> = {
  // `proofLine`/`proofAnchor` beschriften den Vergleichs-Anker der FAHRPLAN-Seite
  // (`schedule.planKernaussage`) — dort vergleicht der Optimierer seinen Plan
  // gegen seine EIGENE Baseline je Slot, und der Satz sagt das ausdrücklich.
  // Die Umstellung dieser Welt gehört dem Optimierer, nicht dieser Runde.
  'src/fleet.ts': [
    { literal: "'Ungeregelt'", grund: 'proofLine — Fahrplan-Anker des Optimierers' },
    { literal: "'Ungeregelt wären es'", grund: 'proofLine — Fahrplan-Anker des Optimierers' },
    {
      literal:
        "'zur ungeregelten Anlage: gleiche Sonne, gleicher Verbrauch, Speicher ungenutzt.'",
      grund: 'realizedFinePrint — ohne Aufrufer in Produktion (nur noch Test-Abdeckung)',
    },
  ],
};

describe('Messlatte · die Wörter der alten Messlatte sind aus den Kunden-Sätzen weg', () => {
  it.each(KUNDEN_ABLEITUNGEN)('%s', (datei) => {
    const quelle = readFileSync(resolve(process.cwd(), datei), 'utf-8');
    const erlaubt = new Set((AUSNAHMEN[datei] ?? []).map((a) => a.literal));
    const verstoesse: string[] = [];
    for (const literal of stringLiterale(quelle)) {
      if (erlaubt.has(literal)) continue;
      for (const muster of VERBOTEN) {
        if (muster.test(literal)) verstoesse.push(`${muster} → ${literal.slice(0, 90)}`);
      }
    }
    expect(verstoesse).toEqual([]);
  });

  it('jede Ausnahme steht wirklich noch in ihrer Datei — tote Ausnahmen fallen auf', () => {
    for (const [datei, eintraege] of Object.entries(AUSNAHMEN)) {
      const quelle = readFileSync(resolve(process.cwd(), datei), 'utf-8');
      for (const a of eintraege) {
        expect({ datei, literal: a.literal, drin: quelle.includes(a.literal) }).toEqual({
          datei,
          literal: a.literal,
          drin: true,
        });
      }
    }
  });

  it('prüft wirklich etwas — der Wächter fällt auf einen eingebauten Verstoß herein', () => {
    const gift = `const x = 'Ihr Speicher hat 92,02 € gebracht — gegenüber einer Anlage ohne Speicher';`;
    const verstoesse = stringLiterale(gift).filter((l) => VERBOTEN.some((m) => m.test(l)));
    expect(verstoesse.length).toBeGreaterThan(0);
    // Und ein KOMMENTAR mit demselben Wortlaut ist kein Verstoß.
    expect(stringLiterale(`// Ihr Speicher hat ... ohne Speicher\n`)).toEqual([]);
  });
});

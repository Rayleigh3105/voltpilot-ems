/**
 * **Der SKALA-WÄCHTER des Bereichs „Verlauf"** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §3.1, Paket P0; Captain-Entscheid E2
 * vom 03.09.2026, wörtlich „a) → `--vp-c-fs-*` mit Alias").
 *
 * Die sechs Reiter des Verlaufs (Messwerte · Erlöse · Marktpreise ·
 * Lastspitzen · Prognose · Wetter) sollen EINE Sprache sprechen. Zwei von
 * ihnen tun es schon (Erlöse), vier noch nicht — und dazwischen liegen die
 * Reiter-Pakete P1–P8.
 *
 * ## Die RATSCHE, und warum es keine Alles-oder-nichts-Regel ist
 *
 * Ein Wächter, der heute rot ist, wird abgeschaltet; ein Wächter, der erst
 * nach dem letzten Paket eingeschaltet wird, hat bis dahin nichts bewacht.
 * Deshalb kennt die Tabelle unten ZWEI Stände:
 *
 * - **streng (`0`)** — die Fläche ist umgestellt, jede Abweichung ist ein
 *   Fehler. Wer eine Fläche fertig hat, setzt SEINEN Eintrag auf `0`.
 * - **Ratsche (`n > 0`)** — der gemessene IST-Stand am Tag von P0. Er darf
 *   NIE wachsen. Eine neue rohe Schriftgröße in `Historie.css` fällt hier
 *   also schon auf, bevor die Fläche überhaupt an der Reihe ist.
 *
 * ⚠ EINE ZAHL WIRD NUR KLEINER. Wer sie erhöht, hat den Wächter abgeschafft,
 *   nicht bestanden — dann gehört die Regel in dieselbe Änderung, nicht die
 *   Ausnahme.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const index = readFileSync(join(root, 'src', 'index.css'), 'utf8');

/**
 * Die Stylesheets des Verlaufs, je Reiter, mit ihrem Stand.
 *
 * ⚠ WER EIN BLATT ERGÄNZT, TRÄGT ES HIER EIN — sonst prüft der Wächter es
 *   nie. Die Pfade sind relativ zu `src/`.
 *
 * Der Reiter „Lastspitzen" hat kein eigenes Blatt (`LastspitzenSection.tsx`
 * rendert auf den geteilten Klassen aus `index.css`); `Fahrplan.css` ist
 * nicht selbst ein Verlauf-Reiter, steht aber als direkter Nachbar mit
 * denselben Chart-Bausteinen in der Ratsche, damit er nicht der Schlupfweg
 * für eine siebte Größe wird.
 */
const BLAETTER: ReadonlyArray<{
  readonly reiter: string;
  readonly datei: string;
  /** Erlaubte Verstöße. `0` = streng. */
  readonly fs: number;
  readonly ff: number;
  readonly fw: number;
}> = [
  // --- umgestellt (Variante C) — streng ---------------------------------
  { reiter: 'Erlöse', datei: 'components/Erloese.css', fs: 0, ff: 0, fw: 0 },
  { reiter: 'Erlöse', datei: 'components/erloese/ErgebnisKarte.css', fs: 0, ff: 0, fw: 0 },
  { reiter: 'Erlöse', datei: 'components/ErloesKomposition.css', fs: 0, ff: 0, fw: 0 },
  { reiter: 'Erlöse', datei: 'components/SteuerungFormel.css', fs: 0, ff: 0, fw: 0 },
  { reiter: 'Erlöse', datei: 'components/PortfolioWelt.css', fs: 0, ff: 0, fw: 0 },
  { reiter: 'Reiterleiste', datei: 'components/BereichTabs.css', fs: 0, ff: 0, fw: 0 },
  // Die geteilten Bausteine des Bereichs (P2b) — von Anfang an streng.
  { reiter: 'Bausteine', datei: 'components/Aufklapper.css', fs: 0, ff: 0, fw: 0 },
  { reiter: 'Bausteine', datei: 'components/VerlaufZustaende.css', fs: 0, ff: 0, fw: 0 },
  // Der Rumpf des Reiters „Messwerte" (P3) — die Ereignis-Chips sind damit
  // vollständig auf der Skala und stehen ab jetzt streng.
  { reiter: 'Messwerte', datei: 'components/Ereignisse.css', fs: 0, ff: 0, fw: 0 },
  // Die neuen Bausteine des Rumpfes (P3) — von Anfang an streng.
  { reiter: 'Messwerte', datei: 'components/VerlaufLedger.css', fs: 0, ff: 0, fw: 0 },
  // --- noch nicht umgestellt — Ratsche auf dem IST-Stand vom 03.09.2026 --
  // P2b hat die Aufklapp-ZEILE aus diesem Blatt in den geteilten Baustein
  // gehoben; ihre drei Telefon-Ausnahmen (1,05 rem · 0,875 rem · 0,72 rem)
  // und die vierte fremde Familie sind damit weg. P3 hat die Quoten-Chips,
  // die Nulllinien-Zeile, das 2-Spalten-Raster des Telefons, die
  // Legenden-Ausnahmen und den Untertitel-Block herausgelöst (35 → 26,
  // 3 → 2). Was bleibt, gehört anderen Paketen: der Zeit-Leiste (Chrome,
  // P1/S1), dem Explorer, der geteilten Fußkarte und `PortfolioMesswerte`
  // (P8, das `.vp-esum*` weiterfährt).
  { reiter: 'Messwerte', datei: 'components/Historie.css', fs: 26, ff: 2, fw: 0 },
  { reiter: 'Messwerte', datei: 'components/Verlauf.css', fs: 10, ff: 0, fw: 0 },
  { reiter: 'Messwerte', datei: 'components/Messwerte.css', fs: 18, ff: 0, fw: 3 },
  { reiter: 'Marktpreise', datei: 'components/Marktpreise.css', fs: 8, ff: 0, fw: 0 },
  { reiter: 'Marktpreise', datei: 'preisFenster.css', fs: 1, ff: 0, fw: 0 },
  { reiter: 'Marktpreise', datei: 'components/StrompreisStrip.css', fs: 12, ff: 0, fw: 1 },
  { reiter: 'Prognose', datei: 'pages/Prognose.css', fs: 10, ff: 0, fw: 0 },
  { reiter: 'Wetter', datei: 'WeatherChart.css', fs: 3, ff: 0, fw: 0 },
  { reiter: 'Nachbar', datei: 'components/Fahrplan.css', fs: 41, ff: 3, fw: 1 },
];

const blatt = Object.fromEntries(
  BLAETTER.map((b) => [b.datei, readFileSync(join(root, 'src', b.datei), 'utf8')]),
);

/** ⚠ Kommentare zuerst RAUS — sie nennen die abgelösten Werte absichtlich. */
function ohneKommentar(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Jede Deklaration einer Eigenschaft, mit ihrer Zeile für die Fehlermeldung. */
function deklarationen(css: string, eigenschaft: string): Array<{ wert: string; zeile: string }> {
  const treffer: Array<{ wert: string; zeile: string }> = [];
  for (const zeile of ohneKommentar(css).split('\n')) {
    const m = new RegExp(`(?:^|[;{])\\s*${eigenschaft}:\\s*([^;}]+)`).exec(zeile);
    if (m) treffer.push({ wert: m[1].trim(), zeile: zeile.trim() });
  }
  return treffer;
}

// Die Skala steht EINMAL — in `index.css`, am kanonischen Namen. Der Test
// liest sie von dort, damit er nicht zu einer zweiten Wahrheit wird.
const SKALA_PX = new Set(
  [...index.matchAll(/--vp-c-fs-[a-z0-9-]+:\s*(\d+)px/g)].map((m) => `${m[1]}px`),
);
const GEWICHTE_ZAHL = new Set([...index.matchAll(/--vp-c-fw-\d+:\s*(\d+)/g)].map((m) => m[1]));

/** Beide Namen sind erlaubt — `--vp-erl-*` ist ein reiner Alias (E2). */
const FS_TOKEN = /var\(\s*--vp-(?:c|erl)-fs-[a-z0-9-]+/;
const FW_TOKEN = /var\(\s*--vp-(?:c|erl)-fw-\d+/;

function verstoesseSchriftgroesse(css: string): string[] {
  return deklarationen(css, 'font-size')
    .filter(({ wert }) => !(FS_TOKEN.test(wert) || SKALA_PX.has(wert)))
    .map(({ zeile }) => zeile);
}

function verstoesseFamilie(css: string): string[] {
  return deklarationen(css, 'font-family')
    .filter(({ wert }) => !(/var\(\s*--vp-c-font/.test(wert) || wert === 'inherit'))
    .map(({ zeile }) => zeile);
}

function verstoesseGewicht(css: string): string[] {
  return deklarationen(css, 'font-weight')
    .filter(({ wert }) => !(FW_TOKEN.test(wert) || GEWICHTE_ZAHL.has(wert)))
    .map(({ zeile }) => zeile);
}

describe('Verlauf P0 · die Skala steht in index.css', () => {
  it('sechs Stufen plus die Telefon-Stufe des Heros', () => {
    expect([...SKALA_PX].sort((a, b) => parseInt(a) - parseInt(b))).toEqual([
      '12px',
      '14px',
      '16px',
      '20px',
      '24px',
      '36px',
      '48px',
    ]);
  });

  it('und genau die vier erlaubten Gewichte', () => {
    expect([...GEWICHTE_ZAHL].sort()).toEqual(['400', '600', '700', '800']);
  });

  it('die Abstands-Skala trägt ihre sechs Stufen (E3.1)', () => {
    const stufen = [...index.matchAll(/--vp-c-space-(\d):\s*(\d+)px/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    );
    expect(stufen).toEqual(['1=4', '2=8', '3=12', '4=16', '5=24', '6=32']);
  });

  it('die Sheet-Maße stehen als Token, nicht in jedem Sheet einzeln (E3.3)', () => {
    for (const t of [
      '--vp-c-sheet-radius',
      '--vp-c-sheet-head',
      '--vp-c-sheet-grip-w',
      '--vp-c-sheet-grip-h',
      '--vp-c-scrim',
      '--vp-c-sheet-max',
    ]) {
      expect(index, `${t} fehlt`).toContain(`${t}:`);
    }
  });
});

describe('Verlauf P0 · E3.4: EINE Dauer, EINE Stelle an der sie verstummt', () => {
  it('`--vp-c-motion` steht als Dauer da', () => {
    expect(/--vp-c-motion:\s*200ms/.test(index)).toBe(true);
  });

  it('genau EIN prefers-reduced-motion-Block setzt sie auf 0', () => {
    const bloecke = [
      ...index.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g),
    ].filter((m) => /--vp-c-motion/.test(m[1]));
    expect(bloecke.length, 'die Dauer wird an mehr als einer Stelle abgeschaltet').toBe(1);
    expect(bloecke[0][1]).toMatch(/--vp-c-motion:\s*0ms/);
  });

  it('der Verlauf erfindet keine zweite Kurve — die Kurve ist das Haus-Token', () => {
    expect(/--vp-c-ease\s*:/.test(index), '--vp-c-ease ist ein Zwilling von --vp-ease').toBe(false);
  });
});

describe('Verlauf P0 · jede Schriftgröße liegt auf der Skala (Ratsche)', () => {
  for (const { reiter, datei, fs } of BLAETTER) {
    it(`${reiter} · ${datei} (erlaubt: ${fs})`, () => {
      const v = verstoesseSchriftgroesse(blatt[datei]);
      expect(
        v.length,
        `${datei}: ${v.length} Schriftgrößen neben der Skala, erlaubt ${fs}` +
          (v.length > fs ? `\n  neu z. B.: ${v.slice(0, 5).join('\n             ')}` : ''),
      ).toBeLessThanOrEqual(fs);
    });
  }
});

describe('Verlauf P0 · jede Schrift ist die Schrift der Variante C (Ratsche)', () => {
  for (const { reiter, datei, ff } of BLAETTER) {
    it(`${reiter} · ${datei} (erlaubt: ${ff})`, () => {
      const v = verstoesseFamilie(blatt[datei]);
      expect(v.length, `${datei}: fremde Schriftfamilie\n  ${v.join('\n  ')}`).toBeLessThanOrEqual(
        ff,
      );
    });
  }
});

describe('Verlauf P0 · jedes Gewicht liegt in {400,600,700,800} (Ratsche)', () => {
  for (const { reiter, datei, fw } of BLAETTER) {
    it(`${reiter} · ${datei} (erlaubt: ${fw})`, () => {
      const v = verstoesseGewicht(blatt[datei]);
      expect(v.length, `${datei}: Gewicht neben der Skala\n  ${v.join('\n  ')}`).toBeLessThanOrEqual(
        fw,
      );
    });
  }
});

describe('Verlauf P0 · die Ratsche selbst', () => {
  /* Ein Eintrag, dessen Zahl über dem IST liegt, bewacht nichts: er würde
     erst anschlagen, NACHDEM jemand neue Verstöße hinzugefügt hat. Der Test
     zieht ihn deshalb selbst nach unten fest. */
  it('keine Zahl liegt über dem gemessenen Stand — sonst hätte sie Luft', () => {
    const zuHoch: string[] = [];
    for (const { datei, fs, ff, fw } of BLAETTER) {
      const ist = {
        fs: verstoesseSchriftgroesse(blatt[datei]).length,
        ff: verstoesseFamilie(blatt[datei]).length,
        fw: verstoesseGewicht(blatt[datei]).length,
      };
      for (const [was, erlaubt] of [
        ['fs', fs],
        ['ff', ff],
        ['fw', fw],
      ] as const) {
        if (erlaubt > ist[was]) zuHoch.push(`${datei} ${was}: erlaubt ${erlaubt}, ist ${ist[was]}`);
      }
    }
    expect(zuHoch, `Ratsche nachziehen:\n  ${zuHoch.join('\n  ')}`).toEqual([]);
  });

  it('die umgestellten Flächen stehen streng auf 0', () => {
    const streng = BLAETTER.filter((b) => b.fs === 0 && b.ff === 0 && b.fw === 0).map(
      (b) => b.datei,
    );
    expect(streng).toContain('components/Erloese.css');
    expect(streng).toContain('components/erloese/ErgebnisKarte.css');
    expect(streng).toContain('components/BereichTabs.css');
    expect(streng).toContain('components/Aufklapper.css');
  });
});

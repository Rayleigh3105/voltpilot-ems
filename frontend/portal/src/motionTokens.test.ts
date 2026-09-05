/**
 * **Der WÄCHTER der Bewegungs-Familie** (Bewegungs-Programm P0).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §4 (Spec-Quelle), §9 Zeile P0;
 * Captain-Entscheid 04.09.2026 („alle Empfehlungen nehmen", E1–E10 = a).
 *
 * Er bewacht vier Zusagen, und jede davon ist einmal gebrochen worden:
 *
 * 1. **Die Familie ist vollständig und registriert.** Ohne `@property` liefert
 *    `getComputedStyle` `"calc(...)"` statt `"0.4s"` — dann kann ECharts (P1)
 *    die Dauer nicht lesen und es gäbe zwei Wahrheiten.
 * 2. **EINE Wahrheit in zwei Sprachen.** `motionPresets.ts` trägt dieselben
 *    Zahlen wie die `@property`-Initialwerte. Der Test rechnet sie nach.
 * 3. **EIN Schalter, EINE Stelle.** Genau ein `prefers-reduced-motion`-Block
 *    unter `src/`, und er setzt `--vp-motion-scale: 0`. Die einzige Ausnahme
 *    ausserhalb ist der Skelett-Schimmer des Design-Systems (Begründung dort).
 * 4. **Zwei RATSCHEN.** `transition: all` animiert auch, was niemand animieren
 *    wollte; eine nackte Dauer entzieht sich dem Schalter. Beide Zahlen dürfen
 *    NUR KLEINER werden.
 *
 * ⚠ EINE ZAHL WIRD NUR KLEINER. Wer sie erhöht, hat den Wächter abgeschafft,
 *   nicht bestanden — dann gehört die Regel in dieselbe Änderung, nicht die
 *   Ausnahme. (Dieselbe Disziplin wie `src/verlaufSkala.test.ts`.)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BASE,
  CHART,
  CHART_UPDATE,
  DISTANCE,
  ENTER,
  EXIT,
  FAST,
  PAGE,
  STAGGER,
  EASE_IN,
  EASE_INOUT,
  EASE_OUT,
  scaled,
  staggerDelay,
} from './motionPresets';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

const effects = lies('designsystem', 'tokens', 'effects.css');
const index = lies('src', 'index.css');
const core = lies('designsystem', 'components', 'core', 'core.css');

/** Alle `.css`-Blätter unter einem Verzeichnis (ohne Guideline-Karten). */
function blaetter(rel: string): string[] {
  const out: string[] = [];
  const lauf = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e !== 'node_modules' && e !== 'guidelines') lauf(p);
      } else if (e.endsWith('.css')) out.push(p);
    }
  };
  lauf(join(root, rel));
  return out.sort();
}

const ALLE_CSS = [...blaetter('src'), ...blaetter('designsystem')];

// ---------------------------------------------------------------------------

describe('Bewegung P0 · die Familie steht und ist registriert', () => {
  /** Token → Initialwert in Millisekunden, wie §4.1 ihn festlegt. */
  const FAMILIE: Record<string, number> = {
    '--vp-motion-fast': 120,
    '--vp-motion-base': 200,
    '--vp-motion-enter': 260,
    '--vp-motion-exit': 160,
    '--vp-motion-page': 300,
    '--vp-motion-chart': 400,
    '--vp-motion-chart-update': 300,
    '--vp-motion-stagger': 30,
  };

  it('der Schalter ist als `<number>` registriert und steht auch als gewöhnlicher Wert', () => {
    expect(effects).toMatch(
      /@property\s+--vp-motion-scale\s*\{[^}]*syntax:\s*'<number>'[^}]*initial-value:\s*1\s*;?[^}]*\}/,
    );
    // Safari < 16.4 kennt `@property` nicht — ohne diese Zeile hätte `calc()`
    // dort keinen Faktor und jede Dauer wäre ungültig.
    expect(effects).toMatch(/--vp-motion-scale:\s*1\s*;/);
  });

  for (const [token, ms] of Object.entries(FAMILIE)) {
    it(`${token} ist als <time> mit ${ms}ms registriert und rechnet mit dem Schalter`, () => {
      const reg = new RegExp(
        `@property\\s+${token}\\s*\\{[^}]*syntax:\\s*'<time>'[^}]*initial-value:\\s*${ms}ms\\s*;?[^}]*\\}`,
      );
      expect(effects, `${token}: @property fehlt oder trägt einen anderen Initialwert`).toMatch(reg);

      const calc = new RegExp(
        `${token}:\\s*calc\\(\\s*${ms}ms\\s*\\*\\s*var\\(--vp-motion-scale\\)\\s*\\)`,
      );
      expect(effects, `${token}: rechnet nicht mit --vp-motion-scale`).toMatch(calc);
    });
  }

  it('`--vp-motion-distance` ist als <length> registriert (8px)', () => {
    expect(effects).toMatch(
      /@property\s+--vp-motion-distance\s*\{[^}]*syntax:\s*'<length>'[^}]*initial-value:\s*8px\s*;?[^}]*\}/,
    );
    expect(effects).toMatch(/--vp-motion-distance:\s*8px/);
  });

  it('drei Kurven, und `--vp-ease` ist der zweite Name von `--vp-ease-inout`', () => {
    expect(effects).toMatch(/--vp-ease-out:\s*cubic-bezier\(0\.2,\s*0\.7,\s*0\.2,\s*1\)/);
    expect(effects).toMatch(/--vp-ease-in:\s*cubic-bezier\(0\.4,\s*0,\s*1,\s*1\)/);
    expect(effects).toMatch(/--vp-ease-inout:\s*cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/);
    expect(effects, '--vp-ease muss ein Alias bleiben, kein zweiter Wert').toMatch(
      /--vp-ease:\s*var\(--vp-ease-inout\)/,
    );
  });

  it('`--vp-c-motion` ist seit P0 ein ALIAS, kein zweiter Wert', () => {
    expect(index, '--vp-c-motion trägt wieder eine eigene Zahl').toMatch(
      /--vp-c-motion:\s*var\(--vp-motion-base\)/,
    );
    expect(/--vp-c-motion:\s*\d/.test(index.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });

  it('die abgelösten `all`-Tokens sind fort und kommen nicht zurück', () => {
    for (const datei of ALLE_CSS) {
      const s = readFileSync(datei, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(/var\(--vp-transition(-fast)?\)/.test(s), `${relative(root, datei)}`).toBe(false);
      expect(/--vp-transition(-fast)?\s*:/.test(s), `${relative(root, datei)}`).toBe(false);
      expect(/--vp-lift-lg\s*:/.test(s), `${relative(root, datei)}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('Bewegung P0 · EINE Wahrheit: CSS-Initialwert == TS-Konstante', () => {
  /** Die TS-Seite in Millisekunden, gegen die CSS-Seite geprüft. */
  const PAARE: Array<[string, number]> = [
    ['--vp-motion-fast', FAST.duration * 1000],
    ['--vp-motion-base', BASE.duration * 1000],
    ['--vp-motion-enter', ENTER.duration * 1000],
    ['--vp-motion-exit', EXIT.duration * 1000],
    ['--vp-motion-page', PAGE.duration * 1000],
    ['--vp-motion-chart', CHART.duration * 1000],
    ['--vp-motion-chart-update', CHART_UPDATE.duration * 1000],
    ['--vp-motion-stagger', STAGGER * 1000],
  ];

  for (const [token, ms] of PAARE) {
    it(`${token} == ${ms} ms in motionPresets.ts`, () => {
      const m = effects.match(new RegExp(`@property\\s+${token}\\b[^}]*initial-value:\\s*(\\d+)ms`));
      expect(m, `${token}: kein @property-Initialwert gefunden`).toBeTruthy();
      expect(Number(m![1]), `${token}: CSS und motionPresets.ts sind auseinandergelaufen`).toBe(
        Math.round(ms),
      );
    });
  }

  it('`--vp-motion-distance` == DISTANCE', () => {
    const m = effects.match(/@property\s+--vp-motion-distance\b[^}]*initial-value:\s*(\d+)px/);
    expect(Number(m![1])).toBe(DISTANCE);
  });

  it('die drei Kurven sind dieselben Zahlen wie in CSS', () => {
    const kurve = (name: string) => {
      const m = effects.match(new RegExp(`${name}:\\s*cubic-bezier\\(([^)]*)\\)`));
      return m![1].split(',').map((x) => Number(x.trim()));
    };
    expect(kurve('--vp-ease-out')).toEqual([...EASE_OUT]);
    expect(kurve('--vp-ease-in')).toEqual([...EASE_IN]);
    expect(kurve('--vp-ease-inout')).toEqual([...EASE_INOUT]);
  });

  it('`scaled()` nullt die Dauer, behält aber die Kurve (Endzustand wird gesetzt)', () => {
    expect(scaled(ENTER, 0)).toEqual({ duration: 0, ease: EASE_OUT });
    expect(scaled(ENTER, 1)).toEqual(ENTER);
    expect(scaled(CHART, 0.5).duration).toBeCloseTo(0.2, 6);
    // Ein kaputter Wert darf nie eine Bewegung erfinden.
    expect(scaled(BASE, Number.NaN).duration).toBe(0);
    expect(scaled(BASE, -1).duration).toBe(0);
  });

  it('`staggerDelay()` deckelt bei 8 und verstummt mit dem Schalter', () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(3)).toBeCloseTo(0.09, 6);
    expect(staggerDelay(20)).toBeCloseTo(8 * STAGGER, 6);
    expect(staggerDelay(20, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('Bewegung P0 · EIN Schalter, EINE Stelle', () => {
  const bloecke = (s: string) => [
    ...s.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g),
  ];

  it('unter `src/` gibt es genau EINEN Block, und er legt den Schalter um', () => {
    const treffer: string[] = [];
    for (const datei of blaetter('src')) {
      const n = bloecke(readFileSync(datei, 'utf8')).length;
      for (let i = 0; i < n; i += 1) treffer.push(relative(root, datei));
    }
    expect(
      treffer,
      `die Bewegung wird an mehr als einer Stelle abgeschaltet: ${treffer.join(', ')}`,
    ).toEqual(['src/index.css']);

    const [block] = bloecke(index);
    expect(block[1]).toMatch(/--vp-motion-scale:\s*0\s*;/);
  });

  it('der EINE Block nullt jede benannte Dauer-Animation des Portals', () => {
    const [block] = bloecke(index);
    // Die vollständige Liste der `infinite`-Animationen von index.css: jede
    // muss im Block stehen — eine Loop mit 0 ms wäre ein stehendes Bild.
    const loops = [
      '.vp-flow-on',
      '.vp-flow-rev',
      '.vp-boot-spinner',
      '.vp-spinner',
      '.vp-auth-flow .spoke',
      '.vp-flowport.accepts',
      '.vp-ustate-busy .vp-ustate-dot',
      '.vp-fleet-dot',
    ];
    for (const sel of loops) {
      expect(block[1], `${sel} läuft unter reduzierter Bewegung weiter`).toContain(sel);
    }
  });

  it('der EINE Block steht NACH jeder `infinite`-Animation (Kaskade)', () => {
    // ⚠ Im Browser gemessen, nicht theoretisch: eine Media-Query erhöht die
    // Spezifität NICHT. Stand der Block oben in der Datei, gewann
    // `.vp-auth-flow .spoke { animation: … infinite }` aus Zeile ~1130 und die
    // Login-Bühne lief unter reduzierter Bewegung weiter — obwohl der Block sie
    // namentlich nennt. Ein Text-Wächter kann die Kaskade nur so prüfen.
    const letzteLoop = index.lastIndexOf('infinite;');
    const blockStart = index.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(letzteLoop, 'keine `infinite`-Animation gefunden — Test wäre vakuum').toBeGreaterThan(0);
    expect(
      blockStart,
      'der EINE Block steht VOR einer Dauer-Animation und verliert die Kaskade gegen sie',
    ).toBeGreaterThan(letzteLoop);
  });

  it('das Design-System hat GENAU EINE Ausnahme: den Skelett-Schimmer', () => {
    const alle: string[] = [];
    for (const datei of blaetter('designsystem')) {
      for (const b of bloecke(readFileSync(datei, 'utf8'))) {
        alle.push(`${relative(root, datei)} :: ${b[1].trim()}`);
      }
    }
    expect(alle.length, `unerwartete Blöcke: ${alle.join(' | ')}`).toBe(1);
    expect(alle[0]).toContain('designsystem/components/core/core.css');
    expect(alle[0]).toMatch(/\.vp-skeleton\s*\{\s*animation:\s*none;\s*\}/);
    // Die Begründung steht daneben und darf nicht wegkommentiert werden.
    expect(core).toMatch(/DER EINZIGE `prefers-reduced-motion`-Block/);
  });
});

// ---------------------------------------------------------------------------

/**
 * Zählt Übergänge, die `all` animieren — sei es wörtlich oder über ein Token,
 * dessen Wert ein `all`-Kurzschreiben ist (so kam `--vp-transition-fast` an
 * 19 Stellen an).
 */
function verstoesseAll(s: string, tokenMitAll: string[]): string[] {
  const ohneKommentar = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of ohneKommentar.matchAll(/transition(-property)?\s*:\s*([^;{}]*)/g)) {
    const wert = m[2];
    if (/(^|[\s,(])all([\s,)]|$)/.test(wert)) out.push(m[0].trim());
    else if (tokenMitAll.some((t) => wert.includes(`var(${t})`))) out.push(m[0].trim());
  }
  return out;
}

/**
 * Zählt Dauern, die NICHT aus der Familie kommen.
 *
 * Zwei Dinge sind ausgenommen, jedes aus eigenem Grund:
 *
 * - **`infinite`-Animationen.** Die Periode einer Loop ist eine Aussage über
 *   SIE (0,9 s Spinner), kein Familien-Wert — sie verstummt über
 *   `animation: none` im EINEN Block, nicht über eine Dauer.
 * - **Der Rückfall in `var(--token, 200ms)`.** Die Dauer KOMMT dort aus dem
 *   Token; die Zahl daneben ist der Rückfall für ein Blatt, das ohne die
 *   Token-Datei gerendert wird. Sie zu zählen hiesse, die richtige
 *   Schreibweise zu bestrafen.
 */
function verstoesseDauer(s: string): string[] {
  const ohneKommentar = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = /(transition|animation)(-duration)?\s*:\s*([^;{}]*)/g;
  for (const m of ohneKommentar.matchAll(re)) {
    // JEDE SCHICHT EINZELN. `animation: a var(--x) both, b 0.9s infinite` ist
    // zwei Animationen in einer Zeile — würde der benannte Loop die ganze
    // Zeile freistellen, dürfte die Schicht daneben still eine nackte Dauer
    // tragen. Kommas INNERHALB von `cubic-bezier(…)` trennen dabei nichts.
    for (const schicht of schichten(m[3])) {
      // Ein Endlos-Loop ist NUR dann frei, wenn er als Ausnahme benannt ist
      // (`LOOP_AUSNAHMEN`) — jeder andere zählt wie eine nackte Dauer.
      if (/\binfinite\b/.test(schicht) && loopName(schicht) !== null) continue;
      const ohneVar = schicht.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ');
      if (/(^|[\s,(])-?[\d.]+m?s([\s,)]|$)/.test(ohneVar)) out.push(`${m[1]}: ${schicht.trim()}`);
    }
  }
  return out;
}

/** Ein Kurzschreibweise-Wert, an den Kommas der OBERSTEN Ebene zerlegt. */
function schichten(wert: string): string[] {
  const out: string[] = [];
  let tiefe = 0;
  let akt = '';
  for (const c of wert) {
    if (c === '(') tiefe++;
    else if (c === ')') tiefe--;
    if (c === ',' && tiefe === 0) {
      out.push(akt);
      akt = '';
    } else akt += c;
  }
  out.push(akt);
  return out.filter((t) => t.trim() !== '');
}

/**
 * **Die benannten Dauer-Loops** (Konzept §3 Punkt 6 „eine Dauer-Animation =
 * eine Aussage", §7.4). Sie behalten ihr eigenes Tempo, weil das Tempo hier
 * die AUSSAGE trägt und nicht die Familie — aber jeder einzelne steht mit
 * seinem Grund hier, sonst zählt er als Ratschen-Verstoß.
 *
 * ⚠ Diese Liste wächst NICHT ohne Grund. Wer einen Loop ergänzt, ergänzt eine
 *   Aussage — und muss zeigen, dass sie nicht schon eine andere trägt.
 */
const LOOP_AUSNAHMEN: Record<string, string> = {
  'vp-spin': 'Spinner: die eine Aussage „busy". 0,9 s ist sein Lesetempo.',
  'vp-boot-spin': 'derselbe Spinner im App-Start, vor dem ersten Stylesheet.',
  'vp-skeleton-shimmer': 'Skelett: die Aussage „lädt" (Design-System, eigener reduced-Block).',
  'vp-fleet-pulse-ok': 'Flotten-Punkt „lebt": 2,4 s ist ein Herzschlag, kein Feedback.',
  'vp-fleet-pulse-warn': 'derselbe Herzschlag in Warn-Farbe.',
  'vp-flowport-pulse': 'Fluss-Andockpunkt: gehört zum Energiefluss (Tempo aus `useFlowTempo`).',
  'vp-ustate-pulse': 'Zustands-Punkt „Auftrag unterwegs": Wartezeit, nicht Zustandswechsel.',
  'vp-auth-flow': 'Login-Bühne — die benannte Ausnahme E7 des Konzepts (1,8 s).',
  'vp-flow':
    'Energiefluss: 0,9 s ist nur das Referenztempo bei 2 kW — das GEZEIGTE ' +
    'Tempo kommt aus `flowTempo(kW)` per `Animation.playbackRate` ' +
    '(`useFlowTempo.ts`), damit ein Leistungswechsel die Punkte nicht springen lässt.',
};

/** Der Keyframe-Name einer `animation:`-Kurzschreibweise, wenn sie eine hat. */
function loopName(wert: string): string | null {
  for (const w of wert.trim().split(/[\s,]+/)) {
    if (Object.prototype.hasOwnProperty.call(LOOP_AUSNAHMEN, w)) return w;
  }
  return null;
}

describe('Bewegung P0 · Ratsche „kein `transition: all`" (Ziel 0, erreicht)', () => {
  it('kein einziges Blatt animiert mehr `all`', () => {
    const alle: string[] = [];
    for (const datei of ALLE_CSS) {
      for (const v of verstoesseAll(readFileSync(datei, 'utf8'), [
        '--vp-transition',
        '--vp-transition-fast',
      ])) {
        alle.push(`${relative(root, datei)}: ${v}`);
      }
    }
    expect(alle, `\`all\` animiert auch Layout — es gibt keinen Fall dafür:\n${alle.join('\n')}`)
      .toEqual([]);
  });
});

/**
 * **Die Ratsche steht auf NULL** (P7, Konzept §9 Zeile P7 „restliche
 * `transition:` auf Tokens, Ratsche → 0"). Was P6 als offene Baustelle
 * übergab, ist geräumt:
 *
 * - `index.css`: die BREITE des Batterie-Balkens läuft jetzt im Tempo eines
 *   Wertwechsels (`--vp-motion-chart-update`, 300 ms) — die Breite IST der
 *   Wert, und ein Wertwechsel morpht (§3 Punkt 4).
 * - `Fahrplan.css` (4×), `FahrplanWhy.css` (1×): Aufklapper-Chevrons, jetzt
 *   `transform var(--vp-motion-base) var(--vp-ease-inout)` wie jeder andere
 *   Chevron im Portal.
 *
 * ⚠ EIN EINTRAG HIER IST EIN RÜCKSCHRITT. Die Ratsche ist leer, und leer
 *   heißt: jede neue nackte Dauer ist ein Fehler, keine Verhandlung. Wer eine
 *   Ausnahme braucht, braucht einen GRUND — und der gehört als benannter
 *   Loop nach `LOOP_AUSNAHMEN`, nicht als Zahl hierher.
 *
 * ⚠ WER EIN BLATT ERGÄNZT, muss nichts mehr eintragen — der Test unten läuft
 *   über ALLE Blätter und erlaubt jedem genau 0.
 */
const DAUER_RATSCHE: Record<string, number> = {};
describe('Bewegung P0 · Ratsche „keine nackte Dauer"', () => {
  it('jedes Blatt liegt auf oder unter seinem Stand', () => {
    const zuViel: string[] = [];
    for (const datei of ALLE_CSS) {
      const rel = relative(root, datei);
      const erlaubt = DAUER_RATSCHE[rel] ?? 0;
      const v = verstoesseDauer(readFileSync(datei, 'utf8'));
      if (v.length > erlaubt) {
        zuViel.push(`${rel}: ${v.length} nackte Dauern, erlaubt ${erlaubt}\n    ${v.join('\n    ')}`);
      }
    }
    expect(zuViel, `\n${zuViel.join('\n')}`).toEqual([]);
  });

  it('keine Zahl der Ratsche hat Luft — sie wird nur kleiner', () => {
    const luft: string[] = [];
    for (const [rel, erlaubt] of Object.entries(DAUER_RATSCHE)) {
      const v = verstoesseDauer(lies(rel));
      if (v.length !== erlaubt) luft.push(`${rel}: Ratsche ${erlaubt}, gemessen ${v.length}`);
    }
    expect(luft, `eine Zahl mit Luft bewacht nichts:\n${luft.join('\n')}`).toEqual([]);
  });

  it('die Ratsche ist LEER — P7 hat sie auf 0 gefahren', () => {
    expect(
      Object.keys(DAUER_RATSCHE),
      'Die Ratsche stand seit P7 auf null. Ein Eintrag hier ist ein Rückschritt:\n' +
        'eine neue nackte Dauer gehört auf ein Familien-Token, ein neuer\n' +
        'Dauer-Loop mit Aussage nach `LOOP_AUSNAHMEN` — nicht als Zahl hierher.',
    ).toEqual([]);
  });
});

describe('Bewegung P7 · die benannten Dauer-Loops', () => {
  /** Jede `animation:`-Kurzschreibweise mit Endlos-Lauf, über alle Blätter. */
  const loops = ALLE_CSS.flatMap((datei) => {
    const s = readFileSync(datei, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const out: { datei: string; wert: string }[] = [];
    for (const m of s.matchAll(/animation\s*:\s*([^;{}]*)/g)) {
      for (const schicht of schichten(m[1])) {
        if (/\binfinite\b/.test(schicht)) {
          out.push({ datei: relative(root, datei), wert: schicht.trim() });
        }
      }
    }
    return out;
  });

  it('es gibt überhaupt Loops zu bewachen', () => {
    expect(loops.length).toBeGreaterThan(0);
  });

  it('jeder laufende Loop steht mit seinem Grund in der Liste', () => {
    const fremd = loops.filter((l) => loopName(l.wert) === null);
    expect(
      fremd.map((l) => `${l.datei}: ${l.wert}`),
      'Ein Dauer-Loop ohne Eintrag ist Dekoration, bis das Gegenteil dasteht.\n' +
        'Entweder er trägt eine Aussage — dann nach `LOOP_AUSNAHMEN` mit Grund —\n' +
        'oder er gehört auf ein Familien-Token.',
    ).toEqual([]);
  });

  it('kein Eintrag der Liste ist tot', () => {
    const benutzt = new Set(loops.map((l) => loopName(l.wert)));
    const tot = Object.keys(LOOP_AUSNAHMEN).filter((n) => !benutzt.has(n));
    expect(tot, `eine Ausnahme ohne Loop erlaubt nur noch Zukünftiges:\n${tot.join('\n')}`)
      .toEqual([]);
  });

  it('jeder Grund ist ein Satz, kein Wort', () => {
    const duenn = Object.entries(LOOP_AUSNAHMEN)
      .filter(([, grund]) => grund.trim().length < 20)
      .map(([n]) => n);
    expect(duenn, `ein Grund, den niemand nachprüfen kann, ist keiner:\n${duenn.join('\n')}`)
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * „Importiert dieses Modul Motion?" — EINE Regel, zwei Formen: der
 * gewöhnliche `import … from 'motion'` UND der Nebenwirkungs-Import
 * `import 'motion/react'` (der zieht das Paket genauso in den Chunk).
 */
function importiertMotion(quelltext: string): boolean {
  const s = quelltext.replace(/\/\*[\s\S]*?\*\//g, '');
  return (
    /from\s*['"]motion(\/[^'"]*)?['"]/.test(s) || /import\s*['"]motion(\/[^'"]*)?['"]/.test(s)
  );
}

/** Alle Module, die vom Einstieg aus STATISCH erreichbar sind. */
function statischErreichbar(einstieg: string): Set<string> {
  const gesehen = new Set<string>();
  const offen = [resolve(root, einstieg)];
  const aufloesen = (von: string, spez: string): string | null => {
    if (!spez.startsWith('.')) return null; // Pakete verfolgen wir nicht
    const basis = resolve(dirname(von), spez);
    for (const k of ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.js']) {
      try {
        const p = basis + k;
        if (statSync(p).isFile()) return p;
      } catch {
        /* weiter */
      }
    }
    return null;
  };
  while (offen.length) {
    const d = offen.pop()!;
    if (gesehen.has(d)) continue;
    gesehen.add(d);
    let s: string;
    try {
      s = readFileSync(d, 'utf8');
    } catch {
      continue;
    }
    // NUR statische Imports/Exports — ein `import()` ist die Lazy-Grenze.
    for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]/g)) {
      const p = aufloesen(d, m[1]);
      if (p) offen.push(p);
    }
    for (const m of s.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
      const p = aufloesen(d, m[1]);
      if (p) offen.push(p);
    }
  }
return gesehen;
}

describe('Bewegung P0 · Motion lebt NUR in Lazy-Stücken (E10 a)', () => {
  it('kein vom Einstieg aus statisch erreichbares Modul importiert `motion`', () => {
    const module = statischErreichbar('src/main.tsx');
    const sünder: string[] = [];
    for (const d of module) {
      if (importiertMotion(readFileSync(d, 'utf8'))) sünder.push(relative(root, d));
    }
    expect(
      sünder,
      'Motion im Einstieg kostet +16 bis +45 kB gz (Konzept §7.1, E10 a):\n' + sünder.join('\n'),
    ).toEqual([]);
    // Nicht-vakuum: der Lauf muss wirklich Module gefunden haben.
    expect(module.size).toBeGreaterThan(50);
  });

  it('die Lazy-Grenze existiert und lädt `domAnimation` dynamisch nach', () => {
    const feat = lies('src', 'motionFeatures.ts');
    expect(feat).toMatch(/export\s*\{\s*domAnimation as default\s*\}\s*from\s*'motion\/react'/);
    const wirt = lies('src', 'components', 'MotionRoot.tsx');
    expect(wirt, 'MotionRoot muss `strict` fahren, sonst zieht `motion.div` alles herein').toMatch(
      /<LazyMotion\s+strict/,
    );
    expect(wirt).toMatch(/import\('\.\.\/motionFeatures'\)/);
  });

  it('`motionPresets.ts` bleibt frei von Motion — es liegt im Einstieg', () => {
    // Bewusst DIREKT geprüft und nicht über den Graphen: in P0 importiert es
    // noch niemand, ein Graph-Lauf wäre hier also vakuum. Ab P4 gilt beides.
    expect(importiertMotion(lies('src', 'motionPresets.ts'))).toBe(false);
  });

  it('`MotionRoot.tsx` und `motionFeatures.ts` sind KEINE Einstiegs-Module', () => {
    const module = [...statischErreichbar('src/main.tsx')].map((d) => relative(root, d));
    expect(module, 'MotionRoot gehört in ein Lazy-Stück').not.toContain(
      'src/components/MotionRoot.tsx',
    );
    expect(module).not.toContain('src/motionFeatures.ts');
  });
});

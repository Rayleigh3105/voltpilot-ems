/**
 * **Der 375-px-WÄCHTER des Bereichs „Verlauf"** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §2 A-Kriterien, Paket P0).
 *
 * Er prüft AM STYLESHEET, was ein Browser-Beweis am gerenderten Bild misst:
 * jede Fläche, die man antippt, ist mindestens 44 px hoch. Beides zusammen —
 * der Beweis findet, was die Regel nicht kennt; die Regel hält, was der
 * Beweis einmal gefunden hat.
 *
 * ## Was als „antippbar" gilt
 *
 * Eine Regel, deren LETZTES Selektor-Glied ein `button`, ein `summary` oder
 * ein `[role=button]` ist — oder die selbst `cursor: pointer` setzt.
 * Ausdrücklich NICHT: Pseudo-Elemente (`::after` ist kein Ziel, es ist eine
 * Verzierung) und Nachfahren eines Knopfes (`summary svg` ist das Symbol IM
 * Knopf, nicht der Knopf).
 *
 * ## Was als „gross genug" gilt
 *
 * `min-height`/`height` ≥ 44 px auf der Regel selbst oder auf einer ihrer
 * Zustandsvarianten (`:hover`, `.is-active`, … erben ihre Größe von der
 * Grundregel), ODER das dokumentierte Overlay-Muster aus `Erloese.css`:
 * `position: absolute` + `inset: -Npx` auf einem Pseudo-Element.
 *
 * ## Die RATSCHE
 *
 * Wie beim Skala-Wächter: die umgestellten Flächen stehen streng auf `0`, die
 * übrigen auf ihrem gemessenen IST-Stand vom 03.09.2026, der NIE wachsen
 * darf. Jeder Eintrag > 0 nennt seine offenen Selektoren im Kommentar — wer
 * einen davon repariert, zieht die Zahl herunter.
 *
 * ⚠ EINE ZAHL WIRD NUR KLEINER.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Das Mindest-Tippziel (pro-rules · Touch Targets). */
const ZIEL = 44;

const BLAETTER: ReadonlyArray<{
  readonly reiter: string;
  readonly datei: string;
  readonly offen: number;
  /** Welche Selektoren die Zahl ausmachen — damit sie nicht anonym bleibt. */
  readonly bekannt: readonly string[];
}> = [
  // --- umgestellt (Variante C) ------------------------------------------
  { reiter: 'Erlöse', datei: 'components/Erloese.css', offen: 0, bekannt: [] },
  {
    reiter: 'Erlöse',
    datei: 'components/erloese/ErgebnisKarte.css',
    offen: 1,
    /* ⚠ KEIN Mangel, sondern die Grenze der statischen Prüfung: die
       Trefferfläche dieses `summary` ist sein einziges Kind `.vp-c-led-sum`
       (`min-height: 48px`, §3.2 (3) — im Browser-Beweis von P7 gemessen). Der
       Wächter liest Regeln, nicht den Baum, und kann die zwei nicht
       verbinden. Der Eintrag bleibt auf 1, damit ein ZWEITER, echter Fall
       hier auffällt. */
    bekannt: ['.vp-c-led-det > summary'],
  },
  { reiter: 'Erlöse', datei: 'components/ErloesKomposition.css', offen: 0, bekannt: [] },
  { reiter: 'Erlöse', datei: 'components/SteuerungFormel.css', offen: 0, bekannt: [] },
  { reiter: 'Erlöse', datei: 'components/PortfolioWelt.css', offen: 0, bekannt: [] },
  { reiter: 'Reiterleiste', datei: 'components/BereichTabs.css', offen: 0, bekannt: [] },
  // Die geteilten Bausteine des Bereichs (P2b) — von Anfang an auf 0.
  { reiter: 'Bausteine', datei: 'components/Aufklapper.css', offen: 0, bekannt: [] },
  { reiter: 'Bausteine', datei: 'components/VerlaufZustaende.css', offen: 0, bekannt: [] },
  // --- noch nicht umgestellt — Ratsche auf dem IST-Stand vom 03.09.2026 --
  {
    reiter: 'Messwerte',
    datei: 'components/Historie.css',
    offen: 4,
    bekannt: [
      '.vp-zl-jump input, .vp-zl-jump select',
      '.vp-zl-fehler > button',
      '.vp-zl-row > .vp-seg > button',
      '.vp-zeitleiste-mobil .vp-zl-row-1 > .vp-seg > button',
    ],
  },
  // P2a hat das Sheet gebaut und dabei die letzten zwei offenen Ziele dieses
  // Blattes geschlossen — die Ratsche geht damit auf 0 und nie wieder hoch.
  { reiter: 'Messwerte', datei: 'components/Verlauf.css', offen: 0, bekannt: [] },
  { reiter: 'Messwerte', datei: 'components/Messwerte.css', offen: 0, bekannt: [] },
  {
    reiter: 'Messwerte',
    datei: 'components/Ereignisse.css',
    offen: 1,
    /* ⚠ KEIN Mangel, sondern dieselbe Grenze der statischen Prüfung wie beim
       Erlöse-`summary`: `.vp-chart-clickable` ist das DIAGRAMM (260 px hoch,
       `.vp-chart.tall` in `index.css`), nicht ein Chip — der Wächter liest
       Regeln, nicht Höhen aus einem fremden Blatt. P3 hat die echten Ziele
       dieses Blattes geschlossen: die Ereignis-Chips tragen jetzt das
       44-px-Overlay und ihre Telefon-Grenze ist die Haus-Grenze 720. */
    bekannt: ['.vp-chart-clickable'],
  },
  // Die neuen Bausteine des Rumpfes (P3) — von Anfang an auf 0.
  { reiter: 'Messwerte', datei: 'components/VerlaufLedger.css', offen: 0, bekannt: [] },
  {
    reiter: 'Marktpreise',
    datei: 'components/Marktpreise.css',
    offen: 1,
    bekannt: ['.vp-mp-profi > summary'],
  },
  { reiter: 'Marktpreise', datei: 'preisFenster.css', offen: 0, bekannt: [] },
  {
    reiter: 'Marktpreise',
    datei: 'components/StrompreisStrip.css',
    offen: 1,
    bekannt: ['.vp-sp-link'],
  },
  {
    reiter: 'Prognose',
    datei: 'pages/Prognose.css',
    offen: 2,
    bekannt: ['.vp-pq-fold > summary', '.vp-pq-beleg > summary'],
  },
  { reiter: 'Wetter', datei: 'WeatherChart.css', offen: 0, bekannt: [] },
  {
    reiter: 'Nachbar',
    datei: 'components/Fahrplan.css',
    offen: 2,
    bekannt: ['.vp-strahl-seg', '.vp-sched-layer'],
  },
];

const blatt = Object.fromEntries(
  BLAETTER.map((b) => [b.datei, readFileSync(join(root, 'src', b.datei), 'utf8')]),
);

type Regel = { sel: string[]; rumpf: string };

/** Alle Regeln eines Blattes. ⚠ Kommentare zuerst RAUS — sie nennen Selektoren. */
function regeln(css: string): Regel[] {
  const out: Regel[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]
      .split(',')
      .map((t) => t.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (sel.length) out.push({ sel, rumpf: m[2] });
  }
  return out;
}

const istPseudoElement = (sel: string) => /::[a-z-]+$/.test(sel);

/** `summary svg` ist das Symbol IM Knopf, nicht der Knopf. */
function letztesGlied(sel: string): string {
  const t = sel.split(/[\s>+~]+/).filter(Boolean);
  return t.length ? t[t.length - 1] : '';
}

function istKnopf(sel: string): boolean {
  const g = letztesGlied(sel);
  return /^(button|summary)(?![\w-])/.test(g) || /\[role=["']?button/.test(g);
}

/** Ein Zustand erbt seine Größe von der Grundregel. */
function varianten(sel: string): string[] {
  const ohnePseudo = sel.replace(/:(hover|focus-visible|focus|active|disabled)\b/g, '');
  const ohneZustand = ohnePseudo.replace(/\.(is-[\w-]+|active|open|current|selected)\b/g, '');
  return [...new Set([sel, ohnePseudo, ohneZustand])];
}

/** Die Selektoren, denen dieses Blatt irgendwo ein Ziel ≥ 44 px gibt. */
function grossGenug(alle: Regel[]): Set<string> {
  const gross = new Set<string>();
  for (const { sel, rumpf } of alle) {
    const mh = /min-height:\s*(\d+)px/.exec(rumpf);
    const h = /(?:^|[;{])\s*height:\s*(\d+)px/.exec(rumpf);
    // Das Overlay-Muster aus `Erloese.css`: ein Pseudo-Element weitet die
    // Trefferfläche über den Text hinaus.
    const overlay = /position:\s*absolute/.test(rumpf) && /inset:\s*-\d+px/.test(rumpf);
    if ((mh && Number(mh[1]) >= ZIEL) || (h && Number(h[1]) >= ZIEL) || overlay) {
      for (const s of sel) gross.add(s.replace(/::(before|after)$/, '').trim());
    }
  }
  return gross;
}

/** Jede antippbare Regel ohne nachweisbares 44-px-Ziel. */
function offeneZiele(css: string): string[] {
  const alle = regeln(css);
  const gross = grossGenug(alle);
  const offen: string[] = [];
  for (const { sel, rumpf } of alle) {
    const echte = sel.filter((s) => !istPseudoElement(s));
    if (!echte.length) continue;
    const tippbar = /cursor:\s*pointer/.test(rumpf) || echte.some(istKnopf);
    if (!tippbar) continue;
    if (!echte.every((s) => varianten(s).some((v) => gross.has(v)))) offen.push(echte.join(', '));
  }
  return offen;
}

describe('Verlauf P0 · jede antippbare Fläche ist ≥ 44 px (Ratsche)', () => {
  for (const { reiter, datei, offen } of BLAETTER) {
    it(`${reiter} · ${datei} (erlaubt: ${offen})`, () => {
      const v = offeneZiele(blatt[datei]);
      expect(
        v.length,
        `${datei}: ${v.length} antippbare Regeln ohne 44-px-Ziel, erlaubt ${offen}\n  ` +
          v.join('\n  '),
      ).toBeLessThanOrEqual(offen);
    });
  }
});

describe('Verlauf P0 · die Ratsche selbst', () => {
  it('keine Zahl liegt über dem gemessenen Stand — sonst hätte sie Luft', () => {
    const zuHoch = BLAETTER.filter((b) => b.offen > offeneZiele(blatt[b.datei]).length).map(
      (b) => `${b.datei}: erlaubt ${b.offen}, ist ${offeneZiele(blatt[b.datei]).length}`,
    );
    expect(zuHoch, `Ratsche nachziehen:\n  ${zuHoch.join('\n  ')}`).toEqual([]);
  });

  it('jeder Eintrag > 0 nennt seine offenen Selektoren beim Namen', () => {
    for (const { datei, offen, bekannt } of BLAETTER) {
      expect(bekannt.length, `${datei}: ${offen} offen, aber ${bekannt.length} benannt`).toBe(offen);
    }
  });

  it('und die benannten sind wirklich die offenen — kein Eintrag altert still', () => {
    for (const { datei, bekannt } of BLAETTER) {
      expect([...offeneZiele(blatt[datei])].sort()).toEqual([...bekannt].sort());
    }
  });
});

describe('Verlauf P0 · das Overlay-Muster ist erkannt, nicht geraten', () => {
  /* Der Wächter darf nicht an einem Muster scheitern, das die Variante C
     absichtlich fährt: ein Textlink weitet seine Trefferfläche über ein
     Pseudo-Element statt über die Zeilenhöhe. Steht das Muster nicht mehr in
     `ErgebnisKarte.css`, prüft der Wächter oben etwas anderes als er meint. */
  it('`.vp-c-led-sek a::before` weitet den Textlink auf ≥ 44 px', () => {
    // ⚠ Die Regel steht als GRUPPE (`.vp-c-led-sek a::before, .vp-c-sp-sek …`);
    //   ein Muster, das `{` direkt hinter dem Selektor erwartet, findet sie nicht.
    const treffer = regeln(blatt['components/erloese/ErgebnisKarte.css']).filter((r) =>
      r.sel.includes('.vp-c-led-sek a::before'),
    );
    expect(treffer.length, 'das Overlay-Muster fehlt').toBe(1);
    const rumpf = treffer[0].rumpf;
    expect(rumpf).toMatch(/position:\s*absolute/);
    const inset = /inset:\s*-(\d+)px/.exec(rumpf);
    expect(inset, '`inset` der Trefferfläche fehlt').not.toBeNull();
    // 21 px Zeilenhöhe + 2 × 12 px = 45 px ≥ 44 px.
    expect(Number(inset![1])).toBeGreaterThanOrEqual(12);
  });
});

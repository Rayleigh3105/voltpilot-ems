import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Portal v3 · M7 — the copy guard.
 *
 * The customer surface speaks OUTCOMES, never internals (BUILD.md §4.4) and
 * uses the locked D3 dictionary (Gerät / Komponente / Messwert). This test
 * reads the customer-facing source files (`node:fs`, the `migration.test.ts`
 * teardown-guard precedent), strips comments, and fails if a forbidden word
 * has crept back into a rendered string — so a future edit that re-introduces
 * "Entität", "Messpunkt", "MILP" … in a customer view breaks CI here first.
 *
 * SCOPE (explicit, per the M7 gotcha): the technical/installer + admin +
 * flow-editor construction surfaces legitimately use operator vocabulary, so
 * they are excluded by path. Comments are stripped, so a German docstring
 * explaining the v2 entity model never trips the guard — only VISIBLE strings
 * are scanned.
 */

/** The portal source root (vitest runs in the `frontend/portal` root). */
const SRC = join(process.cwd(), 'src');

/**
 * Path fragments that are NOT the plain-customer surface, so they are allowed
 * to use operator vocabulary:
 *  - `pages/admin/` — the Portal-Admin console (DO-NOT-TOUCH).
 *  - `EntitaetenSection` — the installer/technical panel (M7 gates it behind
 *    `showTechnicalLayer()`; it is only ever rendered for a platform-admin).
 *  - `entities.ts` / `entitiesApi.ts` / `entityLabel` internals kept out only
 *    where they carry raw catalog vocabulary (`entities.ts`, `entitiesApi.ts`).
 *  - `channels.ts` — the raw-channel fallback (per the M7 gotcha).
 *  - `flows/` — the flow-graph editor is a power-user CONSTRUCTION surface; its
 *    validator/model messages reference entity IDs inherently (like the
 *    installer panel). Sweeping it is out of M7 scope.
 */
const EXCLUDED = [
  '/pages/admin/',
  // Die REINEN Schichten der Admin-Konsole. Sie liegen in `src/`, weil dort
  // die reinen Module wohnen - sie sind aber ausschließlich Zulieferer von
  // `pages/admin/*` und sprechen deshalb legitim Betreiber-Vokabular („Broker",
  // „Rollout", „Manifest"). Damit diese Ausnahme keine Lücke wird, PRÜFT der
  // Test unten, dass keine Kundenfläche sie importiert.
  '/adminEdgeUpdates.ts',
  '/adminFleet.ts',
  '/adminPulse.ts',
  '/onboardingFunnel.ts',
  '/adminVorlagen.ts',
  '/adminKomponentenFlotte.ts',
  '/adminGeraet.ts',
  // Anlagen-Zentrale Stufe 3 (PR 3a): der Nachfolger der aufgelösten
  // Installateur-Ansicht. Er spricht legitim Betreiber-Vokabular („Entität",
  // „Messpunkt") und wird - wie die Plattform-Sicht - NUR hinter dem EINEN Tor
  // gerendert; der Test unten prüft dieses Tor, statt es zu glauben.
  '/components/TechnischeKarten.tsx',
  '/entities.ts',
  '/entitiesApi.ts',
  '/channels.ts',
  '/flows/',
];

/**
 * Forbidden vocabulary in the customer surface (M7). Each is unambiguous German
 * jargon or an internal acronym — never legitimate customer copy.
 *
 * Deliberately NOT blanket-forbidden here (documented, not an oversight):
 *  - `Optimizer` — the German customer copy says „Optimierung"; „Optimizer"
 *    survives only as the admin Plattform PAGE name (`nav.ts`, adminOnly).
 *  - `Modul` — „Module" is legitimate customer copy for Solarmodule (Technik
 *    „N Module"); the value-module jargon is guarded in `moduleSurface.test.ts`.
 *  - `Quelle` as an entity noun — not regex-separable from the legitimate
 *    „Energiequelle" / „Quelle: Marktstammdaten"; the entity noun was already
 *    removed from the customer model in M6.
 */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /Entität/, why: 'D3: „Komponente" statt „Entität"' },
  { re: /Messpunkt/, why: 'D3: „Messwert"/„Messgerät" statt „Messpunkt"' },
  { re: /Mess-Einheit/, why: 'D3: keine „Mess-Einheit" in der Kundensicht' },
  { re: /Anlagenteil/, why: 'D3: „Komponente" statt „Anlagenteil"' },
  { re: /Flow-Dokument/, why: 'Ergebnissprache: kein „Flow-Dokument"' },
  { re: /\bMILP\b/, why: 'Ergebnissprache: kein „MILP" (sag „Optimierungsmodell")' },
  // Fahrplan-"Warum" (vp-fahrplan-why-design): the λ number is customer-named
  // "Wert gespeicherter Energie" - solver vocabulary never reaches customers.
  { re: /Schattenpreis/, why: 'Fahrplan-Warum: „Wert gespeicherter Energie" statt „Schattenpreis"' },
  { re: /\bDual(werte?|s)?\b/, why: 'Fahrplan-Warum: keine „Duals" in der Kundensicht' },
  { re: /\bBroker\b/, why: 'Ergebnissprache: kein „Broker"' },
  { re: /\bAngefragt\b/i, why: 'M3: kein „Angefragt" — jedes Profil ist ein direkter Schalter' },
  { re: /in Vorbereitung/, why: 'M3: kein „in Vorbereitung"' },
  { re: /VoltPilot richtet ein/, why: 'M3: keine „VoltPilot richtet ein"-Anfragewand' },
  // Naming Set A (Einheitsmodell, Captain-Entscheid E1): die Kapsel heißt
  // „Regeln", der Knopf „＋ Neue Regel". „Automation" war das technischere Wort
  // für dieselbe Sache und ist aus der Kundensicht verschwunden. Die
  // WORTGRENZE ist load-bearing: Bezeichner wie `AutomationRow` oder
  // „Geräte-Automatik" (ein eigener Cockpit-Block, kein Regel-Wort) bleiben
  // unberührt.
  { re: /\bAutomation(en)?\b/, why: 'Set A: „Regel" statt „Automation"' },
];

/** Every customer-facing portal source file (no tests, no excluded paths). */
/** JEDE Quelldatei - der Wächter über die Ausnahme braucht auch die ausgenommenen. */
function walk(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function customerFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...customerFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    const rel = full.slice(SRC.length).replace(/\\/g, '/');
    if (EXCLUDED.some((frag) => rel.includes(frag))) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip block, JSDoc, JSX and line comments so only VISIBLE code (string
 * literals + JSX text) is scanned; a JSX comment is a block comment wrapped in
 * braces, so the block-comment pass covers it. Over-stripping can only hide a
 * violation (a false negative), never invent one — acceptable for a guard whose
 * job is to catch a re-introduced word in normal copy. URLs (`://`) survive the
 * line-comment strip.
 */
function stripComments(code: string): string {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('copy guard: the customer surface uses the v3 dictionary', () => {
  it('scans a non-empty set of customer files (the walker is wired)', () => {
    // A sanity check so a broken walker cannot make the guard vacuously green.
    expect(customerFiles().length).toBeGreaterThan(20);
  });

  it('contains no forbidden vocabulary in any rendered string', () => {
    const violations: string[] = [];
    for (const file of customerFiles()) {
      const visible = stripComments(readFileSync(file, 'utf8'));
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      for (const { re, why } of FORBIDDEN) {
        const m = re.exec(visible);
        if (m) violations.push(`${rel}: „${m[0]}" — ${why}`);
      }
    }
    expect(violations, `Verbotenes Vokabular in der Kundensicht:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  /**
   * Der Wächter über die Ausnahme: die vier ausgenommenen reinen Schichten
   * dürfen NUR von der Admin-Konsole benutzt werden. Zöge sie eines Tages eine
   * Kundenfläche herein, wäre die Ausnahme still zu einem Loch geworden - und
   * genau das fällt hier auf, nicht erst im Portal.
   */
  it('the admin-only pure layers are really admin-only', () => {
    const adminOnly = [
      'adminEdgeUpdates',
      'adminFleet',
      'adminPulse',
      'onboardingFunnel',
      'adminVorlagen',
      'adminKomponentenFlotte',
      'adminGeraet',
    ];
    // PR 1f (Anlagen-Zentrale Stufe 1): die Plattform-Sicht wohnt seither
    // ADDITIV auf der KUNDEN-Geräteseite - hinter dem EINEN Rollen-Tor
    // `showTechnicalLayer()` (das M7-Muster der Installateur-Ansicht). Genau
    // diese zwei Dateien dürfen die reinen Schichten deshalb hereinziehen;
    // damit die Ausnahme kein Loch wird, wird das Tor GEPRÜFT statt geglaubt.
    const GATE = 'showTechnicalLayer(';
    const ADMIN_BLOCK = 'components/AdminGeraetKarten.tsx';
    const rollenGehostet = [
      ADMIN_BLOCK,
      'pages/GeraetSeiteSection.tsx',
      // Geräteseiten Stufe 1: die BOX hat ihre eigene Gattung - und trägt die
      // Plattform-Sicht nach demselben Muster (dasselbe Tor, derselbe Block).
      'pages/BoxSeiteSection.tsx',
    ];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel.includes('.test.')) continue;
      // Die Admin-Konsole selbst und die vier Module untereinander dürfen.
      if (rel.startsWith('pages/admin/') || rel.startsWith('admin/')) continue;
      if (adminOnly.some((m) => rel === `${m}.ts`)) continue;
      const code = readFileSync(file, 'utf8');
      // ⚠ Auf dem KOMMENTAR-freien Text: ein Tor, das nur in einem Kommentar
      // erwähnt wird, ist keines (beim Mutationstest genau so aufgefallen).
      const gated = stripComments(code).includes(GATE);
      for (const m of adminOnly) {
        if (!new RegExp(`from '[^']*\\b${m}'`).test(code)) continue;
        // Der Block SELBST ist die Plattform-Sicht; seine Wirte tragen das Tor.
        if (rel === ADMIN_BLOCK) continue;
        if (rollenGehostet.includes(rel) && gated) continue;
        offenders.push(`${rel} importiert ${m}`);
      }
      // Und wer die Plattform-Sicht RENDERT, muss das Tor tragen.
      if (/from '[^']*\bAdminGeraetKarten'/.test(code) && !gated) {
        offenders.push(`${rel} rendert die Plattform-Sicht OHNE ${GATE})`);
      }
      // Dasselbe für die aufgelöste Installateur-Ansicht (Stufe 3): sie ist
      // vom Copy-Wächter ausgenommen, also darf sie nur hinter dem Tor
      // gerendert werden - sonst wäre die Ausnahme still ein Loch.
      if (/from '[^']*\bTechnischeKarten'/.test(code) && !gated) {
        offenders.push(`${rel} rendert die technische Sicht OHNE ${GATE})`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('would fail on a re-introduced forbidden word (the guard actually bites)', () => {
    // Every pattern matches its own bare word, so a real regression is caught.
    for (const { re } of FORBIDDEN) {
      const bareWord = re.source.replace(/\\b/g, '');
      expect(re.test(bareWord)).toBe(true);
    }
    // A forbidden word in a normal string literal IS caught…
    expect(stripComments('const x = "Entität";')).toMatch(/Entität/);
    // …while the same word inside a comment is NOT (it is stripped first).
    expect(stripComments('// erklärt die Entität\nconst x = "ok";')).not.toMatch(/Entität/);
    expect(stripComments('/** Entität */\nconst x = "ok";')).not.toMatch(/Entität/);
    // A JSX comment is stripped too.
    expect(stripComments('return <div>{/* Entität */}ok</div>;')).not.toMatch(/Entität/);
  });
});

/* ---------------------------------------------------------------------------
 * K4 · Der Klartext-Wächter über den CHART-Beschriftungen
 *
 * Der Wächter oben prüft das gesperrte D3-Vokabular (Gerät/Komponente/
 * Messwert). Eine Achse, eine Legendenzeile und ein Tooltip sind aber ebenso
 * Kundencopy — nur eine Ebene tiefer, und sie standen bis Stufe 1 des
 * Chart-Redesigns unter gar keinem Wächter. Die Ersetzungen selbst leben in
 * `src/chartCopy.ts`; hier wird gemessen, dass sie eingehalten sind.
 * ------------------------------------------------------------------------- */

/** Die Kunden-Chart-Flächen (die Admin-Charts sprechen legitim Betreiber-Vokabular). */
const CHART_FILES = [
  'ScheduleChart.tsx',
  'HistoryChart.tsx',
  'TelemetryChart.tsx',
  'WeatherChart.tsx',
  'PriceHistoryChart.tsx',
  'ForecastQualityChart.tsx',
  'components/VerlaufChart.tsx',
  'components/ErloeseVerlaufChart.tsx',
  'components/PeakHistoryChart.tsx',
  // Das Tagesbild (Stufe 3) - seine Beschriftungen leben in der reinen Regel,
  // also steht die Regel-Datei hier gleichberechtigt neben dem Render.
  'components/Tagesbild.tsx',
  'tagesbild.ts',
];

const CHART_FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\bSoC\b/, why: 'K4: „Ladestand" statt „SoC"' },
  { re: /State of Charge/i, why: 'K4: „Ladestand" statt „State of Charge"' },
  { re: /Day-?Ahead/i, why: 'K4: „Börsenpreis" statt „Day-Ahead"' },
  { re: /\bSpot(preis|-Preis)?\b/i, why: 'K4: „Börsenpreis" statt „Spot"' },
  // Das Fallenwort: im Energie-Portal liest sich „Viertel" als VIERTELSTUNDE.
  // Wer ein Tages-Quartil meint, schreibt die Zeitspanne aus.
  { re: /günstigste[sn]? Viertel|teuerste[sn]? Viertel/i, why: 'K4: „Viertel" liest sich als Viertelstunde' },
];

/**
 * Eine Achsen-BESCHRIFTUNG, die nur aus einer Einheit besteht. kW sagt nicht,
 * WAS gemessen wird, und kW (Leistung) neben kWh (Energie) unkommentiert zu
 * mischen ist die häufigste Verwechslung im Energie-Portal — deshalb komponiert
 * `chartCopy.axisName` „Leistung (kW)". Die SCHMALE Fassung darf die Einheit
 * allein tragen (dort ist kein Platz), und die steht immer hinter einem
 * `narrow ?`, also nie in dieser Form.
 */
const BARE_UNIT_AXIS = /name:\s*'(kW|kWh|%|ct\/kWh|EUR\/MWh|°C|W\/m²|€)'/;

describe('K4 · Klartext-Wächter über den Chart-Beschriftungen', () => {
  it('scannt die Chart-Dateien wirklich (der Wächter ist verdrahtet)', () => {
    for (const rel of CHART_FILES) {
      expect(() => readFileSync(join(SRC, rel), 'utf8'), rel).not.toThrow();
    }
  });

  it('nennt kein Fachwort in einer sichtbaren Chart-Beschriftung', () => {
    const violations: string[] = [];
    for (const rel of CHART_FILES) {
      const visible = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      for (const { re, why } of CHART_FORBIDDEN) {
        const m = re.exec(visible);
        if (m) violations.push(`${rel}: „${m[0]}" — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('lässt keine Einheit als Achsennamen allein stehen', () => {
    const violations: string[] = [];
    for (const rel of CHART_FILES) {
      const visible = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      const m = BARE_UNIT_AXIS.exec(visible);
      if (m) violations.push(`${rel}: ${m[0]} — K4: die Einheit steht nie allein`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('beisst wirklich (beide Muster gegen ihren eigenen Fall geprüft)', () => {
    expect(CHART_FORBIDDEN.some(({ re }) => re.test("name: 'SoC'"))).toBe(true);
    expect(CHART_FORBIDDEN.some(({ re }) => re.test('das günstigste Viertel'))).toBe(true);
    expect(BARE_UNIT_AXIS.test("name: 'kW',")).toBe(true);
    // …und die zulässigen Formen NICHT: die komponierte Beschriftung und die
    // schmale Fassung, die die Einheit hinter einem `narrow ?` allein trägt.
    expect(BARE_UNIT_AXIS.test("name: 'Leistung (kW)',")).toBe(false);
    expect(BARE_UNIT_AXIS.test("name: narrow ? 'kW' : 'Leistung (kW)',")).toBe(false);
  });
});

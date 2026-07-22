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
  '/pages/EntitaetenSection.',
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
  { re: /\bBroker\b/, why: 'Ergebnissprache: kein „Broker"' },
  { re: /\bAngefragt\b/i, why: 'M3: kein „Angefragt" — jedes Profil ist ein direkter Schalter' },
  { re: /in Vorbereitung/, why: 'M3: kein „in Vorbereitung"' },
  { re: /VoltPilot richtet ein/, why: 'M3: keine „VoltPilot richtet ein"-Anfragewand' },
];

/** Every customer-facing portal source file (no tests, no excluded paths). */
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

/**
 * **Der GRÖSSEN-WÄCHTER der drei Wegweiser** (Projekt-Gedächtnis, 05.09.2026).
 *
 * Claude Code lädt `CLAUDE.md` → `AGENTS.md` bei JEDEM Sitzungsstart in den Kontext,
 * und beim Arbeiten in `frontend/portal` zusätzlich dessen `CLAUDE.md`. Am 05.09.2026
 * waren die drei Dateien auf 1,17 MB / 765 KB / 356 KB angewachsen und haben vier
 * Worker binnen Minuten an der Kontextgrenze sterben lassen — bei 28 Werkzeugaufrufen
 * und 32 KB Werkzeugausgabe. Seither ist jede der drei ein WEGWEISER; jedes Detail
 * wohnt byte-verbatim in `docs/agents/` und wird über den Themen-Index gefunden.
 *
 * Dieser Test ist die Portal-Hälfte des Wächters und fährt dieselbe Prüfung wie
 * `tools/agents-md-budget.sh` (das Matrix-Leg `agents-md` in `deploy.yaml`) — hier,
 * weil `npm test` der Weg ist, den eine Portal-Sitzung ohnehin geht.
 *
 * ⚠ **Die Budget-Zahl wird nur KLEINER, nie größer.** Wer sie anhebt, hat den
 * Wächter abgeschafft, nicht bestanden. Ein neuer Abschnitt zieht nach
 * `docs/agents/<bereich>/<slug>.md` und bekommt EINE Zeile im Themen-Index.
 *
 * Das Muster ist der quellenlesende Text-Wächter (`motionTokens.test.ts`,
 * `keineSeitenleisten.test.ts`): er liest die AUSGELIEFERTEN Dateien, nicht ein Modell
 * davon, und er ist mutationsgeprüft (Budget künstlich auf 1 gesetzt ⇒ er fällt).
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** `frontend/portal` → Repo-Wurzel. */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Dieselben Zahlen wie `tools/agents-md-budget.sh` — der Test liest sie von dort. */
const budgets = (): Array<[string, number]> => {
  const sh = readFileSync(join(repo, 'tools', 'agents-md-budget.sh'), 'utf8');
  const block = sh.slice(sh.indexOf('BUDGETS=('), sh.indexOf(')', sh.indexOf('BUDGETS=(')));
  return [...block.matchAll(/"([^":]+):(\d+)"/g)].map(([, f, b]) => [f, Number(b)]);
};

describe('Projekt-Gedächtnis · die drei AGENTS.md bleiben Wegweiser', () => {
  const list = budgets();

  it('der Wächter kennt genau die drei Dateien, die bei Sitzungsstart geladen werden', () => {
    expect(list.map(([f]) => f)).toEqual([
      'AGENTS.md',
      'frontend/portal/AGENTS.md',
      'edge-app/AGENTS.md',
    ]);
  });

  for (const [file, budget] of list) {
    it(`${file} bleibt unter ${budget} B`, () => {
      const bytes = statSync(join(repo, file)).size;
      expect(bytes, `${file} ist ${bytes} B — Detail gehört nach docs/agents/`).toBeLessThanOrEqual(
        budget,
      );
    });
  }

  it('jeder Wegweiser trägt seinen Themen-Index und die Umzugs-Regel', () => {
    for (const [file] of list) {
      const text = readFileSync(join(repo, file), 'utf8');
      expect(text, file).toContain('## Themen-Index (der ausgelagerte Bestand)');
      expect(text, file).toContain('## Maintaining this file');
      expect(text, file).toContain('docs/agents/');
    }
  });

  it('der ausgelagerte Bestand ist da und hat sein Inhaltsverzeichnis', () => {
    const toc = readFileSync(join(repo, 'docs', 'agents', 'README.md'), 'utf8');
    for (const bereich of ['root/', 'portal/', 'edge/']) {
      expect(toc).toContain(`## \`${bereich}\``);
    }
  });
});

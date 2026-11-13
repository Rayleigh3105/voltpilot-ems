import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PORTAL_ROOT, statischErreichbar } from './test/statischErreichbar';

/**
 * Der schnelle Zwilling von `test/bundle-smoke.sh` für die Stücke, die der Einstieg NICHT tragen darf
 * (Wartungs-Auftrag „Luft im Einstieg", Gemessen: 258,00 → 243,6 kB gz).
 *
 * Jedes Stück hier hing zuvor durch EINEN kleinen Aufruf im ersten Bild und zog sein ganzes Fach-Modul
 * mit - Rollup beschneidet ein Modul mit Top-Level-Code (Tabellen, `new Set`, JSON) nicht, auch wenn
 * der Einstieg nur eine Zeile braucht. Die Gegenprobe am echten Artefakt ist der Bündel-Wächter; dieser
 * Test läuft in Millisekunden bei jedem Lauf und nennt den Import, der das Stück zurückholt.
 *
 * Nur STATISCHE Wertimporte zählen: `import()` ist die Lazy-Grenze, `import type` wird vom Bauen
 * gelöscht.
 */

const root = PORTAL_ROOT;
const erreichbar = statischErreichbar;

/** Stück → warum es nicht in den Einstieg gehört. */
const NICHT_IM_EINSTIEG: Record<string, string> = {
  'src/components/EigeneAuswertungDialog.tsx':
    'öffnet nur aus dem Anpassen-Modus; `AnlagenPage.tsx` lädt es per `lazy` nach',
  'src/komponenten.ts':
    'das Komponenten-Fachmodul (Rollen, Boards); der Einstieg braucht nur `toComponentHealth` aus `komponentenHealth.ts`',
  'src/verlauf.ts':
    'der Messwert-Baum des Verlaufs; der Einstieg braucht nur `V1_ENTITY` aus `verlaufEntity.ts`',
  'src/strompreis.ts':
    'die Ableitung des Börsenpreis-Streifens (Film-Wortlaut, Preisfenster, Bezugspreis); die Anlagen-Seite braucht nur das Tor aus `strompreisGate.ts`',
  'src/fahrplanFilm.ts': 'hängt allein an `strompreis.ts`',
  'src/preisFenster.ts': 'hängt allein an `strompreis.ts`',
};

describe('Einstieg-Luft · Stücke, die das erste Bild nicht trägt', () => {
  const weg = erreichbar('src/main.tsx');

  it('der Lauf hat den Einstieg wirklich gefunden (nicht vakuum)', () => {
    expect(weg.size).toBeGreaterThan(50);
    expect([...weg.keys()].map((d) => relative(root, d))).toContain('src/pages/AnlagenPage.tsx');
  });

  for (const [stueck, grund] of Object.entries(NICHT_IM_EINSTIEG)) {
    it(`${stueck} ist kein Einstiegs-Modul`, () => {
      const datei = resolve(root, stueck);
      expect(
        weg.has(datei),
        `${stueck} liegt wieder im Einstieg (${grund}). Importiert von ${relative(root, weg.get(datei) ?? '')}.\n` +
          'Der Bündel-Wächter (`test/bundle-smoke.sh`) misst, was das kostet.',
      ).toBe(false);
    });
  }

  it('die winzigen Zwillinge stehen im Einstieg und reichen ihre Sachen weiter', () => {
    const gesehen = [...weg.keys()].map((d) => relative(root, d));
    expect(gesehen).toContain('src/komponentenHealth.ts');
    expect(gesehen).toContain('src/verlaufEntity.ts');
    expect(gesehen).toContain('src/strompreisGate.ts');
    // Die alten Namen bleiben erreichbar (Aufrufer und Tests ändern sich nicht).
    expect(readFileSync(resolve(root, 'src/komponenten.ts'), 'utf8')).toMatch(
      /export \{ toComponentHealth, type ComponentHealth \}/,
    );
    expect(readFileSync(resolve(root, 'src/verlauf.ts'), 'utf8')).toMatch(/export \{ V1_ENTITY \}/);
    expect(readFileSync(resolve(root, 'src/strompreis.ts'), 'utf8')).toMatch(/export \{ gateStrompreis \}/);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Keine Seitenleisten** (Captain-Entscheid 04.09.2026, wörtlich: „search for
 * sidebars. I dont want them in my project. Every Sidebar should be a modal.").
 *
 * Jede Formular- und Detailfläche des Portals ist das zentrierte
 * Design-System-`Modal`; das rechts einfahrende `Drawer` ist ersatzlos darin
 * aufgegangen. Dieser Wächter verhindert die Rückkehr — sowohl über den alten
 * Bausteinnamen als auch über eine handgebaute, seitlich verankerte
 * Vollhöhen-Fläche.
 *
 * ⚠ ER LIEST DEN ROHEN TEXT, KOMMENTARE EINGESCHLOSSEN, denn ein „so machen
 * wir es wieder"-Kommentar ist genau der Weg zurück, den er zumachen soll.
 * Wer eine Datei ergänzt, trägt sie hier NICHT ein — die Liste ist der Baum,
 * die Ausnahmen sind die drei benannten Flächen unten.
 */
const ROOT = process.cwd() + '/';
const SRC = join(ROOT, 'src');
const DS = join(ROOT, 'designsystem');

function dateien(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...dateien(full));
    } else if (/\.(tsx?|jsx?|css)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// Der Wächter selbst nennt die verbotenen Namen naturgemäß — er prüft sie.
const ALLE = [...dateien(SRC), ...dateien(DS)].filter(
  (f) => !f.endsWith('keineSeitenleisten.test.ts'),
);
const kurz = (f: string) => f.slice(ROOT.length);

/**
 * Die drei Flächen, die bewusst KEINE Modale sind — sie tragen kein Formular
 * und keine Detailansicht:
 *  - die linke HAUPTNAVIGATION der Schale (`.vp-sidebar`) — sie ist die
 *    App-Schale selbst, nicht eine Aufgabe darin,
 *  - das Desktop-Rail des Messwerte-Explorers (`.vp-verlauf-rail`) — eine
 *    dauerhaft sichtbare Auswahlliste neben dem Diagramm,
 *  - das `BottomSheet` — die Telefon-Form, die von UNTEN kommt.
 */
const AUSNAHMEN = [
  'src/shell/Shell.css',
  'src/index.css',
  'src/components/BottomSheet.tsx',
  'src/components/VerlaufExplorer.css',
];

describe('Keine Seitenleisten im Portal', () => {
  it('kennt den Bausteinnamen `Drawer` nirgends mehr', () => {
    const treffer = ALLE.filter((f) =>
      /shell\/Drawer|<Drawer[\s/>]|import\s*\{[^}]*\bDrawer\b[^}]*\}/.test(readFileSync(f, 'utf8')),
    ).map(kurz);
    expect(treffer).toEqual([]);
  });

  it('kennt die Klasse `vp-drawer` nirgends mehr', () => {
    const treffer = ALLE.filter((f) => /vp-drawer/.test(readFileSync(f, 'utf8'))).map(kurz);
    expect(treffer).toEqual([]);
  });

  it('baut keine seitlich verankerte Vollhöhen-Fläche mehr nach', () => {
    // `position: fixed` + eine Seitenkante auf 0 + volle Bildschirmhöhe: das
    // IST eine Seitenleiste, egal wie ihre Klasse heißt.
    const treffer: string[] = [];
    for (const f of ALLE.filter((x) => x.endsWith('.css'))) {
      if (AUSNAHMEN.some((a) => kurz(f) === a)) continue;
      for (const regel of readFileSync(f, 'utf8').split('}')) {
        const fixed = /position:\s*fixed/.test(regel);
        const kante = /(^|[;{\s])(left|right):\s*0/.test(regel);
        const hoch = /height:\s*100(vh|dvh)/.test(regel);
        if (fixed && kante && hoch) {
          treffer.push(`${kurz(f)}: ${regel.trim().split('\n')[0]}`);
        }
      }
    }
    expect(treffer).toEqual([]);
  });

  it('das Modal des Design-Systems ist zentriert und kein `aside`', () => {
    const jsx = readFileSync(join(DS, 'components/shell/Modal.jsx'), 'utf8');
    expect(jsx).not.toMatch(/<aside/);
    expect(jsx).toMatch(/createPortal/);
    const css = readFileSync(join(DS, 'components/shell/shell.css'), 'utf8');
    const block = css.slice(css.indexOf('.vp-modal-scrim'), css.indexOf('.vp-modal .dhead'));
    expect(block).toMatch(/place-items:\s*center/);
    expect(block).not.toMatch(/(^|[;{\s])(left|right):\s*0/);
  });
});

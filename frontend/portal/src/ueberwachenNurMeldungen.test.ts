import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **„Überwachen“ wohnt nur unter Meldungen** (Konzept b1, Entscheid E3 vom 20.10.2026).
 *
 * Vorher bot jede Fläche „Überwachen“ direkt am Wert an (Menü ⋯ und Marke „überwacht“ im Cockpit,
 * an Geräteseite, Aufbau, Messstelle, Kennzahl und Energieziel; Alerting Scheiben 2 und 5). Das sah
 * der Captain als fremd und unruhig an: eine Überwachung entsteht jetzt nur noch unter
 * Meldungen › Überwachungen („+ Überwachung“: Ort, Wert, dann das Blatt „Überwachen“). Der einzige
 * zweite Weg ist das Umwandeln einer Steuerungsregel (Alerting Scheibe 6, Entscheid 10A) - dort
 * entsteht die Überwachung aus einer Regel, nicht an einem Wert.
 *
 * Dieser Wächter liest die Quellen als Text (wie der frühere `wertverweisWaechter.test.ts`, den er
 * ersetzt) und hält die Entscheidung fest, damit kein neuer Wert-Baustein sie still zurückholt.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

function dateien(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'test') continue;
      out.push(...dateien(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const QUELLEN = dateien(SRC).map((f) => ({ datei: f.slice(SRC.length + 1).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

/** Wer das Blatt „Überwachen“ öffnen darf - und warum. */
const BLATT_ERLAUBT: Record<string, string> = {
  'pages/MeldungenPage.tsx': '„+ Überwachung“ unter Meldungen › Überwachungen',
  'steuerung/SteuerungSeite.tsx': '„In Überwachung umwandeln“ an einer Steuerungsregel (Scheibe 6, Entscheid 10A)',
};

describe('Konzept b1 E3 · „Überwachen“ nur unter Meldungen', () => {
  it('nur Meldungen und das Umwandeln einer Steuerungsregel öffnen das Blatt „Überwachen“', () => {
    const oeffnen = QUELLEN.filter(({ datei, text }) =>
      datei !== 'components/UeberwachenBlatt.tsx' && /import\(?['"][^'"]*\/UeberwachenBlatt['"]|from ['"][^'"]*\/UeberwachenBlatt['"]/.test(text)
      && !/^import type /m.test(text.match(/.*UeberwachenBlatt['"].*/)?.[0] ?? ''),
    ).map((q) => q.datei);
    expect(oeffnen.sort()).toEqual(Object.keys(BLATT_ERLAUBT).sort());
  });

  it('keine Fläche bietet „Überwachen“ als Menüpunkt an einem Wert an', () => {
    const menue = QUELLEN.filter(({ text }) => /label:\s*WORT_UEBERWACHEN\b/.test(text)).map((q) => q.datei);
    expect(menue).toEqual([]);
  });

  it('die Wert-Zeile („Überwachen“ + Marke „überwacht“) gibt es nicht mehr', () => {
    expect(existsSync(join(SRC, 'components/WertZeile.tsx'))).toBe(false);
    // („überwacht“ als Zustand eines Wächters, z. B. `adminGemeinsameSteuerung.ts`, ist etwas anderes.)
    expect(QUELLEN.filter(({ text }) => /\bWORT_UEBERWACHT\b|\bvp-wz-marke\b/.test(text)).map((q) => q.datei)).toEqual([]);
  });

  it('nur das Meldungs-Center liest die Liste der Überwachungen (keine Marke an einem Wert)', () => {
    const leser = QUELLEN.filter(({ text }) => /\.regeln\(\)/.test(text)).map((q) => q.datei);
    expect(leser).toEqual(['pages/MeldungenPage.tsx']);
  });
});

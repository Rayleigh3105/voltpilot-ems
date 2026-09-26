/**
 * **Der REGISTRIERUNGS-WÄCHTER der Diagramm-Schicht.**
 *
 * `src/echarts.ts` registriert von Hand, was die Flächen brauchen — der volle
 * `echarts`-Import würde Diagrammtypen mitschleppen, die das Portal nie
 * zeichnet. Der Preis dieser Sparsamkeit: ein Bauteil, das irgendwo GENANNT
 * und hier nicht registriert ist, ist kein fehlendes Detail, sondern ein
 * Absturz.
 *
 * Der belegte Fall (Konzept-Scout AP-01, 10.09.2026, Verlauf bei 375 px):
 * {@link REPLACE_MERGE} nennt `graphic` und `visualMap`, `echarts.ts`
 * registrierte beide nicht. ECharts prüft JEDEN Namen aus `replaceMerge` gegen
 * sein Bauteil-Register (`model/Global.js` `normalizeSetOptionInput` →
 * `assert(ComponentModel.hasClass(...))`) und wirft, BEVOR es zeichnet — also
 * stürzte jede Fläche ab, die über die Bewegungs-Hülle zeichnet (Verlauf,
 * Fahrplan, Komponenten, Einstellungen, Box).
 *
 * ⚠ Der `assert` steht hinter `NODE_ENV !== 'production'`: im Entwicklungs-
 * Server ist ein unregistrierter Name ein Absturz, im gebauten Bündel ein
 * STILLES Nichtstun. Beide Hälften sind falsch, und nur dieser Test macht die
 * Frage unabhängig vom Bau-Modus sichtbar.
 *
 * Er stellt dieselbe Frage wie ECharts selbst, nur ohne Zeichenfläche. Die
 * Hülle selbst (dass `setOption(opt, true)` zu `replaceMerge` wird) prüft
 * `chartFamilien.test.ts` — hier geht es allein um das Register.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ComponentModel from 'echarts/lib/model/Component.js';
import './echarts';
import { REPLACE_MERGE } from './chartMotion';

/** Die Frage, die ECharts in `normalizeSetOptionInput` selbst stellt. */
const registriert = (mainType: string): boolean =>
  (ComponentModel as unknown as { hasClass(t: string): boolean }).hasClass(mainType);

describe('ECharts-Bauteile: registriert ist, was benutzt wird', () => {
  it('jeder Name aus REPLACE_MERGE ist registriert — sonst wirft `setOption`', () => {
    const fehlend = REPLACE_MERGE.filter((t) => !registriert(t));
    expect(fehlend).toEqual([]);
  });

  it('die Bauteile, die die Flächen im Options-Objekt nennen, sind registriert', () => {
    // Was die Diagramme des Portals tatsächlich setzen: Reihen, Raster, Achsen,
    // Zeiger, Legende, Titel, Zoom-Streifen. `aria` steht bewusst nicht dabei:
    // es ist kein `ComponentModel`-Haupttyp und darf deshalb auch nie in
    // REPLACE_MERGE stehen.
    for (const t of [
      'series', 'grid', 'xAxis', 'yAxis', 'tooltip', 'legend', 'title', 'dataZoom',
      'graphic',
    ]) {
      expect(registriert(t), `${t} ist nicht registriert`).toBe(true);
    }
  });

  it('kein Diagramm setzt ein Bauteil, das `echarts.ts` nicht registriert (V-01)', () => {
    // Die Gegenrichtung zum ersten Fall: `visualMap` ist seit dem UX-Review
    // V-01 (24.09.2026) nicht mehr registriert, weil ihn kein Diagramm setzt -
    // er kostete das Chart-Bündel 11,4 kB gz. Ein Options-Schlüssel ohne
    // Registrierung wird im gebauten Bündel still übergangen; die Ampel wäre
    // dann einfach nicht da. Wer ihn zurückbringt, registriert ihn in
    // `echarts.ts` und nennt ihn wieder in REPLACE_MERGE.
    const nichtRegistriert = ['visualMap'].filter((t) => !registriert(t));
    const SRC = join(process.cwd(), 'src');
    const quellen = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return quellen(full);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });
    const treffer: string[] = [];
    for (const file of quellen(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const t of nichtRegistriert) {
        if (new RegExp(`\\b${t}\\s*:`).test(text)) treffer.push(`${file.slice(SRC.length + 1)}: ${t}`);
      }
    }
    expect(treffer).toEqual([]);
  });
});

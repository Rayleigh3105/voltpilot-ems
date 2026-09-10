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
});

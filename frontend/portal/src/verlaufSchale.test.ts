import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Schalen-Paket S1 · die drei klebenden Leisten stapeln sich, sie überlappen
 * nicht (Konzept `vp-verlauf-sprache-konzept-v5` §6 Schalen-Kasten S1,
 * Captain-Ja 03.09.2026, wörtlich „ja, klebend").
 *
 * ⚠ Die Arithmetik ist über DREI Dateien verteilt, und keine kennt die andere:
 * die Kopfzeile ist 68 px hoch (`index.css`), die Bereichs-Reiter kleben
 * darunter und messen 44 px + 1 px Linie (`BereichTabs.css`), die Zeit-Leiste
 * klebt bei 68 + 45 = 113 px (`BereichTabs.css` setzt den Knopf, `Historie.css`
 * liest ihn). Wer eine der Höhen anfasst, ohne die Summe nachzuziehen, erzeugt
 * entweder eine Lücke, durch die der Inhalt scrollt, oder eine Überlappung —
 * beides ist am Telefon nur im Browser zu sehen. Dieser Test rechnet es nach.
 *
 * Er liest den AUSGELIEFERTEN Text der drei Blätter, nicht eine Kopie der
 * Zahlen: eine Kopie könnte selbst veralten.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (p: string) => readFileSync(join(root, 'src', p), 'utf8');

/** Die erste `<eigenschaft>: <n>px`-Angabe im Block hinter `selektor`. */
function pxIn(css: string, selektor: string, eigenschaft: string): number {
  const start = css.indexOf(selektor);
  expect(start, `${selektor} fehlt`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('}', start));
  const treffer = block.match(new RegExp(`${eigenschaft}:\\s*(\\d+)px`));
  expect(treffer, `${eigenschaft} in ${selektor} fehlt`).not.toBeNull();
  return Number(treffer![1]);
}

describe('Verlauf S1 · die klebenden Leisten stapeln sich lückenlos', () => {
  const index = lies('index.css');
  const tabs = lies('components/BereichTabs.css');
  const historie = lies('components/Historie.css');

  const kopfzeile = pxIn(index, '.vp-topbar {', 'height');
  const reiter = pxIn(tabs, '.vp-bereich-tab {', 'min-height');
  // Die Linie unter der Leiste zählt zu ihrer Höhe (`border-box` gilt hier
  // nicht — `.vp-bereich-tabs` hat keine feste Höhe, sie wächst um den Rand).
  const linie = Number(
    tabs.match(/\.vp-bereich-tabs\s*\{[\s\S]*?border-bottom:\s*(\d+)px/)![1],
  );

  it('die Reiter kleben genau unter der Kopfzeile', () => {
    const start = tabs.indexOf('@media (max-width: 720px)');
    expect(pxIn(tabs.slice(start), '.vp-bereich-tabs {', 'top')).toBe(kopfzeile);
  });

  it('die Zeit-Leiste klebt genau unter den Reitern — keine Lücke, keine Überlappung', () => {
    const gesetzt = Number(tabs.match(/--vp-zeitleiste-top:\s*(\d+)px/)![1]);
    expect(gesetzt).toBe(kopfzeile + reiter + linie);
  });

  it('ohne Reiter fällt die Zeit-Leiste auf die Kopfzeile zurück, nie auf deren Summe', () => {
    // `tabsFor` schweigt bei höchstens EINEM Reiter (BereichTabs.tsx), dort
    // dürfte die Leiste nicht 45 px unter der Kopfzeile schweben.
    const rueckfall = Number(
      historie.match(/top:\s*var\(--vp-zeitleiste-top,\s*(\d+)px\)/)![1],
    );
    expect(rueckfall).toBe(kopfzeile);
    expect(tabs).toMatch(/\.vp-main:has\(\.vp-bereich-tabs\)/);
  });

  it('die z-Ordnung ist Kopfzeile > Reiter > Zeit-Leiste', () => {
    const z = (css: string, sel: string) => {
      const start = css.indexOf(sel);
      return Number(css.slice(start, css.indexOf('}', start)).match(/z-index:\s*(\d+)/)![1]);
    };
    const zKopf = z(index, '.vp-topbar {');
    const zReiter = z(tabs.slice(tabs.indexOf('@media (max-width: 720px)')), '.vp-bereich-tabs {');
    const zLeiste = z(historie, '.vp-zeitleiste {');
    expect(zKopf).toBeGreaterThan(zReiter);
    expect(zReiter).toBeGreaterThan(zLeiste);
  });

  it('die klebende Leiste ist undurchsichtig — sonst scrollt der Inhalt hindurch', () => {
    const phone = tabs.slice(tabs.indexOf('@media (max-width: 720px)'));
    const block = phone.slice(phone.indexOf('.vp-bereich-tabs {'), phone.indexOf('}'));
    expect(block).toMatch(/background:\s*var\(--vp-c-bg/);
    // und der Grund reicht über die Seitenpolsterung von `.vp-main` hinaus,
    // sonst liefe der Inhalt in den Rinnen neben der Leiste vorbei.
    expect(block).toMatch(/box-shadow:[\s\S]*--vp-c-bg/);
  });

  it('am Rechner ändert sich nichts — das Kleben steht NUR im Telefon-Block', () => {
    const vorDemBlock = tabs.slice(0, tabs.indexOf('@media (max-width: 720px)'));
    expect(vorDemBlock).not.toMatch(/position:\s*sticky/);
    expect(vorDemBlock).not.toMatch(/--vp-zeitleiste-top/);
  });
});

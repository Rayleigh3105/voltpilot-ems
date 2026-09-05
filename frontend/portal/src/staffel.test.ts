import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mitStaffel, staffelGesehen, staffelZuruecksetzen, useStaffel } from './staffel';

/**
 * **Bewegung P6 · die Listen-Staffel** (Konzept
 * `data/vp-motion-konzept-m1/report.md` §6 Zeile „Listen/Karten": „260 ms,
 * 30 ms je Zeile, Deckel 8; beim Nachladen nur neue Zeilen; nie beim zweiten
 * Besuch").
 *
 * Die Aufteilung ist die Sache: CSS staffelt, das Modul ERINNERT. Beides wird
 * hier geprüft — die Erinnerung am Verhalten, der Deckel am ausgelieferten
 * Blatt (jsdom rechnet keine Kaskade, ein DOM-Test bewiese nichts).
 */
const index = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'index.css'),
  'utf8',
);

describe('useStaffel · nie beim zweiten Besuch', () => {
  beforeEach(() => staffelZuruecksetzen());

  it('gibt die Klasse beim ERSTEN Besuch und danach nie wieder', () => {
    const erste = renderHook(() => useStaffel('portfolio-anlagen'));
    expect(erste.result.current).toBe('vp-stagger');
    erste.unmount();

    const zweite = renderHook(() => useStaffel('portfolio-anlagen'));
    expect(zweite.result.current).toBe('');
  });

  it('hält die Entscheidung über die Lebensdauer EINER Instanz fest', () => {
    const { result, rerender } = renderHook(() => useStaffel('steuerung-regeln'));
    expect(result.current).toBe('vp-stagger');
    // Ein Neuzeichnen derselben Fläche (Filter, Nachladen) staffelt NICHT neu
    // und nimmt der laufenden Staffel auch nicht mitten im Lauf die Klasse weg.
    rerender();
    rerender();
    expect(result.current).toBe('vp-stagger');
  });

  it('zählt Listen einzeln — eine gesehene sperrt die andere nicht', () => {
    renderHook(() => useStaffel('portfolio-anlagen'));
    const andere = renderHook(() => useStaffel('ladevorgaenge'));
    expect(andere.result.current).toBe('vp-stagger');
    expect(staffelGesehen('portfolio-anlagen')).toBe(true);
  });

  it('merkt sich die Liste erst NACH dem Rendern (kein Seiteneffekt im Render)', () => {
    expect(staffelGesehen('spaet')).toBe(false);
    const { unmount } = renderHook(() => useStaffel('spaet'));
    expect(staffelGesehen('spaet')).toBe(true);
    unmount();
  });

  it('hängt die Klasse an, ohne doppelte Leerzeichen zu erzeugen', () => {
    expect(mitStaffel('vp-at-karten', 'vp-stagger')).toBe('vp-at-karten vp-stagger');
    expect(mitStaffel('vp-at-karten', '')).toBe('vp-at-karten');
  });
});

describe('.vp-stagger · 260 ms, 30 ms je Zeile, Deckel 8', () => {
  it('jedes Kind blendet in `--vp-motion-enter` mit `backwards` ein', () => {
    // Der Vorbehalt `:not([data-vp-no-stagger])` kam mit P4 dazu (siehe unten).
    const regel = /\.vp-stagger > \*(?::not\([^)]*\))? \{([^}]*)\}/.exec(index)?.[1] ?? '';
    expect(regel).toMatch(/animation:\s*vp-stagger-ein\s+var\(--vp-motion-enter\)/);
    // Ohne `backwards` stünde ein verzögertes Kind seine Wartezeit lang VOLL
    // sichtbar da und spränge dann zum Einblenden auf Null zurück.
    expect(regel).toMatch(/\bbackwards\b/);
  });

  it('die Verzögerung wächst um EINEN `--vp-motion-stagger` je Zeile', () => {
    for (let kind = 2; kind <= 8; kind += 1) {
      const re = new RegExp(
        `\\.vp-stagger > \\*:nth-child\\(${kind}\\)[^}]*calc\\(var\\(--vp-motion-stagger\\) \\* ${kind - 1}\\)`,
      );
      expect(index, `Kind ${kind}`).toMatch(re);
    }
  });

  it('ab dem NEUNTEN Kind steht die Verzögerung still (Deckel 8, Prinzip 5)', () => {
    expect(index).toMatch(
      /\.vp-stagger > \*:nth-child\(n \+ 9\)[^}]*calc\(var\(--vp-motion-stagger\) \* 8\)/,
    );
    // …und es gibt keine neunte, zehnte, … Einzelregel, die den Deckel
    // stillschweigend wieder aufmacht.
    expect(index).not.toMatch(/\.vp-stagger > \*:nth-child\(9\)/);
  });

  it('bewegt nur Opazität und Weg — nie Höhe, nie Breite (Prinzip 9)', () => {
    const kf = /@keyframes vp-stagger-ein \{([\s\S]*?)\n\}/.exec(index)?.[1] ?? '';
    expect(kf).toMatch(/transform:\s*translateY\(var\(--vp-motion-distance\)\)/);
    expect(kf).not.toMatch(/height|width|margin|padding/);
  });

  it('beginnt SICHTBAR — eine Null naehme dem groessten Inhalt seinen LCP', () => {
    const kf = /@keyframes vp-stagger-ein \{([\s\S]*?)\n\}/.exec(index)?.[1] ?? '';
    const start = /opacity:\s*([\d.]+)/.exec(kf)?.[1];
    // ⚠ Chrome zaehlt ein vollstaendig durchsichtiges Element nicht als
    //   LCP-Kandidaten. Gemessen: mit `0` verschob sich LCP um den ganzen
    //   Versatz (272 → 520 ms). Der Wert darf leiser oder lauter werden —
    //   NULL darf er nie sein, und die Begruendung steht am Keyframe.
    expect(start).toBeDefined();
    expect(Number(start)).toBeGreaterThan(0);
    expect(Number(start)).toBeLessThan(1);
  });

  it('die erste Bildschirmhoehe des Cockpits steht still — und NUR das Cockpit', () => {
    // ⚠ Der Weg der obersten Karte fiel bei 375 px mit dem Umbau des
    //   Platzhalters `.vp-anlage-pending` zusammen und vervielfachte dessen
    //   echten Sprung (CLS 0,033 → 0,313; gemessen in `e2e/motion-p4/`).
    //   Zwei Kinder, weil das erste je nach Anlage die mobile Kopfzeile ist.
    const regel = /\.vp-cockpit-stack\.vp-stagger > \*:nth-child\(-n \+ 2\)[^{]*\{([^}]*)\}/.exec(index)?.[1];
    expect(regel).toBeDefined();
    expect(regel).toMatch(/animation:\s*none/);
    // Nur der Cockpit-Stapel — eine nachladende Liste (P6) springt beim Start
    // nicht und darf ihre obersten Zeilen weiterhin bewegen.
    expect(index).not.toMatch(/^\.vp-stagger > \*:nth-child\(-n \+ 2\)/m);
  });

  it('die Versaetze bleiben unangetastet — der Rhythmus ist derselbe', () => {
    // Die dritte Karte kommt weiterhin nach 2 x 30 ms; das Stillstehen der
    // ersten zwei verschiebt niemanden.
    expect(index).toMatch(
      /\.vp-stagger > \*:nth-child\(3\) \{ animation-delay: calc\(var\(--vp-motion-stagger\) \* 2\); \}/,
    );
  });
});

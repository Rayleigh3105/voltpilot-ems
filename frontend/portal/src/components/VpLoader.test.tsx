import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { LOADER_TEXT, VP_MARK, VpLoader, VpLoaderScreen } from './VpLoader';

// vitest root ist frontend/portal (vitest.config.ts), wie in `bootSkeleton.test.ts`.
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/** Geschütztes Leerzeichen (U+00A0) - encoding-sicher statt literalem NBSP im Quelltext. */
const NBSP = ' ';

/**
 * ⚠ DER FEEDBACK-5-WÄCHTER: zwei Lader im selben Dokument dürfen KEINE SVG-`id`
 * teilen. Inline-Lader (index.html) und React-Lader laufen bei der Übergabe
 * gleichzeitig, dazu eingebettete Lader in mehreren Karten. Doppelte IDs sind
 * ungültiges HTML, und `url(#id)` löst immer auf das ERSTE passende Element -
 * liegt das in einem ausgeblendeten Teilbaum, malt Chrome falsch. Das Zeichen
 * ist flächig gefüllt wie im Logo und braucht deshalb gar keine `id`.
 */
describe('VpLoader · keine SVG-ids', () => {
  it('mehrere gleichzeitig gerenderte Lader tragen keine id und keinen url(#…)-Verweis', () => {
    const { container } = render(
      <>
        <VpLoader />
        <VpLoader />
        <VpLoaderScreen />
      </>,
    );
    expect(container.querySelectorAll('svg').length).toBe(3);
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids, `unerwartete id(s): ${ids.join(', ')}`).toEqual([]);
    for (const el of container.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        expect(el.getAttribute(attr) ?? '', `${el.tagName}[${attr}]`).not.toMatch(/url\(#/);
      }
    }
  });
});

/**
 * ⚠ DAS ECHTE ZEICHEN, an beiden Stellen dasselbe: der React-Lader zeichnet
 * {@link VP_MARK} (aus dem App-Symbol nachgezogen), und das Inline-Skelett in
 * `index.html` trägt dieselben Zahlen - sonst springt das Zeichen beim
 * Übergang Skelett → BootSplash.
 */
describe('VpLoader · das Zeichen der Marke', () => {
  type Mark = {
    dot: Record<string, string | null>;
    bolt: Record<string, string | null>;
  };
  const markOf = (svg: Element): Mark => {
    const dots = svg.querySelectorAll('circle:not([class])');
    const bolts = svg.querySelectorAll('path');
    expect(dots.length, 'genau ein Punkt').toBe(1);
    expect(bolts.length, 'genau ein Blitz').toBe(1);
    const dot = dots[0];
    const bolt = bolts[0];
    return {
      dot: {
        cx: dot.getAttribute('cx'),
        cy: dot.getAttribute('cy'),
        r: dot.getAttribute('r'),
        fill: dot.getAttribute('fill')?.toUpperCase() ?? null,
      },
      bolt: {
        d: bolt.getAttribute('d'),
        fill: bolt.getAttribute('fill')?.toUpperCase() ?? null,
      },
    };
  };
  const expected: Mark = {
    dot: {
      cx: String(VP_MARK.dot.cx),
      cy: String(VP_MARK.dot.cy),
      r: String(VP_MARK.dot.r),
      fill: VP_MARK.dot.fill.toUpperCase(),
    },
    bolt: { d: VP_MARK.bolt.d, fill: VP_MARK.bolt.fill.toUpperCase() },
  };

  it('der React-Lader zeichnet Punkt und Blitz der Marke, flächig in den Farben des Logos', () => {
    const { container } = render(<VpLoader />);
    const svg = container.querySelector('svg.vp-loader-mark');
    expect(svg).not.toBeNull();
    expect(markOf(svg as Element)).toEqual(expected);
    // Punkt schwarz, Blitz im Marken-Blau (`--vp-primary`) - wie im App-Symbol.
    expect(VP_MARK.dot.fill).toBe('#000000');
    expect(VP_MARK.bolt.fill).toBe('#95B9FF');
  });

  it('das Inline-Skelett in index.html trägt dasselbe Zeichen', () => {
    const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
    const svg = doc.querySelector('#vp-boot-skeleton svg.vp-bs-mark');
    expect(svg).not.toBeNull();
    expect(markOf(svg as Element)).toEqual(expected);
  });

  it('das frühere Ersatzzeichen (symmetrischer Blitz mit Verlauf) ist an keiner Stelle mehr', () => {
    const { container } = render(<VpLoader />);
    for (const text of [container.innerHTML, indexHtml]) {
      expect(text).not.toContain('M34 25 L25 37.5');
      expect(text).not.toContain('vplFill');
    }
  });
});

describe('VpLoader · Barrierefreiheit und Text', () => {
  it('ist ein Statusbereich mit Screenreader-Text und trägt den Phasentext', () => {
    const { getByText, container } = render(<VpLoader text={LOADER_TEXT.sites} />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('[data-vp-loader]')).not.toBeNull();
    // Der Phasentext (der geschützte „…"-Umbruch normalisiert sich weg).
    expect(getByText(/Ihre Anlagen werden geladen/)).toBeInTheDocument();
    expect(getByText('Wird geladen…')).toBeInTheDocument();
  });

  it('das geschützte Leerzeichen vor dem „…" ist wirklich ein NBSP', () => {
    // Punkt 3: „…" darf nie allein umbrechen - der Text trägt U+00A0 davor.
    expect(LOADER_TEXT.sites).toContain(`${NBSP}…`);
    expect(LOADER_TEXT.auth).toContain(`${NBSP}…`);
    expect(LOADER_TEXT.page).toContain(`${NBSP}…`);
  });
});

/**
 * ⚠ NICE-2-WÄCHTER (Phasen-Übergabe): steht beim Mount ein laufender Inline-Lader
 * daneben, übernimmt `VpLoaderScreen` dessen Puls-Phase als `--vp-loader-phase`
 * (negativer Delay) - so knüpfen die React-Ringe rhythmus-nahtlos an. Ohne
 * Inline-Lader bleibt die Variable ungesetzt (Rückfall 0s, wie bisher).
 */
describe('VpLoaderScreen · Phasen-Übergabe vom Inline-Lader', () => {
  afterEach(() => {
    document.getElementById('vp-boot-skeleton')?.remove();
  });

  it('übernimmt die laufende Inline-Puls-Phase als --vp-loader-phase', () => {
    const skeleton = document.createElement('div');
    skeleton.id = 'vp-boot-skeleton';
    const ring = document.createElement('span');
    ring.className = 'vp-bs-ring r1';
    (ring as unknown as { getAnimations: () => Partial<Animation>[] }).getAnimations = () => [
      {
        animationName: 'vp-bs-pulse',
        currentTime: 500,
      } as unknown as Animation,
    ];
    skeleton.appendChild(ring);
    document.body.appendChild(skeleton);

    const { container } = render(<VpLoaderScreen />);
    const screen = container.querySelector('.vp-loader-screen') as HTMLElement;
    expect(screen.style.getPropertyValue('--vp-loader-phase')).toBe('-500ms');
  });

  it('setzt --vp-loader-phase nicht, wenn kein Inline-Lader läuft', () => {
    const { container } = render(<VpLoaderScreen />);
    const screen = container.querySelector('.vp-loader-screen') as HTMLElement;
    expect(screen.style.getPropertyValue('--vp-loader-phase')).toBe('');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LOADER_TEXT, VpLoader, VpLoaderScreen } from './VpLoader';

/** Geschütztes Leerzeichen (U+00A0) - encoding-sicher statt literalem NBSP im Quelltext. */
const NBSP = ' ';

/**
 * ⚠ DER FEEDBACK-5-WÄCHTER: zwei Lader im selben Dokument dürfen KEINE SVG-`id`
 * teilen. Inline-Lader (index.html) und React-Lader laufen bei der Übergabe
 * gleichzeitig, dazu eingebettete Lader in mehreren Karten. Doppelte IDs sind
 * ungültiges HTML, und `url(#id)` löst immer auf das ERSTE passende Element -
 * liegt das in einem ausgeblendeten Teilbaum, malt Chrome den Verlauf falsch.
 */
describe('VpLoader · eindeutige IDs je Instanz', () => {
  it('zwei gleichzeitig gerenderte Lader teilen keine einzige SVG-id', () => {
    const { container } = render(
      <>
        <VpLoader />
        <VpLoader />
        <VpLoaderScreen />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, `doppelte id(s): ${ids.join(', ')}`).toBe(ids.length);
  });

  it('jede `url(#id)`-Referenz löst innerhalb desselben Dokuments auf', () => {
    const { container } = render(
      <>
        <VpLoader />
        <VpLoader />
      </>,
    );
    const present = new Set([...container.querySelectorAll('[id]')].map((el) => el.id));
    const refs: string[] = [];
    for (const el of container.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        const v = el.getAttribute(attr) ?? '';
        const m = v.match(/url\(#([^)]+)\)/);
        if (m) refs.push(m[1]);
      }
    }
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(present.has(ref), `url(#${ref}) zeigt ins Leere`).toBe(true);
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
      { animationName: 'vp-bs-pulse', currentTime: 500 } as unknown as Animation,
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

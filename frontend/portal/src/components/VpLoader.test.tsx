import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LOADER_TEXT, VpLoader, VpLoaderScreen } from './VpLoader';

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
    expect(LOADER_TEXT.sites).toContain(' …');
    expect(LOADER_TEXT.auth).toContain(' …');
    expect(LOADER_TEXT.page).toContain(' …');
  });
});

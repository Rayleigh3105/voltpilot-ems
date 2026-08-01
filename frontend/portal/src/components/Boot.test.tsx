import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootErrorBoundary, BootSplash, removeBootSkeleton } from './Boot';

/** The inline skeleton index.html ships (see its comment block). */
function mountSkeleton(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'vp-boot-skeleton';
  document.body.appendChild(el);
  return el;
}

describe('BootSplash', () => {
  it('renders the boot state synchronously (never a white first frame)', () => {
    render(<BootSplash />);
    expect(screen.getByText('Anmeldung wird geprüft …')).toBeInTheDocument();
    expect(screen.getByAltText('VoltPilot')).toBeInTheDocument();
  });
});

describe('BootErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <BootErrorBoundary>
        <p>Portal-Inhalt</p>
      </BootErrorBoundary>,
    );
    expect(screen.getByText('Portal-Inhalt')).toBeInTheDocument();
  });

  it('a throwing child lands on the German recovery card, never blank', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): never {
      throw new Error('render explosion');
    }
    render(
      <BootErrorBoundary>
        <Boom />
      </BootErrorBoundary>,
    );
    expect(
      screen.getByText(/Es ist ein unerwarteter Fehler aufgetreten/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('removes the inline first-paint skeleton on its first committed frame', () => {
    mountSkeleton();
    render(
      <BootErrorBoundary>
        <BootSplash />
      </BootErrorBoundary>,
    );
    // Gone in the same commit React wrote its first DOM - no flicker, and the
    // splash it hands over to is already on screen.
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
    expect(screen.getByText('Anmeldung wird geprüft …')).toBeInTheDocument();
  });

  it('also removes it when the very first render throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mountSkeleton();
    function Boom(): never {
      throw new Error('render explosion');
    }
    render(
      <BootErrorBoundary>
        <Boom />
      </BootErrorBoundary>,
    );
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
    consoleError.mockRestore();
  });
});

describe('removeBootSkeleton', () => {
  it('is idempotent and safe when the skeleton is absent', () => {
    mountSkeleton();
    removeBootSkeleton();
    expect(() => removeBootSkeleton()).not.toThrow();
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootErrorBoundary, BootSplash } from './Boot';

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
});

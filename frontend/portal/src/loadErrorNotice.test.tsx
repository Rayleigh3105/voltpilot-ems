import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoadErrorNotice } from './App';

/**
 * vp-admin-du: der initiale Ladefehler duzt NUR, wenn an dieser Stelle schon
 * sicher bekannt ist, dass ein Plattform-Admin angemeldet ist (`admin`-Prop
 * aus `isAdmin`, nicht aus einem noch ladenden Abruf) - sonst bleibt "Sie".
 */
describe('LoadErrorNotice (vp-admin-du)', () => {
  it('spricht ohne bekannte Admin-Rolle mit "Sie" (Standard, Kundenfläche)', () => {
    render(<LoadErrorNotice onRetry={vi.fn()} />);
    expect(screen.getByText(/Ihre Anlagen und Geräte/)).toBeInTheDocument();
    expect(screen.getByText(/Bitte versuchen Sie es erneut/)).toBeInTheDocument();
  });

  it('duzt, wenn der Admin-Bereich ausdrücklich admin=true setzt', () => {
    render(<LoadErrorNotice onRetry={vi.fn()} admin />);
    expect(screen.getByText(/Deine Anlagen und Geräte/)).toBeInTheDocument();
    expect(screen.getByText(/Versuch es erneut/)).toBeInTheDocument();
    expect(screen.queryByText(/\bSie\b/)).toBeNull();
  });
});

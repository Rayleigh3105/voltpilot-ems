import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ManagementbewertungAnlegenBlatt } from './ManagementbewertungDialoge';

/**
 * „Managementbewertung anlegen“ (Konzept Nachweisen n1 Runde 2, §6.7): das Blatt wählt nie ein Jahr vor der jüngsten
 * vorhandenen vor - wie „Als Nächstes“ im Reiter (`mbNaechstes`), Review P5-3.
 */
describe('Managementbewertung anlegen', () => {
  const original = { ...api };
  beforeEach(() => {
    Object.assign(api, { unternehmen: async () => ({ id: 'u-1' }) });
  });
  afterEach(() => {
    cleanup();
    Object.assign(api, original);
  });

  const gewaehlt = () => screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked).map((r) => (r as HTMLInputElement).value);

  it('ohne Managementbewertung ist das Vorjahr vorgewählt', async () => {
    render(<ManagementbewertungAnlegenBlatt heute="2029-02-05" vorhanden={[]} onClose={vi.fn()} onAngelegt={vi.fn()} />);
    await act(async () => {});
    expect(gewaehlt()).toEqual(['2028']);
  });

  it('Review P5-3: gibt es 2028 schon, ist nichts vorgewählt - nicht 2027', async () => {
    render(<ManagementbewertungAnlegenBlatt heute="2029-02-05" vorhanden={['2028']} onClose={vi.fn()} onAngelegt={vi.fn()} />);
    await act(async () => {});
    expect(gewaehlt()).toEqual([]);
  });
});

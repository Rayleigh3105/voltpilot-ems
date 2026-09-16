import { act } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Q2: historischer HTML-Bestand; Bezugsstand und main-Nachzüge stehen in bestandsschutz/README.md. */
export function bestandsZeit(): void {
  vi.setSystemTime(new Date('2026-09-02T10:19:00Z'));
}

export async function bestandSnapshot(name: string, view: { container: HTMLElement; unmount: () => void }): Promise<void> {
  try {
    await act(async () => {});
    expect(view.container.textContent?.trim().length).toBeGreaterThan(20);
    // Kein Entfernen von Wörtern, Zahlen, Klassen oder Attributen: jedes Byte zählt.
    await expect(view.container.innerHTML).toMatchFileSnapshot(
      join(dirname(fileURLToPath(import.meta.url)), 'bestandsschutz', `${name}.html`),
    );
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
}

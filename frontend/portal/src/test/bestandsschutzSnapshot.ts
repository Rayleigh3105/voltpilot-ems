import { act } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Q2: HTML auf 84f8307ffbd668cf5dcd0cbb1f4ebfedf84062a3 erzeugt, nie am neuen Stand erneuern. */
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

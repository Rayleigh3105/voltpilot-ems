import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { initInstallApp, resetInstallApp, type InstallEnv } from '../installApp';
import KontoAppDialog from './KontoAppDialog';

/*
  „Als App auf dem Handy" wohnt seit E5 im Konto-Menü (sie gilt dem Gerät,
  nicht der Anlage). Die Regeln sind dieselben wie vorher in den
  Einstellungen - hier auf ihrem neuen Blatt geprüft.
*/

/** Ein `window`-Stellvertreter für den Einrichten-Zustand dieses Geräts. */
function installEnv(opts: { standalone?: boolean; ua?: string } = {}) {
  const handlers = new Map<string, Array<(e: Event) => void>>();
  const env: InstallEnv & { fire(type: string, e?: Partial<Event>): void } = {
    addEventListener(type, cb) {
      handlers.set(type, [...(handlers.get(type) ?? []), cb]);
    },
    removeEventListener(type, cb) {
      const list = handlers.get(type) ?? [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    matchMedia: () => ({ matches: opts.standalone === true }),
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (Linux; Android 14) Chrome/151' },
    fire(type, e) {
      for (const cb of handlers.get(type) ?? []) cb({ ...e, type } as Event);
    },
  };
  return env;
}

function oeffne() {
  render(<KontoAppDialog open onClose={() => {}} />);
  return screen.getByRole('dialog', { name: 'Als App auf dem Handy' });
}

describe('Konto-Menü · Als App auf dem Handy', () => {
  it('nennt ohne Angebot des Browsers den GRUND statt eines toten Knopfes', () => {
    resetInstallApp();
    initInstallApp(installEnv());
    const blatt = oeffne();
    expect(within(blatt).getByText(/bietet das Einrichten hier nicht an/)).toBeInTheDocument();
    expect(within(blatt).queryByRole('button', { name: 'App installieren' })).toBeNull();
  });

  it('zeigt den Knopf, sobald der Browser sein Angebot macht - auch NACH dem Öffnen', async () => {
    resetInstallApp();
    const env = installEnv();
    initInstallApp(env);
    const blatt = oeffne();
    expect(within(blatt).queryByRole('button', { name: 'App installieren' })).toBeNull();

    const prompt = vi.fn(() => Promise.resolve());
    act(() => {
      env.fire('beforeinstallprompt', {
        preventDefault: vi.fn(),
        prompt,
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      } as never);
    });
    fireEvent.click(within(blatt).getByRole('button', { name: 'App installieren' }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
  });

  it('sagt der installierten App nur einen ruhigen Satz', () => {
    resetInstallApp();
    initInstallApp(installEnv({ standalone: true }));
    const blatt = oeffne();
    expect(within(blatt).getByText('Sie nutzen VoltPilot bereits als App.')).toBeInTheDocument();
    expect(within(blatt).queryByRole('button', { name: 'App installieren' })).toBeNull();
  });

  it('führt auf dem iPhone in zwei Schritten statt einen Dialog zu versprechen', () => {
    resetInstallApp();
    initInstallApp(installEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari' }));
    const blatt = oeffne();
    const steps = within(blatt).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/Teilen/);
    expect(steps[1]).toHaveTextContent(/Home-Bildschirm/);
  });
});

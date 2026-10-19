import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { initInstallApp, resetInstallApp, type InstallEnv } from '../installApp';
import { InstallAppPanel } from './InstallAppPanel';

/*
  „Als App auf diesem Gerät" wohnt seit Einstellungen Scheibe 1 in der Gruppe „Dieses Gerät" der
  Einstellungs-Seite (vorher im eigenen Konto-Menü-Blatt `KontoAppDialog`, das E1A ablöst) - die
  Regeln dieser reinen Fläche sind unverändert, hier direkt auf ihr geprüft.
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

describe('InstallAppPanel', () => {
  it('nennt ohne Angebot des Browsers den GRUND statt eines toten Knopfes', () => {
    resetInstallApp();
    initInstallApp(installEnv());
    render(<InstallAppPanel />);
    expect(screen.getByText(/bietet das Einrichten hier nicht an/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'App installieren' })).toBeNull();
  });

  it('zeigt den Knopf, sobald der Browser sein Angebot macht - auch NACH dem Rendern', async () => {
    resetInstallApp();
    const env = installEnv();
    initInstallApp(env);
    render(<InstallAppPanel />);
    expect(screen.queryByRole('button', { name: 'App installieren' })).toBeNull();

    const prompt = vi.fn(() => Promise.resolve());
    act(() => {
      env.fire('beforeinstallprompt', {
        preventDefault: vi.fn(),
        prompt,
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      } as never);
    });
    fireEvent.click(screen.getByRole('button', { name: 'App installieren' }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
  });

  it('sagt der installierten App nur einen ruhigen Satz', () => {
    resetInstallApp();
    initInstallApp(installEnv({ standalone: true }));
    render(<InstallAppPanel />);
    expect(screen.getByText('Sie nutzen VoltPilot bereits als App.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'App installieren' })).toBeNull();
  });

  it('führt auf dem iPhone in zwei Schritten statt einen Dialog zu versprechen', () => {
    resetInstallApp();
    initInstallApp(installEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari' }));
    render(<InstallAppPanel />);
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/Teilen/);
    expect(steps[1]).toHaveTextContent(/Home-Bildschirm/);
  });
});

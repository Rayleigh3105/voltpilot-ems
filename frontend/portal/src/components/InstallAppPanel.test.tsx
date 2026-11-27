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
  it('nennt auf Chrome/Android ohne Angebot den Menü-Weg, NIE die falsche Behauptung "bietet es nicht an"', () => {
    resetInstallApp();
    initInstallApp(installEnv());
    render(<InstallAppPanel />);
    expect(screen.queryByText(/bietet das Einrichten hier nicht an/)).toBeNull();
    expect(screen.getByText(/noch nicht von sich aus angeboten/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'App installieren' })).toBeNull();
  });

  it('nennt auf einem wirklich fremden Browser den GRUND statt eines toten Knopfes', () => {
    resetInstallApp();
    initInstallApp(
      installEnv({ ua: 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/118.0 Firefox/118.0' }),
    );
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

  it('ist auf dem installierten Gerät KEIN totes Ende: Link, QR-Code und Weg aufs andere Gerät', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    resetInstallApp();
    initInstallApp(installEnv({ standalone: true }));
    render(<InstallAppPanel />);

    expect(screen.getByText('Auf einem weiteren Gerät installieren')).toBeInTheDocument();
    const link = window.location.origin;
    expect(screen.getByText(link)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: `QR-Code: ${link}` })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Kopieren' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link));
    expect(await screen.findByRole('button', { name: 'Kopiert' })).toBeInTheDocument();
  });

  it('zeigt den Weg aufs andere Gerät NUR, wenn dieses Gerät schon installiert ist', () => {
    resetInstallApp();
    initInstallApp(installEnv());
    render(<InstallAppPanel />);
    expect(screen.queryByText('Auf einem weiteren Gerät installieren')).toBeNull();
  });
});

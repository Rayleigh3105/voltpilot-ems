import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BefehleSection } from './BefehleSection';
import { api, type CommandEntry, type CommandHistory, type Site } from '../api';

const site = { id: 's1', name: 'Hof Herzogau' } as Site;

function periode(over: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: 1,
    stream: 'batterie',
    kind: 'periode',
    eventKind: null,
    startedAt: '2026-08-16T08:00:00Z',
    endedAt: '2026-08-16T09:30:00Z',
    mode: 'plan',
    path: 'remote',
    whyKind: 'fahrplan',
    whyRef: '-6.50',
    commandedKwFirst: -6.5,
    commandedKwLast: -6.5,
    commandedKwMin: -6.5,
    commandedKwMax: -6.5,
    verdict: 'bestaetigt',
    cycles: null,
    cyclesConfirmed: null,
    cyclesNoAnswer: null,
    cyclesMismatch: null,
    controlEnabled: true,
    released: true,
    foreignInfluence: false,
    entityId: 'e1',
    source: 'cloud_abgeleitet',
    detail: null,
    ...over,
  };
}

function history(over: Partial<CommandHistory> = {}): CommandHistory {
  return {
    recordingSince: '2026-08-12T00:00:00Z',
    accuracySeconds: 15,
    from: '2026-08-16T00:00:00Z',
    to: '2026-08-16T10:00:00Z',
    entityId: 'e1',
    entityLabel: 'Speicher',
    writes: true,
    truncated: false,
    entries: [],
    control: null,
    curtailment: null,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('BefehleSection', () => {
  it('zeigt den Tages-Film samt Aufzeichnungs-Beginn', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ entries: [periode()] }));
    render(<BefehleSection site={site} entityId="e1" />);

    await waitFor(() => expect(screen.getByText(/Entladen mit/)).toBeInTheDocument());
    expect(screen.getByText(/Aufzeichnung seit 12\.08\.2026/)).toBeInTheDocument();
    expect(screen.getByText('vom Gerät bestätigt')).toBeInTheDocument();
  });

  /**
   * Captain-Entscheid F1: der Roh-Blick ist für ALLE Kunden aufklappbar - die
   * Transparenz IST das Produktversprechen. Der Test mockt bewusst KEINE
   * Admin-Rolle; wer ihn hinter `showTechnicalLayer()` schöbe, bräche ihn.
   */
  it('bietet den Roh-Blick JEDEM Kunden an', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ entries: [periode()] }));
    render(<BefehleSection site={site} entityId="e1" />);

    await waitFor(() => expect(screen.getByText('Technische Details')).toBeInTheDocument());
    expect(screen.getByText('Schreibweg')).toBeInTheDocument();
    expect(screen.getByText('Fernsteuer-Register')).toBeInTheDocument();
  });

  /** Captain-Entscheid F4: die Herzogau-Antwort steht an jedem Gerät. */
  it('sagt an einer nur gelesenen Komponente, dass nichts geschickt wird', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ writes: false }));
    render(<BefehleSection site={site} entityId="e1" />);

    await waitFor(() =>
      expect(screen.getAllByText(/keine Befehle/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/nur gelesen/).length).toBeGreaterThan(0);
  });

  it('unterscheidet „noch nicht aufgezeichnet" von „nichts geschickt"', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ recordingSince: null }));
    const { unmount } = render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() =>
      expect(screen.getByText(/Aufzeichnung hat noch nicht begonnen/)).toBeInTheDocument());
    unmount();

    vi.spyOn(api, 'commandHistory').mockResolvedValue(history());
    render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() =>
      expect(screen.getByText(/kein Befehl geschickt/)).toBeInTheDocument());
  });

  it('rendert das Wächter-Panel aus dem mitgelieferten Abregel-Block', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({
      curtailment: {
        deviceId: 'd1',
        units: 2,
        certifiedUnits: 0,
        controlEnabled: true,
        active: false,
        appliedCapKw: null,
        allMatch: null,
        possibleOverride: false,
        checkedAt: new Date().toISOString(),
        exportGuard: {
          limitKw: 70,
          state: 'ueberwacht',
          reason: 'Die Einspeisung liegt bei 0,0 kW von 70,0 kW.',
          capKw: 76.9,
          limiting: false,
          blind: false,
          effective: false,
          reach: 'Kein Wechselrichter ist für die Abregelung freigegeben (0 von 2).',
        },
        deviceExportLimit: null,
      },
    }));
    render(<BefehleSection site={site} entityId="e1" />);

    await waitFor(() =>
      expect(screen.getByText(/Kein Wechselrichter ist für die Abregelung freigegeben/))
        .toBeInTheDocument());
  });

  it('meldet einen Fehlschlag ehrlich, statt einen leeren Verlauf zu behaupten', async () => {
    vi.spyOn(api, 'commandHistory').mockRejectedValue(new Error('offline'));
    render(<BefehleSection site={site} entityId="e1" />);

    await waitFor(() =>
      expect(screen.getByText(/Verlauf nicht abrufbar/)).toBeInTheDocument());
  });
});

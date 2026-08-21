import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    total: 0,
    matched: 0,
    nextBefore: null,
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

  /**
   * Die SUCHE (Geräteseiten Revision B §6, Captain-Punkt 4). Struktur filtert
   * der Server, der Freitext läuft über die ANGEZEIGTEN Sätze - und die Leiste
   * sagt, worin sie sucht.
   */
  it('schickt einen Schnell-Chip als STRUKTUR-Filter an den Server', async () => {
    const spy = vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ total: 212, matched: 212 }));
    render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Nur Abweichungen' }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('s1', expect.objectContaining({ verdicts: 'abweichend' })));
    // Ein zweiter Klick NIMMT ihn zurück - ein Filter, den man nur setzen kann,
    // ist eine Sackgasse.
    fireEvent.click(screen.getByRole('button', { name: 'Nur Abweichungen' }));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith('s1', expect.objectContaining({ verdicts: null })));
  });

  it('nennt BEIDE Zahlen, sobald ein Filter greift', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(
      history({ total: 212, matched: 14, entries: [periode()] }));
    render(<BefehleSection site={site} entityId="e1" />);

    await waitFor(() => expect(screen.getByText(/212 Zeilen/)).toBeInTheDocument());
  });

  /** Der Freitext läuft NUR über die gezeigten Sätze - kein zweiter Abruf. */
  it('durchsucht clientseitig die angezeigten Sätze', async () => {
    const spy = vi.spyOn(api, 'commandHistory').mockResolvedValue(history({
      total: 2,
      matched: 2,
      entries: [periode(), periode({ id: 2, commandedKwFirst: 4.2, commandedKwLast: 4.2,
        commandedKwMin: 4.2, commandedKwMax: 4.2 })],
    }));
    render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() => expect(screen.getByText(/Laden mit/)).toBeInTheDocument());
    const rufe = spy.mock.calls.length;

    fireEvent.change(screen.getByPlaceholderText(/Suchen/), { target: { value: 'entladen' } });
    await waitFor(() => expect(screen.queryByText(/Laden mit/)).not.toBeInTheDocument());
    expect(screen.getByText(/Entladen mit/)).toBeInTheDocument();
    expect(spy.mock.calls.length).toBe(rufe);
  });

  /** Ein Filter, der nichts trifft, ist NICHT dasselbe wie ein leerer Zeitraum. */
  it('nennt bei einem leeren Treffer, wie viele Zeilen der Zeitraum trägt', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ total: 212, matched: 0 }));
    render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Suchen/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Nur über das Portal' }));
    await waitFor(() =>
      expect(screen.getByText(/212 Zeilen in diesem Zeitraum/)).toBeInTheDocument());
  });

  /** „Mehr laden" wird nie angeboten, wo es nichts mehr gibt. */
  it('bietet „Ältere laden" nur mit einem Server-Cursor an', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({ entries: [periode()] }));
    const { unmount } = render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() => expect(screen.getByText(/Entladen mit/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Ältere laden/ })).not.toBeInTheDocument();
    unmount();

    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({
      entries: [periode()], truncated: true, nextBefore: '2026-08-16T08:00:00Z',
    }));
    render(<BefehleSection site={site} entityId="e1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ältere laden/ })).toBeInTheDocument());
  });

  /**
   * Der Geräte-Filter (Anlagen-Zentrale Stufe 1, D3): dieselbe Seite,
   * eingegrenzt auf EIN Gerät. Der NAME kommt aus dem gemeldeten
   * Einrichtungs-Stand, nicht aus der Verlaufs-Antwort - sie trägt bewusst
   * keinen.
   */
  it('grenzt auf ein GERÄT ein und nennt es bei seinem Namen', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({
      entityId: null,
      entityLabel: null,
      deviceRef: 'src-7c1e9a2b',
      deviceIsBox: false,
      entries: [periode()],
    }));
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [],
      localSetup: [
        {
          id: 'src-7c1e9a2b',
          kind: 'source',
          role: 'pv-generation',
          brand: 'fronius_sunspec',
          model: 'Eco 27.0-3-S',
          label: null,
          reportedAt: '2026-08-16T10:00:00Z',
          adoptedEntityId: null,
        },
      ],
      staleOnDevice: [],
    } as never);

    render(<BefehleSection site={site} entityId={null} geraetRef="src-7c1e9a2b" />);

    await waitFor(() =>
      expect(api.commandHistory).toHaveBeenCalledWith('s1', expect.objectContaining({
        entity: null,
        device: 'src-7c1e9a2b',
        range: 'day',
      })),
    );
    // Der Name kommt aus dem gemeldeten Einrichtungs-Stand (Marke + Kurzmodell),
    // der Schreibweg aus den Zeilen - beides ohne einen zweiten Namensbildner.
    await waitFor(() =>
      expect(screen.getByText(/Fronius Eco .* · Fernsteuer-Register\./)).toBeInTheDocument());
    // Die Grenze wird ERKLÄRT: die anlagenweiten Befehle gehören der Box.
    expect(screen.getByText(/Anlagenweite Befehle/)).toBeInTheDocument();
  });

  /**
   * Die Gegenrichtung auf der BOX (Ziel-Attribution, Konzept
   * `vp-geraeteseite-rev-b8` §5): sie ÜBERBRINGT, ausgeführt wird am Gerät -
   * und dort steht der Befehl seither auch.
   */
  it('sagt auf der BOX, dass Geräte-Befehle auf der Geräteseite stehen', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history({
      entityId: null,
      entityLabel: null,
      deviceRef: 'edge-45gz7da',
      deviceIsBox: true,
      entries: [periode()],
    }));

    render(<BefehleSection site={site} entityId={null} geraetRef="edge-45gz7da" />);

    await waitFor(() =>
      expect(screen.getByText(/die anlagenweiten Befehle, die Ihre Box überbringt/))
        .toBeInTheDocument());
    expect(screen.getByText(/stehen auf der\s+Seite dieses Geräts/)).toBeInTheDocument();
    // Der Grenz-Satz der Gegenrichtung gehört ihr NICHT.
    expect(screen.queryByText(/Anlagenweite Befehle -/)).not.toBeInTheDocument();
  });

  it('lässt die Komponente gewinnen - zwei Fragen, nie beide zugleich', async () => {
    vi.spyOn(api, 'commandHistory').mockResolvedValue(history());
    render(<BefehleSection site={site} entityId="e1" geraetRef="src-7c1e9a2b" />);
    // Der Server lehnt beides zusammen mit 400 ab; das Gerät reist gar nicht
    // erst mit, statt sich auf eine Fehlermeldung zu verlassen.
    await waitFor(() =>
      expect(api.commandHistory).toHaveBeenCalledWith('s1', expect.objectContaining({
        entity: 'e1',
        device: null,
        range: 'day',
      })),
    );
  });
});

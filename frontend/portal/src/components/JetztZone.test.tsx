import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JetztZone } from './JetztZone';
import { api, type Site } from '../api';

const cList = vi.fn();
const cStatus = vi.fn();
const cOverrides = vi.fn();
const cStartOverride = vi.fn();
const cClearOverride = vi.fn();

vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    list: (...a: unknown[]) => cList(...a),
    status: (...a: unknown[]) => cStatus(...a),
    overrides: (...a: unknown[]) => cOverrides(...a),
    startOverride: (...a: unknown[]) => cStartOverride(...a),
    clearOverride: (...a: unknown[]) => cClearOverride(...a),
  },
}));

const site = { id: 's-1', name: 'Halle Nord', plantKind: 'eigenverbrauch' } as Site;

const CONSUMER = {
  id: 'e-wb', type: 'wallbox', typeLabel: 'Wallbox', name: 'Wallbox Garage',
  controlKind: 'on_off', ratedPowerKw: 11, minPowerKw: null, levelsKw: null,
  resolutionKw: null, powerRangesKw: null, storageRelation: 'consumer_first',
  defaultGridEnergyPolicy: 'allow', allowStorageDischarge: false, failsafe: 'off',
  enabled: true, version: 1, connection: 'connected', edgeSourceId: 'src-1',
  controlActivation: 'active', hasDraftPolicy: true, draftPolicyVersion: 1,
};

beforeEach(() => {
  vi.restoreAllMocks();
  cList.mockResolvedValue([]);
  cStatus.mockResolvedValue([]);
  cOverrides.mockResolvedValue([]);
  cClearOverride.mockResolvedValue({});
  cStartOverride.mockResolvedValue({});
  vi.spyOn(api, 'schedule').mockResolvedValue({ deviceId: null, slots: [] } as never);
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
  vi.spyOn(api, 'curtailmentStatus').mockResolvedValue(null as never);
  vi.spyOn(api, 'siteInterventions').mockResolvedValue(
    { automationPaused: false, pausedUntil: null, interventions: [] } as never);
});

describe('Zone ① „Jetzt" (Steuerung Stufe 1)', () => {
  it('sagt ohne Steuerbares den WEG statt einer Zeile mit „—"', async () => {
    render(<JetztZone site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Jetzt' })).toBeInTheDocument());
    expect(await screen.findByText(/steuert VoltPilot noch nichts/)).toBeInTheDocument();
    expect(document.querySelectorAll('.vp-jetztrow')).toHaveLength(0);
  });

  it('zeigt je Gerät Zustand, Quelle und das Eingriffs-Menü', async () => {
    cList.mockResolvedValue([CONSUMER]);
    cStatus.mockResolvedValue([
      { entityId: 'e-wb', state: 'running_optimized', actualKw: 7.4, confirmed: true },
    ]);
    render(<JetztZone site={site} />);

    expect(await screen.findByText('Wallbox Garage')).toBeInTheDocument();
    expect(screen.getByText(/7,4/)).toBeInTheDocument();
    expect(screen.getByText('Ihre Regel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Wallbox Garage: eingreifen/ }));
    expect(screen.getByRole('menuitem', { name: 'Jetzt starten' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Jetzt stoppen' })).toBeInTheDocument();
  });

  it('ein Eingriff geht durch die Rückfrage — der erste Klick schaltet nichts', async () => {
    cList.mockResolvedValue([CONSUMER]);
    render(<JetztZone site={site} />);
    fireEvent.click(await screen.findByRole('button', { name: /Wallbox Garage: eingreifen/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Jetzt starten' }));
    expect(cStartOverride).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(cStartOverride).toHaveBeenCalledWith(
      's-1', 'e-wb', expect.objectContaining({ action: 'start' }),
    ));
  });

  it('nennt einen laufenden Handeingriff im Banner — mit Ende UND Countdown', async () => {
    cList.mockResolvedValue([CONSUMER]);
    cOverrides.mockResolvedValue([{
      entityId: 'e-wb', kind: 'start', targetCommand: 'on_off',
      endsAt: new Date(Date.now() + 72 * 60 * 1000).toISOString(),
    }]);
    render(<JetztZone site={site} />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Handeingriff läuft');
    expect(banner.textContent).toContain('Wallbox Garage');
    expect(banner.textContent).toMatch(/noch 1 Std\./);
    // Der einzige Ausweg ist „Automatik fortsetzen" — auch im Zeilen-Menü.
    fireEvent.click(screen.getByRole('button', { name: 'Automatik fortsetzen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(cClearOverride).toHaveBeenCalledWith('s-1', 'e-wb'));
  });

  it('bietet keinem unerreichbaren Gerät einen Knopf an und nennt den Grund', async () => {
    cList.mockResolvedValue([{ ...CONSUMER, connection: 'disconnected' }]);
    render(<JetztZone site={site} />);
    expect(await screen.findByText(/meldet sich gerade nicht/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /eingreifen/ })).toBeNull();
  });
});

describe('Zone ① „Jetzt" — die Handeingriffe (Steuerung Stufe 4)', () => {
  /** Ein Fahrplan, der die nächsten vier Stunden mit 4 kW Entladung plant. */
  function planMitSlots(stunden = 4) {
    const slots = [];
    for (let i = 0; i < stunden * 4; i++) {
      slots.push({
        start: new Date(Date.now() + i * 15 * 60_000).toISOString(),
        batteryKw: -4, gridKw: null, socPct: null, priceEurMwh: null,
        costEur: null, baselineCostEur: null, importPriceCtKwh: 32,
      });
    }
    return { deviceId: 'd-1', slots };
  }

  it('bietet „Automatik pausieren" an und zeigt seine Folgen-Karte', async () => {
    vi.spyOn(api, 'schedule').mockResolvedValue(planMitSlots() as never);
    render(<JetztZone site={site} />);
    const knopf = await screen.findByRole('button', { name: 'Automatik pausieren' });
    fireEvent.click(knopf);
    // Die vier festen Blöcke des Konzepts (§3.5).
    expect(await screen.findByText('Das passiert')).toBeInTheDocument();
    expect(screen.getByText('Auswirkung auf den Fahrplan')).toBeInTheDocument();
    expect(screen.getByText('Das bleibt gleich')).toBeInTheDocument();
    expect(screen.getByText('Ende / Rücknahme')).toBeInTheDocument();
    expect(screen.getByText(/Eigenverbrauch/)).toBeInTheDocument();
  });

  it('⚠ die Folgen-Karte FOLGT der gewählten Dauer — sonst beschriebe sie eine andere Handlung',
    async () => {
      // Vier Stunden Plan: die 2-h-Vorauswahl ist abschätzbar, „bis morgen früh"
      // reicht über den Horizont hinaus und muss den GRUND nennen.
      vi.spyOn(api, 'schedule').mockResolvedValue(planMitSlots(4) as never);
      render(<JetztZone site={site} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Automatik pausieren' }));
      expect(await screen.findByText(/Der Fahrplan hätte/)).toBeInTheDocument();

      const picker = screen.getByLabelText('Dauer des Eingriffs');
      fireEvent.click(picker);
      fireEvent.click(await screen.findByText('Bis morgen früh (06:00)'));
      await waitFor(() =>
        expect(screen.getByText(/reicht nicht bis zum gewählten Ende/)).toBeInTheDocument());
      expect(screen.queryByText(/Der Fahrplan hätte/)).not.toBeInTheDocument();
    });

  it('ein laufender Eingriff steht im Banner UND in der Zeile', async () => {
    vi.spyOn(api, 'schedule').mockResolvedValue(planMitSlots() as never);
    vi.spyOn(api, 'siteInterventions').mockResolvedValue({
      automationPaused: false, pausedUntil: null,
      interventions: [{
        kind: 'speicher_halten', entityId: 'e-batt', targetValueKw: 0,
        endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        createdBy: 'demo', createdAt: new Date().toISOString(),
      }],
    } as never);
    render(<JetztZone site={site} />);
    expect(await screen.findByText(/Handeingriff läuft: Speicher hält seinen Ladestand/))
      .toBeInTheDocument();
    expect(screen.getAllByText(/Automatik fortsetzen/).length).toBeGreaterThan(0);
  });

  it('eine laufende ANLAGEN-Pause geht im Banner VOR und bietet ihren eigenen Rückweg',
    async () => {
      vi.spyOn(api, 'schedule').mockResolvedValue(planMitSlots() as never);
      vi.spyOn(api, 'siteInterventions').mockResolvedValue({
        automationPaused: true,
        pausedUntil: new Date(Date.now() + 3 * 3600_000).toISOString(),
        interventions: [{
          kind: 'speicher_halten', entityId: 'e-batt', targetValueKw: 0,
          endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
          createdBy: 'demo', createdAt: new Date().toISOString(),
        }],
      } as never);
      render(<JetztZone site={site} />);
      expect(await screen.findByText(/Automatik pausiert bis/)).toBeInTheDocument();
      // ... und NICHT der Geräte-Eingriff (zwei Banner gäbe es nie).
      expect(screen.queryByText(/Handeingriff läuft/)).not.toBeInTheDocument();
      // Während der Pause wird sie nicht ein zweites Mal angeboten.
      expect(screen.queryByRole('button', { name: 'Automatik pausieren' })).not.toBeInTheDocument();
    });

  it('⚠ „Automatik fortsetzen" trifft den RICHTIGEN Umfang, wenn BEIDES läuft', async () => {
    // Speicher-Eingriff UND Anlagen-Pause gleichzeitig: aus dem Wort „resume"
    // allein wäre nicht ableitbar, welchen der beiden der Kunde meint.
    vi.spyOn(api, 'schedule').mockResolvedValue(planMitSlots() as never);
    vi.spyOn(api, 'siteInterventions').mockResolvedValue({
      automationPaused: true,
      pausedUntil: new Date(Date.now() + 3 * 3600_000).toISOString(),
      interventions: [{
        kind: 'speicher_halten', entityId: 'e-batt', targetValueKw: 0,
        endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        createdBy: 'demo', createdAt: new Date().toISOString(),
      }],
    } as never);
    const resumeAnlage = vi.spyOn(api, 'resumeAutomation').mockResolvedValue({} as never);
    const clearSpeicher = vi.spyOn(api, 'clearBatteryOverride').mockResolvedValue({} as never);

    render(<JetztZone site={site} />);
    // Der BANNER gehört der Pause - er muss die ANLAGE fortsetzen.
    fireEvent.click(await screen.findByRole('button', { name: 'Automatik fortsetzen' }));
    // Danach steht derselbe Wortlaut zweimal (Banner + Bestätigen im Dialog) -
    // der ZWEITE ist der des Dialogs.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Automatik fortsetzen' }))
        .toHaveLength(2));
    const knoepfe = screen.getAllByRole('button', { name: 'Automatik fortsetzen' });
    fireEvent.click(knoepfe[knoepfe.length - 1]);
    await waitFor(() => expect(resumeAnlage).toHaveBeenCalledTimes(1));
    expect(clearSpeicher).not.toHaveBeenCalled();
  });

  it('ein älteres Backend ohne die Route lässt die Zone still (fail-soft)', async () => {
    vi.spyOn(api, 'schedule').mockResolvedValue(planMitSlots() as never);
    vi.spyOn(api, 'siteInterventions').mockRejectedValue(new Error('404'));
    render(<JetztZone site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Jetzt' })).toBeInTheDocument());
    expect(screen.queryByText(/Handeingriff läuft/)).not.toBeInTheDocument();
    // Der Pause-Knopf steht trotzdem - er hängt an der Zone, nicht am Abruf.
    expect(await screen.findByRole('button', { name: 'Automatik pausieren' }))
      .toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerbraucherSection } from './VerbraucherSection';
import { api, type Site } from '../api';
import type { Consumer, ConsumerOptions } from '../consumers/types';

const OPTIONS: ConsumerOptions = {
  types: [
    { type: 'wallbox', label: 'Wallbox', controlKinds: ['on_off', 'stepped', 'continuous'], defaultFailsafe: 'release', releaseAllowed: true, intents: ['react', 'cheap'] },
    { type: 'heating-rod', label: 'Heizstab', controlKinds: ['on_off', 'stepped', 'continuous'], defaultFailsafe: 'off', releaseAllowed: false, intents: ['schedule', 'cheap'] },
  ],
  signals: [
    { name: 'market.spot_price_ct_kwh', label: 'Börsenpreis (ct/kWh)', signalClass: 'cloud', valueType: 'number' },
    { name: 'consumer.available', label: 'Gerät verfügbar', signalClass: 'local', valueType: 'boolean' },
  ],
  intents: [
    { key: 'react', title: 'Sofort reagieren', customerLine: '' },
    { key: 'schedule', title: 'Feste Zeiten', customerLine: '' },
    { key: 'deadline', title: 'Bis zu einer Frist erledigen', customerLine: '' },
    { key: 'cheap', title: 'Günstige Energie nutzen', customerLine: '' },
  ],
  hasStorage: false,
  reportedSources: [],
  defaultStorageRelation: 'consumer_first',
  defaultGridEnergyPolicy: 'allow',
};

const CREATED: Consumer = {
  id: 'c-1', type: 'heating-rod', typeLabel: 'Heizstab', name: 'Heizstab Keller',
  controlKind: 'on_off', ratedPowerKw: 3, minPowerKw: null, levelsKw: null, resolutionKw: null,
  powerRangesKw: null, storageRelation: 'consumer_first', defaultGridEnergyPolicy: 'allow',
  allowStorageDischarge: false, failsafe: 'off', enabled: false, version: 1,
  connection: 'disconnected', edgeSourceId: null, controlActivation: 'not_activated',
  hasDraftPolicy: false, draftPolicyVersion: null,
};

const options = vi.fn();
const list = vi.fn();
const create = vi.fn();
const savePolicy = vi.fn();
const status = vi.fn();
const activatePolicy = vi.fn();
const deactivatePolicy = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const fulfillment = vi.fn();
const overrides = vi.fn();
const startOverride = vi.fn();
const clearOverride = vi.fn();

vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    options: (...a: unknown[]) => options(...a),
    list: (...a: unknown[]) => list(...a),
    create: (...a: unknown[]) => create(...a),
    savePolicy: (...a: unknown[]) => savePolicy(...a),
    status: (...a: unknown[]) => status(...a),
    activatePolicy: (...a: unknown[]) => activatePolicy(...a),
    deactivatePolicy: (...a: unknown[]) => deactivatePolicy(...a),
    pause: (...a: unknown[]) => pause(...a),
    resume: (...a: unknown[]) => resume(...a),
    get: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    getPolicy: vi.fn(),
    // Inkrement 5: fulfilment ledger + manual override (fail-soft in the effect).
    fulfillment: (...a: unknown[]) => fulfillment(...a),
    overrides: (...a: unknown[]) => overrides(...a),
    startOverride: (...a: unknown[]) => startOverride(...a),
    clearOverride: (...a: unknown[]) => clearOverride(...a),
  },
}));

const SITE = { id: 's-1', name: 'Demo' } as unknown as Site;

beforeEach(() => {
  options.mockResolvedValue(OPTIONS);
  list.mockResolvedValue([]);
  create.mockResolvedValue(CREATED);
  status.mockResolvedValue([]);
  savePolicy.mockResolvedValue({ entityId: 'c-1', version: 1, lifecycle: 'draft', document: {}, contentHash: 'sha256:x', createdBy: null });
  activatePolicy.mockResolvedValue({
    activated: true, reason: null,
    message: 'Regel aktiviert - VoltPilot steuert den Verbraucher jetzt nach dieser Regel.',
    published: true, policyVersion: 1,
  });
  pause.mockResolvedValue({ published: true, message: 'Verbraucher pausiert.' });
  resume.mockResolvedValue({ activated: true, reason: null, message: 'Fortgesetzt.', published: true, policyVersion: 1 });
  deactivatePolicy.mockResolvedValue({ published: true, message: 'Regel deaktiviert.' });
  fulfillment.mockResolvedValue({ tasks: [] });
  overrides.mockResolvedValue([]);
  startOverride.mockResolvedValue({
    applied: true, pushed: false, kind: 'start', endsAt: null,
    effectivePowerKw: null, gridImportPossible: true, ttlCapped: false, message: '',
  });
  clearOverride.mockResolvedValue({
    applied: true, pushed: false, kind: 'clear', endsAt: null,
    effectivePowerKw: null, gridImportPossible: false, ttlCapped: false, message: '',
  });
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('VerbraucherSection', () => {
  it('creates a consumer as a draft and offers the two ways forward', async () => {
    render(<VerbraucherSection site={SITE} />);
    const add = await screen.findByRole('button', { name: /Verbraucher hinzufügen/ });
    await waitFor(() => expect(add).not.toBeDisabled());
    fireEvent.click(add);

    // Fill the power and save.
    const power = await screen.findByLabelText(/Nennleistung/);
    fireEvent.change(power, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    // The success screen offers exactly the two ways (§14.3).
    expect(await screen.findByRole('button', { name: /Jetzt festlegen/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Später/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Steuerung noch nicht aktiviert/).length).toBeGreaterThan(0);
  });

  it('a draft consumer never claims a live state', async () => {
    list.mockResolvedValue([CREATED]);
    render(<VerbraucherSection site={SITE} />);
    expect(await screen.findByText('Heizstab Keller')).toBeInTheDocument();
    expect(screen.getByText('Noch nicht verbunden')).toBeInTheDocument();
    expect(screen.getByText(/Steuerung noch nicht aktiviert/)).toBeInTheDocument();
  });

  it('without any reported status the surface stays byte-identical (no live line)', async () => {
    list.mockResolvedValue([CREATED]);
    render(<VerbraucherSection site={SITE} />);
    expect(await screen.findByText('Heizstab Keller')).toBeInTheDocument();
    expect(document.querySelector('.vp-vb-live')).toBeNull();
  });

  it('a status-failure is fail-soft: no live line, page intact', async () => {
    list.mockResolvedValue([CREATED]);
    status.mockRejectedValue(new Error('boom'));
    render(<VerbraucherSection site={SITE} />);
    expect(await screen.findByText('Heizstab Keller')).toBeInTheDocument();
    expect(document.querySelector('.vp-vb-live')).toBeNull();
  });

  it('renders the reported live state with its mapped reason and the readback disclaimer', async () => {
    list.mockResolvedValue([CREATED, { ...CREATED, id: 'c-2', name: 'Wallbox Carport' }]);
    status.mockResolvedValue([
      { entityId: 'c-1', state: 'waiting', reasonCode: 'guard_min_off', reportedAt: '2026-08-10T12:00:00Z' },
      { entityId: 'c-2', state: 'running_optimized', confirmed: false, reportedAt: '2026-08-10T12:00:00Z' },
    ]);
    render(<VerbraucherSection site={SITE} />);
    expect(await screen.findByText(/Wartet auf passenden Zeitpunkt/)).toBeInTheDocument();
    expect(screen.getByText(/Mindestpause des Geräts/)).toBeInTheDocument();
    const wb = screen.getByText(/Läuft · von VoltPilot geplant/);
    expect(wb.textContent).toContain('Ausführung nicht bestätigt');
  });

  it('a consumer WITHOUT its own entry while others report reads honest unknown', async () => {
    list.mockResolvedValue([CREATED, { ...CREATED, id: 'c-2', name: 'Wallbox Carport' }]);
    status.mockResolvedValue([
      { entityId: 'c-2', state: 'running_optimized', reportedAt: '2026-08-10T12:00:00Z' },
    ]);
    render(<VerbraucherSection site={SITE} />);
    expect(await screen.findByText(/Zustand nicht bestätigt/)).toBeInTheDocument();
  });

  it('the rule builder saves a policy DRAFT and stays honest about activation', async () => {
    list.mockResolvedValue([CREATED]);
    render(<VerbraucherSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Regel festlegen/ }));

    // Absichtskarte -> Feste Zeiten (a fixed window, so the rule is complete).
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));

    // The permanent sentence preview reflects the document.
    const preview = await screen.findByText(/schaltet VoltPilot Heizstab Keller ein/);
    expect(preview).toBeInTheDocument();
    // A Pflichtlauf shows Netzstrom as a fact, not an editable question.
    expect(screen.getByText('Netzstrom ist für diesen Pflichtlauf erlaubt.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    fireEvent.click(await screen.findByRole('button', { name: /Als Entwurf speichern/ }));

    await waitFor(() => expect(savePolicy).toHaveBeenCalled());
    expect(await screen.findByText('Regel als Entwurf gespeichert.')).toBeInTheDocument();
    expect(screen.getAllByText(/Steuerung noch nicht aktiviert/).length).toBeGreaterThan(0);

    // The saved document validates (the builder never emits an invalid draft).
    const [, , doc] = savePolicy.mock.calls[0];
    expect(doc.requirements[0].kind).toBe('fixed_window');
    // Flag OFF: no activate offer anywhere - byte-identical to Increment 1.
    expect(screen.queryByRole('button', { name: /Speichern & aktivieren/ })).toBeNull();
    expect(activatePolicy).not.toHaveBeenCalled();
  });

  it('with the activation flag ON the review really activates (save → activate)', async () => {
    options.mockResolvedValue({ ...OPTIONS, policyActivationEnabled: true });
    list.mockResolvedValue([CREATED]);
    render(<VerbraucherSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Regel festlegen/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));

    // The review names the real consequence instead of the Increment-1 note.
    expect(await screen.findByText(/Nach dem Aktivieren steuert VoltPilot/)).toBeInTheDocument();
    // Both ways stay open: draft (ghost) and the real activation (primary).
    expect(screen.getByRole('button', { name: 'Als Entwurf speichern' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Speichern & aktivieren/ }));
    await waitFor(() => expect(activatePolicy).toHaveBeenCalledWith('s-1', 'c-1'));
    expect(savePolicy).toHaveBeenCalled();
    expect(await screen.findByText('Regel aktiviert.')).toBeInTheDocument();
    expect(screen.getByText(/steuert den Verbraucher jetzt nach dieser Regel/)).toBeInTheDocument();
  });

  it('an honest refusal keeps the draft and shows the server reason', async () => {
    options.mockResolvedValue({ ...OPTIONS, policyActivationEnabled: true });
    list.mockResolvedValue([CREATED]);
    activatePolicy.mockResolvedValue({
      activated: false, reason: 'compiler_disabled',
      message: 'Die Regel kann auf dieser Umgebung noch nicht verteilt werden.',
      published: false, policyVersion: null,
    });
    render(<VerbraucherSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Regel festlegen/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    fireEvent.click(await screen.findByRole('button', { name: /Speichern & aktivieren/ }));

    await waitFor(() => expect(activatePolicy).toHaveBeenCalled());
    expect(await screen.findByText(/noch nicht verteilt werden/)).toBeInTheDocument();
    expect(screen.getByText(/Die Regel ist als Entwurf gespeichert/)).toBeInTheDocument();
    // Never a false success.
    expect(screen.queryByText('Regel aktiviert.')).toBeNull();
  });

  it('names the V-5 conflict BEFORE the click when a foreign automation claims the consumer', async () => {
    options.mockResolvedValue({ ...OPTIONS, policyActivationEnabled: true });
    list.mockResolvedValue([CREATED]);
    vi.spyOn(api, 'entityStrategies').mockResolvedValue({
      'c-1': [{ flowId: 'f-9', flowName: 'Wallbox-Sparregel' }],
    });
    render(<VerbraucherSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Regel festlegen/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));

    expect(await screen.findByText(/Wallbox-Sparregel/)).toBeInTheDocument();
    expect(screen.getByText(/kann diese Regel nicht aktiviert werden/)).toBeInTheDocument();
  });

  it('an ACTIVE consumer reads "Steuerung aktiv" and can pause; a paused one resumes', async () => {
    list.mockResolvedValue([
      { ...CREATED, controlActivation: 'active', hasDraftPolicy: true, draftPolicyVersion: 2 },
      { ...CREATED, id: 'c-2', name: 'Wallbox Carport', controlActivation: 'paused' },
    ]);
    render(<VerbraucherSection site={SITE} />);

    expect(await screen.findByText('Steuerung aktiv')).toBeInTheDocument();
    expect(screen.getByText(/Pausiert – das Gerät folgt seinem Failsafe/)).toBeInTheDocument();
    // The active row never re-claims "Entwurf gespeichert" next to the badge.
    expect(screen.queryByText(/Regel als Entwurf gespeichert/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pausieren' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('s-1', 'c-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Fortsetzen' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith('s-1', 'c-2'));
  });

  it('the builder of an activated consumer offers the real stop path', async () => {
    list.mockResolvedValue([{ ...CREATED, controlActivation: 'active', hasDraftPolicy: true }]);
    render(<VerbraucherSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Regel bearbeiten/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Regel deaktivieren' }));
    await waitFor(() => expect(deactivatePolicy).toHaveBeenCalledWith('s-1', 'c-1'));
  });

  it('a ?vorlage= deep link (D7) opens the builder prefilled and strips the params', async () => {
    window.location.hash = '#/anlage/s-1/verbraucher?vorlage=schedule-consumer';
    list.mockResolvedValue([CREATED]);
    render(<VerbraucherSection site={SITE} />);

    // The builder opens on the QUESTIONS (intent already prefilled to
    // "Feste Zeiten"), not on the intent cards.
    expect(await screen.findByText(/Regel für Heizstab Keller/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Feste Zeiten/ })).toBeNull();
    // The template's daily window is prefilled.
    expect(screen.getByLabelText('Von')).toHaveValue('11:00');
    // Params are consumed once - the hash is clean again.
    expect(window.location.hash).not.toContain('vorlage=');
  });

  it('a ?vorlage= deep link without any consumer opens the create wizard first', async () => {
    window.location.hash = '#/anlage/s-1/verbraucher?vorlage=pv-surplus-consumer';
    list.mockResolvedValue([]);
    render(<VerbraucherSection site={SITE} />);
    expect(await screen.findByLabelText(/Nennleistung/)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerbraucherSection } from './VerbraucherSection';
import type { Site } from '../api';
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

vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    options: (...a: unknown[]) => options(...a),
    list: (...a: unknown[]) => list(...a),
    create: (...a: unknown[]) => create(...a),
    savePolicy: (...a: unknown[]) => savePolicy(...a),
    get: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    getPolicy: vi.fn(),
  },
}));

const SITE = { id: 's-1', name: 'Demo' } as unknown as Site;

beforeEach(() => {
  options.mockResolvedValue(OPTIONS);
  list.mockResolvedValue([]);
  create.mockResolvedValue(CREATED);
  savePolicy.mockResolvedValue({ entityId: 'c-1', version: 1, lifecycle: 'draft', document: {}, contentHash: 'sha256:x', createdBy: null });
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
  });
});

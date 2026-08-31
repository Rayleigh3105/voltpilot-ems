import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerbraucherAnlegenDrawer, VerbraucherRegelDrawer } from './VerbraucherDrawers';
import { api, type Site } from '../api';
import type { Consumer, ConsumerOptions } from '../consumers/types';

/**
 * Die zwei EINSCHÜBE der Verbraucher-Welt. Bis zum Einheitsmodell (Stufe 5a)
 * lagen sie auf der eigenen Seite „Verbraucher"; die SEITE ist aufgelöst, die
 * Einschübe sind wörtlich dieselben und werden jetzt von der Regeln-Kapsel
 * gehostet — die Liste-Seite dieser Fälle steht deshalb in
 * `pages/SteuerungSection.test.tsx`.
 */

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

const create = vi.fn();
const savePolicy = vi.fn();
const activatePolicy = vi.fn();
const deactivatePolicy = vi.fn();

vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    create: (...a: unknown[]) => create(...a),
    savePolicy: (...a: unknown[]) => savePolicy(...a),
    activatePolicy: (...a: unknown[]) => activatePolicy(...a),
    deactivatePolicy: (...a: unknown[]) => deactivatePolicy(...a),
  },
}));

const SITE = { id: 's-1', name: 'Demo' } as unknown as Site;

beforeEach(() => {
  create.mockResolvedValue(CREATED);
  savePolicy.mockResolvedValue({
    entityId: 'c-1', version: 1, lifecycle: 'draft', document: {},
    contentHash: 'sha256:x', createdBy: null,
  });
  activatePolicy.mockResolvedValue({
    activated: true, reason: null,
    message: 'Regel aktiviert - VoltPilot steuert den Verbraucher jetzt nach dieser Regel.',
    published: true, policyVersion: 1,
  });
  deactivatePolicy.mockResolvedValue({ published: true, message: 'Regel deaktiviert.' });
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('VerbraucherAnlegenDrawer', () => {
  it('legt eine Komponente als Entwurf an und bietet die zwei Wege weiter', async () => {
    render(
      <VerbraucherAnlegenDrawer
        site={SITE}
        options={OPTIONS}
        open
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    const power = await screen.findByLabelText(/Nennleistung/);
    fireEvent.change(power, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    // Der Erfolgs-Schritt bietet genau die zwei Wege (§14.3).
    expect(await screen.findByRole('button', { name: /Jetzt festlegen/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Später/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Steuerung noch nicht aktiviert/).length).toBeGreaterThan(0);
  });

  it('verlangt die Nennleistung - und lässt GENAU den Typ sie weg, der es darf (P8)', async () => {
    // ⚠ Die Regel kommt vom SERVER (`ratedPowerRequired`), nicht aus einem
    // Typ-Vergleich in der Fläche.
    const options: ConsumerOptions = {
      ...OPTIONS,
      types: [
        { type: 'heat-pump-sgready', label: 'Wärmepumpe (SG-Ready)', controlKinds: ['on_off'],
          defaultFailsafe: 'off', releaseAllowed: false, intents: [],
          ratedPowerRequired: false },
        ...OPTIONS.types,
      ],
    };
    render(
      <VerbraucherAnlegenDrawer
        site={SITE} options={options} open onClose={() => {}} onCreated={() => {}}
      />,
    );
    // Das Feld sagt selbst, dass es optional ist, und WARUM.
    expect(await screen.findByLabelText(/Nennleistung \(kW, optional\)/)).toBeInTheDocument();
    expect(screen.getByText(/entscheidet sie selbst/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    // Leer gelassen heißt WEGGELASSEN - nie eine erfundene 0.
    expect(create.mock.calls[0][1]).not.toHaveProperty('ratedPowerKw');
  });

  it('⚠ ohne das Server-Feld bleibt die Nennleistung Pflicht (älteres Backend)', async () => {
    render(
      <VerbraucherAnlegenDrawer
        site={SITE} options={OPTIONS} open onClose={() => {}} onCreated={() => {}}
      />,
    );
    expect(await screen.findByLabelText(/Nennleistung \(kW\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(screen.getByText(/Leistung größer als 0/)).toBeInTheDocument());
    expect(create).not.toHaveBeenCalled();
  });
});

function regelDrawer(over: Partial<Consumer> = {}, options: ConsumerOptions = OPTIONS) {
  return render(
    <VerbraucherRegelDrawer
      site={SITE}
      options={options}
      consumer={{ ...CREATED, ...over }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

describe('VerbraucherRegelDrawer', () => {
  it('speichert einen ENTWURF und bleibt ehrlich zur Aktivierung', async () => {
    regelDrawer();
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));

    // Die permanente Satz-Vorschau spiegelt das Dokument.
    expect(await screen.findByText(/schaltet VoltPilot Heizstab Keller ein/)).toBeInTheDocument();
    // Ein Pflichtlauf zeigt Netzstrom als FAKT, nicht als Frage.
    expect(screen.getByText('Netzstrom ist für diesen Pflichtlauf erlaubt.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    fireEvent.click(await screen.findByRole('button', { name: /Als Entwurf speichern/ }));

    await waitFor(() => expect(savePolicy).toHaveBeenCalled());
    expect(await screen.findByText('Regel als Entwurf gespeichert.')).toBeInTheDocument();
    const [, , doc] = savePolicy.mock.calls[0];
    expect(doc.requirements[0].kind).toBe('fixed_window');
    // Flag AUS: nirgends ein Aktivieren-Angebot.
    expect(screen.queryByRole('button', { name: /Speichern & aktivieren/ })).toBeNull();
    expect(activatePolicy).not.toHaveBeenCalled();
  });

  it('aktiviert mit gesetztem Flag wirklich (speichern → aktivieren)', async () => {
    regelDrawer({}, { ...OPTIONS, policyActivationEnabled: true });
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));

    expect(await screen.findByText(/Nach dem Aktivieren steuert VoltPilot/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Als Entwurf speichern' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Speichern & aktivieren/ }));
    await waitFor(() => expect(activatePolicy).toHaveBeenCalledWith('s-1', 'c-1'));
    expect(savePolicy).toHaveBeenCalled();
    expect(await screen.findByText('Regel aktiviert.')).toBeInTheDocument();
  });

  it('eine ehrliche Ablehnung behält den Entwurf und nennt den Server-Grund', async () => {
    activatePolicy.mockResolvedValue({
      activated: false, reason: 'compiler_disabled',
      message: 'Die Regel kann auf dieser Umgebung noch nicht verteilt werden.',
      published: false, policyVersion: null,
    });
    regelDrawer({}, { ...OPTIONS, policyActivationEnabled: true });
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    fireEvent.click(await screen.findByRole('button', { name: /Speichern & aktivieren/ }));

    await waitFor(() => expect(activatePolicy).toHaveBeenCalled());
    expect(await screen.findByText(/noch nicht verteilt werden/)).toBeInTheDocument();
    expect(screen.getByText(/Die Regel ist als Entwurf gespeichert/)).toBeInTheDocument();
    // Nie ein Schein-Erfolg.
    expect(screen.queryByText('Regel aktiviert.')).toBeNull();
  });

  it('nennt den V-5-Konflikt VOR dem Klick', async () => {
    render(
      <VerbraucherRegelDrawer
        site={SITE}
        options={{ ...OPTIONS, policyActivationEnabled: true }}
        consumer={CREATED}
        claims={[{ flowId: 'f-9', flowName: 'Wallbox-Sparregel' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Feste Zeiten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));

    expect(await screen.findByText(/Wallbox-Sparregel/)).toBeInTheDocument();
    expect(screen.getByText(/kann diese Regel nicht aktiviert werden/)).toBeInTheDocument();
  });

  it('der Baukasten einer aktivierten Regel bietet den echten Stopp-Weg', async () => {
    regelDrawer({ controlActivation: 'active', hasDraftPolicy: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Regel deaktivieren' }));
    await waitFor(() => expect(deactivatePolicy).toHaveBeenCalledWith('s-1', 'c-1'));
  });

  it('eine Vorbefüllung öffnet direkt die Fragen, nicht die Absichtskarten', async () => {
    render(
      <VerbraucherRegelDrawer
        site={SITE}
        options={OPTIONS}
        consumer={CREATED}
        prefill={{ intent: 'schedule', recurrence: { days: 'daily', from: '11:00', to: '15:00' } }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(await screen.findByText(/Regel für Heizstab Keller/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Feste Zeiten/ })).toBeNull();
    expect(screen.getByLabelText('Von')).toHaveValue('11:00');
  });
});

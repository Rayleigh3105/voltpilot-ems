import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Selbstauskunft } from '../api';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { Consumer } from '../consumers/types';
import { setSelbstauskunft } from '../rollen';
import { HeizstabKarte, heizStufen } from './HeizstabKarte';

const startOverride = vi.fn();
const clearOverride = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const patch = vi.fn();
const testComponentConnection = vi.fn();
const updateComponent = vi.fn();
const edgeVersions = vi.fn();
const siteVerbraucher = vi.fn();
vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      testComponentConnection: (...a: unknown[]) => testComponentConnection(...a),
      updateComponent: (...a: unknown[]) => updateComponent(...a),
      edgeVersions: (...a: unknown[]) => edgeVersions(...a),
      siteVerbraucher: (...a: unknown[]) => siteVerbraucher(...a),
    },
  };
});
vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    startOverride: (...a: unknown[]) => startOverride(...a),
    clearOverride: (...a: unknown[]) => clearOverride(...a),
    pause: (...a: unknown[]) => pause(...a),
    resume: (...a: unknown[]) => resume(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

// Ein Heizstab aus Paket 3: Stufenprofil [0, 2, 4, 6] kW über drei Ausgänge.
const ROD = {
  id: 'rod-1', type: 'heating-rod', typeLabel: 'Heizstab', name: 'Heizstab', controlKind: 'stepped',
  ratedPowerKw: 6, levelsKw: [0, 2, 4, 6], controlActivation: 'active', allowStorageDischarge: false, version: 7,
} as unknown as Consumer;

const PRO3 = {
  id: 'rod-1', role: 'consumer', label: 'Heizstab', templateRef: 'shelly-pro-3', templateVersion: 2, definitionVersion: 4,
  connection: { ip: '192.168.178.43', channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3], rotation: 'daily', anschluss: 'stern_mit_n' },
};
const JETZT = new Date('2026-11-05T10:05:00Z');

function status(p: Partial<ConsumerRuntimeStatus>): ConsumerRuntimeStatus {
  return { entityId: 'rod-1', state: 'running_optimized', reportedAt: '2026-11-05T10:05:00Z', ...p };
}
const heizt = status({
  stufe: { commanded: 2, commanded_kw: 4, confirmed: 2, confirmed_kw: 4, outputs_on: [0, 1], at: '2026-11-05T10:04:00Z' },
  heizstab: { stufe: 2, code: 'ueberschuss', grund: 'Heizt mit Überschuss.' },
});

function box(phasen: boolean) {
  edgeVersions.mockResolvedValue({
    eintraege: [{ deviceId: 'b1', siteId: 'site-1', capabilities: phasen ? ['heizstab_regler', 'heizstab_phasen'] : ['heizstab_regler'] }],
  });
}

function karte(p: Partial<Parameters<typeof HeizstabKarte>[0]> = {}) {
  return render(
    <HeizstabKarte siteId="site-1" consumer={ROD} status={heizt} override={null} kanaele={3} komponente={PRO3}
      jetzt={JETZT} onGeaendert={() => {}} {...p} />,
  );
}

describe('Heizstab: Smart zuerst, ein Schalter je Phase', () => {
  beforeEach(() => {
    for (const f of [startOverride, clearOverride, pause, resume, patch, testComponentConnection, updateComponent]) f.mockReset().mockResolvedValue({});
    startOverride.mockResolvedValue({ pushed: true, phasenGenau: true, message: 'Der Verbraucher wird gestartet.' });
    box(true);
    siteVerbraucher.mockReset().mockResolvedValue({
      verbraucher: [{ entityId: 'rod-1', name: 'Heizstab', typ: 'heating-rod', typLabel: 'Heizstab', ladepunkt: false,
        steuerart: { quelle: 'ueberschuss', herkunft: 'policy' }, regeln: 0 }],
      ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
      rangliste: [{ position: 1, art: 'verbraucher', entityId: 'rod-1', name: 'Heizstab' }],
    });
    setSelbstauskunft({
      zustand: 'aktiv', unternehmen_rechte: ['handeingriff.setzen', 'geraet.einrichten', 'betriebsweise.aendern'], standorte: [],
    } as unknown as Selbstauskunft);
  });
  afterEach(() => setSelbstauskunft(null));

  it('liest die Stufen aus dem Profil', () => {
    expect(heizStufen(ROD, 3)).toEqual([
      { stufe: 1, ausgaenge: 1, kw: 2 }, { stufe: 2, ausgaenge: 2, kw: 4 }, { stufe: 3, ausgaenge: 3, kw: 6 },
    ]);
  });

  it('Smart steht oben, darunter je Phase ein Schalter in der BESTÄTIGTEN Stellung', async () => {
    karte();
    const smart = screen.getByTestId('heizstab-smart');
    expect(smart).toHaveTextContent('Heizt mit Überschuss.');
    expect(within(smart).getByRole('switch', { name: 'Smart ruhen lassen' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(screen.getByRole('switch', { name: 'L1 ausschalten' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('switch', { name: 'L2 ausschalten' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'L3 einschalten' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/2,0\skW je Phase/)).toBeInTheDocument();
    await waitFor(() => expect(smart).toHaveTextContent('Smart · Überschuss'));
  });

  it('ein Tipp auf L3 schaltet von Hand: L1 bis L3 für zwei Stunden (D1-A)', async () => {
    const onGeaendert = vi.fn();
    karte({ onGeaendert });
    fireEvent.click(await screen.findByRole('switch', { name: 'L3 einschalten' }));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalled());
    expect(startOverride).toHaveBeenCalledWith('site-1', 'rod-1', { action: 'start', durationMinutes: 120, ausgaenge: [0, 1, 2] });
  });

  it('die letzte Phase aus ist „Aus“ von Hand, ebenfalls zwei Stunden', async () => {
    const einPhase = status({ stufe: { commanded: 1, confirmed: 1, confirmed_kw: 2, outputs_on: [1] } });
    karte({ status: einPhase });
    fireEvent.click(await screen.findByRole('switch', { name: 'L2 ausschalten' }));
    await waitFor(() => expect(startOverride).toHaveBeenCalledWith('site-1', 'rod-1', { action: 'stop', durationMinutes: 120 }));
  });

  it('eine nicht erlaubte Zahl schickt nichts und sagt warum', async () => {
    karte({ komponente: { ...PRO3, connection: { ...PRO3.connection, stages: [1, 3] } }, status: status({ stufe: { commanded: 1, confirmed: 1, outputs_on: [0] } }) });
    fireEvent.click(await screen.findByRole('switch', { name: 'L2 einschalten' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 Phasen zugleich sind bei diesem Heizstab nicht erlaubt (erlaubt: 1, 3).');
    expect(startOverride).not.toHaveBeenCalled();
  });

  it('von Hand: der Wunsch wartet sichtbar, Smart ruht bis zur Rückkehr, „Zurück zu Smart“ beendet es', async () => {
    karte({
      status: status({ stufe: { commanded: 2, confirmed: 1, outputs_on: [0] } }),
      override: { entityId: 'rod-1', kind: 'start', targetCommand: 'setpoint_kw', targetValue: 4, targetOutputs: [0, 2], endsAt: '2026-11-05T12:00:00Z' },
    });
    expect(screen.getByTestId('heizstab-smart')).toHaveTextContent('Smart ruhtVon Hand geschaltet');
    expect(screen.getByTestId('heizstab-hand')).toHaveTextContent('Von Hand · Smart wieder ab 13:00');
    const l3 = await screen.findByTestId('heizstab-phase-L3');
    expect(l3).toHaveTextContent('schaltet ein …');
    expect(l3).toHaveTextContent('gesendet, noch nicht bestätigt');
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu Smart' }));
    await waitFor(() => expect(clearOverride).toHaveBeenCalledWith('site-1', 'rod-1'));
    expect(resume).not.toHaveBeenCalled();
  });

  it('ohne Rückmeldung steht „?“, nie „aus“', async () => {
    karte({ status: null });
    const l1 = await screen.findByTestId('heizstab-phase-L1');
    expect(l1).toHaveTextContent('?');
    expect(l1).toHaveTextContent('noch keine Rückmeldung der Box');
    expect(within(l1).getByRole('switch')).toHaveAttribute('aria-checked', 'mixed');
  });

  it('der Smart-Schalter: aus = Smart ruht (Pausieren), an = fortsetzen (D3-A)', async () => {
    const { unmount } = karte();
    fireEvent.click(screen.getByRole('switch', { name: 'Smart ruhen lassen' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('site-1', 'rod-1'));
    unmount();
    karte({ consumer: { ...ROD, controlActivation: 'paused' } as Consumer, status: status({ stufe: { commanded: 0, confirmed: 0, outputs_on: [] } }) });
    expect(screen.getByTestId('heizstab-smart')).toHaveTextContent('Der Stab bleibt aus, bis Smart wieder an ist.');
    // Die Phasen-Schalter gehen weiter, auch wenn Smart ruht.
    expect(await screen.findByRole('switch', { name: 'L1 einschalten' })).toBeEnabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Smart einschalten' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith('site-1', 'rod-1'));
  });

  it('eine Box ohne heizstab_phasen schaltet Stufen und sagt, dass Phasen ein Update brauchen', async () => {
    box(false);
    karte();
    expect(await screen.findByText('Einzelne Phasen nach dem nächsten Update der Box')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /L1/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 Phase' }));
    await waitFor(() => expect(startOverride).toHaveBeenCalledWith('site-1', 'rod-1', { action: 'start', durationMinutes: 120, stufe: 1 }));
  });

  it('die Antwort einer älteren Box steht da, wenn sie die Phasen noch selbst wählt', async () => {
    startOverride.mockResolvedValue({ pushed: true, phasenGenau: false, message: 'Der Verbraucher wird gestartet. Ihre Box wählt die Phasen noch selbst; einzelne Phasen schaltet sie nach dem nächsten Update.' });
    karte();
    fireEvent.click(await screen.findByRole('switch', { name: 'L3 einschalten' }));
    expect(await screen.findByText(/Ihre Box wählt die Phasen noch selbst/)).toBeInTheDocument();
  });

  it('ein Stab „nur alle zusammen“ hat einen Schalter für alle Phasen', async () => {
    karte({ komponente: { ...PRO3, connection: { ...PRO3.connection, stages: [3] } }, status: status({ stufe: { commanded: 0, confirmed: 0, outputs_on: [] } }) });
    fireEvent.click(await screen.findByRole('switch', { name: 'Heizstab einschalten' }));
    expect(screen.getByText('L1–3')).toBeInTheDocument();
    await waitFor(() => expect(startOverride).toHaveBeenCalledWith('site-1', 'rod-1', { action: 'start', durationMinutes: 120, stufe: 3 }));
  });

  it('ein offener Anschluss steht sichtbar da und sperrt jedes Schalten', async () => {
    karte({ komponente: { ...PRO3, connection: { ...PRO3.connection, anschluss: 'unbekannt' } } });
    expect(screen.getByTestId('heizstab-anschluss-offen')).toHaveTextContent(/schaltet VoltPilot den Heizstab nicht/);
    expect(await screen.findByRole('switch', { name: 'L3 einschalten' })).toBeDisabled();
  });

  it('Einstellungen: eine Zeile, zugeklappt mit den Werten (D2-A)', async () => {
    karte();
    const e = screen.getByTestId('heizstab-einstellungen');
    expect(e).not.toHaveAttribute('open');
    await waitFor(() => expect(within(e).getByText('Überschuss · Speicher hilft nicht · Platz 1 von 1 · Technik')).toBeInTheDocument());
    expect(within(e).getAllByRole('link', { name: 'Ändern' })[0]).toHaveAttribute('href', '#/anlage/site-1/steuerung?einstellungen=rod-1');
    fireEvent.click(within(e).getByRole('switch', { name: 'Speicher darf aushelfen' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('site-1', 'rod-1', { allowStorageDischarge: true, expectedVersion: 7 }));
  });

  it('Technik: ein Stab mit zu wenigen Ausgängen lässt sich reparieren - erst prüfen, dann speichern', async () => {
    testComponentConnection.mockResolvedValue({
      requestId: 'r1',
      results: [{ id: 'verbindung', ok: true, samples: [{ channel: 'relay_on_0', raw: 0, value: 0, count: 1 }] }],
    });
    const onGeaendert = vi.fn();
    const einer = { ...PRO3, connection: { ip: '192.168.178.43', channels: [0], output_kw: [1.5], stages: [1], rotation: 'daily', anschluss: 'stern_mit_n' } };
    karte({ komponente: einer, kanaele: 1, onGeaendert, status: status({ stufe: { commanded: 0, confirmed: 0, outputs_on: [] } }) });
    const e = screen.getByTestId('heizstab-einstellungen');
    expect(within(e).getByText(/1 Ausgang · 1,5\skW je Element · Stern mit N/)).toBeInTheDocument();
    fireEvent.click(within(e).getByRole('button', { name: '3' }));
    fireEvent.click(within(e).getByRole('button', { name: '3 Ausgänge prüfen und speichern' }));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalled());
    expect(testComponentConnection.mock.calls[0][1]).toMatchObject({ entityId: 'rod-1', connection: { channels: [0, 1, 2] } });
    expect(updateComponent.mock.calls[0][2]).toMatchObject({
      expectedRevision: 4,
      connection: { channels: [0, 1, 2], output_kw: [1.5, 1.5, 1.5], stages: [1, 2, 3], anschluss: 'stern_mit_n', ip: '192.168.178.43' },
    });
  });

  it('„Immer L1“ prüft die Verbindung und speichert sie mit rotation fixed', async () => {
    testComponentConnection.mockResolvedValue({
      requestId: 'r1',
      results: [{ id: 'verbindung', ok: true, samples: [{ channel: 'relay_on_0', raw: 0, value: 0, count: 1 }] }],
    });
    const onGeaendert = vi.fn();
    karte({ onGeaendert });
    expect(screen.getByRole('button', { name: 'Täglich wechselnd' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Immer L1' }));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalled());
    expect(testComponentConnection.mock.calls[0][1]).toMatchObject({ entityId: 'rod-1', connection: { rotation: 'fixed' } });
    expect(updateComponent.mock.calls[0][2]).toMatchObject({
      expectedRevision: 4, connection: { rotation: 'fixed', channels: [0, 1, 2], anschluss: 'stern_mit_n' },
    });
  });

  it('im Dialog ohne eigene Einstellungen, mit dem Weg zur Geräteseite', async () => {
    karte({ einstellungen: false, zurGeraeteseite: '#/anlage/site-1/geraet/edge-1/src-1' });
    expect(screen.queryByTestId('heizstab-einstellungen')).toBeNull();
    expect(screen.getByRole('link', { name: /Zur Geräteseite/ })).toHaveAttribute('href', '#/anlage/site-1/geraet/edge-1/src-1');
    // Smart nennt seine Art auch im Dialog.
    await waitFor(() => expect(screen.getByTestId('heizstab-smart')).toHaveTextContent('Smart · Überschuss'));
  });
});

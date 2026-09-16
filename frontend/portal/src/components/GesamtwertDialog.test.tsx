import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type MeasurementCatalogPoint } from '../api';
import { GesamtwertDialog } from './GesamtwertDialog';
import { SummenwertAssistent } from './SummenwertAssistent';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';

const gen = 'deye.hybrid_3p.generator-smartload-microinverter.generator-power';
function point(key: string, value: number | null, extra = {}): MeasurementCatalogPoint {
  return { pointKey: key, labelDe: key === gen ? 'Gen-Port' : key, group: 'PV', quantity: 'active_power',
    direction: 'generation', aggregationKind: 'gauge', unit: 'kW', selected: true,
    decodedValue: value === null ? null : String(value), lastReadAt: new Date().toISOString(),
    estimatedDataPerYearBytes: 400_000_000, ...extra } as MeasurementCatalogPoint;
}
function stub(points = [point('PV 1', 5.2), point('PV 2', 4.1), point('PV 3', 3.1), point(gen, null, { selected: false, direction: null })]) {
  vi.spyOn(api, 'summenwertQuellen').mockResolvedValue([{ entityId: 'inv', deviceId: 'd1', name: 'Deye SUN-30K', grund: null }]);
  vi.spyOn(api, 'measurementCatalog').mockResolvedValue({ points, total: points.length } as never);
  vi.spyOn(api, 'measurementSelection').mockResolvedValue({ desiredRevision: 1 } as never);
  const observe = vi.spyOn(api, 'changeMeasurementSelection').mockResolvedValue({ desiredRevision: 2 } as never);
  const read = vi.spyOn(api, 'measurementLesen').mockResolvedValue({ wert: 2, einheit: 'kW', gelesen_am: new Date().toISOString() });
  vi.spyOn(api, 'geraetRolle').mockResolvedValue({ zugeordnet: null } as never);
  const save = vi.spyOn(api, 'berechneteMessstelleAnlegen').mockImplementation(async (b) => ({ id: 'gw', name: b.name, kennzeichen: 'MS-0007' }) as never);
  return { read, observe, save };
}
function mount(device = false, onGespeichert = vi.fn()) {
  const common = { open: true, siteId: 's1', onClose: vi.fn(), onGespeichert };
  return device ? render(<SummenwertAssistent {...common} kontext={{ art: 'geraet', boxId: 'd1', geraetId: 'inverter' }} deviceId="d1" entityId="inv" geraetName="Deye SUN-30K" />) : render(<GesamtwertDialog {...common} />);
}
function next() { fireEvent.click(screen.getByRole('button', { name: 'Weiter', exact: true })); }
async function rolle() { next(); await screen.findByText('Wie zählen wir sie?'); next(); await screen.findByLabelText('Name des Summenwerts'); next(); }
afterEach(() => vi.restoreAllMocks());

describe('ein Summenwert-Assistent für Gerät und Anlage', () => {
  it('Anlagen-Einstieg beginnt ohne Vorauswahl und führt in fünf Schritten ohne Rolle', async () => {
    const { save } = stub(); const cb = vi.fn(); mount(false, cb);
    const choose = await screen.findByRole('button', { name: 'PV 1 mitzählen' });
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    fireEvent.click(choose); fireEvent.click(screen.getByRole('button', { name: 'PV 2 mitzählen' }));
    await rolle();
    expect(screen.getByRole('button', { name: 'keine Rolle', exact: true })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern', exact: true }));
    await screen.findByText(/ist angelegt/);
    expect(save.mock.calls[0][0].rolle).toBeUndefined();
    expect(save.mock.calls[0][0].terme).toHaveLength(2);
    expect(cb).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Fertig', exact: true })).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('Geräte-Kontext lädt nur die aufgelösten Komponenten, auch mehrere am selben Gerät', async () => {
    const { save } = stub();
    vi.mocked(api.summenwertQuellen).mockImplementation(async (_site, context) => context?.art === 'geraet'
      ? [{ entityId: 'inv', deviceId: 'd1', name: 'Deye', grund: null }, { entityId: 'haus', deviceId: 'd1', name: 'Haus', grund: null }]
      : [{ entityId: 'other', deviceId: 'd1', name: 'Anderes Gerät', grund: null }]);
    mount(true); await screen.findByRole('button', { name: 'PV 1 entfernen' });
    expect(api.summenwertQuellen).toHaveBeenCalledWith('s1', { art: 'geraet', boxId: 'd1', geraetId: 'inverter' });
    expect(vi.mocked(api.measurementCatalog).mock.calls.map(c => c[1].get('entityId'))).toEqual(['inv', 'haus']);
    expect(screen.queryByText('Weitere Geräte dieser Anlage')).not.toBeInTheDocument();
    expect(screen.getByText(/Wählen Sie Register von diesem Gerät/)).toBeVisible();
    await rolle(); fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].kontext).toEqual({ art: 'geraet', site_id: 's1', box_id: 'd1', geraet_id: 'inverter' });
  });

  it('fehlende Familie nennt die Zuordnung statt einer ergebnislosen Suche', async () => {
    stub([]); vi.mocked(api.measurementCatalog).mockResolvedValue({ points: [], total: 0, availabilityReason: 'registerfamilie_nicht_zugeordnet' } as never);
    mount(true);
    expect(await screen.findByText(/Registerfamilie nicht zugeordnet/)).toBeVisible();
    expect(screen.queryByText('Keine passenden Register.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  });

  it('ein verweigerter Quellenabruf bleibt ein Ladefehler und lädt keinen Katalog', async () => {
    stub(); vi.mocked(api.summenwertQuellen).mockRejectedValue(new Error('403'));
    mount(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Register konnten nicht geladen werden.');
    expect(api.measurementCatalog).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  });

  it('ohne lesende Box benennt der Dialog die fehlende Zuordnung', async () => {
    stub(); vi.mocked(api.summenwertQuellen).mockResolvedValue([{ entityId: 'inv', deviceId: null, name: 'Deye', grund: 'keine_wahl' }]);
    mount(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Keine lesende Box zugeordnet: Deye.');
    expect(api.measurementCatalog).not.toHaveBeenCalled();
  });

  it('Gen-Port: ein Lesen je Sitzung, keine Beobachtung vor Speichern, atomar mit PV-Rolle', async () => {
    const { read, observe, save } = stub(); mount(true);
    await screen.findByRole('button', { name: 'PV 1 entfernen' });
    const lesen = screen.getByRole('button', { name: 'Gen-Port einmal lesen', hidden: true });
    fireEvent.click(lesen);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    await screen.findByText(/jetzt gelesen/);
    expect(observe).not.toHaveBeenCalled();
    const entscheid = screen.getByText('Am Gen-Port hängt ein Mikrowechselrichter?').closest('.vp-sw-suggest')!;
    fireEvent.click(within(entscheid as HTMLElement).getByRole('checkbox', { hidden: true }));
    fireEvent.click(within(entscheid as HTMLElement).getByRole('checkbox', { hidden: true }));
    fireEvent.click(within(entscheid as HTMLElement).getByRole('checkbox', { hidden: true }));
    expect(read).toHaveBeenCalledOnce();
    await rolle();
    fireEvent.click(screen.getByRole('button', { name: 'PV-Produktion', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern', exact: true }));
    await screen.findByText(/ist angelegt/);
    expect(observe).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({ rolle: { entity_id: 'inv', role: 'pv', ersetzen: false } });
    expect(save.mock.calls[0][0].terme[3]).toMatchObject({ point_key: gen, gilt_als_erzeugung: true });
    expect(document.body.textContent).toContain('14,4');
  });

  it('auch am Gerät ändern Vorzeichen und Faktor genau die Anfrage', async () => {
    const { save } = stub(); mount(true); await screen.findByRole('button', { name: 'PV 1 entfernen' });
    next();
    fireEvent.click(within(screen.getByRole('group', { name: 'Vorzeichen für PV 2' })).getByRole('button', { name: '−' }));
    fireEvent.click(screen.getByRole('button', { name: /Feineinstellung/ }));
    fireEvent.change(screen.getByLabelText('Faktor für PV 2'), { target: { value: '0.5' } });
    next(); next(); fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].terme[1]).toMatchObject({ vorzeichen: '-', faktor: 0.5 });
  });

  it('ein fehlender oder veralteter Eingang liefert keine Teilsumme und nie Null', async () => {
    stub([point('PV 1', 5.2), point('PV 2', 4.1, { lastReadAt: '2000-01-01T00:00:00Z' })]); mount(true);
    await screen.findByRole('button', { name: 'PV 1 entfernen' });
    expect(screen.getByText('unvollständig', { exact: true })).toBeVisible();
    expect(screen.getByText(/liefert keinen aktuellen Wert/)).toHaveTextContent('PV 2');
  });

  it('ein fehlgeschlagenes Lesen bleibt fehlend und schreibt nichts', async () => {
    const { read, observe } = stub(); read.mockResolvedValue({ wert: null, einheit: 'kW', gelesen_am: null, grund: 'box_offline' });
    mount(true); fireEvent.click(await screen.findByRole('button', { name: 'Gen-Port einmal lesen', hidden: true }));
    await screen.findByText(/die Box antwortet nicht/); expect(observe).not.toHaveBeenCalled();
  });

  it('ohne Einrichtungsrecht kann ein Summenwert nur ohne Rolle gespeichert werden', async () => {
    stub(); const me = rechteSeed().me; me.unternehmen_rechte = me.unternehmen_rechte.filter((r) => r !== 'geraet.einrichten');
    setSelbstauskunft(me); mount(true); await screen.findByRole('button', { name: 'PV 1 entfernen' }); await rolle();
    expect(screen.queryByRole('button', { name: 'PV-Produktion', exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled();
  });

  it('weitere Geräte der Anlage bilden einen Verbrauch mit einer atomaren Rollenwahl', async () => {
    const { save } = stub([point('Wirkleistung', 148.6, { direction: 'import' })]);
    vi.mocked(api.summenwertQuellen).mockResolvedValue([
      { entityId: 'inv', deviceId: 'd1', name: 'Spritzguss', grund: null },
      { entityId: 'druck', deviceId: 'd2', name: 'Druckluft', grund: null },
    ]);
    mount(); await screen.findAllByRole('button', { name: 'Wirkleistung mitzählen' });
    for (const b of screen.getAllByRole('button', { name: 'Wirkleistung mitzählen' })) fireEvent.click(b);
    await rolle(); fireEvent.click(screen.getByRole('button', { name: 'Verbrauch', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].terme.map((t) => t.entity_id)).toEqual(['inv', 'druck']);
    expect(save.mock.calls[0][0].rolle?.role).toBe('consumer');
  });

  it('Netz entsteht als Bezug minus Abgabe und fragt vor dem Ablösen', async () => {
    const { save } = stub([point('Bezug', 8, { direction: 'import' }), point('Abgabe', 2, { direction: 'export' })]);
    vi.spyOn(api, 'rollenWert').mockResolvedValue({ zuordnung_vorhanden: true, geraete: [{ name: 'Bisheriger Netzwert', art: 'messkanal' }] } as never);
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Bezug mitzählen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abgabe mitzählen' })); next();
    fireEvent.click(within(screen.getByRole('group', { name: 'Vorzeichen für Abgabe' })).getByRole('button', { name: '−' }));
    next(); next(); fireEvent.click(screen.getByRole('button', { name: 'Netz', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Zuordnung ersetzen?'); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ersetzen', exact: true }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].rolle).toMatchObject({ role: 'grid', ersetzen: true });
    expect(save.mock.calls[0][0].terme[1].vorzeichen).toBe('-');
  });

  it('ein atomarer Rollenfehler lässt die Anfrage im Dialog korrigierbar', async () => {
    const { save } = stub(); save.mockRejectedValue(new Error('Netzwert schon vorhanden.'));
    mount(true); await screen.findByRole('button', { name: 'PV 1 entfernen' }); await rolle();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Netzwert schon vorhanden.');
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled();
  });
});

it('ein Entzug des Messauswahlrechts vor Speichern schreibt weder Auswahl noch Summe', async () => {
  const { observe, save } = stub(); mount(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Gen-Port einmal lesen', hidden: true }));
  await screen.findByText(/jetzt gelesen/);
  const entscheid = screen.getByText('Am Gen-Port hängt ein Mikrowechselrichter?').closest('.vp-sw-suggest')!;
  fireEvent.click(within(entscheid as HTMLElement).getByRole('checkbox', { hidden: true }));
  await rolle();
  const me = rechteSeed().me;
  act(() => setSelbstauskunft({ ...me, unternehmen_rechte: me.unternehmen_rechte.filter((r) => r !== 'mess_selektion.bearbeiten') }));
  expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Beobachten weiterer Register');
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  expect(observe).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChargingConfig, type Netzanschluss } from '../api';
import { RechteStandort, setSelbstauskunft } from '../rollen';
import { FIXTURE_IDS as I } from '../test/standorteFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import type { BlattKontext } from './Blaetter';
import { RahmenBlatt } from './LadenReiter';

// Umgezogen aus `LadeparkRahmenKarte.test.tsx` (AP-01 IP-13): main hat die Karte gelöscht, die Grenze wohnt seit
// „Steuerung neu“ im Rahmen-Blatt von Steuerung › Laden. Der Stepper ersetzt das freie Feld.

const site = { id: I.an2, name: 'Werk Ahrenberg – Halle 2' };
const config: ChargingConfig = {
  gridLimitKw: 200,
  priorityChargePointIds: [],
  chargePoints: [],
  frame: { houseReserveKw: 30, maxHouseLoadKw: 96.5 },
};

function na2(vereinbart: number | null): Netzanschluss {
  return {
    id: 'na-2', kennzeichen: 'NA-2', name: 'Netzanschluss Halle 2',
    standort: { id: I.st1, kurzzeichen: 'ST-1' }, malo: null, netzbetreiber: null,
    anschluss_kva: 250, vereinbart_kw: vereinbart, messung: 'RLM',
    gueltig_ab: '2024-03-12', gueltig_bis: null, hinweise: [], angelegt_am: '2024-03-12T00:00:00Z',
    anlagen: [{ id: 'b-2', anlage: { id: I.an2, name: site.name }, gueltig_ab: '2024-03-12', gueltig_bis: null }],
  };
}

function antwort(liste: Netzanschluss[] = [na2(200)]) {
  vi.spyOn(api, 'siteDetail').mockResolvedValue({ ...site, standort: { id: I.st1, kurzzeichen: 'ST-1' } } as never);
  vi.spyOn(api, 'netzanschluesse').mockResolvedValue({
    standort: { id: I.st1, kurzzeichen: 'ST-1' }, stichtag: null, kennzeichen_vorschlag: 'NA-3', netzanschluesse: liste,
  });
}

function blatt(onGrenze = vi.fn(async () => true), c: ChargingConfig = config) {
  const k = { busy: null, zu: vi.fn() } as unknown as BlattKontext;
  render(<RechteStandort.Provider value={I.st1}>
    <RahmenBlatt k={k} siteId={site.id} rahmen={null} config={c} onGrenze={onGrenze} />
  </RechteStandort.Provider>);
  return { k, onGrenze };
}

const uebernehmen = () => screen.getByRole('button', { name: 'Übernehmen' });

beforeEach(() => setSelbstauskunft(rechteSeed().me));
afterEach(() => { cleanup(); vi.restoreAllMocks(); setSelbstauskunft(null); });

describe('AP-01 IP-13 · Grenze gegen den Netzanschluss im Rahmen-Blatt', () => {
  it('zeigt NA-2, 7-Tage-Grundlast und das verbleibende Ladebudget', async () => {
    antwort();
    blatt();

    expect(await screen.findByText(/Netzanschluss NA-2: 200/)).toHaveTextContent('vereinbart');
    expect(screen.getByText(/Grundlast der letzten 7 Tage 96,5 kW/)).toHaveTextContent('Ladebudget 73,5 kW');
    expect(screen.queryByText(/bitte prüfen/)).toBeNull();
  });

  it('sperrt eine Grenze über der vereinbarten Leistung mit demselben Grund wie der Server', async () => {
    antwort();
    blatt();
    await screen.findByText(/Netzanschluss NA-2: 200/);
    fireEvent.click(screen.getByRole('button', { name: 'mehr' }));
    expect(screen.getByText('201 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeInTheDocument();
    expect(uebernehmen()).toBeDisabled();
  });

  it('nennt eine schon gespeicherte zu hohe Grenze beim Öffnen', async () => {
    antwort();
    blatt(undefined, { ...config, gridLimitKw: 220 });
    expect(await screen.findByText('220 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeInTheDocument();
  });

  it('sperrt ohne vereinbarte Leistung am gebundenen Anschluss und ohne Ladebudget', async () => {
    antwort([na2(null)]);
    blatt();
    expect(await screen.findByText('Netzanschluss NA-2: vereinbarte Leistung fehlt.')).toBeInTheDocument();
    expect(screen.getByText('Beim Netzanschluss NA-2 ist keine vereinbarte Leistung hinterlegt.')).toBeInTheDocument();

    cleanup();
    antwort();
    blatt(undefined, { ...config, gridLimitKw: 120, frame: { houseReserveKw: 30, maxHouseLoadKw: 96.5 } });
    await screen.findByText(/Netzanschluss NA-2: 200/);
    fireEvent.click(screen.getByRole('button', { name: 'weniger' }));
    expect(screen.getByText('Grundlast und Hausreserve lassen innerhalb der Anschlussgrenze kein Ladebudget übrig.')).toBeInTheDocument();
    expect(uebernehmen()).toBeDisabled();
  });

  it('nennt ohne Bindung den Übergang und sendet die dort eingegebene Leistung', async () => {
    antwort([]);
    const { onGrenze, k } = blatt();
    expect(await screen.findByText(/Heute ist kein Netzanschluss gebunden/)).toHaveTextContent('für den Übergang');
    fireEvent.click(screen.getByRole('button', { name: 'weniger' }));
    const feld = screen.getByLabelText('Vereinbarte Leistung (kW)');

    fireEvent.click(uebernehmen());
    expect(screen.getByText('Tragen Sie die vereinbarte Leistung ein.')).toBeInTheDocument();
    expect(feld).toHaveFocus();
    expect(onGrenze).not.toHaveBeenCalled();

    fireEvent.change(feld, { target: { value: '150' } });
    expect(screen.getByText('199 kW liegen über 150 kW vereinbarter Leistung — bitte prüfen.')).toBeInTheDocument();
    fireEvent.change(feld, { target: { value: '200' } });
    await act(async () => { fireEvent.click(uebernehmen()); });
    expect(onGrenze).toHaveBeenCalledWith(199, 200);
    expect(k.zu).toHaveBeenCalled();
  });

  it('sendet mit Bindung keinen Übergangswert', async () => {
    antwort();
    const { onGrenze } = blatt();
    await screen.findByText(/Netzanschluss NA-2: 200/);
    fireEvent.click(screen.getByRole('button', { name: 'weniger' }));
    expect(screen.queryByLabelText('Vereinbarte Leistung (kW)')).toBeNull();
    await act(async () => { fireEvent.click(uebernehmen()); });
    expect(onGrenze).toHaveBeenCalledWith(199, undefined);
  });

  it('sperrt Übernehmen, solange der Netzanschluss nicht geprüft werden konnte', async () => {
    vi.spyOn(api, 'siteDetail').mockRejectedValue(new Error('offline'));
    blatt();
    expect(await screen.findByText('Der Netzanschluss konnte nicht geladen werden.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'weniger' }));
    expect(screen.getByText('Der Netzanschluss konnte nicht geprüft werden. Versuchen Sie es erneut.')).toBeInTheDocument();
    expect(uebernehmen()).toBeDisabled();
  });

  it('zeigt ohne Recht weder Stepper noch Knopf', async () => {
    antwort();
    const me = rechteSeed().me;
    setSelbstauskunft({ ...me, unternehmen_rechte: [], standorte: me.standorte.map((s) => ({ ...s, rechte: [] })) });
    blatt();
    await screen.findByText(/Netzanschluss NA-2: 200/);
    expect(screen.queryByRole('button', { name: 'mehr' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Übernehmen' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('note')).toBeInTheDocument());
  });
});

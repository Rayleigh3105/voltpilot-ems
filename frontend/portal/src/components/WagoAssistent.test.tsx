import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Device, type EdgeVersion, type ProbeAntwort, type UemsDatenquelle, type UemsDatenquellePruefergebnis } from '../api';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { WagoAssistent } from './WagoAssistent';

/**
 * B05: Schritt 2 übernimmt Steckplatz, Kartentyp und Variante aus den Kennwörtern, die die
 * Datenquellen-Prüfung in Schritt 1 gelesen hat — und `slot` ist in jedem Aufruf der gelesene
 * Steckplatz, nie die Position der Karte. Die Steuerung hat eine Lücke: Karten auf 2 und 5.
 */

const SITE = { id: 'anlage-wago', name: 'Werk Ahrenberg' };
const BOX = { id: 'box-1', kind: 'edge', siteId: SITE.id, name: 'Box Halle 2', externalRef: 'VP-BOX-1' } as Device;
const VERSION = { deviceId: BOX.id, siteId: SITE.id, capabilities: ['wago_registerbild'] } as EdgeVersion;

const PRUEFUNG = {
  ergebnis: 'ok', gewertet: true, text: 'Registerbild v1 erkannt', adresse: '192.168.20.10:502',
  antwort: { requestId: 'kopf-1', results: [{ id: 'erreichbarkeit', ok: true, wago_kopf: {
    signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kartenzahl: 2, herzschlag: 17, controller_kennung: 8212,
  } }] },
  wago: { erkannt: true, satz: 'Registerbild v1 erkannt', controller_kennung: 8212, kartenzahl: 2, karten: [
    { karte: 1, steckplatz: 2, kartentyp: 494, variante: 0 },
    { karte: 2, steckplatz: 5, kartentyp: 495, variante: 25001 },
  ] },
} as unknown as UemsDatenquellePruefergebnis;

let komponentenTest: ReturnType<typeof vi.spyOn<typeof api, 'testComponentConnection'>>;
let kartenAnlegen: ReturnType<typeof vi.spyOn<typeof api, 'wagoKartenAnlegen'>>;

beforeEach(() => {
  vi.spyOn(api, 'datenquelleAnlegen').mockResolvedValue({ id: 'dq-1', kennzeichen: 'DQ-1' } as UemsDatenquelle);
  vi.spyOn(api, 'datenquellePruefen').mockResolvedValue(PRUEFUNG);
  vi.spyOn(api, 'datenquelleZuweisen').mockResolvedValue({} as Awaited<ReturnType<typeof api.datenquelleZuweisen>>);
  komponentenTest = vi.spyOn(api, 'testComponentConnection').mockImplementation(async (_site, body) => {
    const slot = (body.connection as { slot?: number }).slot;
    return { requestId: `wert-${slot}`, errorCode: null, results: [{ id: 'karte', ok: true,
      reading: { steckplatz: slot ?? 0, kartentyp: 494, 'Wirkleistung gesamt': 18 + (slot ?? 0) } }] } as ProbeAntwort;
  });
  kartenAnlegen = vi.spyOn(api, 'wagoKartenAnlegen').mockImplementation(async (_site, body) => ({
    geraetId: 'geraet-1', kennzeichen: 'G-1', eingebautAm: '2026-09-23T08:00:00Z',
    karten: body.karten.map((k, i) => ({ entityId: `e-${k.steckplatz}`, teilId: `t-${k.steckplatz}`, steckplatz: k.steckplatz, typ: null, index: i + 1 })),
  }));
  vi.spyOn(api, 'siteComponents').mockResolvedValue({ componentAuthority: 'cloud',
    components: [{ id: 'e-2', definitionVersion: 1 }, { id: 'e-5', definitionVersion: 1 }] } as unknown as Awaited<ReturnType<typeof api.siteComponents>>);
  vi.spyOn(api, 'wagoKarteEintragen').mockResolvedValue({} as Awaited<ReturnType<typeof api.wagoKarteEintragen>>);
  vi.spyOn(api, 'geraetEinstellungEintragen').mockResolvedValue({} as Awaited<ReturnType<typeof api.geraetEinstellungEintragen>>);
  vi.spyOn(api, 'wagoSollLesen').mockRejectedValue(new Error('nicht gelesen'));
});

function slots(): Array<number | undefined> {
  return komponentenTest.mock.calls.map(([, body]) => (body.connection as { slot?: number }).slot);
}

describe('WAGO-Assistent — Karten aus den Kennwörtern, slot = Steckplatz', () => {
  it('liest in Schritt 2 nichts erneut und setzt slot in Schritt 3 und beim Anlegen auf den gelesenen Steckplatz (2 und 5)', async () => {
    render(<WagoAssistent site={SITE} standortId={FIXTURE_IDS.st1} geraete={[BOX]} versionen={[VERSION]}
      onClose={() => {}} onMessstellen={() => {}} />);
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '192.168.20.10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopf prüfen' }));
    await screen.findByText('Kopf erkannt');

    fireEvent.click(screen.getByRole('button', { name: /^(Weiter|Karten auslesen und weiter)$/ }));
    await screen.findByRole('heading', { name: 'Ausgelesene Energiekarten ergänzen' });
    // Die Identität der Karten kommt aus Schritt 1 — kein component-test je Karte.
    expect(komponentenTest).not.toHaveBeenCalled();
    expect(screen.getByText('Steckplatz 2 · 750-494')).toBeTruthy();
    expect(screen.getByText('Steckplatz 5 · 750-495')).toBeTruthy();

    screen.getAllByLabelText('Was misst die Karte?').forEach((feld, i) =>
      fireEvent.change(feld, { target: { value: ['Zuleitung Halle 2', 'Maschine M1'][i] } }));
    screen.getAllByLabelText('Wandler Primärwert in A').forEach((feld) => fireEvent.change(feld, { target: { value: '400' } }));
    screen.getAllByLabelText('Wandler Sekundärwert in A').forEach((feld) => fireEvent.change(feld, { target: { value: '5' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await screen.findByRole('heading', { name: 'Werte prüfen und Komponenten anlegen' });
    fireEvent.click(screen.getByRole('button', { name: 'Echte Werte lesen' }));
    await screen.findByText('Wirkleistung gesamt: 23');
    expect(slots()).toEqual([2, 5]);

    fireEvent.click(screen.getByRole('button', { name: 'Komponenten anlegen' }));
    await screen.findByText('Komponenten angelegt');
    const karten = kartenAnlegen.mock.calls[0][1].karten;
    expect(karten.map((k) => [k.steckplatz, (k.komponente.connection as { slot?: number }).slot, k.kartentyp]))
      .toEqual([[2, 2, 494], [5, 5, 495]]);
  });

  it('geht ohne gelesenen Steckplatz nicht weiter und nimmt keine Position an', async () => {
    vi.spyOn(api, 'datenquellePruefen').mockResolvedValue({ ...PRUEFUNG, wago: { ...PRUEFUNG.wago!, karten: [
      { karte: 1, steckplatz: 2, kartentyp: 494, variante: 0 },
      { karte: 2, steckplatz: null, kartentyp: 494, variante: null },
    ] } });
    render(<WagoAssistent site={SITE} standortId={FIXTURE_IDS.st1} geraete={[BOX]} versionen={[VERSION]}
      onClose={() => {}} onMessstellen={() => {}} />);
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '192.168.20.10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopf prüfen' }));
    await screen.findByText('Kopf erkannt');
    fireEvent.click(screen.getByRole('button', { name: /^(Weiter|Karten auslesen und weiter)$/ }));
    await screen.findByRole('heading', { name: 'Ausgelesene Energiekarten ergänzen' });
    expect(screen.getByText('Unbekannt — Lesung unvollständig')).toBeTruthy();
    expect(screen.getByText('Steckplatz unbekannt · 750-494')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Weiter' }) as HTMLButtonElement).disabled).toBe(true));
    expect(komponentenTest).not.toHaveBeenCalled();
  });
});

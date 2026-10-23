import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RechteStandort, setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { FIXTURE_IDS as I } from '../test/standorteFixtures';
import type { BlattKontext } from './Blaetter';
import type { GeraetBild } from './bild';
import TAG from './ladeVorschau-tag.json';
import { LadeWahlBlatt } from './LadeWahl';
import { ZielBlatt } from './LadenReiter';
import type { VorschauAnlage } from './ladeVorschau';

let telefon = true;
vi.mock('../useIsPhone', () => ({ useIsPhone: () => telefon }));

/**
 * Das Vorschau-Blatt „Womit laden?“ (Konzept k1, E1=B, E4=A, E5=A, E6=A): Antippen
 * ändert nur die Vorschau, erst „So laden“ sendet; nichts wird still gesetzt.
 */
const anlage: VorschauAnlage = { speicher: { kapKwh: 10, kw: 5, minPct: 10, reserveKwh: 1 }, speicherZuerst: true, startKw: 1.4 };
const N = 192;
const reihe = (a: readonly number[]) => Array.from({ length: N }, (_, i) => a[i] ?? null);

function geraet(steuerart: Record<string, unknown>, quellen = ['ueberschuss', 'ueberschuss_speicher', 'guenstig', 'sofort']): GeraetBild {
  return {
    id: 'e-wb', name: 'Wallbox Werkstatt', nennKw: 11, jetztKw: 0, eingriff: null, steuerart,
    ladepunkt: { angesteckt: true, gemeldetAm: null, gemessenAm: null },
    eintrag: { optionen: { quellen: quellen.map((id) => ({ id, gesperrt: false })), ziele: [{ id: 'bis_uhrzeit', gesperrt: false }], vorgaben: { preisgrenzeCtKwh: 30 } } },
  } as unknown as GeraetBild;
}

function kontext(g: GeraetBild): BlattKontext {
  return {
    busy: null, zu: vi.fn(),
    bild: {
      raster: { start: 0, jetzt: 52, jetztMin: 790, nowMs: 0 }, jetztGemessen: null, geraete: [g],
      reihen: { pv: reihe(TAG.pv), last: reihe(TAG.last), soc: reihe(TAG.soc), bezug: reihe(TAG.preis.map((p) => (p + 17) * 1.19)),
        einspeise: reihe(TAG.pv.map(() => 7.9)), preis: reihe(TAG.preis), morgenBekannt: true },
    },
  } as unknown as BlattKontext;
}

function oeffnen(g: GeraetBild) {
  const k = kontext(g);
  const onSoLaden = vi.fn(async () => true);
  render(<RechteStandort.Provider value={I.st1}><LadeWahlBlatt k={k} id={g.id} anlage={anlage} rahmenMinKw={1.4} onSoLaden={onSoLaden} /></RechteStandort.Provider>);
  return { k, onSoLaden, dialog: screen.getByRole('dialog', { name: /Womit laden/ }) };
}

beforeEach(() => { telefon = true; setSelbstauskunft(rechteSeed().me); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); setSelbstauskunft(null); });

describe('Womit laden? - erst sehen, dann „So laden“', () => {
  it('Antippen ändert nur die Vorschau; erst „So laden“ schickt die ganze Steuerart', () => {
    const { onSoLaden, dialog } = oeffnen(geraet({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }));
    expect(within(dialog).getByRole('radio', { name: /Nur Sonne/ })).toBeChecked();
    expect(dialog).toHaveTextContent('kein');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Sonne \+ Minimum/ }));
    expect(onSoLaden).not.toHaveBeenCalled();
    // Die Vorschau rechnet mit: nachts Netzstrom, durchgehend bis 7:00.
    expect(dialog).toHaveTextContent('durchgehend bis 7:00');
    expect(dialog).toHaveTextContent(/19\skWh\s*Netzstrom/);
    fireEvent.click(within(dialog).getByRole('button', { name: /So laden/ }));
    expect(onSoLaden).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-wb' }),
      { quelle: 'ueberschuss', ueberschussModus: 'mindestleistung', mindestleistungKw: 1.4 });
  });

  it('Abbrechen sendet nichts, und eine unveränderte Wahl wird nicht erneut gesendet', () => {
    const { onSoLaden, k, dialog } = oeffnen(geraet({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Günstig/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Nur Sonne/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /So laden/ }));
    expect(onSoLaden).not.toHaveBeenCalled();
    expect(k.zu).toHaveBeenCalled();
  });

  it('das Ziel wohnt im Blatt und behält die Ladequelle (kein zweites „Womit?“)', () => {
    const { onSoLaden, dialog } = oeffnen(geraet({ quelle: 'guenstig', herkunft: 'saeule', preisgrenzeCtKwh: 28 }));
    fireEvent.click(within(dialog).getByRole('button', { name: '+20 kWh' }));
    expect(dialog).toHaveTextContent(/Schafft \+20 kWh bis/);
    fireEvent.click(within(dialog).getByRole('button', { name: /So laden/ }));
    expect(onSoLaden).toHaveBeenCalledWith(expect.anything(), {
      quelle: 'guenstig', preisgrenzeCtKwh: 28, ziel: 'bis_uhrzeit', zielEnergieKwh: 20, zielFenster: { tage: 'daily', von: '', bis: '07:00' },
    });
  });

  it('Günstig: die Preisgrenze steht sichtbar mit − / + (Vorgabe aus den letzten 7 Tagen)', () => {
    const { onSoLaden, dialog } = oeffnen(geraet({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Günstig/ }));
    expect(dialog).toHaveTextContent('Vorgabe: billigstes Viertel der letzten 7 Tage');
    expect(dialog).toHaveTextContent(/30\sct/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preisgrenze anheben' }));
    expect(dialog).toHaveTextContent(/31\sct/);
    expect(dialog).toHaveTextContent('Bezugspreis, unter dem das Auto lädt');
    fireEvent.click(within(dialog).getByRole('button', { name: /So laden/ }));
    expect(onSoLaden).toHaveBeenCalledWith(expect.anything(), { quelle: 'guenstig', preisgrenzeCtKwh: 31 });
  });

  it('erster Besuch: „Sonne + Minimum“ ist sichtbar vorgewählt und empfohlen - gesetzt wird erst mit „So laden“', () => {
    const { onSoLaden, dialog } = oeffnen(geraet({ quelle: 'sofort', herkunft: 'standard' }));
    expect(within(dialog).getByRole('radio', { name: /Sonne \+ Minimum/ })).toBeChecked();
    expect(dialog).toHaveTextContent('Empfohlen');
    expect(onSoLaden).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /So laden/ }));
    expect(onSoLaden).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quelle: 'ueberschuss', ueberschussModus: 'mindestleistung' }));
  });

  it('am Rechner: vier Spalten nebeneinander, jede mit ihrer Vorschau', () => {
    telefon = false;
    const { dialog } = oeffnen(geraet({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }));
    expect(within(dialog).getAllByRole('radio')).toHaveLength(4);
    expect(within(dialog).getAllByRole('img', { name: /Ladeleistung bis/ })).toHaveLength(4);
    expect(within(dialog).getByRole('button', { name: 'So laden: Nur Sonne' })).toBeInTheDocument();
  });
});

describe('Ladeziel-Blatt', () => {
  it('fragt nicht „Womit?“ und schickt die Ladequelle der Karte unverändert mit', () => {
    const g = geraet({ quelle: 'guenstig', herkunft: 'saeule', preisgrenzeCtKwh: 28 });
    const onSpeichern = vi.fn(async () => true);
    render(<RechteStandort.Provider value={I.st1}><ZielBlatt k={kontext(g)} id={g.id} anlage={anlage} rahmenMinKw={1.4} onSpeichern={onSpeichern} /></RechteStandort.Provider>);
    const dialog = screen.getByRole('dialog', { name: /Ladeziel/ });
    expect(within(dialog).queryByText('Womit?')).toBeNull();
    expect(within(dialog).queryByText(/Sonne zuerst, dann günstig/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ziel übernehmen' }));
    expect(onSpeichern).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quelle: 'guenstig', preisgrenzeCtKwh: 28, zielEnergieKwh: 20 }));
  });
});

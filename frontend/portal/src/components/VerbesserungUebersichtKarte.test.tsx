import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { massnahmeRoute, verbesserungRoute } from '../nav';
import { UEMS_NORMGRENZE } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { bausteineMitInhalt } from '../uebersichtBausteine';
import {
  bausteinSatz,
  sprungDerZeile,
  verbesserungUebersichtBild,
  type VerbesserungUebersicht,
  type VerbesserungUebersichtZaehler,
} from '../verbesserungUebersicht';
import { UebersichtBausteine, useUebersichtBausteine } from './UebersichtBausteine';
import { VerbesserungUebersichtKarte } from './VerbesserungUebersichtKarte';

const NULL: VerbesserungUebersichtZaehler = {
  auffaelligkeiten_offen: 0,
  abweichungen_offen: 0,
  abweichungen_ueberfaellig: 0,
  massnahmen_geplant: 0,
  massnahmen_ueberfaellig: 0,
  massnahmen_umgesetzt_ohne_bewertung: 0,
  energieziele_laufend: 0,
  energieziele_bewertung_faellig: 0,
  anstoesse_offen: 0,
  messbedarfe_ueberfaellig: 0,
};

/** AP-18 R9: Abruf 15.03.2028 — so liefert es `GET /api/v1/verbesserung/uebersicht` (IP-19). */
const r9 = (titel = 'Druckluft-Leckagen orten und beseitigen'): VerbesserungUebersicht => ({
  abruf: '2028-03-15',
  zaehler: { ...NULL, massnahmen_geplant: 1, massnahmen_ueberfaellig: 1, massnahmen_umgesetzt_ohne_bewertung: 1, energieziele_laufend: 1 },
  faellig: [
    {
      art: 'massnahme',
      id: 'm-2',
      kennzeichen: 'M-2028-0002',
      titel,
      zustand: 'geplant',
      termin: '2028-02-29',
      faellig: 'ueberfaellig',
      seit_tagen: 15,
      verantwortlich: 'Ines Kaltenbach',
      satz: 'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.',
      kennzahl_id: null,
      einsatz_id: 'ee-3',
    },
  ],
});

describe('verbesserungUebersichtBild (rein, F2/F3, R9, R13)', () => {
  it('R9: der Baustein-Satz aus §5.9 wörtlich, die übrigen Zähler und die Zeile mit Sprung auf die Maßnahmen-Seite', () => {
    expect(bausteinSatz(r9('Druckluft-Leckagen'))).toBe(
      'Ziele und Maßnahmen — 1 Maßnahme überfällig: M-2028-0002 Druckluft-Leckagen, Termin 29.02.2028, überfällig seit 15 Tagen (Ines Kaltenbach) · 1 Maßnahme umgesetzt, noch nicht bewertet · 1 Energieziel läuft.',
    );
    const bild = verbesserungUebersichtBild(r9());
    expect(bild?.faellig).toBe(true);
    expect(bild?.zahlen).toBe('1 Maßnahme geplant');
    expect(bild?.zeilen).toEqual([
      {
        key: 'massnahme-m-2',
        satz: 'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.',
        sprung: { art: 'massnahme', id: 'm-2' },
      },
    ]);
  });

  it('R13: ohne Vorgang kein Bild — auch nicht mit einem überfälligen Messbedarf allein; ohne Antwort ebenso', () => {
    expect(verbesserungUebersichtBild({ abruf: '2028-03-15', zaehler: NULL, faellig: [] })).toBeNull();
    expect(verbesserungUebersichtBild({ abruf: '2028-03-15', zaehler: { ...NULL, messbedarfe_ueberfaellig: 1 }, faellig: [] })).toBeNull();
    expect(verbesserungUebersichtBild(null)).toBeNull();
    expect(bausteineMitInhalt({ messstellen: null, energiebilanz: null, gebaeude: [], kennzahlen: null, zieleMassnahmen: null })).toEqual([]);
  });

  it('mehrere Fällige: Zählwort statt Name, Energieziel „Bewertung fällig seit n Tagen“ mit Sprung auf seine Seite', () => {
    const u: VerbesserungUebersicht = {
      abruf: '2029-01-10',
      zaehler: {
        ...NULL,
        auffaelligkeiten_offen: 2,
        abweichungen_offen: 1,
        abweichungen_ueberfaellig: 1,
        massnahmen_geplant: 2,
        massnahmen_ueberfaellig: 2,
        energieziele_laufend: 1,
        energieziele_bewertung_faellig: 1,
        anstoesse_offen: 1,
        messbedarfe_ueberfaellig: 1,
      },
      faellig: [
        { ...r9().faellig[0], seit_tagen: 1 },
        {
          ...r9().faellig[0],
          art: 'energieziel',
          id: 'ez-1',
          kennzeichen: 'EZ-2028-0001',
          titel: 'Spritzguss: 5 % weniger Strom',
          zustand: 'offen',
          termin: '2028-12-31',
          faellig: 'bewertung_faellig',
          seit_tagen: 10,
          satz: null,
          kennzahl_id: 'kz-4',
          einsatz_id: null,
        },
      ],
    };
    const bild = verbesserungUebersichtBild(u);
    expect(bild?.summe).toBe('1 Abweichung überfällig · 2 Maßnahmen überfällig · 1 Energieziel mit fälliger Bewertung · 1 Energieziel läuft.');
    expect(bild?.zahlen).toBe('2 offene Auffälligkeiten · 1 offene Abweichung · 2 Maßnahmen geplant · 1 offener Anstoß · 1 Messbedarf überfällig');
    expect(bild?.zeilen[1]).toEqual({
      key: 'energieziel-ez-1',
      satz: 'EZ-2028-0001 · Spritzguss: 5 % weniger Strom · Bewertung fällig seit 10 Tagen · Ines Kaltenbach.',
      sprung: { art: 'energieziel', id: 'ez-1' },
    });
    // IP-18: auch die Abweichung springt auf ihre eigene Seite — nie mehr zur Kennzahl.
    expect(sprungDerZeile({ art: 'abweichung', id: 'aw-1' })).toEqual({ art: 'abweichung', id: 'aw-1' });
  });
});

describe('VerbesserungUebersichtKarte (Render)', () => {
  it('Titel, Summe, Zahlen, Zeile mit Sprung und der Grenz-Satz; eine Zeile ohne Ziel ist kein Knopf', () => {
    const onSprung = vi.fn();
    const bild = verbesserungUebersichtBild(r9())!;
    render(<VerbesserungUebersichtKarte bild={bild} onOeffnen={() => {}} onSprung={onSprung} />);
    const karte = screen.getByTestId('baustein-ziele-massnahmen');
    expect(screen.getByRole('heading', { name: 'Ziele und Maßnahmen' })).toBeTruthy();
    expect(screen.getByTestId('ziele-massnahmen-summe').textContent).toBe(
      '1 Maßnahme überfällig: M-2028-0002 Druckluft-Leckagen orten und beseitigen, Termin 29.02.2028, überfällig seit 15 Tagen (Ines Kaltenbach) · 1 Maßnahme umgesetzt, noch nicht bewertet · 1 Energieziel läuft.',
    );
    expect(karte.textContent).toContain(UEMS_NORMGRENZE);
    fireEvent.click(screen.getByTestId('faellig-massnahme-m-2'));
    expect(onSprung).toHaveBeenCalledWith({ art: 'massnahme', id: 'm-2' });

    const ohneZiel = { ...bild, zeilen: [{ ...bild.zeilen[0], sprung: null }] };
    render(<VerbesserungUebersichtKarte bild={ohneZiel} onOeffnen={() => {}} onSprung={onSprung} />);
    expect(screen.getAllByTestId('faellig-massnahme-m-2')[1].tagName).toBe('DIV');
  });
});

const st = werkAhrenberg();
const anlagen = st.anlagen.map((a) => ({ id: a.id, name: a.name }));
function Uebersicht({ art, onNavigate = () => {} }: { art: 'unternehmen' | 'standort'; onNavigate?: (r: unknown) => void }) {
  const daten = useUebersichtBausteine(
    art === 'standort' ? { art, standort: st } : { art, name: 'Ahrenberg', standorte: [st] },
    anlagen,
    ahrenbergFunktionen(),
  );
  return daten && <UebersichtBausteine daten={daten} zeigen={['ziele-massnahmen']} onNavigate={onNavigate} />;
}

describe('Übersichts-Baustein „Ziele und Maßnahmen“ am Unternehmen', () => {
  beforeEach(() => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister());
    vi.spyOn(api, 'anlageBilanz').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'standortOrte').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [] });
    vi.spyOn(api, 'berichte').mockResolvedValue({ berichte: [] });
    vi.spyOn(api, 'bezugsbasisUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'verbesserungUebersicht').mockResolvedValue(r9());
  });
  afterEach(() => {
    setSelbstauskunft(null);
    vi.restoreAllMocks();
  });

  it('R9: am Unternehmen erscheint die Kachel mit der Zeile; der Sprung geht auf die Maßnahmen-Seite (IP-13)', async () => {
    const onNavigate = vi.fn();
    render(<Uebersicht art="unternehmen" onNavigate={onNavigate} />);
    await act(async () => {});
    expect(screen.getByTestId('baustein-ziele-massnahmen').textContent).toContain('überfällig seit 15 Tagen');
    fireEvent.click(screen.getByTestId('faellig-massnahme-m-2'));
    expect(onNavigate).toHaveBeenLastCalledWith(massnahmeRoute('m-2'));
    fireEvent.click(screen.getByRole('button', { name: 'Alle Ziele und Maßnahmen' }));
    expect(onNavigate).toHaveBeenLastCalledWith(verbesserungRoute());
  });

  it('R13: ohne Vorgang kein Render', async () => {
    vi.mocked(api.verbesserungUebersicht).mockResolvedValue({ abruf: '2028-03-15', zaehler: NULL, faellig: [] });
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('am Standort nie und ohne Abfrage — der Baustein gehört dem Unternehmen', async () => {
    const { container } = render(<Uebersicht art="standort" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(api.verbesserungUebersicht).not.toHaveBeenCalled();
  });

  it('eine abgelehnte Abfrage zeigt nichts', async () => {
    vi.mocked(api.verbesserungUebersicht).mockRejectedValue(new Error('403'));
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});

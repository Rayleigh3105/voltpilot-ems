import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  beendetSatz,
  bezugsbasisUebersichtBild,
  fristSatz,
  seitText,
  type BezugsbasisUebersicht,
  type BezugsbasisZustand,
} from '../bezugsbasisUebersicht';
import { UEMS_NORMGRENZE } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { BezugsbasisUebersichtKarte } from './BezugsbasisUebersichtKarte';
import { UebersichtBausteine, useUebersichtBausteine } from './UebersichtBausteine';

/** AP-17 R13: BB-0001 Fassung 2 vom 24.11.2027, abgerufen am 25.11.2028 — so liefert es die Übersichts-Route (IP-17). */
const bb0001 = (z: Partial<BezugsbasisZustand> = {}): BezugsbasisZustand => ({
  bezugsbasis_id: 'bb-1',
  kennzeichen: 'BB-0001',
  kennzahl_id: 'kz-4',
  kennzahl_kennzeichen: 'KZ-0004',
  kennzahl_name: 'Stromeinsatz Spritzguss je kg',
  fassung: 2,
  freigegeben_am: '2027-11-24',
  datenlage: 'vollstaendig',
  zustand: 'ueberpruefung_faellig',
  faellig_am: '2028-11-24',
  faellig_seit_tagen: 1,
  anstoss_liegt_vor: false,
  beendet_zum: null,
  beendet_grund: null,
  ...z,
});

const r13 = (u: Partial<BezugsbasisUebersicht> = {}): BezugsbasisUebersicht => ({
  stichtag: '2028-11-25',
  laufend: 3,
  freigegeben: 3,
  vorlaeufig: 1,
  mit_anstoss: 1,
  ueberpruefung_faellig: 1,
  faellig: [bb0001()],
  ...u,
});

describe('bezugsbasisUebersicht.ts: Sätze aus AP-17 §5.8', () => {
  it('R13 „Frist“ wörtlich — fällig seit 1 Tag', () => {
    expect(fristSatz(bb0001())).toBe(
      'Bezugsbasis BB-0001, Fassung 2 vom 24.11.2027 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.',
    );
  });

  it('zählt Tage: heute · 1 Tag · n Tagen', () => {
    expect(seitText(0)).toBe('seit heute');
    expect(seitText(1)).toBe('seit 1 Tag');
    expect(seitText(30)).toBe('seit 30 Tagen');
  });

  it('„Beendet“: nicht bewertbar mit Tag und Anlass', () => {
    expect(beendetSatz('2026-12-31', 'Anbau Halle 2')).toBe('Nicht bewertbar: Bezugsbasis beendet am 31.12.2026 (Anbau Halle 2).');
    expect(beendetSatz('2028-11-25')).toBe('Nicht bewertbar: Bezugsbasis beendet am 25.11.2028.');
  });

  it('das Bild: Zahlen freigegeben · vorläufig · Anstoß · fällig und die fälligen Zeilen', () => {
    expect(bezugsbasisUebersichtBild(r13())).toEqual({
      summe: '1 Bezugsbasis mit fälliger Überprüfung',
      faellig: true,
      zahlen: '3 freigegeben · 1 vorläufig · 1 Anstoß liegt vor · 1 Überprüfung fällig',
      zeilen: [
        {
          key: 'bb-1',
          kennzahlId: 'kz-4',
          satz: 'Bezugsbasis BB-0001, Fassung 2 vom 24.11.2027 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.',
        },
      ],
    });
    const nachBleibt = bezugsbasisUebersichtBild(r13({ laufend: 2, freigegeben: 1, vorlaeufig: 0, mit_anstoss: 0, ueberpruefung_faellig: 0, faellig: [] }));
    expect(nachBleibt).toEqual({ summe: 'Keine Überprüfung fällig', faellig: false, zahlen: '1 freigegeben · 0 Überprüfung fällig · 1 im Entwurf', zeilen: [] });
  });

  it('R10: ohne laufende Bezugsbasis keine Kachel', () => {
    expect(bezugsbasisUebersichtBild(null)).toBeNull();
    expect(bezugsbasisUebersichtBild(r13({ laufend: 0, freigegeben: 0, vorlaeufig: 0, mit_anstoss: 0, ueberpruefung_faellig: 0, faellig: [] }))).toBeNull();
  });
});

describe('BezugsbasisUebersichtKarte', () => {
  it('rendert Summe, Zahlen, die fällige Basis mit Sprung zur Kennzahl und den Grenz-Satz', () => {
    const bild = bezugsbasisUebersichtBild(r13())!;
    const zurKennzahl = vi.fn();
    const zurListe = vi.fn();
    render(<BezugsbasisUebersichtKarte bild={bild} onOeffnen={zurListe} onKennzahl={zurKennzahl} />);
    expect(screen.getByRole('heading', { name: 'Bezugsbasen' })).toBeTruthy();
    expect(screen.getByTestId('bezugsbasen-summe').textContent).toBe('1 Bezugsbasis mit fälliger Überprüfung');
    expect(screen.getByTestId('bezugsbasen-summe').className).toContain('is-warn');
    expect(screen.getByTestId('bezugsbasen-zahlen').textContent).toBe(
      '3 freigegeben · 1 vorläufig · 1 Anstoß liegt vor · 1 Überprüfung fällig',
    );
    const zeile = screen.getByTestId('bezugsbasis-bb-1');
    expect(zeile.textContent).toContain('Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.');
    fireEvent.click(zeile);
    expect(zurKennzahl).toHaveBeenCalledWith('kz-4');
    fireEvent.click(screen.getByRole('button', { name: 'Alle Kennzahlen' }));
    expect(zurListe).toHaveBeenCalledTimes(1);
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
});

const st = werkAhrenberg();
const anlagen = st.anlagen.map((a) => ({ id: a.id, name: a.name }));
function Uebersicht({ art, zeigen = ['kennzahlen'] }: { art: 'unternehmen' | 'standort'; zeigen?: string[] }) {
  const daten = useUebersichtBausteine(
    art === 'standort' ? { art, standort: st } : { art, name: 'Ahrenberg', standorte: [st] },
    anlagen,
    ahrenbergFunktionen(),
  );
  return daten && <UebersichtBausteine daten={daten} zeigen={zeigen} onNavigate={() => {}} />;
}

describe('Übersichts-Baustein „Bezugsbasen“ am Unternehmen', () => {
  beforeEach(() => {
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister());
    vi.spyOn(api, 'anlageBilanz').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'standortOrte').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [] });
    vi.spyOn(api, 'berichte').mockResolvedValue({ berichte: [] });
    setSelbstauskunft(rechteSeed('IK').me);
  });
  afterEach(() => {
    setSelbstauskunft(null);
    vi.restoreAllMocks();
  });

  it('am Unternehmen: die Kachel mit der fälligen Überprüfung (R13)', async () => {
    const abruf = vi.spyOn(api, 'bezugsbasisUebersicht').mockResolvedValue(r13());
    render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(abruf).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('baustein-bezugsbasen')).toBeTruthy();
    expect(screen.getByTestId('bezugsbasen-summe').textContent).toBe('1 Bezugsbasis mit fälliger Überprüfung');
  });

  it('R10: ohne laufende Basis keine Kachel; am Standort wird nicht abgefragt', async () => {
    vi.spyOn(api, 'bezugsbasisUebersicht').mockResolvedValue(
      r13({ laufend: 0, freigegeben: 0, vorlaeufig: 0, mit_anstoss: 0, ueberpruefung_faellig: 0, faellig: [] }),
    );
    const { unmount } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(screen.queryByTestId('baustein-bezugsbasen')).toBeNull();
    unmount();
    const abruf = vi.spyOn(api, 'bezugsbasisUebersicht').mockResolvedValue(r13());
    render(<Uebersicht art="standort" />);
    await act(async () => {});
    expect(abruf).not.toHaveBeenCalled();
    expect(screen.queryByTestId('baustein-bezugsbasen')).toBeNull();
  });

  it('wer „Kennzahlen“ ausblendet, blendet die Bezugsbasen mit aus', async () => {
    vi.spyOn(api, 'bezugsbasisUebersicht').mockResolvedValue(r13());
    render(<Uebersicht art="unternehmen" zeigen={['messstellen']} />);
    await act(async () => {});
    expect(screen.queryByTestId('baustein-bezugsbasen')).toBeNull();
  });

  it('ein Fehler der Route lässt die Kachel weg', async () => {
    vi.spyOn(api, 'bezugsbasisUebersicht').mockRejectedValue(new Error('503'));
    render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(screen.queryByTestId('baustein-bezugsbasen')).toBeNull();
  });
});

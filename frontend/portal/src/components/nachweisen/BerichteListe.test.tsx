/**
 * Der Reiter „Berichte“ (Konzept Nachweisen n1, Runde 2, §6.4): zwei Zähler, die Entscheidung zuerst, eine Zeile je
 * Bericht mit „PDF“, Bewertung und Managementbewertung auf ihrer Seite (Entscheid 15) - und „Erstellen“ in drei Schritten
 * bis zur Bestätigung mit PDF.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    berichte: vi.fn(),
    berichtDatei: vi.fn(),
    standorte: vi.fn(),
    unternehmen: vi.fn(),
    kennzahlen: vi.fn(),
    berichtAnlegen: vi.fn(),
    bericht: vi.fn(),
    berichtEntwurf: vi.fn(),
    berichtFreigeben: vi.fn(),
  },
}));

vi.mock('../../api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('../../api')>();
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (name in mocks ? mocks[name as keyof typeof mocks] : () => Promise.reject(new Error('nicht im Test'))),
  });
  return { ...echt, api };
});

import { ApiError, type Bericht, type BerichtAnlegen, type Selbstauskunft } from '../../api';
import { setSelbstauskunft } from '../../rollen';
import { anlegenAm, detailAm, entwurfAm, freigabeAm, ZEIT } from '../../test/berichtFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS } from '../../test/standorteFixtures';
import { BerichteListe } from './BerichteListe';

const selbst = (rechte: string[]): Selbstauskunft => ({
  kennung: 'ines',
  name: 'Ines Kaltenbach',
  konto: 'benutzer',
  zustand: 'aktiv',
  kundenbereich: null,
  zugang: 'konto',
  rollen: ['energiemanager'],
  unternehmensweit: false,
  standorte: [{ id: FIXTURE_IDS.st1, rechte } as unknown as Selbstauskunft['standorte'][number]],
  unternehmen_rechte: [],
  kuenftig: [],
  text: null,
  teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] } as unknown as Selbstauskunft['unterstuetzungen'],
  kundenadministratoren: [{ kennung: 'jonas', name: 'Jonas Wendlinger' }] as Selbstauskunft['kundenadministratoren'],
});

function bericht(b: Partial<Bericht> & Pick<Bericht, 'kennung' | 'vorlage'>): Bericht {
  return {
    vorlage_fassung: 1,
    geltung_art: 'unternehmen',
    geltung_id: 'u-1',
    geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
    zeitraum_art: 'monat',
    zeitraum: '2026-10',
    zeitraum_text: 'Oktober 2026',
    zeitzone: 'Europe/Berlin',
    angelegt_von: { name: 'Ines Kaltenbach', rolle: null },
    angelegt_am: '2026-11-09T09:00:00Z',
    archiviert_am: null,
    stand_zeichen: 'berichtsstand',
    stand_text: 'Berichtsstand Nr. 1',
    neueste_nr: 1,
    entwurf_datenstand: null,
    freigegeben_am: '2026-11-10T08:02:00Z',
    anstoss_seit: null,
    ...b,
  };
}

const LISTE: Bericht[] = [
  bericht({ kennung: 'BR-2029-0002', vorlage: 'energetische_bewertung', zeitraum_art: 'datengrundlage', zeitraum_text: 'April 2028 bis März 2029', freigegeben_am: '2029-04-30T08:02:00Z' }),
  bericht({ kennung: 'BR-2029-0001', vorlage: 'managementbewertung', zeitraum_art: 'jahr', zeitraum_text: '2028', freigegeben_am: '2029-02-12T13:10:00Z' }),
  bericht({ kennung: 'BR-2028-0001', vorlage: 'leistungsvergleich', zeitraum_text: 'Dezember 2027', freigegeben_am: '2028-01-20T09:02:00Z' }),
  bericht({
    kennung: 'BR-2027-0001', vorlage: 'energetische_bewertung', zeitraum_art: 'datengrundlage', zeitraum_text: 'November 2026 bis Oktober 2027', freigegeben_am: '2027-11-24T09:00:00Z',
    ueberpruefung: { stand_nr: 1, stand_vom: '2027-11-24', wiedervorlage_monate: 12, faellig_am: null, ueberpruefung_faellig: false, faellig_seit_tagen: null, abgeloest_durch: 'BR-2029-0002', wesentliche_einsaetze: 0, offene_bedarfe: 0, verantwortliche: [], ohne_verantwortliche: [] },
  }),
  bericht({
    kennung: 'BR-2026-0001', vorlage: 'monatsbericht_standort', geltung_art: 'standort', geltung_id: FIXTURE_IDS.st1, geltung_name: 'Werk Ahrenberg',
    stand_zeichen: 'revision_noetig', neueste_nr: 2, freigegeben_am: '2026-12-20T10:00:00Z', anstoss_seit: '2028-04-02T22:30:00Z',
  }),
];

const zeige = async (props: Partial<Parameters<typeof BerichteListe>[0]> = {}) => {
  const ruf = { onOeffnen: vi.fn(), onBewertung: vi.fn(), onManagementbewertung: vi.fn() };
  render(<BerichteListe standort={null} {...ruf} {...props} />);
  await screen.findByTestId('berichte-zaehler');
  await act(async () => {});
  return ruf;
};

describe('Reiter „Berichte“ (Konzept Nachweisen n1, Runde 2, §6.4)', () => {
  beforeEach(() => {
    mocks.berichte.mockResolvedValue({ berichte: LISTE, abruf: '2029-04-30T20:10:00Z' });
    mocks.berichtDatei.mockResolvedValue(new Blob(['%PDF']));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    // jsdom navigiert nicht: der Download-Link wird nur geklickt, nicht gefolgt.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    vi.clearAllMocks();
  });

  it('zwei Zähler, die Entscheidung zuerst, dann was gilt - abgelöste Bewertungen als eine Zeile', async () => {
    setSelbstauskunft(selbst(['bericht.standort_abrufen', 'bericht.standort_freigeben']));
    await zeige();
    expect(screen.getByTestId('zaehler-gelten').textContent).toBe('4 gelten');
    expect(screen.getByTestId('zaehler-wartet').textContent).toBe('1 wartet auf Sie');
    const wartet = within(screen.getByTestId('berichte-wartet')).getByTestId('bericht-zeile-BR-2026-0001');
    expect(wartet.textContent).toContain('Daten geändert');
    expect(wartet.textContent).toContain('Entscheiden');
    expect(within(wartet).getByRole('img').getAttribute('aria-label')).toBe('seit 03.04.2028');
    expect(within(screen.getByTestId('berichte-gelten')).getAllByTestId(/^bericht-zeile-/).map((z) => z.getAttribute('data-testid'))).toEqual([
      'bericht-zeile-BR-2029-0002',
      'bericht-zeile-BR-2029-0001',
      'bericht-zeile-BR-2028-0001',
    ]);
    expect(within(screen.getByTestId('bericht-zeile-BR-2029-0001')).getByRole('img').getAttribute('aria-label')).toBe('frei 12.02.2029');
    fireEvent.click(screen.getByTestId('berichte-abgeloest'));
    expect(within(await screen.findByTestId('berichte-blatt')).getByTestId('bericht-zeile-BR-2027-0001')).toBeTruthy();
  });

  it('ohne Recht zu entscheiden „wartet“, nicht „wartet auf Sie“ - und kein „Erstellen“', async () => {
    setSelbstauskunft(selbst(['bericht.standort_abrufen']));
    await zeige();
    expect(screen.getByTestId('zaehler-wartet').textContent).toBe('1 wartet');
    expect(screen.queryByTestId('bericht-anlegen-knopf')).toBeNull();
  });

  it('Review r1, P3-5: „wartet auf Sie“ zählt nur, was die Person entscheiden darf - die übrigen „warten“', async () => {
    // Ein zweiter Bericht wartet - an Werk Lindach, wo Ines nur lesen darf.
    const lindach = bericht({
      kennung: 'BR-2026-0002', vorlage: 'monatsbericht_standort', geltung_art: 'standort', geltung_id: FIXTURE_IDS.st2, geltung_name: 'Werk Lindach',
      stand_zeichen: 'revision_noetig', neueste_nr: 1, anstoss_seit: '2028-04-03T08:00:00Z',
    });
    mocks.berichte.mockResolvedValue({ berichte: [...LISTE, lindach], abruf: '2029-04-30T20:10:00Z' });
    setSelbstauskunft(selbst(['bericht.standort_abrufen', 'bericht.standort_freigeben']));
    await zeige();
    expect(screen.getByTestId('zaehler-wartet').textContent).toBe('1 wartet auf Sie');
    expect(screen.getByTestId('zaehler-wartet-andere').textContent).toBe('1 wartet');
  });

  it('Review r1, P3-7 (C8): die Liste lädt die archivierten mit und zeigt sie als eine Zeile „Archiviert · n“, nie gezählt', async () => {
    const archiviert = bericht({ kennung: 'BR-2026-0009', vorlage: 'jahresbericht_unternehmen', zeitraum_art: 'jahr', zeitraum_text: '2026', archiviert_am: '2029-03-01T09:00:00Z' });
    mocks.berichte.mockResolvedValue({ berichte: [...LISTE, archiviert], abruf: '2029-04-30T20:10:00Z' });
    setSelbstauskunft(selbst(['bericht.standort_abrufen']));
    const ruf = await zeige();
    expect(mocks.berichte).toHaveBeenCalledWith({ archiviert: true });
    expect(screen.getByTestId('zaehler-gelten').textContent).toBe('4 gelten');
    expect(screen.getByTestId('berichte-archiviert').textContent).toContain('1');
    fireEvent.click(screen.getByTestId('berichte-archiviert'));
    const blatt = await screen.findByTestId('berichte-blatt');
    fireEvent.click(within(blatt).getByTestId('bericht-zeile-BR-2026-0009'));
    expect(ruf.onOeffnen).toHaveBeenCalledWith('BR-2026-0009');
  });

  it('Bewertung und Managementbewertung öffnen ihre Seite, andere die Berichtsseite; „PDF“ lädt den gültigen Stand', async () => {
    setSelbstauskunft(selbst(['bericht.standort_abrufen']));
    const ruf = await zeige();
    fireEvent.click(screen.getByTestId('bericht-zeile-BR-2029-0001'));
    expect(ruf.onManagementbewertung).toHaveBeenCalledWith('BR-2029-0001');
    fireEvent.click(screen.getByTestId('bericht-zeile-BR-2029-0002'));
    expect(ruf.onBewertung).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('bericht-zeile-BR-2028-0001'));
    expect(ruf.onOeffnen).toHaveBeenCalledWith('BR-2028-0001');
    fireEvent.click(screen.getByTestId('bericht-pdf-BR-2028-0001'));
    await waitFor(() => expect(mocks.berichtDatei).toHaveBeenCalledWith('BR-2028-0001', 1, 'pdf'));
  });

  it('„Erstellen“: Welcher? · Für wo und wann? · Prüfen - dann die Bestätigung mit PDF', async () => {
    const ANGELEGT = Date.parse(ZEIT.angelegt) + 60_000;
    setSelbstauskunft(selbst(['bericht.standort_abrufen', 'bericht.standort_freigeben']));
    mocks.berichte.mockResolvedValue({ berichte: LISTE, abruf: new Date(ANGELEGT).toISOString() });
    mocks.standorte.mockResolvedValue(ahrenbergHeute());
    mocks.unternehmen.mockResolvedValue(ahrenbergUnternehmen());
    mocks.kennzahlen.mockResolvedValue({ kennzahlen: [] });
    mocks.berichtAnlegen.mockImplementation(async (a: BerichtAnlegen) => anlegenAm(a, false, ANGELEGT));
    mocks.bericht.mockImplementation(async () => detailAm(ANGELEGT));
    mocks.berichtEntwurf.mockImplementation(async () => entwurfAm(ANGELEGT));
    // Die Bühne gibt Stand 1 zur Uhr seiner Freigabe heraus (10.11., 09:02).
    mocks.berichtFreigeben.mockImplementation(async (_k: string, datenstand: string) => freigabeAm(datenstand, Date.parse(ZEIT.nr1) + 60_000));
    const ruf = await zeige();
    fireEvent.click(screen.getByTestId('bericht-anlegen-knopf'));
    await screen.findByTestId('bericht-erstellen-art');
    fireEvent.click(screen.getByRole('radio', { name: /^Monatsbericht/ }));
    fireEvent.click(screen.getByTestId('bericht-erstellen-weiter'));
    const fuer = await screen.findByTestId('bericht-erstellen-fuer');
    fireEvent.click(within(fuer).getByRole('radio', { name: 'Werk Ahrenberg' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-erstellen-weiter'));
    });
    expect(mocks.berichtAnlegen).toHaveBeenCalledWith(expect.objectContaining({ vorlage: 'monatsbericht_standort', geltung_id: FIXTURE_IDS.st1, zeitraum: '2026-10' }));
    const pruefen = await screen.findByTestId('bericht-pruefen');
    expect(pruefen.textContent).toContain('Monatsbericht Oktober 2026');
    expect(pruefen.textContent).toContain('Werk Ahrenberg');
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-erstellen-freigeben'));
    });
    expect(mocks.berichtFreigeben).toHaveBeenCalledWith('BR-2026-0001', entwurfAm(ANGELEGT).datenstand);
    expect((await screen.findByTestId('bericht-bestaetigung')).textContent).toContain('Stand 1 ist freigegeben');
    fireEvent.click(screen.getByTestId('bericht-fertig'));
    expect(ruf.onOeffnen).toHaveBeenCalledWith('BR-2026-0001');
  });

  it('Review r1, P3-9: „Erstellen“ - ist der Entwurf veraltet (409), lädt „Entwurf neu laden“ ihn statt einer Sackgasse', async () => {
    const ANGELEGT = Date.parse(ZEIT.angelegt) + 60_000;
    mocks.berichte.mockResolvedValue({ berichte: LISTE, abruf: new Date(ANGELEGT).toISOString() });
    mocks.standorte.mockResolvedValue(ahrenbergHeute());
    mocks.unternehmen.mockResolvedValue(ahrenbergUnternehmen());
    mocks.kennzahlen.mockResolvedValue({ kennzahlen: [] });
    mocks.berichtAnlegen.mockImplementation(async (a: BerichtAnlegen) => anlegenAm(a, false, ANGELEGT));
    mocks.bericht.mockImplementation(async () => detailAm(ANGELEGT));
    mocks.berichtEntwurf.mockImplementation(async () => entwurfAm(ANGELEGT));
    const neu = { ...entwurfAm(ANGELEGT), datenstand: '2026-11-10T08:58:00Z' };
    mocks.berichtFreigeben
      .mockRejectedValueOnce(new ApiError(409, 'Der Entwurf ist nicht mehr aktuell.', { code: 'entwurf_veraltet', message: 'Der Entwurf ist nicht mehr aktuell.' }))
      // Die Bühne kennt nur ihren Datenstand - der Stand, den sie herausgibt, ist hier nebensächlich.
      .mockImplementation(async () => freigabeAm(entwurfAm(ANGELEGT).datenstand, Date.parse(ZEIT.nr1) + 60_000));
    const erstellen = async () => {
      fireEvent.click(screen.getByTestId('bericht-anlegen-knopf'));
      await screen.findByTestId('bericht-erstellen-art');
      fireEvent.click(screen.getByRole('radio', { name: /^Monatsbericht/ }));
      fireEvent.click(screen.getByTestId('bericht-erstellen-weiter'));
      const fuer = await screen.findByTestId('bericht-erstellen-fuer');
      fireEvent.click(within(fuer).getByRole('radio', { name: 'Werk Ahrenberg' }));
      await act(async () => {
        fireEvent.click(screen.getByTestId('bericht-erstellen-weiter'));
      });
      await screen.findByTestId('bericht-pruefen');
    };
    setSelbstauskunft(selbst(['bericht.standort_abrufen', 'bericht.standort_freigeben']));
    await zeige();
    await erstellen();
    expect(screen.queryByTestId('bericht-erstellen-ohne-recht')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-erstellen-freigeben'));
    });
    mocks.berichtEntwurf.mockResolvedValue(neu);
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-erstellen-neu-laden'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-erstellen-freigeben'));
    });
    expect(mocks.berichtFreigeben).toHaveBeenLastCalledWith('BR-2026-0001', '2026-11-10T08:58:00Z');
    expect(await screen.findByTestId('bericht-bestaetigung')).toBeTruthy();
  });
});

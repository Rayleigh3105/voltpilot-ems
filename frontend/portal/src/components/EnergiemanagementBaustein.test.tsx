import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { energiemanagementRoute } from '../nav';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { bausteineMitInhalt } from '../uebersichtBausteine';
import {
  bausteinSatz,
  energiemanagementBaustein,
  kalenderVermerk,
  KALENDER_ABZUG_FEHLER,
  type Wiedervorlage,
  type WiedervorlageZeile,
} from '../wiedervorlage';
import { EnergiemanagementBaustein } from './EnergiemanagementBaustein';
import { UebersichtBausteine, useUebersichtBausteine } from './UebersichtBausteine';

const zeile = (kennzeichen: string, faellig_am: string, tage: number, art: WiedervorlageZeile['art']): WiedervorlageZeile => ({
  art,
  kennzeichen,
  titel: `${kennzeichen} — Überprüfung`,
  faellig_am,
  tage,
  satz: tage > 0 ? `seit ${tage} Tagen fällig` : tage === 0 ? 'heute fällig' : `fällig in ${-tage} Tagen`,
  verantwortlich: null,
  id: null,
  kennzahl_id: null,
});

/** R12 am 12.02.2029: acht fällige Zeilen und eine Vorschau (die Antwort der Wiedervorlage-Route). */
function r12(): Wiedervorlage {
  return {
    stichtag: '2029-02-12T08:00:00+01:00',
    vorschau_tage: 30,
    faellig: [
      zeile('BB-0002', '2027-11-13', 457, 'bezugsbasis_ueberpruefung'),
      zeile('BB-0005', '2027-11-20', 450, 'bezugsbasis_ueberpruefung'),
      zeile('BB-0003', '2028-03-05', 344, 'bezugsbasis_ueberpruefung'),
      zeile('BR-2028-0001', '2028-04-03', 315, 'bericht_anstoss'),
      zeile('BB-0004', '2028-11-24', 80, 'bezugsbasis_ueberpruefung'),
      zeile('BR-2027-0001', '2028-11-24', 80, 'bewertung_ueberpruefung'),
      zeile('D-0001', '2028-12-10', 64, 'dokument_ueberpruefung'),
      zeile('D-0002', '2028-12-10', 64, 'dokument_ueberpruefung'),
    ],
    vorschau: [zeile('M-2029-0001', '2029-02-28', -16, 'massnahme_termin')],
    anzahl_faellig: 8,
    anzahl_vorschau: 1,
    nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'D-0003', 'D-0004', 'F-2029-0001', 'M-2029-0002'],
    verantwortung: UEMS_VERANTWORTUNG,
  };
}

const leer = (): Wiedervorlage => ({ ...r12(), faellig: [], vorschau: [], anzahl_faellig: 0, anzahl_vorschau: 0, nicht_in_liste: [] });

describe('Wiedervorlage — das reine Bild des Bausteins „Energiemanagement“ (WV5, E10)', () => {
  it('R12: der §5.8-Satz „Baustein“ wörtlich, am Baustein ohne den Titel davor, mit Warnton', () => {
    expect(bausteinSatz(r12())).toBe('Energiemanagement — 8 fällig · 1 in den nächsten 30 Tagen.');
    expect(energiemanagementBaustein(r12())).toEqual({ summe: '8 fällig · 1 in den nächsten 30 Tagen.', faellig: true });
  });

  it('ohne Inhalt kein Bild: nichts fällig und keine Vorschau — oder keine Antwort', () => {
    expect(energiemanagementBaustein(leer())).toBeNull();
    expect(energiemanagementBaustein(null)).toBeNull();
    expect(bausteineMitInhalt({ messstellen: null, energiebilanz: null, gebaeude: [], kennzahlen: null, energiemanagement: null }))
      .toEqual([]);
    expect(
      bausteineMitInhalt({
        messstellen: null,
        energiebilanz: null,
        gebaeude: [],
        kennzahlen: null,
        energiemanagement: energiemanagementBaustein(r12()),
      }),
    ).toEqual(['energiemanagement']);
  });

  it('nur eine Vorschau: die Kachel steht, ruhig — nichts ist fällig', () => {
    const nurVorschau = { ...r12(), faellig: [], anzahl_faellig: 0 };
    expect(energiemanagementBaustein(nurVorschau)).toEqual({ summe: '0 fällig · 1 in den nächsten 30 Tagen.', faellig: false });
  });

  it('der Stand-Vermerk des Kalender-Abzugs (§5.8) mit dem Tag des Abrufs', () => {
    expect(kalenderVermerk(r12().stichtag)).toBe('Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.');
  });
});

describe('EnergiemanagementBaustein — die Kachel', () => {
  it('rendert die Summe, den Kalender-Abzug und beide Sätze (SP4); die Knöpfe rufen ihre Handlung', () => {
    const onOeffnen = vi.fn();
    const onKalender = vi.fn();
    render(<EnergiemanagementBaustein bild={energiemanagementBaustein(r12())!} onOeffnen={onOeffnen} onKalender={onKalender} />);
    const summe = screen.getByTestId('energiemanagement-summe');
    expect(summe.textContent).toBe('8 fällig · 1 in den nächsten 30 Tagen.');
    expect(summe.className).toContain('is-warn');
    const kachel = screen.getByTestId('baustein-energiemanagement');
    expect(kachel.textContent).toContain(UEMS_VERANTWORTUNG);
    expect(kachel.textContent).toContain(UEMS_NORMGRENZE);
    expect(kachel.textContent).toContain('VoltPilot verschickt nichts.');
    fireEvent.click(screen.getByTestId('energiemanagement-kalender'));
    expect(onKalender).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Zum Energiemanagement' }));
    expect(onOeffnen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ein gescheiterter Abzug sagt es sichtbar', () => {
    render(
      <EnergiemanagementBaustein bild={energiemanagementBaustein(r12())!} onOeffnen={() => {}} onKalender={() => {}} kalenderFehler />,
    );
    expect(screen.getByRole('alert').textContent).toBe(KALENDER_ABZUG_FEHLER);
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
  return daten && <UebersichtBausteine daten={daten} zeigen={['energiemanagement']} onNavigate={onNavigate} />;
}

describe('Übersichts-Baustein „Energiemanagement“ am Unternehmen', () => {
  beforeEach(() => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister());
    vi.spyOn(api, 'anlageBilanz').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'standortOrte').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [] });
    vi.spyOn(api, 'berichte').mockResolvedValue({ berichte: [] });
    vi.spyOn(api, 'bezugsbasisUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'verbesserungUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'energiemanagementWiedervorlage').mockResolvedValue(r12());
  });
  afterEach(() => {
    setSelbstauskunft(null);
    vi.restoreAllMocks();
  });

  it('R12: am Unternehmen erscheint die Kachel „8 fällig · 1 in den nächsten 30 Tagen.“; der Sprung geht ins Energiemanagement', async () => {
    const onNavigate = vi.fn();
    render(<Uebersicht art="unternehmen" onNavigate={onNavigate} />);
    await act(async () => {});
    expect(screen.getByTestId('energiemanagement-summe').textContent).toBe('8 fällig · 1 in den nächsten 30 Tagen.');
    fireEvent.click(screen.getByRole('button', { name: 'Zum Energiemanagement' }));
    expect(onNavigate).toHaveBeenLastCalledWith(energiemanagementRoute('wiedervorlage'));
  });

  it('der Kalender-Abzug ist ein Abruf: er lädt die Datei, nichts wird verschickt; scheitert er, steht der Satz da', async () => {
    const ics = vi.spyOn(api, 'energiemanagementWiedervorlageIcs').mockRejectedValue(new Error('503'));
    render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId('energiemanagement-kalender'));
    });
    expect(ics).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe(KALENDER_ABZUG_FEHLER);
  });

  it('ohne Inhalt kein Render (WV5, AP-13 E3)', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(leer());
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('am Standort nie und ohne Abfrage — der Baustein gehört dem Unternehmen', async () => {
    const { container } = render(<Uebersicht art="standort" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(api.energiemanagementWiedervorlage).not.toHaveBeenCalled();
  });

  it('eine abgelehnte Abfrage zeigt nichts', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockRejectedValue(new Error('403'));
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});

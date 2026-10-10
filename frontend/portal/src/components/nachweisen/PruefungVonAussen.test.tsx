import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api';
import { benutzerApi } from '../../benutzer';
import { VOKABULARE } from '../../energiemanagement';
import { mappeRoute } from '../../nav';
import { MappeSeite } from '../../pages/MappeSeite';
import { setSelbstauskunft } from '../../rollen';
import { vergissAbruf } from '../../routenUhr';
import { MAPPE_IDS, mappeBuehne, type MappeLage } from '../../test/mappeFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
import { EinsichtBlatt } from './EinsichtBlatt';
import { MappeBlatt } from './MappeBlatt';
import { PruefungVonAussen } from './PruefungVonAussen';

/**
 * „Prüfung von außen“ (Konzept Nachweisen n1, Runde 2, Entscheide 7 und 8, PR 6) mit den Rollen des Referenzunternehmens:
 * JW Kundenadministrator (beide Knöpfe), IK Energiemanager (nur „Unterlagen zusammenstellen“), RF Einsicht (nur lesen:
 * die Mappen, die noch abrufbar sind). Die Routen spielt `mappeBuehne` (MOCK); was die Route selbst prüft, steht in
 * `EnergiemanagementMappeApiTest`.
 */
const STAGE = '2029-04-30T10:20:00+02:00';
const laden = async () => {
  await act(async () => {});
  await act(async () => {});
};

describe('Prüfung von außen', () => {
  const original = { ...api };
  const originalBenutzer = { ...benutzerApi };
  let mp: ReturnType<typeof mappeBuehne>;

  const buehne = (kennung: string, lage: MappeLage, jetzt = STAGE) => {
    const me = rechteSeed(kennung).me;
    setSelbstauskunft(me);
    mp = mappeBuehne(lage, () => new Date(jetzt).toISOString(), { name: me.name! });
    Object.assign(api, mp.routen);
    Object.assign(benutzerApi, mp.benutzer);
  };

  beforeEach(() => {
    // Die Uhr des Browsers läuft in der Demo Jahre hinter der Uhr der Route (Befund 3).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:00:00+02:00'));
    vergissAbruf();
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    Object.assign(benutzerApi, originalBenutzer);
    vergissAbruf();
    vi.useRealTimers();
  });

  const abschnitt = (onNavigate = vi.fn()) =>
    render(<PruefungVonAussen heute="2029-04-30" verzeichnis={{ gruppen: [] }} offen={['kontext', 'beschaffung']} onNavigate={onNavigate} />);

  it('Kundenadministrator: beide Knöpfe; Energiemanager: nur „Unterlagen zusammenstellen“', async () => {
    buehne('JW', 'leer');
    abschnitt();
    await laden();
    expect(screen.getByTestId('aussen-mappe').textContent).toBe('Unterlagen zusammenstellen');
    expect(screen.getByTestId('aussen-einsicht').textContent).toBe('Einsicht geben');
    expect(screen.queryByTestId('aussen-mappen')).toBeNull();
    cleanup();

    buehne('IK', 'leer');
    abschnitt();
    await laden();
    expect(screen.getByTestId('aussen-mappe')).toBeTruthy();
    expect(screen.queryByTestId('aussen-einsicht')).toBeNull();
  });

  it('„Einsicht“ hat keinen Knopf; ohne abrufbare Mappe steht der Abschnitt nicht da, mit einer nur „Mappen · 1“', async () => {
    buehne('RF', 'leer');
    abschnitt();
    await laden();
    expect(screen.queryByTestId('ueberblick-aussen')).toBeNull();
    cleanup();

    const onNavigate = vi.fn();
    buehne('RF', 'r6');
    abschnitt(onNavigate);
    await laden();
    const aussen = screen.getByTestId('ueberblick-aussen');
    expect(within(aussen).queryAllByRole('button', { name: /Unterlagen zusammenstellen|Einsicht geben/ })).toHaveLength(0);
    // Die abgelaufene Mappe zählt nicht mit.
    expect(screen.getByTestId('aussen-mappen').textContent).toContain('Mappen1');
    fireEvent.click(screen.getByTestId('aussen-mappen'));
    fireEvent.click(screen.getByTestId(`aussen-mappe-${MAPPE_IDS.abrufbar}`));
    expect(onNavigate).toHaveBeenCalledWith(mappeRoute(MAPPE_IDS.abrufbar));
  });

  it('Unterlagen zusammenstellen: Anlass, 12 Monate bis zum Tag der Route, alle Gruppen, die offenen Teile', async () => {
    const onNavigate = vi.fn();
    buehne('IK', 'leer');
    abschnitt(onNavigate);
    await laden();
    fireEvent.click(screen.getByTestId('aussen-mappe'));
    const blatt = screen.getByTestId('mappe-blatt');
    expect(blatt.textContent).toContain('seit 01.05.2028');
    expect(within(blatt).getByTestId('mappe-offen').textContent).toContain('2 Teile offen');
    // Ohne Bündel geht nichts hinaus.
    for (const box of within(blatt).getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByTestId('mappe-erstellen'));
    await laden();
    expect(screen.getByRole('alert').textContent).toBe('Bitte wählen Sie mindestens einen Teil.');
    expect(mp.gesendet).toEqual([]);
    for (const box of within(blatt).getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByTestId('mappe-erstellen'));
    await laden();
    expect(mp.gesendet).toEqual([
      { route: 'POST /mappen', body: { anlass: 'audit_von_aussen', von: '2028-05-01', gruppen: [...VOKABULARE.verzeichnis_gruppe], offen: ['kontext', 'beschaffung'] } },
    ]);
    expect(onNavigate).toHaveBeenCalledWith(mappeRoute(expect.any(String)));
  });

  it('Einsicht geben: Rolle „Einsicht“ bis zum 14. Tag nach dem Tag der Route, das Startpasswort einmal', async () => {
    buehne('JW', 'leer');
    abschnitt();
    await laden();
    fireEvent.click(screen.getByTestId('aussen-einsicht'));
    fireEvent.change(screen.getByTestId('einsicht-name'), { target: { value: 'Petra Prüfer' } });
    fireEvent.change(screen.getByTestId('einsicht-email'), { target: { value: 'kein-at-zeichen' } });
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await laden();
    expect(screen.getByTestId('einsicht-blatt').textContent).toContain('Bitte geben Sie eine E-Mail-Adresse an.');
    expect(mp.gesendet).toEqual([]);
    fireEvent.change(screen.getByTestId('einsicht-email'), { target: { value: 'petra.pruefer@audit.example' } });
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await laden();
    expect(mp.gesendet).toEqual([
      {
        route: 'POST /benutzer',
        body: {
          username: 'petra.pruefer@audit.example', email: 'petra.pruefer@audit.example', vorname: 'Petra', nachname: 'Prüfer',
          rolle: 'einsicht', standorte: [], gueltig_bis: '2029-05-14',
        },
      },
    ]);
    expect(screen.getByTestId('einsicht-angelegt').textContent).toContain('bis 14.05.2029');
    expect(screen.getByTestId('einsicht-passwort').textContent).toBe('Buehne-Start-7Kq2');
  });
});

describe('Seite einer Mappe', () => {
  const original = { ...api };
  const originalBenutzer = { ...benutzerApi };
  let mp: ReturnType<typeof mappeBuehne>;

  const oeffne = async (kennung: string, id: string) => {
    const me = rechteSeed(kennung).me;
    setSelbstauskunft(me);
    mp = mappeBuehne('r6', () => new Date(STAGE).toISOString(), { name: me.name! });
    Object.assign(api, mp.routen);
    Object.assign(benutzerApi, mp.benutzer);
    render(<MappeSeite id={id} onZurueck={vi.fn()} />);
    await laden();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:00:00+02:00'));
    vergissAbruf();
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    Object.assign(benutzerApi, originalBenutzer);
    vergissAbruf();
    vi.useRealTimers();
  });

  it('„Einsicht“ liest und lädt, gibt aber keine Einsicht weiter', async () => {
    await oeffne('RF', MAPPE_IDS.abrufbar);
    expect(screen.getByTestId('mappe-fertig').textContent).toContain('Die Mappe ist fertig');
    expect(screen.getByTestId('mappe-datei').textContent).toContain('PDF · CSV · noch 28 Tage');
    expect(screen.getByTestId('mappe-offen').textContent).toBe('2 Teile als offen aufgeführt');
    expect(screen.getByTestId('mappe-speichern')).toBeTruthy();
    expect(screen.queryByTestId('mappe-einsicht')).toBeNull();
  });

  it('der Kundenadministrator gibt Einsicht ab dem Tag der Route, nicht ab der Uhr des Browsers (Befund 3)', async () => {
    await oeffne('JW', MAPPE_IDS.abrufbar);
    fireEvent.click(screen.getByTestId('mappe-einsicht'));
    fireEvent.change(screen.getByTestId('einsicht-name'), { target: { value: 'Petra Prüfer' } });
    fireEvent.change(screen.getByTestId('einsicht-email'), { target: { value: 'petra.pruefer@audit.example' } });
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await laden();
    expect(mp.gesendet.at(-1)?.body).toMatchObject({ rolle: 'einsicht', gueltig_bis: '2029-05-14' });
  });

  it('nach 30 Tagen: „Nicht mehr abrufbar“, kein Abruf, „Neu zusammenstellen“', async () => {
    await oeffne('JW', MAPPE_IDS.abgelaufen);
    expect(screen.getByTestId('mappe-abgelaufen').textContent).toContain('Nicht mehr abrufbar');
    expect(screen.getByTestId('mappe-datei').textContent).toContain('nicht mehr abrufbar');
    expect(screen.queryByTestId('mappe-speichern')).toBeNull();
    expect(screen.queryByTestId('mappe-einsicht')).toBeNull();
    expect(screen.getByTestId('mappe-neu')).toBeTruthy();
  });
});

describe('Review r1 (PR 6)', () => {
  const original = { ...api };
  const originalBenutzer = { ...benutzerApi };
  const ADRESSE = 'petra.pruefer@audit.example';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:00:00+02:00'));
    vergissAbruf();
    setSelbstauskunft(rechteSeed('JW').me);
    const mp = mappeBuehne('r6', () => new Date(STAGE).toISOString(), { name: 'Jonas Wendlinger' });
    Object.assign(api, mp.routen);
    Object.assign(benutzerApi, mp.benutzer);
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    Object.assign(benutzerApi, originalBenutzer);
    vergissAbruf();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Ein Versprechen, das der Test selbst einlöst - so lässt sich prüfen, was während des Wartens geht. */
  function offen<T>() {
    let einloesen!: (v: T) => void;
    const versprechen = new Promise<T>((r) => (einloesen = r));
    return { versprechen, einloesen };
  }
  const ausfuellen = () => {
    fireEvent.change(screen.getByTestId('einsicht-name'), { target: { value: 'Petra Prüfer' } });
    fireEvent.change(screen.getByTestId('einsicht-email'), { target: { value: ADRESSE } });
  };

  it('P6-3: „Einsicht geben“ sagt ohne Aufklappen, was die Person sieht und bis wann', async () => {
    render(<EinsichtBlatt heute="2029-04-30" onClose={vi.fn()} />);
    const umfang = () => screen.getByTestId('einsicht-umfang').textContent;
    expect(umfang()).toBe('Sieht alle Daten aller Standorte, nur lesend, bis\u00a014.05.2029.');
    fireEvent.click(screen.getByRole('radio', { name: '4 Wochen' }));
    expect(umfang()).toBe('Sieht alle Daten aller Standorte, nur lesend, bis\u00a028.05.2029.');
    fireEvent.click(screen.getByRole('radio', { name: 'Anderer Tag' }));
    expect(umfang()).toBe('Sieht alle Daten aller Standorte, nur lesend.');
  });

  it('P6-5: während der Zugang entsteht, schließt das Blatt nicht - danach steht das Startpasswort da', async () => {
    const warten = offen<{ benutzer: never; startpasswort: string }>();
    Object.assign(benutzerApi, { anlegen: () => warten.versprechen });
    const onClose = vi.fn();
    render(<EinsichtBlatt heute="2029-04-30" onClose={onClose} />);
    ausfuellen();
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => warten.einloesen({ benutzer: undefined as never, startpasswort: 'Start-9Zq4' }));
    expect(screen.getByTestId('einsicht-passwort').textContent).toBe('Start-9Zq4');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('P6-5: während die Mappe entsteht, schließt das Blatt nicht - und öffnet danach die Mappe', async () => {
    const warten = offen<Awaited<ReturnType<typeof api.energiemanagementMappeAnlegen>>>();
    const fertig = await api.energiemanagementMappe(MAPPE_IDS.abrufbar);
    Object.assign(api, { energiemanagementMappeAnlegen: () => warten.versprechen });
    const onClose = vi.fn();
    const onErstellt = vi.fn();
    render(<MappeBlatt heute="2029-04-30" verzeichnis={{ gruppen: [] }} offen={[]} onClose={onClose} onErstellt={onErstellt} />);
    fireEvent.click(screen.getByTestId('mappe-erstellen'));
    await act(async () => {});
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => warten.einloesen(fertig));
    expect(onErstellt).toHaveBeenCalledWith(fertig);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('P6-7: hat die Adresse schon ein Konto, bekommt es die Einsicht bis zum gewählten Tag - mit Weg in die Benutzerverwaltung', async () => {
    const zuweisen = vi.fn(async () => ({}));
    Object.assign(benutzerApi, {
      anlegen: async () => {
        throw new ApiError(409, 'vergeben', { code: 'konflikt', message: 'vergeben' });
      },
      liste: async () => [{ sub: 'pp-1', anzeigename: 'Petra Prüfer', email: 'Petra.Pruefer@audit.example', zustand: 'aktiv', zuweisungen: [] }],
      einsichtZuweisen: zuweisen,
    });
    render(<EinsichtBlatt heute="2029-04-30" onClose={vi.fn()} />);
    ausfuellen();
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByTestId('einsicht-vorhanden').textContent).toContain('Petra Prüfer');
    expect(screen.getByTestId('einsicht-benutzerverwaltung').getAttribute('href')).toBe('#/unternehmen/einstellungen/benutzer');
    expect(screen.getByTestId('einsicht-anlegen').textContent).toBe('Einsicht bis 14.05.2029 geben');
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    expect(zuweisen).toHaveBeenCalledWith('pp-1', '2029-05-14', null);
    expect(screen.getByTestId('einsicht-gegeben').textContent).toBe('Einsicht gegeben· bis 14.05.2029');
  });

  it('P6-7: läuft die Einsicht des Kontos noch, bekommt sie die neue Frist', async () => {
    const wechseln = vi.fn(async () => undefined);
    Object.assign(benutzerApi, {
      anlegen: async () => {
        throw new ApiError(409, 'vergeben', { code: 'konflikt', message: 'vergeben' });
      },
      liste: async () => [
        {
          sub: 'pp-1', anzeigename: 'Petra Prüfer', email: ADRESSE, zustand: 'aktiv',
          zuweisungen: [{ id: 'z-1', rolle: 'einsicht', standort_id: null, standort_name: null, gueltig_ab: '2029-04-01', gueltig_bis: '2029-05-02' }],
        },
      ],
      wechseln,
    });
    render(<EinsichtBlatt heute="2029-04-30" onClose={vi.fn()} />);
    ausfuellen();
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    await act(async () => {});
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    expect(wechseln).toHaveBeenCalledWith('pp-1', ['z-1'], 'einsicht', [], '2029-05-14');
  });

  /** Ein Konto mit laufender Einsicht bis `bis` (null = ohne Ende): das Blatt nach dem 409. */
  const mitLaufenderEinsicht = async (bis: string | null) => {
    const wechseln = vi.fn(async () => undefined);
    const zuweisen = vi.fn(async () => ({}));
    Object.assign(benutzerApi, {
      anlegen: async () => {
        throw new ApiError(409, 'vergeben', { code: 'konflikt', message: 'vergeben' });
      },
      liste: async () => [
        {
          sub: 'rf-1', anzeigename: 'Robert Falk', email: ADRESSE, zustand: 'aktiv',
          zuweisungen: [{ id: 'z-9', rolle: 'einsicht', standort_id: null, standort_name: null, gueltig_ab: '2029-01-01', gueltig_bis: bis }],
        },
      ],
      wechseln,
      einsichtZuweisen: zuweisen,
    });
    render(<EinsichtBlatt heute="2029-04-30" onClose={vi.fn()} />);
    ausfuellen();
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    await act(async () => {});
    return { wechseln, zuweisen };
  };

  it('Review r2, N-6.1: läuft die Einsicht ohne Ende, sagt der Kasten es und das Blatt kürzt sie nicht', async () => {
    const { wechseln, zuweisen } = await mitLaufenderEinsicht(null);
    expect(screen.getByTestId('einsicht-stand').textContent).toBe('Einsicht läuft ohne Ende · bleibt so');
    // Der Umfang sagt, was gilt: ohne Ende kein Tag - nicht der gewählte.
    expect(screen.getByTestId('einsicht-umfang').textContent).toBe('Sieht alle Daten aller Standorte, nur lesend.');
    expect(screen.queryByTestId('einsicht-anlegen')).toBeNull();
    // Auch ein Absenden (Enter im Feld) ändert nichts.
    await act(async () => {
      fireEvent.submit(screen.getByTestId('einsicht-email').closest('form')!);
    });
    expect(wechseln).not.toHaveBeenCalled();
    expect(zuweisen).not.toHaveBeenCalled();
  });

  it('Review r2, N-6.1: läuft sie länger als gewählt, bleibt sie und es gibt nichts abzusenden', async () => {
    const { wechseln } = await mitLaufenderEinsicht('2029-06-30');
    expect(screen.getByTestId('einsicht-stand').textContent).toBe('Einsicht läuft bis\u00a030.06.2029 · bleibt so');
    expect(screen.getByTestId('einsicht-umfang').textContent).toBe('Sieht alle Daten aller Standorte, nur lesend, bis\u00a030.06.2029.');
    expect(screen.queryByTestId('einsicht-anlegen')).toBeNull();
    expect(wechseln).not.toHaveBeenCalled();
  });

  it('Review r2, N-6.1: läuft sie kürzer, nennt der Kasten ihr Ende und der Knopf verlängert', async () => {
    const { wechseln } = await mitLaufenderEinsicht('2029-05-02');
    expect(screen.getByTestId('einsicht-stand').textContent).toBe('Einsicht läuft bis\u00a002.05.2029');
    expect(screen.getByTestId('einsicht-anlegen').textContent).toBe('Einsicht bis 14.05.2029 verlängern');
    fireEvent.click(screen.getByTestId('einsicht-anlegen'));
    await act(async () => {});
    expect(wechseln).toHaveBeenCalledWith('rf-1', ['z-9'], 'einsicht', [], '2029-05-14');
  });

  it('P6-6: „Einsicht“ sieht an einer abgelaufenen Mappe kein „Neu zusammenstellen“', async () => {
    setSelbstauskunft(rechteSeed('RF').me);
    render(<MappeSeite id={MAPPE_IDS.abgelaufen} onZurueck={vi.fn()} />);
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByTestId('mappe-abgelaufen')).toBeTruthy();
    expect(screen.queryByTestId('mappe-neu')).toBeNull();
  });

  it('P6-4: „Öffnen“ lädt das PDF wie „Speichern“ und öffnet kein Fenster mit einem Blob-Dokument', async () => {
    const oeffnen = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => 'blob:vp/pdf'), revokeObjectURL: vi.fn() }));
    const klick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<MappeSeite id={MAPPE_IDS.abrufbar} onZurueck={vi.fn()} />);
    await act(async () => {});
    await act(async () => {});
    fireEvent.click(screen.getByTestId('mappe-oeffnen'));
    await act(async () => {});
    expect(oeffnen).not.toHaveBeenCalled();
    expect(klick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mappe-abruf').textContent).toBe('Abgerufen, der Abruf ist protokolliert.');
    klick.mockRestore();
    oeffnen.mockRestore();
  });
});

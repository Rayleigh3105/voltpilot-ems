import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { benutzerApi } from '../../benutzer';
import { VOKABULARE } from '../../energiemanagement';
import { mappeRoute } from '../../nav';
import { MappeSeite } from '../../pages/MappeSeite';
import { setSelbstauskunft } from '../../rollen';
import { vergissAbruf } from '../../routenUhr';
import { MAPPE_IDS, mappeBuehne, type MappeLage } from '../../test/mappeFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
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

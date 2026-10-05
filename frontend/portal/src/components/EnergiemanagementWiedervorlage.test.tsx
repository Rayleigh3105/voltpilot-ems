import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { verzeichnisDemo, wvDemo, wvLeer, wvNormal, wvR12 } from '../test/wiedervorlageFixtures';
import { KALENDER_ABZUG_FEHLER, LADEFEHLER, NOCH_KEINE_FRISTEN, NUR_EINSICHT, WOHER_SATZ } from '../wiedervorlage';
import { EnergiemanagementWiedervorlage } from './EnergiemanagementWiedervorlage';

const ladeAus = async () => {
  await act(async () => {});
};

describe('Die Wiedervorlage als Arbeitsliste (Konzept Wiedervorlage w1)', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/#/portfolio/energiemanagement/wiedervorlage');
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'energiemanagementWiedervorlage').mockResolvedValue(wvR12());
    vi.spyOn(api, 'energiemanagementVerzeichnis').mockResolvedValue(verzeichnisDemo());
  });
  afterEach(() => {
    // Erst abbauen, dann die Rechte zurücksetzen; sonst rendert die Seite noch einmal außerhalb von `act`.
    cleanup();
    setSelbstauskunft(null);
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
  });

  it('R12: Kopf mit Stand, Marken, Überfällig vor den nächsten 30 Tagen, Fuß mit Herkunft und beiden Sätzen', async () => {
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Wiedervorlage');
    expect(screen.getByTestId('wiedervorlage-kopf').textContent).toBe(
      'Alle Fristen Ihres Energiemanagements, das am längsten Überfällige zuerst. Stand 12.02.2029.',
    );
    const marken = screen.getByTestId('wiedervorlage-marken');
    expect([...marken.children].map((m) => m.textContent)).toEqual(['8 überfällig', '1 in den nächsten 30 Tagen']);
    expect(screen.getByRole('heading', { name: 'Überfällig · 8' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'In den nächsten 30 Tagen · 1' })).toBeTruthy();
    const ueber = within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem');
    expect(ueber).toHaveLength(8);
    expect(ueber[0].textContent).toContain('Bezugsbasis BB-0002 überprüfen');
    expect(ueber[0].textContent).toContain('Vergleichsgrundlage einer Kennzahl · Fassung 2 vom 13.11.2026 + 12 Monate');
    expect(ueber[0].textContent).toContain('Auswerten');
    expect(ueber[0].textContent).toContain('Ines Kaltenbach');
    expect(ueber[0].textContent).toContain('Bestätigen oder neu fassen');
    // Datum statt Tageszähler.
    expect(within(ueber[0]).getByRole('img', { name: 'fällig seit 13.11.2027' })).toBeTruthy();
    expect(screen.getByTestId('wiedervorlage').textContent).not.toMatch(/seit \d+ Tagen/);
    // Wo die Route keine Person nennt, steht das so; nichts wird erfunden.
    expect(ueber[3].textContent).toContain('ohne Person am Objekt');
    const bald = within(screen.getByTestId('wiedervorlage-bald')).getAllByRole('listitem');
    expect(bald[0].textContent).toContain('Maßnahme M-2029-0001 · in 16 Tagen');
    expect(bald[0].textContent).toContain('Jonas Wendlinger');
    expect(screen.getByTestId('wiedervorlage-danach').textContent).toBe('Danach stehen 6 weitere Fristen an.');
    const fuss = screen.getByTestId('wiedervorlage-fuss');
    expect(fuss.textContent).toContain(`Woher kommen diese Fristen? ${WOHER_SATZ}`);
    expect(fuss.textContent).toContain(UEMS_VERANTWORTUNG);
    expect(fuss.textContent).toContain(UEMS_NORMGRENZE);
  });

  it('der Schritt ist die ganze Karte: ein Link mit Entscheid, der über die Schale springt', async () => {
    const springe = vi.fn();
    render(<EnergiemanagementWiedervorlage springe={springe} />);
    await ladeAus();
    const karte = screen.getByTestId('wiedervorlage-eintrag-D-0001');
    expect(karte.tagName).toBe('A');
    expect(karte.getAttribute('href')).toMatch(/^#\/portfolio\/energiemanagement\/dokumente\/.+\?entscheid=dokument_ueberpruefung$/);
    fireEvent.click(karte);
    expect(springe).toHaveBeenCalledWith(expect.objectContaining({ hash: karte.getAttribute('href') }));
  });

  it('Filter: je Bereich, und die Art aus der Übersicht als aufhebbarer Filter', async () => {
    history.replaceState(null, '', '/#/portfolio/energiemanagement/wiedervorlage?art=bezugsbasis_ueberpruefung');
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByRole('heading', { name: 'Überfällig · 4' })).toBeTruthy();
    // Die Maßnahme ist keine Bezugsbasis: der Abschnitt sagt, dass die Auswahl ihn leert.
    expect(screen.getByTestId('wiedervorlage-nichts-bald').textContent).toBe('In dieser Auswahl steht hier keine Frist.');
    fireEvent.click(screen.getByTestId('wiedervorlage-filter-art'));
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(8);
    expect(window.location.hash).toBe('#/portfolio/energiemanagement/wiedervorlage');
    fireEvent.click(screen.getByTestId('wiedervorlage-filter-nachweisen'));
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('wiedervorlage-filter-nachweisen').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }));
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(8);
  });

  it('Demo heute: ein Bericht mit zehn Korrekturen ist ein Eintrag; Zuletzt erledigt kommt aus dem Verzeichnis', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvDemo());
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByTestId('wiedervorlage-eintrag-BR-2026-0001').textContent).toContain('10 Korrekturen nach der Freigabe');
    expect(screen.getByTestId('wiedervorlage-nichts-bald').textContent).toBe('Bis 30.05.2029 ist nichts fällig.');
    const zuletzt = within(screen.getByTestId('wiedervorlage-zuletzt')).getAllByRole('listitem');
    expect(zuletzt.map((z) => z.textContent)).toEqual([
      expect.stringContaining('Energetische Bewertung BR-2029-0002: Stand Nr. 1 freigegeben'),
      expect.stringContaining('Feststellung F-2029-0001: Wirksamkeit festgehalten'),
      expect.stringContaining('Energiepolitik: Fassung 2 freigegeben'),
      expect.stringContaining('Managementbewertung 2028: Stand Nr. 1 freigegeben'),
      expect.stringContaining('Internes Audit AU-2029-0001 abgeschlossen'),
    ]);
  });

  it('Normalfall: „Keine Frist überfällig“ und das nächste Fenster statt einer Null', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvNormal());
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-marken').textContent).toBe('Keine Frist überfällig');
    expect(screen.queryByTestId('wiedervorlage-ueberfaellig')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-nichts-bald').textContent).toBe('Bis 30.05.2029 ist nichts fällig.');
    expect(screen.getByTestId('wiedervorlage-danach').textContent).toBe('Danach stehen 11 weitere Fristen an.');
    expect(screen.getByTestId('wiedervorlage').textContent).not.toMatch(/\b0 (überfällig|in den nächsten)/);
  });

  it('noch keine Fristen: der Satz sagt, woher sie kommen', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvLeer());
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-leer').textContent).toBe(NOCH_KEINE_FRISTEN);
  });

  it('ein gescheitertes Laden ist nie „nichts fällig“ und lässt sich wiederholen', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockRejectedValueOnce(new Error('503'));
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-fehler').textContent).toContain(LADEFEHLER);
    expect(screen.queryByTestId('wiedervorlage-leer')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    });
    expect(screen.queryByTestId('wiedervorlage-fehler')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-ueberfaellig')).toBeTruthy();
  });

  it('Einsicht: alle Fristen lesen, der Schritt öffnet nur zum Ansehen', async () => {
    setSelbstauskunft(rechteSeed('RF').me);
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-einsicht').textContent).toBe(NUR_EINSICHT);
    const karte = screen.getByTestId('wiedervorlage-eintrag-D-0001');
    expect(karte.getAttribute('href')).not.toContain('entscheid=');
    expect(karte.textContent).toContain('Ansehen');
  });

  it('der Kalender-Abzug ist ein Abruf; scheitert er, steht der Satz da', async () => {
    const ics = vi.spyOn(api, 'energiemanagementWiedervorlageIcs').mockRejectedValue(new Error('503'));
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wiedervorlage-kalender'));
    });
    expect(ics).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('wiedervorlage-kalender-fehler').textContent).toBe(KALENDER_ABZUG_FEHLER);
  });
});

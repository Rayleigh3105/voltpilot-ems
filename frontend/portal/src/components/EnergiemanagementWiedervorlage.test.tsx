import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { ABLESUNG, ableseRunde, wvDemo, wvLeer, wvNormal, wvR12, zuletztDemo, zuletztLeer } from '../test/wiedervorlageFixtures';
import { KALENDER_ABZUG_FEHLER, LADEFEHLER, NOCH_KEINE_FRISTEN, NUR_EINSICHT, WOHER_SATZ, ZULETZT_FEHLER } from '../wiedervorlage';
import { EnergiemanagementWiedervorlage } from './EnergiemanagementWiedervorlage';

const ladeAus = async () => {
  await act(async () => {});
};

describe('Die Wiedervorlage als Arbeitsliste (Konzept Wiedervorlage w1)', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/#/portfolio/energiemanagement/wiedervorlage');
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'energiemanagementWiedervorlage').mockResolvedValue(wvR12());
    vi.spyOn(api, 'energiemanagementWiedervorlageZuletzt').mockResolvedValue(zuletztDemo());
  });
  afterEach(() => {
    // Erst abbauen, dann die Rechte zurücksetzen; sonst rendert die Seite noch einmal außerhalb von `act`.
    cleanup();
    setSelbstauskunft(null);
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
  });

  it('R12: Kopf mit Stand, Marken, Überfällig vor den nächsten 30 Tagen, Jahresplan zu, Fuß mit Herkunft und beiden Sätzen', async () => {
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Wiedervorlage');
    expect(screen.getByTestId('wiedervorlage-kopf').textContent).toBe(
      'Alle Fristen Ihres Energiemanagements, das am längsten Überfällige zuerst. Stand 12.02.2029.',
    );
    const marken = screen.getByTestId('wiedervorlage-marken');
    expect([...marken.children].map((m) => m.textContent)).toEqual(['8 überfällig', '1 in den nächsten 30 Tagen', 'Jahresplan']);
    expect(screen.getByRole('heading', { name: 'Überfällig · 8' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'In den nächsten 30 Tagen · 1' })).toBeTruthy();
    const ueber = within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem');
    expect(ueber).toHaveLength(8);
    expect(ueber[0].textContent).toContain('Bezugsbasis BB-0002 überprüfen');
    expect(ueber[0].textContent).toContain('Grundlage für „Stromeinsatz Montage je Stück“ · Fassung 2 vom 13.11.2026 +\u00a012\u00a0Monate');
    expect(ueber[0].textContent).toContain('Auswerten');
    expect(ueber[0].textContent).toContain('Ines Kaltenbach');
    expect(ueber[0].textContent).toContain('Bestätigen oder neu fassen');
    // Datum statt Tageszähler.
    expect(within(ueber[0]).getByRole('img', { name: 'fällig seit 13.11.2027' })).toBeTruthy();
    expect(screen.getByTestId('wiedervorlage').textContent).not.toMatch(/seit \d+ Tagen/);
    const bald = within(screen.getByTestId('wiedervorlage-bald')).getAllByRole('listitem');
    expect(bald[0].textContent).toContain('Maßnahme M-2029-0001 · aus der Feststellung F-2029-0001 · in 16 Tagen');
    expect(bald[0].textContent).toContain('Jonas Wendlinger');
    // Bei Überfälligem bleibt der Jahresplan zu; er sagt, was in ihm steht.
    const plan = screen.getByTestId('wiedervorlage-jahresplan');
    expect(within(plan).getByRole('heading', { level: 2 }).textContent).toBe('Jahresplan');
    expect(plan.textContent).toContain('bis 12.02.2030');
    expect(screen.getByTestId('wiedervorlage-jahresplan-anzeigen').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('wiedervorlage-jahresplan-anzeigen').textContent).toBe(
      'Jahresplan anzeigenAlle Fristen nach den nächsten 30 Tagen, nach Monaten',
    );
    const fuss = screen.getByTestId('wiedervorlage-fuss');
    expect(fuss.textContent).toContain(`Woher kommen diese Fristen? ${WOHER_SATZ}`);
    expect(fuss.textContent).toContain(UEMS_VERANTWORTUNG);
    expect(fuss.textContent).toContain(UEMS_NORMGRENZE);
  });

  it('Zuständig: am Objekt „verantwortlich“, sonst „laut Aufgabe“ mit ihrem Wort; ohne beide „Niemand zuständig“ mit dem Weg dorthin', async () => {
    const springe = vi.fn();
    render(<EnergiemanagementWiedervorlage springe={springe} />);
    await ladeAus();
    const bb2 = screen.getByTestId('wiedervorlage-eintrag-BB-0002');
    expect(bb2.querySelector('.vp-wv-wer')!.textContent).toBe('Ines Kaltenbachverantwortlich');
    const d1 = screen.getByTestId('wiedervorlage-eintrag-D-0001');
    expect(d1.querySelector('.vp-wv-wer-kurz')!.textContent).toBe('· laut Aufgabe');
    expect(d1.querySelector('.vp-wv-wer-lang')!.textContent).toBe('laut Aufgabe „Dokumente des Energiemanagements pflegen“');
    const bericht = screen.getByTestId('wiedervorlage-eintrag-BR-2028-0001');
    expect(bericht.querySelector('.vp-wv-wer')!.textContent).toBe('Niemand zuständigAufgabe festlegen ›');
    const festlegen = within(bericht).getByRole('link', { name: 'Aufgabe festlegen' });
    expect(festlegen.getAttribute('href')).toBe('#/portfolio/energiemanagement/aufgaben?entscheid=aufgabe_festlegen&kennzeichen=energiemanagement_leiten');
    fireEvent.click(festlegen);
    expect(springe).toHaveBeenLastCalledWith(expect.objectContaining({ hash: festlegen.getAttribute('href') }));
  });

  it('die ganze Karte ist das Tippziel: der Link der Aufgabe mit Entscheid, der über die Schale springt', async () => {
    const springe = vi.fn();
    render(<EnergiemanagementWiedervorlage springe={springe} />);
    await ladeAus();
    const karte = screen.getByTestId('wiedervorlage-eintrag-D-0001');
    const link = within(karte).getByRole('link', { name: 'Energiepolitik überprüfen: Bestätigen oder neu fassen' });
    expect(link.getAttribute('href')).toMatch(/^#\/portfolio\/energiemanagement\/dokumente\/.+\?entscheid=dokument_ueberpruefung$/);
    // Ein zweiter Link in der Karte nur dort, wo niemand zuständig ist.
    expect(within(karte).getAllByRole('link')).toHaveLength(1);
    fireEvent.click(link);
    expect(springe).toHaveBeenCalledWith(expect.objectContaining({ hash: link.getAttribute('href') }));
  });

  it('Filter: Meine, Ohne Zuständige, je Bereich, und die Art aus der Übersicht als aufhebbarer Filter', async () => {
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
    fireEvent.click(screen.getByTestId('wiedervorlage-filter-meine'));
    expect(screen.getByRole('heading', { name: 'Überfällig · 6' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('wiedervorlage-filter-ohne'));
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem').map((li) => li.firstElementChild!.getAttribute('data-testid'))).toEqual([
      'wiedervorlage-eintrag-BR-2028-0001',
      'wiedervorlage-eintrag-BR-2027-0001',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }));
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(8);
  });

  it('der Jahresplan klappt auf: nach Monaten, gestrichelt, mit „Öffnen“ statt eines Entscheids; die Marke springt hin', async () => {
    const springe = vi.fn();
    render(<EnergiemanagementWiedervorlage springe={springe} />);
    await ladeAus();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wiedervorlage-marke-jahresplan'));
    });
    const plan = screen.getByTestId('wiedervorlage-jahresplan');
    expect(within(plan).getByRole('heading', { level: 2 }).textContent).toBe('Jahresplan · 6');
    expect(within(plan).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['April 2029', 'Juni 2029', 'November 2029', 'Januar 2030']);
    const audit = screen.getByTestId('wiedervorlage-eintrag-AU-2029-0001');
    expect(within(audit).getByRole('img', { name: 'fällig bis 22.01.2030' }).className).toBe('vp-fd is-plan');
    expect(audit.textContent).toContain('Zuletzt AU-2029-0001 am 22.01.2029 · alle 12\u00a0Monate');
    const link = within(audit).getByRole('link', { name: 'Internes Audit durchführen: Öffnen' });
    expect(link.getAttribute('href')).toBe('#/portfolio/energiemanagement/audits');
    fireEvent.click(screen.getByTestId('wiedervorlage-jahresplan-zuklappen'));
    expect(screen.getByTestId('wiedervorlage-jahresplan-anzeigen')).toBeTruthy();
  });

  it('„Öffnen“ im Jahresplan nimmt nur den Entscheid aus dem Sprung: das Register bleibt auf den Ort der Runde gefiltert', async () => {
    const w = wvNormal();
    w.spaeter = [ableseRunde('G-1', 'Halle 1', 8, ABLESUNG.halle1, -90, '2029-07-29'), ...w.spaeter];
    w.anzahl_spaeter = w.spaeter.length;
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(w);
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    const runde = screen.getByTestId('wiedervorlage-eintrag-G-1');
    const link = within(runde).getByRole('link', { name: '8 Zähler in Halle 1 ablesen: Öffnen' });
    expect(link.getAttribute('href')).toBe('#/portfolio/messstellen?ort=G-1');
  });

  it('Demo heute: der Bericht mit zehn Korrekturen ist ein Eintrag; Zuletzt erledigt kommt vom Server, mit „geprüft, bleibt“', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvDemo());
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(within(screen.getByTestId('wiedervorlage-ueberfaellig')).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByTestId('wiedervorlage-eintrag-BR-2026-0001').textContent).toContain('10 Korrekturen nach der Freigabe, zuerst K-2026-0014');
    // Entscheid 7: eine Ablese-Runde je Ort; der Schritt führt ins Register des Orts, bei einem Zähler zu ihm.
    expect(screen.getByTestId('wiedervorlage-eintrag-G-1').textContent).toContain('8 Zähler in Halle 1 ablesen');
    expect(screen.getByTestId('wiedervorlage-ziel-G-1').getAttribute('aria-label')).toBe('8 Zähler in Halle 1 ablesen: Ablesungen eintragen');
    expect(screen.getByTestId('wiedervorlage-ziel-G-1').getAttribute('href')).toBe('#/portfolio/messstellen?ablesen=G-1&entscheid=zaehlerablesung');
    expect(screen.getByTestId('wiedervorlage-ziel-G-3').getAttribute('aria-label')).toBe('Zähler MS-22 in Verwaltung ablesen: Ablesung eintragen');
    expect(screen.getByTestId('wiedervorlage-nichts-bald').textContent).toBe('Bis 30.05.2029 ist nichts fällig. Die nächste Frist ist am 30.06.2029.');
    const zuletzt = within(screen.getByTestId('wiedervorlage-zuletzt')).getAllByRole('listitem');
    expect(zuletzt.map((z) => z.textContent)).toEqual([
      expect.stringContaining('Energetische Bewertung BR-2029-0002: Stand Nr. 1 freigegeben'),
      expect.stringContaining('Bezugsbasis BB-0001: geprüft, bleibt'),
      expect.stringContaining('Feststellung F-2029-0001: Wirksamkeit festgehalten'),
      expect.stringContaining('Energiepolitik: Fassung 2 freigegeben'),
      expect.stringContaining('Anwendungsbereich: geprüft, bleibt'),
    ]);
  });

  it('Normalfall: „Keine Frist überfällig“, das nächste Datum statt einer Null, der Jahresplan offen', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvNormal());
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect([...screen.getByTestId('wiedervorlage-marken').children].map((m) => m.textContent)).toEqual(['Keine Frist überfällig', '11 im Jahresplan']);
    expect(screen.queryByTestId('wiedervorlage-ueberfaellig')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-nichts-bald').textContent).toBe('Bis 30.05.2029 ist nichts fällig. Die nächste Frist ist am 30.06.2029.');
    const plan = screen.getByTestId('wiedervorlage-jahresplan');
    expect(within(plan).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Juni 2029',
      'November und Dezember 2029',
      'Januar bis April 2030',
    ]);
    expect(within(plan).getAllByRole('listitem')).toHaveLength(11);
    expect(screen.getByTestId('wiedervorlage').textContent).not.toMatch(/\b0 (überfällig|in den nächsten)/);
  });

  it('noch keine Fristen: der Satz sagt, woher sie kommen; ohne Erledigtes kein leerer Block', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvLeer());
    vi.mocked(api.energiemanagementWiedervorlageZuletzt).mockResolvedValue(zuletztLeer());
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-leer').textContent).toBe(NOCH_KEINE_FRISTEN);
    expect(screen.queryByTestId('wiedervorlage-zuletzt')).toBeNull();
  });

  it('ein gescheitertes Laden ist nie „nichts fällig“ und lässt sich wiederholen; Zuletzt erledigt scheitert für sich', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockRejectedValueOnce(new Error('503'));
    vi.mocked(api.energiemanagementWiedervorlageZuletzt).mockRejectedValueOnce(new Error('503'));
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-fehler').textContent).toContain(LADEFEHLER);
    expect(screen.queryByTestId('wiedervorlage-leer')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-zuletzt').textContent).toContain(ZULETZT_FEHLER);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    });
    expect(screen.queryByTestId('wiedervorlage-fehler')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-ueberfaellig')).toBeTruthy();
    expect(screen.getByTestId('wiedervorlage-zuletzt').textContent).not.toContain(ZULETZT_FEHLER);
  });

  it('Einsicht: alle Fristen lesen, der Schritt öffnet nur zum Ansehen, keine Aufgabe festlegen', async () => {
    setSelbstauskunft(rechteSeed('RF').me);
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage-einsicht').textContent).toBe(NUR_EINSICHT);
    const karte = screen.getByTestId('wiedervorlage-eintrag-D-0001');
    expect(within(karte).getByRole('link').getAttribute('href')).not.toContain('entscheid=');
    expect(karte.textContent).toContain('Ansehen');
    expect(screen.queryByTestId('wiedervorlage-festlegen-BR-2028-0001')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-eintrag-BR-2028-0001').textContent).toContain('Niemand zuständig');
  });

  it('wer die Aufgaben nicht liest, liest kein „Niemand zuständig“: ohne Person am Objekt steht dort nichts', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue({ ...wvR12(), aufgaben_lesbar: false });
    render(<EnergiemanagementWiedervorlage />);
    await ladeAus();
    expect(screen.getByTestId('wiedervorlage').textContent).not.toContain('Niemand zuständig');
    expect(screen.getByTestId('wiedervorlage-eintrag-BR-2028-0001').querySelector('.vp-wv-wer')).toBeNull();
    expect(screen.queryByTestId('wiedervorlage-filter-ohne')).toBeNull();
    expect(screen.getByTestId('wiedervorlage-eintrag-BB-0002').textContent).toContain('Ines Kaltenbach');
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

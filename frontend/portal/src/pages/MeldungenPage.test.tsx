import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MeldungenPage } from './MeldungenPage';
import { meldungenApi } from '../meldungen';
import { benachrichtigungenApi } from '../benachrichtigungenApi';
import { ueberwachungApi } from '../ueberwachungApi';
import { api } from '../api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MeldungenPage · Ladefehler', () => {
  it('zeigt einen Fehlerzustand mit „Erneut versuchen“ - nicht zugleich „Wird geladen …“', async () => {
    window.location.hash = '#/meldungen';
    const jetzt = vi.spyOn(meldungenApi, 'jetzt').mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([]);
    render(<MeldungenPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Meldungen konnten nicht geladen werden.');
    expect(screen.queryByText('Wird geladen …')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    await waitFor(() => expect(jetzt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('MeldungenPage · Text der Meldung (Kunden-Alarmierung P1)', () => {
  const box = (id: string, kennzeichen: string, ort: string) => ({
    id,
    kennzeichen,
    wertart: 'box.erreichbar',
    schwere: 'warnung' as const,
    anlageId: null,
    anlageName: ort,
    standortId: null,
    ausgeloestAm: '2026-11-13T11:33:00Z',
    zustand: 'aktiv' as const,
    wiederNormalAm: null,
    gesehenVon: null,
    gesehenAm: null,
    erledigtAm: null,
    bezugKennung: null,
    text: {
      wertart: 'box.erreichbar',
      herkunft: 'ab_werk',
      regelName: 'Box erreichbar',
      schwere: 'warnung',
      bezugArt: 'anlage',
      ort,
      bedingung: { art: 'zustand', ziel: ['nicht_erreichbar'], dauer_s: 900, erholen_s: 300 },
      wert: { zahl: null, einheit: null, zustand: 'nicht_erreichbar', satz: null },
      beginn: '2026-11-13T11:18:00Z',
      ende: null,
    },
  });

  it('zeigt Titel als Aussage und die Sätze - keinen Schlüssel, keinen Rohwert', async () => {
    window.location.hash = '#/meldungen';
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([box('a1', 'AL-2026-000002', 'Hof Lindenberg')]);
    render(<MeldungenPage />);
    // P3: die Karte nennt den Titel als Aussage und die Anlage in einer eigenen Zeile.
    expect(await screen.findByTestId('meldung-titel')).toHaveTextContent('Box meldet sich nicht');
    expect(screen.getByText('Hof Lindenberg')).toBeInTheDocument();
    const text = screen.getByTestId('meldung-text');
    expect(text).toHaveTextContent('Meist ist das Internet oder der Strom an der Box unterbrochen.');
    expect(text.textContent).not.toMatch(/nicht_erreichbar|box\.erreichbar|\d{4}-\d{2}-\d{2}T/);
  });

  it('?meldung= hebt die gemeinte Meldung hervor und stellt sie nach vorn', async () => {
    window.location.hash = '#/meldungen?meldung=AL-2026-000009';
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([
      box('a1', 'AL-2026-000002', 'Hof Lindenberg'),
      box('a2', 'AL-2026-000009', 'Werk Lindach'),
    ]);
    render(<MeldungenPage />);
    const gemeint = await screen.findByTestId('meldung-gemeint');
    expect(gemeint).toHaveTextContent('Box meldet sich nicht');
    expect(gemeint).toHaveTextContent('Werk Lindach');
    expect(screen.getAllByTestId('meldung-titel')[0].closest('li')).toBe(gemeint);
  });

  it('?meldung= sucht eine nicht mehr offene Meldung im Verlauf', async () => {
    window.location.hash = '#/meldungen?meldung=a7';
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([]);
    const verlauf = vi.spyOn(meldungenApi, 'verlauf').mockResolvedValue([
      { ...box('a7', 'AL-2026-000007', 'Hof Lindenberg'), zustand: 'erledigt', wiederNormalAm: '2026-11-13T12:05:00Z',
        erledigtAm: '2026-11-13T12:05:00Z',
        text: { ...box('a7', '', 'Hof Lindenberg').text, ende: '2026-11-13T12:00:00Z' } },
    ]);
    render(<MeldungenPage />);
    await waitFor(() => expect(verlauf).toHaveBeenCalled());
    expect(await screen.findByTestId('meldung-entwarnung')).toHaveTextContent(
      'Die Unterbrechung dauerte 42 Minuten.',
    );
  });
});

describe('MeldungenPage · ein Ort (Kunden-Alarmierung P3)', () => {
  const meldung = (id: string, schwere: 'hinweis' | 'warnung' | 'dringend', extra: Record<string, unknown> = {}) => ({
    id,
    kennzeichen: `AL-2026-00000${id.length}`,
    wertart: schwere === 'hinweis' ? 'anlage.preis.jetzt' : 'box.erreichbar',
    schwere,
    anlageId: 'anl-1',
    anlageName: 'Zuhause',
    standortId: null,
    ausgeloestAm: '2026-11-13T11:18:00Z',
    zustand: 'aktiv' as const,
    wiederNormalAm: null,
    gesehenVon: null,
    gesehenAm: null,
    erledigtAm: null,
    bezugKennung: 'anlage:anl-1',
    ueberwachungId: `regel-${id}`,
    text: null,
    ...extra,
  });

  function ohneWeg() {
    vi.spyOn(benachrichtigungenApi, 'emailZustand').mockResolvedValue({
      ziel: 'sommer@voltpilot.local', bestaetigt: true, aktiv: true, abSchwere: 'warnung',
      zusammenfassungAktiv: false, zusammenfassungUhrzeit: '07:00:00',
    });
    vi.spyOn(benachrichtigungenApi, 'pushAbos').mockResolvedValue([]);
  }

  it('Hinweise stehen unter „Leise“, nicht als Karte; Öffnen gilt als gesehen, ohne Knopf „Gesehen“', async () => {
    window.location.hash = '#/meldungen';
    ohneWeg();
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([meldung('w1', 'warnung'), meldung('h1', 'hinweis')]);
    const gesehen = vi.spyOn(meldungenApi, 'gesehen').mockImplementation(async (id: string) => ({
      ...meldung(id, id === 'h1' ? 'hinweis' : 'warnung'), gesehenVon: 'Sommer', gesehenAm: '2026-11-13T11:20:00Z',
    }));
    render(<MeldungenPage />);
    expect(await screen.findAllByTestId('meldung-karte')).toHaveLength(1);
    expect(screen.getByTestId('meldungen-leise')).toHaveTextContent('Leise');
    await waitFor(() => expect(gesehen).toHaveBeenCalledWith('w1'));
    expect(screen.queryByRole('button', { name: 'Gesehen' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Zur Anlage' })).toHaveAttribute('href', '#/anlage/anl-1');
  });

  it('„Alles ruhig“ zeigt ohne Push-Gerät die E-Mail-Zeile und „Push … einschalten“', async () => {
    window.location.hash = '#/meldungen';
    ohneWeg();
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([]);
    render(<MeldungenPage />);
    expect(await screen.findByText('Alles ruhig')).toBeInTheDocument();
    expect(await screen.findByTestId('erste-einrichtung-email')).toHaveTextContent('E-Mail an sommer@voltpilot.local');
  });

  it('mit Push-Gerät steht keine Einrichtung unter „Alles ruhig“', async () => {
    window.location.hash = '#/meldungen';
    vi.spyOn(benachrichtigungenApi, 'emailZustand').mockResolvedValue(undefined);
    vi.spyOn(benachrichtigungenApi, 'pushAbos').mockResolvedValue([
      { id: 'p1', geraet: 'iPhone', aktiv: true, abSchwere: 'warnung', erstelltAm: null, endpoint: null },
    ]);
    const jetzt = vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([]);
    render(<MeldungenPage />);
    expect(await screen.findByText('Alles ruhig')).toBeInTheDocument();
    await waitFor(() => expect(jetzt).toHaveBeenCalled());
    expect(screen.queryByTestId('erste-einrichtung')).toBeNull();
  });

  it('der Verlauf nennt Ende und Dauer statt „seit“', async () => {
    window.location.hash = '#/meldungen?reiter=verlauf';
    ohneWeg();
    vi.spyOn(meldungenApi, 'verlauf').mockResolvedValue([
      meldung('v1', 'warnung', { zustand: 'erledigt', erledigtAm: '2026-11-13T12:00:00Z' }),
    ]);
    render(<MeldungenPage />);
    expect(await screen.findByTestId('meldung-dauer')).toHaveTextContent('42 Min.');
  });

  it('„Einstellen“ zeigt „Das melden wir“ als Schalter; ein Tipp zeigt Wartezeit und Empfänger; Schalten ruft die Route', async () => {
    window.location.hash = '#/meldungen?reiter=einstellen';
    ohneWeg();
    vi.spyOn(benachrichtigungenApi, 'webhookZiele').mockResolvedValue([]);
    vi.spyOn(benachrichtigungenApi, 'telegramStatus').mockResolvedValue({ verfuegbar: false, ziele: [] });
    vi.spyOn(benachrichtigungenApi, 'ruhezeit').mockResolvedValue({
      regeln: '{"werktags":{"von":"22:00","bis":"07:00"},"wochenende":{"von":"22:00","bis":"07:00"}}',
      zeitzone: 'Europe/Berlin', dringendDurch: true, vorgabe: true,
    });
    vi.spyOn(benachrichtigungenApi, 'emailZustand').mockResolvedValue({
      ziel: 'sommer@voltpilot.local', bestaetigt: true, aktiv: true, abSchwere: 'warnung', herkunft: 'anmeldung',
      zusammenfassungAktiv: false, zusammenfassungUhrzeit: '07:00:00',
    });
    vi.spyOn(benachrichtigungenApi, 'ruhezeitProbe').mockResolvedValue(null);
    vi.spyOn(api, 'listSites').mockResolvedValue({ eintraege: [{ id: 'anl-1', name: 'Zuhause' }], teilansicht: { sichtbar: 1 } } as never);
    const box = {
      id: 'r1', name: null, wertart: 'box.erreichbar', schwere: 'warnung' as const, herkunft: 'ab_werk', aktiv: true,
      probelaufBis: null, bezugJson: '{"anlage":"anl-1"}', standortId: null,
      bedingung: { art: 'zustand', ziel: ['nicht_erreichbar'], dauer_s: 900 },
      empfaenger: [{ person: null, rolle: 'kundenadministrator', name: null }], fassung: 1,
    };
    vi.spyOn(meldungenApi, 'regeln').mockResolvedValue([box]);
    const schalten = vi.spyOn(ueberwachungApi, 'schalten').mockResolvedValue({ ...box, aktiv: false });
    render(<MeldungenPage />);
    const zeile = await screen.findByTestId('melden-wir-zeile');
    expect(zeile).toHaveTextContent('Box meldet sich nicht');
    expect(zeile).toHaveTextContent('nach 15 Minuten');
    fireEvent.click(screen.getByRole('button', { name: /Box meldet sich nicht/ }));
    expect(screen.getByTestId('melden-wir-details')).toHaveTextContent('an Kundenadministratoren');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Box meldet sich nicht' }));
    await waitFor(() => expect(schalten).toHaveBeenCalledWith('r1', false));
    const wege = await screen.findByTestId('so-erreichen-wir-sie');
    // P2: die Anmelde-Adresse ist ab Werk der E-Mail-Weg, die Ruhezeit ist die Vorgabe der Kundenart.
    expect(wege).toHaveTextContent('Ihre Anmelde-Adresse - ab Werk eingeschaltet');
    expect(wege).toHaveTextContent('Vorgabe - gilt, bis Sie etwas ändern');
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type MessstelleRegisterZeile, type MessstelleWerte, type MessstelleWerteRaster } from '../api';
import { UEMS_WOCHE_OHNE_ZAHL } from '../glossar';
import {
  f13Stunden,
  f13Tag,
  f13Viertelstunden,
  f16Monat,
  f16Tage,
  grundlastWoche,
  jahr2026,
  ohneQuelleStunden,
  ohneQuelleTag,
  ohneQuelleViertelstunden,
} from '../test/werteKarteFixtures';
import { MESSSTELLE_GIBT_ES_NICHT, VERLAUF_NICHT_ABRUFBAR, WERTE_NICHT_ABRUFBAR } from '../uemsOberflaechen';
import { WerteSektion } from './WerteSektion';

/**
 * Die Zeit-Leiste der Werte mit dem Verlauf (UEMS AP-13 IP-4, E5 = A): vier Zeiträume im Raster der Route, der Zeitraum
 * bleibt beim Umschalten, im Monat und im Jahr antwortet der Verlauf aus der Liste (keine dritte Anfrage), die Woche hat
 * keine Karte. Gelesen am 10.11.2026 an MS-06 (Ahrenberg: F13, F16, Grundlast 28,8 kW, Einführung 01.10.2026).
 */

const HEUTE = '2026-11-10';
const WARTEN = { timeout: 3000 };

const antwortFuer = (raster: MessstelleWerteRaster, von: string, bis: string): MessstelleWerte => {
  if (von === '2026-10-25' && bis === '2026-10-25') return raster === 'tag' ? f13Tag() : raster === 'stunde' ? f13Stunden() : f13Viertelstunden();
  if (von === '2026-10-19' && bis === '2026-10-25') {
    const w = grundlastWoche('2026-10-19', HEUTE);
    return raster === 'tag' ? w.tage : w.stunden;
  }
  if (von === '2026-10-01' && bis === '2026-10-31') return raster === 'monat' ? f16Monat() : f16Tage();
  if (von === '2026-01-01' && bis === '2026-12-31') {
    const j = jahr2026(HEUTE);
    return raster === 'jahr' ? j.karte : j.monate;
  }
  throw new Error(`nicht gestellt: ${raster} ${von} ${bis}`);
};

const verdrahte = (ohneVerlauf = false) =>
  vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, von, bis) => {
    if (ohneVerlauf && raster === 'viertelstunde') throw new Error('Netz');
    return antwortFuer(raster, von, bis);
  });

const zeige = (onZeitraum = vi.fn()) =>
  render(
    <WerteSektion
      kennzeichen="MS-06"
      messstelle="MS-06 · Spritzguss SG01–SG06"
      anfang={{ art: 'tag', wert: '2026-10-25' }}
      heute={HEUTE}
      onZeitraum={onZeitraum}
    />,
  );

const schritteImBild = () => screen.getAllByTestId('verlauf-schritt').length;

afterEach(() => vi.restoreAllMocks());

describe('WerteSektion · Verlauf in vier Zeiträumen (UEMS AP-13 IP-4)', () => {
  it('Tag → Woche → Monat → Jahr → Tag: das Raster der Route, der Zeitraum bleibt, nichts summiert', async () => {
    const werte = verdrahte();
    const onZeitraum = vi.fn();
    zeige(onZeitraum);

    // Tag 25.10.2026: Karte, 25 Stunden in der Liste, 100 Viertelstunden im Verlauf.
    await waitFor(() => expect(schritteImBild()).toBe(100), WARTEN);
    expect(werte).toHaveBeenCalledWith('MS-06', 'tag', '2026-10-25', '2026-10-25');
    expect(werte).toHaveBeenCalledWith('MS-06', 'stunde', '2026-10-25', '2026-10-25');
    expect(werte).toHaveBeenCalledWith('MS-06', 'viertelstunde', '2026-10-25', '2026-10-25');
    expect(screen.getAllByTestId('werte-zeile')).toHaveLength(25);
    expect(screen.getByTestId('verlauf')).toHaveTextContent('So 25.10.2026: 720 kWh · vollständig · endgültig');

    // Woche 43: keine Karte, und der Kopf sagt warum; 169 Stunden, 7 Tage.
    fireEvent.click(screen.getByRole('tab', { name: 'Woche' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026-W43');
    await waitFor(() => expect(schritteImBild()).toBe(169), WARTEN);
    expect(werte).toHaveBeenCalledWith('MS-06', 'tag', '2026-10-19', '2026-10-25');
    expect(werte).toHaveBeenCalledWith('MS-06', 'stunde', '2026-10-19', '2026-10-25');
    expect(screen.queryByTestId('werte-karte')).toBeNull();
    expect(screen.getByTestId('verlauf')).toHaveTextContent(UEMS_WOCHE_OHNE_ZAHL);
    expect(screen.getAllByTestId('werte-zeile')).toHaveLength(7);
    expect(screen.getByRole('heading', { name: 'Tage' })).toBeInTheDocument();

    // Oktober 2026: der Verlauf ist die Liste — zwei Anfragen, keine dritte.
    werte.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Monat' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026-10');
    await waitFor(() => expect(schritteImBild()).toBe(31), WARTEN);
    expect(werte.mock.calls.map((c) => c[1])).toEqual(['monat', 'tag']);
    expect(screen.getByTestId('werte-karte')).toHaveTextContent('Oktober 2026');
    expect(screen.getByTestId('verlauf')).toHaveTextContent('Oktober 2026: 55.100 kWh · vollständig · vorläufig');

    // 2026: bis September „keine Werte“ als Fläche mit Satz, die Monate in der Liste, weiter geht es nicht.
    werte.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Jahr' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026');
    await waitFor(() => expect(schritteImBild()).toBe(12), WARTEN);
    expect(werte.mock.calls.map((c) => c[1])).toEqual(['jahr', 'monat']);
    expect(screen.getByTestId('werte-jahr')).toHaveTextContent('2026');
    expect(screen.getByRole('button', { name: 'Nächster Zeitraum' })).toBeDisabled();
    expect(screen.getAllByTestId('verlauf-luecke')).toHaveLength(1);
    expect(screen.getAllByTestId('verlauf-ereignis').map((e) => e.textContent)).toEqual(['1keine Werte von Januar 2026 bis September 2026']);
    expect(within(screen.getByRole('region', { name: 'Monate' })).getAllByTestId('werte-zeile')[9]).toHaveTextContent('Oktober 2026');

    // Zurück zum Tag: derselbe 25.10., nicht der 01.01.
    fireEvent.click(screen.getByRole('tab', { name: 'Tag' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026-10-25');
    await waitFor(() => expect(schritteImBild()).toBe(100), WARTEN);
  });

  it('scheitert nur der Verlauf, bleiben Karte und Liste stehen — mit einem eigenen Weg, es noch einmal zu versuchen', async () => {
    verdrahte(true);
    zeige();
    expect(await screen.findByText(VERLAUF_NICHT_ABRUFBAR, undefined, WARTEN)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
    expect(screen.getByTestId('werte-karte')).toHaveTextContent(/720\skWh/);
    expect(screen.getAllByTestId('werte-zeile')).toHaveLength(25);
    expect(screen.queryByText(WERTE_NICHT_ABRUFBAR)).toBeNull();
  });
});

describe('WerteSektion · warum eine Zahl fehlt: Auskunft statt Fehlermeldung, Leerzustand ohne Datenquelle (UEMS AP-13 IP-6)', () => {
  const OHNE_DATENQUELLE: MessstelleRegisterZeile['quelle'] = { stand: 'keine_datenquelle', fuehrend: null, davor: null, vergleichsquellen: 0 };
  const KEINE_QUELLE_MS21 =
    'Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.';

  const ms21 = (props: { onQuelleZuordnen?: () => void } = {}) => {
    const werte = vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster) =>
      raster === 'tag' ? ohneQuelleTag() : raster === 'stunde' ? ohneQuelleStunden() : ohneQuelleViertelstunden(),
    );
    render(
      <WerteSektion
        kennzeichen="MS-21"
        messstelle="MS-21 · Gas Heizung Verwaltung"
        anfang={{ art: 'tag', wert: '2026-11-03' }}
        heute="2026-11-04"
        quelle={OHNE_DATENQUELLE}
        {...props}
      />,
    );
    return werte;
  };

  const abgelehnt = (status: number, body: unknown) => {
    vi.spyOn(api, 'messstelleWerte').mockRejectedValue(new ApiError(status, 'vom Server', body));
    zeige();
  };

  it('Z4 · MS-21 ohne Datenquelle: statt 24 Strichen der Leerzustand — Titel, Satz des Grundes, „Quelle zuordnen“ mit Recht', async () => {
    const onQuelleZuordnen = vi.fn();
    ms21({ onQuelleZuordnen });
    const leer = await screen.findByTestId('werte-leer', undefined, WARTEN);
    expect(within(leer).getByRole('heading', { name: 'Keine Datenquelle' })).toBeInTheDocument();
    expect(leer).toHaveTextContent(KEINE_QUELLE_MS21);
    // Kein Strich-Bild: weder Karte noch Liste noch Verlauf — der Leerzustand IST die Auskunft.
    expect(screen.queryByTestId('werte-karte')).toBeNull();
    expect(screen.queryAllByTestId('werte-zeile')).toHaveLength(0);
    expect(screen.queryByTestId('verlauf')).toBeNull();
    // Die Zeit-Leiste bleibt: ein anderer Zeitraum kann eine Quelle haben.
    expect(screen.getByRole('button', { name: 'Vorheriger Zeitraum' })).toBeInTheDocument();
    fireEvent.click(within(leer).getByRole('button', { name: 'Quelle zuordnen' }));
    expect(onQuelleZuordnen).toHaveBeenCalledTimes(1);
    // „Ablesung eintragen“ (Z4) hat weder Route noch Fläche — kein Knopf ins Leere.
    expect(within(leer).queryByRole('button', { name: /Ablesung/ })).toBeNull();
  });

  it('Z4 · ohne das Recht: kein Knopf — der Satz sagt, wer eine Datenquelle zuordnen kann', async () => {
    ms21();
    const leer = await screen.findByTestId('werte-leer', undefined, WARTEN);
    expect(within(leer).queryAllByRole('button')).toHaveLength(0);
    expect(within(leer).getByTestId('werte-leer-weg')).toHaveTextContent('Eine Datenquelle ordnet zu, wer diese Messstelle bearbeiten darf.');
  });

  it('Z2 · 400: der Satz des Grundes (§5.8) — ohne „Erneut versuchen“, die Zeit-Leiste bleibt der Weg', async () => {
    abgelehnt(400, { code: 'anfrage_ungueltig', message: 'Der Zeitpunkt liegt nicht auf dem Raster.', feld: 'von', grund: 'nicht_im_raster' });
    const a = await screen.findByTestId('werte-auskunft', undefined, WARTEN);
    expect(a).toHaveTextContent('Der Zeitraum konnte nicht gelesen werden (Beginn liegt nicht auf einer Tagesgrenze). Wählen Sie einen anderen Zeitraum.');
    expect(a).toHaveAttribute('data-art', 'abgelehnt');
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    expect(screen.queryByText(/konnte nicht geladen werden/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Vorheriger Zeitraum' })).toBeInTheDocument();
  });

  it('Z3 · 404: „Diese Messstelle gibt es nicht.“ — auch für eine fremde, nie 403 und nie „konnte nicht geladen werden“', async () => {
    abgelehnt(404, { status: 404, error: 'Not Found', message: 'Messstelle nicht gefunden.' });
    const a = await screen.findByTestId('werte-auskunft', undefined, WARTEN);
    expect(a).toHaveTextContent(MESSSTELLE_GIBT_ES_NICHT);
    expect(a).toHaveAttribute('data-art', 'gibt_es_nicht');
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
  });

  it('O19 · 404 `wert_nicht_mehr_gespeichert`: der Satz der Route — KEIN Sprung zum Berichtsstand, bis AP-12 IP-16 ihn als Feld liefert', async () => {
    const satz = 'Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. 1 vom 10.11.2026 hält ihn fest.';
    abgelehnt(404, { code: 'wert_nicht_mehr_gespeichert', message: satz });
    const a = await screen.findByTestId('werte-auskunft', undefined, WARTEN);
    expect(a).toHaveTextContent(satz);
    expect(a).toHaveAttribute('data-art', 'nicht_mehr_gespeichert');
    // Heute sendet die Route den Code nicht; ihr Körper nennt den Berichtsstand nur im Satz — ein Sprung ginge ins Leere.
    expect(within(a).queryAllByRole('link')).toHaveLength(0);
    expect(within(a).queryAllByRole('button')).toHaveLength(0);
  });

  it('eine ungültige Version der Adresse: der Satz und „Neueste zeigen“, das ohne Version fragt', async () => {
    const werte = vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, von, bis, version) => {
      if (version != null) throw new ApiError(400, 'vom Server', { code: 'anfrage_ungueltig', feld: 'version', grund: 'version_ungueltig' });
      return antwortFuer(raster, von, bis);
    });
    render(<WerteSektion kennzeichen="MS-06" messstelle="MS-06 · Spritzguss SG01–SG06" anfang={{ art: 'tag', wert: '2026-10-25' }} version={7} heute={HEUTE} />);
    const a = await screen.findByTestId('werte-auskunft', undefined, WARTEN);
    expect(a).toHaveTextContent('Die Version in der Adresse konnte nicht gelesen werden (erlaubt sind ganze Zahlen ab 1).');
    fireEvent.click(within(a).getByRole('button', { name: 'Neueste zeigen' }));
    expect(await screen.findByTestId('werte-karte', undefined, WARTEN)).toHaveTextContent(/720\skWh/);
    expect(werte).toHaveBeenLastCalledWith('MS-06', expect.any(String), expect.any(String), expect.any(String));
  });

  it('Z5 · eine Route, die nicht antwortet, ist eine Störung: „Die Werte sind gerade nicht abrufbar.“ und „Erneut versuchen“ fragt noch einmal', async () => {
    let versuche = 0;
    vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, von, bis) => {
      if (raster === 'tag' && versuche++ === 0) throw new ApiError(503, 'Der Server ist zurzeit nicht erreichbar. Bitte versuchen Sie es erneut.');
      return antwortFuer(raster, von, bis);
    });
    zeige();
    expect(await screen.findByText(WERTE_NICHT_ABRUFBAR, undefined, WARTEN)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByTestId('werte-karte', undefined, WARTEN)).toHaveTextContent(/720\skWh/);
  });
});

import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Ablesung, type Messstelle, type MessstelleVerteilung, type MessstelleWerte, type Protokoll } from '../api';
import { ebenenAktiv } from '../ebenenNav';
import { hashForRoute, messstelleRoute, parseRoute, standortMessstellenRoute } from '../nav';
import {
  EINFUEHRUNG_TAG,
  KOSTENSTELLE_IDS,
  kostenstellenAhrenberg,
  MS_IDS,
  ms06,
  ms08Angelegt,
  ms08OrtGeplant,
  ms08Vorher,
  ms10,
  ms21,
  protokollMs06,
  protokollMs08Angelegt,
  protokollMs08OrtGeplant,
  protokollMs08Vorher,
  protokollMs10,
  prozesseAhrenberg,
  prozesseVon,
  verteilungVon,
} from '../test/messstelleSeiteFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { antwort, grundlastStunden, grundlastTag, MS_06, MS_21, normalStunden, normalTag, schritt, voll } from '../test/werteKarteFixtures';
import { monatPlus } from '../messstelleSeite';
import { f21Stunden, f21Tag, f21TagWert } from '../test/wertVersionenFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../test/standorteFixtures';
import { MessstelleSeite } from './MessstelleSeite';
import { MessstellenPage } from './MessstellenPage';

/**
 * Die Seite einer Messstelle (UEMS AP-04 IP-8, Konzept Messen m1 §6.4) gegen die gestellten Routen — Referenzunternehmen
 * Ahrenberg, heute = 20.10.2026 (Stichtag des Registers). R2: EINE Karte „Zuordnung“ und das Protokoll nach der
 * EINTRAGUNG (im Dialog hinter dem Verweis); Z4: „Ort ändern“ für MS-08 ab 01.03.2027 → „geplant“; MS-21 als Ablesezähler.
 */

const WARTEN = { timeout: 3000 };

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function verdrahte(stand: { messstelle: () => Messstelle; protokoll: () => Protokoll }) {
  vi.spyOn(api, 'messstelle').mockImplementation(async () => stand.messstelle());
  vi.spyOn(api, 'messstelleProzesse').mockImplementation(async () => prozesseVon(stand.messstelle()));
  vi.spyOn(api, 'messstelleVerteilung').mockImplementation(async () => verteilungVon(stand.messstelle()));
  vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => ahrenbergRegister());
  vi.spyOn(api, 'standorte').mockImplementation(async () => ahrenbergHeute());
  vi.spyOn(api, 'standortOrte').mockImplementation(async (id) =>
    id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach(),
  );
  vi.spyOn(api, 'prozesse').mockImplementation(async () => ({ stichtag: null, prozesse: prozesseAhrenberg() }));
  vi.spyOn(api, 'kostenstellen').mockImplementation(async () => ({ stichtag: null, kostenstellen: kostenstellenAhrenberg() }));
  return vi.spyOn(api, 'messstelleAenderungen').mockImplementation(async () => stand.protokoll());
}

const karte = (art: string) => screen.getByTestId(`karte-${art}`);

/**
 * Die Werte-Route für MS-06, wie die Seite sie fragt: im Raster Monat je Monat 8.000 kWh vollständig (Fenster der Balken
 * und Reihe der Leitkachel), sonst der Grundlast-Tag.
 */
function monatsWerte(messstelle: MessstelleWerte['messstelle'] = MS_06) {
  return vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, von, bis) => {
    if (raster !== 'monat') return raster === 'tag' ? grundlastTag(von, 'vorlaeufig') : grundlastStunden(von, 'vorlaeufig');
    const monate: string[] = [];
    for (let m = von.slice(0, 7); m <= bis.slice(0, 7); m = monatPlus(m, 1)) monate.push(m);
    return antwort(
      messstelle,
      'monat',
      `${monate[0]}-01T00:00:00+02:00`,
      `${monatPlus(monate[monate.length - 1], 1)}-01T00:00:00+02:00`,
      monate.map((m) =>
        schritt({ von: `${m}-01T00:00:00+02:00`, bis: `${monatPlus(m, 1)}-01T00:00:00+02:00`, gebildet_aus: 'monat', fassung: 'endgueltig', ...voll(8000, 720) }),
      ),
    );
  });
}
/** Eine Zeile der Karte „Zuordnung“ (Konzept Messen m1, §6.4 Punkt 7): ort · stellung · prozesse · verteilung. */
const zeile = (art: string) => screen.getByTestId(`zuordnung-${art}`);

/** Das Protokoll steht hinter dem Verweis am Fuß der rechten Spalte (Konzept §6.4 Punkt 9) und öffnet im Dialog. */
async function oeffneProtokoll() {
  fireEvent.click(await screen.findByTestId('protokoll-verweis', undefined, WARTEN));
  return screen.findByRole('dialog', { name: /^Änderungsprotokoll: / }, WARTEN);
}

/** Wählt im Datumsfeld einen Tag (wie `MessstellenPage.test.tsx`). */
function waehleTag(label: string, iso: string) {
  const feld = screen.getByRole('combobox', { name: label });
  const vorher = feld.textContent ?? '';
  fireEvent.click(feld);
  const [t, m, j] = vorher.match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  for (let i = 0; i < 40; i++) {
    const tag = document.querySelector<HTMLButtonElement>(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
    if (tag) {
      fireEvent.click(tag);
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: richtung }));
  }
  throw new Error(`Tag ${iso} nicht erreicht`);
}

describe('die Adresse der Seite', () => {
  it('`#/portfolio/messstellen/{id}` und `#/standort/{sid}/messstellen/{id}` — beide im Bereich „Messstellen“', () => {
    expect(hashForRoute(messstelleRoute(MS_IDS.ms06))).toBe(`#/portfolio/messstellen/${MS_IDS.ms06}`);
    expect(parseRoute(`#/portfolio/messstellen/${MS_IDS.ms06}`)).toEqual(messstelleRoute(MS_IDS.ms06));
    const imWerk = messstelleRoute(MS_IDS.ms06, FIXTURE_IDS.st1);
    expect(hashForRoute(imWerk)).toBe(`#/standort/${FIXTURE_IDS.st1}/messstellen/${MS_IDS.ms06}`);
    expect(parseRoute(hashForRoute(imWerk))).toEqual(imWerk);
    expect(ebenenAktiv(imWerk.page, imWerk.standortBereich)).toBe('messstellen');
    expect(ebenenAktiv(messstelleRoute(MS_IDS.ms06).page)).toBe('messstellen');
    // Das Register bleibt, wie es war.
    expect(hashForRoute(standortMessstellenRoute(FIXTURE_IDS.st1))).toBe(`#/standort/${FIXTURE_IDS.st1}/messstellen`);
  });

  it('die Liste öffnet die Seite über die ganze Reihe (ein Verweis auf die Adresse der Messstelle)', async () => {
    vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => ahrenbergRegister());
    const onOeffnen = vi.fn();
    render(
      <MessstellenPage ebene={{ art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' }} bereichDa onOeffnen={onOeffnen} />,
    );
    const reihe = await screen.findByRole('link', { name: /^Spritzguss SG01–SG06 MS-06/ }, WARTEN);
    expect(reihe.getAttribute('href')).toMatch(new RegExp(`/messstellen/${MS_IDS.ms06}$`));
    fireEvent.click(reihe);
    expect(onOeffnen).toHaveBeenCalledWith(MS_IDS.ms06);
  });
});

describe('MessstelleSeite · R2 — MS-06 am 20.10.2026', () => {
  it('EINE Karte „Zuordnung“ mit dem Stand von heute und je Zeile „Ändern“; der Kopf mit Medium, Ort und Zustand', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Spritzguss SG01–SG06 MS-06' }, WARTEN)).toBeInTheDocument();
    expect(screen.getByText('Strom · Halle 1 Nord · Werk Ahrenberg')).toBeInTheDocument();
    expect(within(karte('zuordnung')).getByRole('heading', { level: 2, name: 'Zuordnung' })).toBeInTheDocument();
    expect(within(zeile('ort')).getByText('Halle 1 Nord')).toBeInTheDocument();
    await waitFor(() => expect(within(zeile('ort')).getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024')).toBeInTheDocument(), WARTEN);
    expect(within(zeile('stellung')).getByRole('heading', { level: 3, name: 'Im Stromnetz' })).toBeInTheDocument();
    expect(within(zeile('stellung')).getByText('Unterzähler von MS-01')).toBeInTheDocument();
    expect(within(zeile('stellung')).getByText('Anlage Werk Ahrenberg – Halle 1 · seit 12.03.2024')).toBeInTheDocument();
    expect(within(zeile('prozesse')).getByText('Spritzguss')).toBeInTheDocument();
    expect(within(zeile('verteilung')).getByText('100 % Spritzguss')).toBeInTheDocument();
    for (const name of ['Ort ändern', 'Elektrische Stellung ändern', 'Prozesse ändern', 'Kostenstellen ändern']) {
      expect(screen.getByRole('button', { name })).toHaveTextContent(/^Ändern$/);
    }
    // Eine Zuordnung mit nur einem Abschnitt hat keine aufklappbare Historie.
    expect(screen.queryByText(/^Historie/)).toBeNull();
    // Bearbeiten, Korrekturen und das Protokoll stehen im Menü ⋯ des Kopfs.
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect(await screen.findByRole('menuitem', { name: 'Bearbeiten' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Änderungsprotokoll' })).toBeInTheDocument();
  });

  it('das Änderungsprotokoll steht nach der EINTRAGUNG — die rückwirkende Quelle von 09:14 oben, „gilt ab 12.03.2024“ an der Zeile', async () => {
    const aenderungen = verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);

    // Der Verweis sagt, wie viel es gibt und wann zuletzt; der Dialog zeigt die Zeilen.
    await waitFor(() => expect(screen.getByTestId('protokoll-verweis')).toHaveTextContent(/Einträge · zuletzt \d{2}\.\d{2}\.\d{4}/), WARTEN);
    await oeffneProtokoll();
    expect(await screen.findByText('Sortiert danach, wann die Änderung eingetragen wurde.', undefined, WARTEN)).toBeInTheDocument();
    expect(aenderungen).toHaveBeenCalledWith(MS_IDS.ms06, expect.objectContaining({ achse: 'eintrag' }));
    const zeilen = [...document.querySelectorAll('.vp-befehl')];
    expect(zeilen[0]).toHaveTextContent('Quelle gebunden: Z-5a · Wirkenergie · Bezug (führend)');
    expect(zeilen[0]).toHaveTextContent('rückwirkend');
    expect(zeilen[0]).toHaveTextContent('gilt ab 12.03.2024, 00:00 Uhr');
    expect(zeilen[0]).toHaveTextContent('eingetragen am 01.10.2026, 09:14 Uhr');
    expect(zeilen[zeilen.length - 1]).toHaveTextContent('Messstelle angelegt: Spritzguss SG01–SG06');
  });

  it('ohne Änderung steht grau „Heute gilt: …“, der Knopf wartet und „Was geschieht“ entfällt (kein roter Fehler)', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prozesse ändern' }, WARTEN));
    const dialog = screen.getByRole('dialog', { name: 'Prozesse ändern' });
    expect(within(dialog).getByTestId('zuordnung-gilt-schon')).toHaveTextContent(
      'Heute gilt: Spritzguss. Wählen Sie andere Prozesse, dann können Sie eintragen.',
    );
    expect(within(dialog).queryByText(/nichts zu ändern/)).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(dialog.querySelector('button[type="submit"]')).toBeDisabled();
    expect(within(dialog).queryByTestId('zuordnung-folgen')).toBeNull();
  });

  it('am 01.10.2026 den Ort von MS-08 ab 12.03.2024 eintragen: „rückwirkend (933 Tage)“, bevor etwas gespeichert ist', async () => {
    verdrahte({ messstelle: ms08Angelegt, protokoll: protokollMs08Angelegt });
    vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => ({ ...ahrenbergRegister(), stichtag: EINFUEHRUNG_TAG }));
    render(<MessstelleSeite id={MS_IDS.ms08} onListe={vi.fn()} />);

    expect(await within(await screen.findByTestId('zuordnung-ort', undefined, WARTEN)).findByText('Kein Ort zugeordnet')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('protokoll-verweis')).toHaveTextContent('1 Eintrag · zuletzt 01.10.2026'), WARTEN);
    fireEvent.click(screen.getByRole('button', { name: 'Ort ändern' }));
    const dialog = screen.getByRole('dialog', { name: 'Ort ändern' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Neuer Ort *' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Halle 1 Süd/ }, WARTEN));
    waehleTag('Gilt ab *', '2024-03-12');

    const folgenKarte = await within(dialog).findByTestId('zuordnung-folgen', undefined, WARTEN);
    await waitFor(() => expect(folgenKarte).toHaveTextContent('rückwirkend (933 Tage)'));
    expect(within(dialog).getByText('rückwirkend ab 12.03.2024')).toBeInTheDocument();
    expect(folgenKarte).toHaveTextContent('Für die Tage vom 12.03.2024 bis 30.09.2026 gilt das nachträglich.');
    expect(within(dialog).queryByText('Bisher')).toBeNull();
  });

  it('eine unbekannte Messstelle sagt es — nie eine leere Seite', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    vi.spyOn(api, 'messstelle').mockRejectedValue(new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' }));
    render(<MessstelleSeite id="unbekannt" onListe={vi.fn()} />);
    expect(
      await screen.findByText('Diese Messstelle gibt es nicht — oder sie gehört zu einem Standort, den Sie nicht sehen.', undefined, WARTEN),
    ).toBeInTheDocument();
  });
});

describe('MessstelleSeite · Z4 — MS-08 zieht am 01.03.2027 nach Halle 2 Montage', () => {
  it('Ort ändern ab 01.03.2027: „geplant“, Bisher, Was geschieht → PUT …/ort → Karte, Historie und Protokoll aus der Antwort', async () => {
    let gespeichert = false;
    verdrahte({
      messstelle: () => (gespeichert ? ms08OrtGeplant() : ms08Vorher()),
      protokoll: () => (gespeichert ? protokollMs08OrtGeplant() : protokollMs08Vorher()),
    });
    const put = vi.spyOn(api, 'messstelleOrtAendern').mockImplementation(async () => {
      gespeichert = true;
      return ms08OrtGeplant();
    });
    render(<MessstelleSeite id={MS_IDS.ms08} onListe={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ort ändern' }, WARTEN));

    const dialog = screen.getByRole('dialog', { name: 'Ort ändern' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Neuer Ort *' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Halle 2 Montage/ }, WARTEN));
    waehleTag('Gilt ab *', '2027-03-01');

    await waitFor(() => expect(within(dialog).getByTestId('zuordnung-folgen')).toHaveTextContent('geplant'));
    expect(within(dialog).getByText('Halle 1 Süd (B-2)')).toBeInTheDocument();
    expect(within(dialog).getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024 — endet 28.02.2027')).toBeInTheDocument();
    expect(within(dialog).getByTestId('zuordnung-folgen')).toHaveTextContent(
      'Ab 01.03.2027 gehört MS-08 zu Halle 2 Montage (B-3); bis 28.02.2027 bleibt es bei Halle 1 Süd (B-2).',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Ort ab 01.03.2027 eintragen' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(MS_IDS.ms08, { kennzeichen: 'B-3', gueltig_ab: '2027-03-01' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WARTEN);
    const ort = zeile('ort');
    expect(await within(ort).findByText('Ort ab 01.03.2027 eingetragen · geplant.', undefined, WARTEN)).toBeInTheDocument();
    await waitFor(() => expect(within(ort).getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024 · endet 28.02.2027')).toBeInTheDocument(), WARTEN);
    expect(within(ort).getByText('ab 01.03.2027: Halle 2 Montage')).toBeInTheDocument();
    expect(within(ort).getByText('Historie (2)')).toBeInTheDocument();
    const historie = [...ort.querySelectorAll('.vp-mss-h')];
    expect(historie[0]).toHaveTextContent('Halle 2 Montage');
    expect(historie[0]).toHaveTextContent('ab 01.03.2027');
    expect(historie[0]).toHaveTextContent('geplant');

    // Das Protokoll lädt neu: der Eintrag von heute steht OBEN, obwohl er erst 2027 gilt.
    await oeffneProtokoll();
    await waitFor(() => expect(document.querySelector('.vp-befehl')).toHaveTextContent('Ort zugeordnet: B-3'), WARTEN);
    expect(document.querySelector('.vp-befehl')).toHaveTextContent('angekündigt');
    expect(document.querySelector('.vp-befehl')).toHaveTextContent('gilt ab 01.03.2027, 00:00 Uhr');
  });

  it('eine Ablehnung lässt den Dialog offen und nennt den Satz am Feld', async () => {
    verdrahte({ messstelle: ms08Vorher, protokoll: protokollMs08Vorher });
    vi.spyOn(api, 'messstelleOrtAendern').mockRejectedValue(
      new ApiError(422, 'Halle 2 Lager ist seit 30.06.2027 archiviert. Wählen Sie einen aktiven Ort.', {
        code: 'ort_ungueltig',
        message: 'Halle 2 Lager ist seit 30.06.2027 archiviert. Wählen Sie einen aktiven Ort.',
      }),
    );
    render(<MessstelleSeite id={MS_IDS.ms08} onListe={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ort ändern' }, WARTEN));
    const dialog = screen.getByRole('dialog', { name: 'Ort ändern' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Neuer Ort *' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Halle 2 Lager/ }, WARTEN));
    waehleTag('Gilt ab *', '2027-07-01');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ort ab 01.07.2027 eintragen' }));
    expect(
      await within(dialog).findByText('Halle 2 Lager ist seit 30.06.2027 archiviert. Wählen Sie einen aktiven Ort.', undefined, WARTEN),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Ort ändern' })).toBeInTheDocument();
  });
});

describe('MessstelleSeite · Werte (UEMS AP-13 IP-3, E9 = A, E12 = A)', () => {
  /** F21 · MS-10 · 03.11.2026 in Version v — so, wie `…/werte?version=v` den Tag liefert. */
  const tagIn = (v: 1 | 2 | 3): MessstelleWerte => ({ ...f21Tag(), version: v, werte: [f21TagWert(v)] });
  it('„Verbrauch je Monat“ öffnet im letzten vollen Monat, links vor der Zuordnung; die Zone steht EINMAL am Fuß', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    const werte = monatsWerte();
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);

    const abschnitt = await screen.findByTestId('werte', undefined, WARTEN);
    expect(within(abschnitt).getByRole('heading', { level: 2, name: 'Verbrauch je Monat' })).toBeInTheDocument();
    expect(within(abschnitt).getByText('12 Monate')).toBeInTheDocument();
    await waitFor(() => expect(werte).toHaveBeenCalledWith('MS-06', 'monat', '2026-09-01', '2026-09-30'), WARTEN);
    // Die zwölf Balken und die Reihe der Leitkachel mit dem Vorjahresmonat.
    expect(werte).toHaveBeenCalledWith('MS-06', 'monat', '2025-10-01', '2026-09-30');
    expect(werte).toHaveBeenCalledWith('MS-06', 'monat', '2025-09-01', '2026-09-30');
    await waitFor(
      () => expect(screen.getByTestId('werte-zone')).toHaveTextContent(/^Zeiten: Europe\/Berlin \(Zeitzone des Standorts Werk Ahrenberg\) · Stand 20\.10\.2026, \d{2}:\d{2}$/),
      WARTEN,
    );
    expect(screen.getAllByTestId('werte-zone')).toHaveLength(1);
    expect(abschnitt).not.toContainElement(screen.getByTestId('werte-zone'));
    expect(abschnitt.compareDocumentPosition(karte('zuordnung')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Keine Version in der Adresse, kein Hinweis.
    expect(within(abschnitt).queryByTestId('werte-version')).toBeNull();
  });

  it('Periode und Version der Adresse: die Karte fragt Version 3 und sagt es; blättern meldet die Periode und zeigt die neueste', async () => {
    verdrahte({ messstelle: ms10, protokoll: protokollMs10 });
    const werte = vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, von, _bis, version) =>
      von === '2026-11-03'
        ? raster === 'tag'
          ? tagIn((version ?? 3) as 1 | 2 | 3)
          : f21Stunden()
        : raster === 'tag'
          ? normalTag()
          : normalStunden(),
    );
    const onZeitraum = vi.fn();
    render(
      <MessstelleSeite id={MS_IDS.ms10} werte={{ periode: '2026-11-03', version: 3 }} onWerteZeitraum={onZeitraum} onListe={vi.fn()} />,
    );

    expect(await screen.findByText('Sie sehen Version 3 — heute die neueste', undefined, WARTEN)).toBeInTheDocument();
    expect(werte).toHaveBeenCalledWith('MS-10', 'tag', '2026-11-03', '2026-11-03', 3);
    // Die Liste fragt ohne Version — Stunden haben keine eigenen.
    expect(werte).toHaveBeenCalledWith('MS-10', 'stunde', '2026-11-03', '2026-11-03');
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Zeitraum' }));
    expect(onZeitraum).toHaveBeenCalledWith('2026-11-02');
    await waitFor(() => expect(werte).toHaveBeenCalledWith('MS-10', 'tag', '2026-11-02', '2026-11-02'), WARTEN);
    await waitFor(() => expect(screen.queryByTestId('werte-version')).toBeNull(), WARTEN);
  });

  it('eine frühere Version sagt, welche heute gilt — „Neueste zeigen“ fragt ohne Version und nimmt sie aus der Adresse', async () => {
    verdrahte({ messstelle: ms10, protokoll: protokollMs10 });
    const werte = vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, _von, _bis, version) =>
      raster === 'tag' ? tagIn((version ?? 3) as 1 | 2 | 3) : f21Stunden(),
    );
    const onZeitraum = vi.fn();
    render(
      <MessstelleSeite id={MS_IDS.ms10} werte={{ periode: '2026-11-03', version: 1 }} onWerteZeitraum={onZeitraum} onListe={vi.fn()} />,
    );

    const hinweis = await screen.findByTestId('werte-version', undefined, WARTEN);
    expect(hinweis).toHaveTextContent('Sie sehen Version 1 — heute gilt Version 3');
    fireEvent.click(within(hinweis).getByRole('button', { name: 'Neueste zeigen' }));
    expect(onZeitraum).toHaveBeenCalledWith('2026-11-03');
    await waitFor(() => expect(werte).toHaveBeenLastCalledWith('MS-10', 'stunde', '2026-11-03', '2026-11-03'), WARTEN);
    expect(werte).toHaveBeenCalledWith('MS-10', 'tag', '2026-11-03', '2026-11-03');
    await waitFor(() => expect(screen.queryByTestId('werte-version')).toBeNull(), WARTEN);
  });

  it('eine Version ohne gültige Periode gilt nicht: die Seite öffnet im letzten vollen Monat, ohne Version zu fragen', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    const werte = monatsWerte();
    render(<MessstelleSeite id={MS_IDS.ms06} werte={{ periode: '2026-02-30', version: 2 }} onListe={vi.fn()} />);
    await waitFor(() => expect(werte).toHaveBeenCalledWith('MS-06', 'monat', '2026-09-01', '2026-09-30'), WARTEN);
    expect(werte.mock.calls.every((c) => c.length === 4)).toBe(true);
  });
});

describe('MessstelleSeite · Nebengrößen unter den Werten (UEMS AP-13 IP-6, V8)', () => {
  it('MS-06: die Wirkleistung mit ihrem letzten Wert aus dem Register und der Satz, wofür es Werte gibt — ohne einen Sprung, den es nicht gibt', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    monatsWerte();
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);

    const neben = await screen.findByTestId('werte-nebengroessen', undefined, WARTEN);
    expect(screen.getByTestId('werte')).toContainElement(neben);
    expect(within(neben).getByRole('heading', { name: 'Weitere Größen' })).toBeInTheDocument();
    expect(within(neben).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/^Wirkleistung 148,6\skW · .*10:15 Uhr$/)]);
    expect(neben).toHaveTextContent('Letzter Wert aus der Box — Werte und Verlauf gibt es hier nur für Wirkenergie Bezug.');
    // Der Register-Verlauf der Geräteseite hat von hier keine Adresse (keine Anlage, keine Box-Referenz an der Bindung).
    expect(within(neben).queryAllByRole('link')).toHaveLength(0);
    expect(within(neben).queryAllByRole('button')).toHaveLength(0);
  });
});


it('IP-12: der Standort des Registers trägt auch auf einer Unternehmensadresse das Bearbeitungsrecht', async () => {
  // Thomas richtet ST-1 ein; er hat kein unternehmensweites Bearbeitungsrecht.
  setSelbstauskunft(rechteSeed('TB').me);
  verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
  render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Ort ändern' }, WARTEN)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
  expect(await screen.findByRole('menuitem', { name: 'Bearbeiten' })).toBeInTheDocument();
});

it('IP-12: Murat liest dieselbe Messstelle ohne Pflegeknöpfe, mit Jonas als Weg', async () => {
  setSelbstauskunft(rechteSeed('MD').me);
  verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
  render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);
  await screen.findByRole('heading', { level: 1, name: 'Spritzguss SG01–SG06 MS-06' }, WARTEN);
  await waitFor(() => expect(screen.getByTestId('zuordnung-verteilung')).toHaveTextContent('100 % Spritzguss'), WARTEN);
  expect(screen.queryByRole('button', { name: 'Ort ändern' })).toBeNull();
  expect(screen.getAllByRole('note').some(n => n.textContent?.includes('Jonas Wendlinger'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
  expect(await screen.findByRole('menuitem', { name: 'Änderungsprotokoll' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Bearbeiten' })).toBeNull();
});


it('W14: eine rückwirkende Zuordnung zeigt Thomas den Weg statt des Eintragen-Knopfs', async () => {
  setSelbstauskunft(rechteSeed('TB').me);
  verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
  render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Ort ändern' }, WARTEN));
  const dialog = screen.getByRole('dialog', { name: 'Ort ändern' });
  expect(dialog.querySelector('button[type="submit"]')).not.toBeNull();
  waehleTag('Gilt ab *', '2026-10-19');
  expect(dialog.querySelector('button[type="submit"]')).toBeNull();
  // Konzept Messen m1 §8.2: was nicht geht, wer es kann, und dass er ab heute selbst eintragen kann.
  const note = within(dialog).getByRole('note');
  expect(note).toHaveTextContent('Rückwirkend eintragen dürfen Kundenadministratoren und Energiemanager. Ab heute können Sie es selbst eintragen.');
  expect(note).toHaveTextContent('Jonas Wendlinger');
});

describe('MessstelleSeite · Kostenstellen ändern — Hinweis auf doppelte Zählung (Folge PR 1127, Captain „warnen, nicht ablehnen“)', () => {
  /** Die Antwort des PUT: die gesetzten Anteile ab `gueltig_ab`, dazu der Befund der Route. */
  function antwort(body: { gueltig_ab: string }, doppelzaehlung: MessstelleVerteilung['doppelzaehlung']): MessstelleVerteilung {
    return {
      ...verteilungVon(ms06()),
      anteile: [
        { id: 'neu-1', kostenstelle: { id: KOSTENSTELLE_IDS.k4100, kennzeichen: '4100' }, name: 'Spritzguss', anteil_prozent: '70', gueltig_ab: body.gueltig_ab, gueltig_bis: null, endet_mit_kostenstelle: false },
        { id: 'neu-2', kostenstelle: { id: KOSTENSTELLE_IDS.k4200, kennzeichen: '4200' }, name: 'Montage', anteil_prozent: '30', gueltig_ab: body.gueltig_ab, gueltig_bis: null, endet_mit_kostenstelle: false },
      ],
      ...(doppelzaehlung === undefined ? {} : { doppelzaehlung }),
    };
  }

  /** MS-06 von 100 % Spritzguss auf 70 % Spritzguss und 30 % Montage — bis vor „eintragen“. */
  async function setze7030() {
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kostenstellen ändern' }, WARTEN));
    const dialog = screen.getByRole('dialog', { name: 'Kostenstellen ändern' });
    fireEvent.change(within(dialog).getByLabelText('Anteil (%)'), { target: { value: '70' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kostenstelle hinzufügen' }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Kostenstelle 2' }));
    fireEvent.click(await screen.findByRole('option', { name: /^4200/ }, WARTEN));
    fireEvent.click(within(dialog).getByRole('button', { name: /eintragen$/ }));
    return dialog;
  }

  const DOPPELT_4100 = (am: string): NonNullable<MessstelleVerteilung['doppelzaehlung']> => [
    {
      kostenstelle: { id: KOSTENSTELLE_IDS.k4100, kennzeichen: '4100' },
      am,
      enthalten: [
        { teil: 'MS-06', summe: 'MS-20', umfang: 'ganz', kette: ['MS-20', 'MS-06'], zeitraeume: [{ von: am, bis: am }], satz: 'MS-06 ist bereits in MS-20 enthalten' },
      ],
      nicht_pruefbar: [],
    },
  ];

  it('mit Befund: gespeichert, der Dialog bleibt mit dem Satz wie am Posten, „Verstanden“ schließt', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    const put = vi
      .spyOn(api, 'messstelleVerteilungSetzen')
      .mockImplementation(async (_id, body) => antwort(body, DOPPELT_4100(body.gueltig_ab)));
    await setze7030();

    const hinweis = await screen.findByTestId('verteilung-doppelzaehlung', undefined, WARTEN);
    expect(put).toHaveBeenCalledTimes(1);
    const tag = put.mock.calls[0][1].gueltig_ab.split('-').reverse().join('.');
    expect(hinweis).toHaveTextContent('Die Verteilung ist gespeichert.');
    expect(hinweis).toHaveTextContent(`Kostenstelle 4100 Spritzguss ab ${tag}`);
    expect(within(hinweis).getByRole('listitem')).toHaveTextContent(/^MS-06 ist bereits in MS-20 enthalten \(Anteil 70 %\)$/);
    expect(hinweis).not.toHaveTextContent('4200');
    expect(hinweis).toHaveTextContent('Die Zahlen bleiben, wie sie gemessen und verteilt sind.');
    // Nichts wird zurückgenommen: kein zweiter Aufruf, kein Abbrechen mehr.
    const dialog = screen.getByRole('dialog', { name: 'Kostenstellen ändern' });
    expect(within(dialog).queryByRole('button', { name: 'Abbrechen' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Verstanden' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WARTEN);
    expect(await within(zeile('verteilung')).findByText(/^Verteilung ab .* eingetragen/, undefined, WARTEN)).toBeInTheDocument();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['leeres doppelzaehlung[]', [] as NonNullable<MessstelleVerteilung['doppelzaehlung']>],
    ['fehlendes Feld', undefined],
  ])('ohne Befund (%s): der Dialog schließt sofort wie bisher', async (_fall, doppelzaehlung) => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    vi.spyOn(api, 'messstelleVerteilungSetzen').mockImplementation(async (_id, body) => antwort(body, doppelzaehlung));
    await setze7030();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WARTEN);
    expect(screen.queryByTestId('verteilung-doppelzaehlung')).toBeNull();
    expect(await within(zeile('verteilung')).findByText(/^Verteilung ab .* eingetragen/, undefined, WARTEN)).toBeInTheDocument();
  });
});


describe('MessstelleSeite · Ablesezähler MS-21 (Konzept Messen m1, §6.4/§6.5)', () => {
  const ablesung = (tag: string, stand: number, monat: string | null): Ablesung => ({
    quelle: 'q-ms21',
    zeitpunkt: `${tag}T07:30:00+02:00`,
    fassung: 1,
    stand,
    monat,
    woher: 'eingabe',
    urheber: { name: 'Ines Kaltenbach', rolle: 'energiemanager' },
    korrektur: null,
    eingetragen_am: `${tag}T07:35:00+02:00`,
  });
  const VIER = [
    ablesung('2026-07-01', 48200, null),
    ablesung('2026-08-01', 48610, '2026-07-01'),
    ablesung('2026-09-01', 49020, '2026-08-01'),
    ablesung('2026-10-01', 49451, '2026-09-01'),
  ];

  /** MS-21 liest von Hand ab: zuletzt am 01.10.2026, die nächste ist ab dem 02.11.2026 fällig. */
  function abgelesen() {
    verdrahte({ messstelle: ms21, protokoll: protokollMs10 });
    vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => {
      const r = ahrenbergRegister();
      return {
        ...r,
        register: r.register.map((z) =>
          z.kennzeichen !== 'MS-21'
            ? z
            : {
                ...z,
                quelle: {
                  stand: 'ablesung' as const,
                  fuehrend: null,
                  davor: null,
                  vergleichsquellen: 0,
                  ablesung: { seit: '2026-07-01T07:30:00+02:00', zuletzt: '2026-10-01T07:30:00+02:00', faellig_ab: '2026-11-02T07:30:00+01:00' },
                },
                beobachtung: { zustand: 'liefert' as const, text: 'Abgelesen am 01.10.2026', seit: null, toleranz_s: null, kadenz_s: null, geraet: null },
                letzter_wert: { wert: 49451, text: null, einheit: 'm³', zeitpunkt: '2026-10-01T07:30:00+02:00' },
              },
        ),
      };
    });
    vi.spyOn(api, 'messstelleQuellen').mockImplementation(async () => ({
      messstelle_id: MS_IDS.ms21,
      kennzeichen: 'MS-21',
      stichtag: '2026-10-20',
      groessen: [],
      quellen: [],
    }));
    monatsWerte(MS_21);
    let liefere: (a: Ablesung[]) => void = () => undefined;
    vi.spyOn(api, 'ablesungen').mockImplementation(() => new Promise((r) => (liefere = r)));
    return { liefere: (a: Ablesung[]) => liefere(a) };
  }

  it('Kopf mit „nächste bis“, der Schritt „Ablesung eintragen“ wird erst mit den Ablesungen Ziel; Kachel und Herkunft sagen es', async () => {
    const { liefere } = abgelesen();
    render(<MessstelleSeite id={MS_IDS.ms21} onListe={vi.fn()} />);

    await waitFor(
      () => expect(screen.getByTestId('messstelle-status')).toHaveTextContent('Abgelesen am 01.10.2026 · nächste bis 02.11.2026'),
      WARTEN,
    );
    const schritt = await screen.findByRole('button', { name: 'Ablesung eintragen' }, WARTEN);
    // Konzept Wiedervorlage w1, Entscheid 7: ohne die Ablesungen zum Vergleich ist der Knopf noch kein Ziel.
    expect(schritt).toBeDisabled();
    expect(schritt).not.toHaveAttribute('data-entscheid');
    expect(schritt).toHaveAttribute('data-entscheid-schritt');
    liefere(VIER);
    await waitFor(() => expect(schritt).toHaveAttribute('data-entscheid', 'zaehlerablesung'), WARTEN);
    expect(schritt).toBeEnabled();

    const kacheln = screen.getByTestId('messstelle-kacheln');
    await waitFor(() => expect(kacheln).toHaveTextContent('Nächste Ablesung'), WARTEN);
    expect(kacheln).toHaveTextContent('02.11.2026');
    expect(kacheln).toHaveTextContent('im Plan');
    expect(within(karte('herkunft')).getByText('Von Hand abgelesen')).toBeInTheDocument();
    expect(within(karte('herkunft')).getByText('monatlich · 4 Ablesungen seit 01.07.2026')).toBeInTheDocument();
    // Ein Ablesezähler kennt Monat und Jahr - Tag und Woche gibt es erst mit einem Gerät.
    const zeitraum = within(screen.getByTestId('werte')).getByRole('tablist', { name: 'Zeitraum' });
    expect(within(zeitraum).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Monat', 'Jahr']);
  });

  it('die Ablesungen: die neueste zuerst, drei sichtbar, „Alle 4 ›“ öffnet; der Dialog zeigt die letzte zum Vergleich', async () => {
    const { liefere } = abgelesen();
    render(<MessstelleSeite id={MS_IDS.ms21} onListe={vi.fn()} />);
    const schritt = await screen.findByRole('button', { name: 'Ablesung eintragen' }, WARTEN);
    liefere(VIER);
    const liste = await screen.findByTestId('ablesungen', undefined, WARTEN);
    await waitFor(() => expect(within(liste).getAllByTestId('ablesung-zeile')).toHaveLength(3), WARTEN);
    expect(within(liste).getAllByTestId('ablesung-zeile')[0]).toHaveTextContent('49.451');
    fireEvent.click(within(liste).getByRole('button', { name: 'Alle 4 ›' }));
    expect(within(liste).getAllByTestId('ablesung-zeile')).toHaveLength(4);
    expect(within(liste).getByRole('button', { name: 'Weniger' })).toHaveAttribute('aria-expanded', 'true');

    await waitFor(() => expect(schritt).toBeEnabled(), WARTEN);
    fireEvent.click(schritt);
    const dialog = await screen.findByRole('dialog', { name: 'Ablesung eintragen' }, WARTEN);
    expect(within(dialog).getByTestId('ablesung-letzte')).toHaveTextContent('Letzte Ablesung');
    expect(within(dialog).getByTestId('ablesung-letzte')).toHaveTextContent('49.451');
    expect(within(dialog).getByText('MS-21 Gas Heizung Verwaltung · Zählerstand in m³')).toBeInTheDocument();
  });
});

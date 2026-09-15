import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Messstelle, type Protokoll } from '../api';
import { ebenenAktiv } from '../ebenenNav';
import { hashForRoute, messstelleRoute, parseRoute, standortMessstellenRoute } from '../nav';
import {
  EINFUEHRUNG_TAG,
  kostenstellenAhrenberg,
  MS_IDS,
  ms06,
  ms08Angelegt,
  ms08OrtGeplant,
  ms08Vorher,
  protokollMs06,
  protokollMs08Angelegt,
  protokollMs08OrtGeplant,
  protokollMs08Vorher,
  prozesseAhrenberg,
  prozesseVon,
  verteilungVon,
} from '../test/messstelleSeiteFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../test/standorteFixtures';
import { MessstelleSeite } from './MessstelleSeite';
import { MessstellenPage } from './MessstellenPage';

/**
 * Die Messstellen-Seite (UEMS AP-04 IP-8) gegen die gestellten Routen — Referenzunternehmen
 * Ahrenberg, heute = 20.10.2026 (Stichtag des Registers). R2: drei Zuordnungs-Karten und das
 * Protokoll nach der EINTRAGUNG; Z4: „Ort ändern“ für MS-08 ab 01.03.2027 → „geplant“.
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

  it('das Register öffnet die Seite über den Namen', async () => {
    vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => ahrenbergRegister());
    const onOeffnen = vi.fn();
    render(
      <MessstellenPage ebene={{ art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' }} bereichDa onOeffnen={onOeffnen} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Spritzguss SG01–SG06' }, WARTEN));
    expect(onOeffnen).toHaveBeenCalledWith(MS_IDS.ms06);
  });
});

describe('MessstelleSeite · R2 — MS-06 am 20.10.2026', () => {
  it('drei Zuordnungs-Karten mit dem Stand von heute, Kopf mit Zustand und Quelle', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Spritzguss SG01–SG06' }, WARTEN)).toBeInTheDocument();
    expect(screen.getByText('Strom · Wirkenergie · Bezug · Zählerstand · aktiv')).toBeInTheDocument();
    expect(within(karte('ort')).getByText('Halle 1 Nord')).toBeInTheDocument();
    await waitFor(() => expect(within(karte('ort')).getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024')).toBeInTheDocument(), WARTEN);
    expect(within(karte('elektrisch')).getByText('Unterzähler von MS-01')).toBeInTheDocument();
    expect(within(karte('elektrisch')).getByText('Werk Ahrenberg – Halle 1 · seit 12.03.2024')).toBeInTheDocument();
    expect(within(karte('organisation')).getByText('Spritzguss')).toBeInTheDocument();
    expect(within(karte('organisation')).getByText('4100 Spritzguss · 100 %')).toBeInTheDocument();
    for (const name of ['Ort ändern ab …', 'Elektrische Stellung ändern ab …', 'Prozesse ändern ab …', 'Kostenstellen ändern ab …']) {
      expect(screen.getByRole('button', { name })).toHaveTextContent('Ändern ab …');
    }
    // Eine Zuordnung mit nur einem Abschnitt hat keine aufklappbare Historie.
    expect(screen.queryByText(/^Historie/)).toBeNull();
  });

  it('das Änderungsprotokoll steht nach der EINTRAGUNG — die rückwirkende Quelle von 09:14 oben, „gilt ab 12.03.2024“ an der Zeile', async () => {
    const aenderungen = verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);

    expect(await screen.findByText('Sortiert danach, wann die Änderung eingetragen wurde.', undefined, WARTEN)).toBeInTheDocument();
    expect(aenderungen).toHaveBeenCalledWith(MS_IDS.ms06, expect.objectContaining({ achse: 'eintrag' }));
    const zeilen = [...document.querySelectorAll('.vp-befehl')];
    expect(zeilen[0]).toHaveTextContent('Quelle gebunden: Z-5a · Wirkenergie · Bezug (führend)');
    expect(zeilen[0]).toHaveTextContent('rückwirkend');
    expect(zeilen[0]).toHaveTextContent('gilt ab 12.03.2024, 00:00 Uhr');
    expect(zeilen[0]).toHaveTextContent('eingetragen am 01.10.2026, 09:14 Uhr');
    expect(zeilen[zeilen.length - 1]).toHaveTextContent('Messstelle angelegt: Spritzguss SG01–SG06');
  });

  it('„nichts zu ändern“ steht sofort am Feld und „Was geschieht“ entfällt', async () => {
    verdrahte({ messstelle: ms06, protokoll: protokollMs06 });
    render(<MessstelleSeite id={MS_IDS.ms06} onListe={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prozesse ändern ab …' }, WARTEN));
    const dialog = screen.getByRole('dialog', { name: 'Prozesse ändern' });
    expect(within(dialog).getByText('Am 20.10.2026 gilt schon: Spritzguss. Es gibt nichts zu ändern.')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('zuordnung-folgen')).toBeNull();
  });

  it('am 01.10.2026 den Ort von MS-08 ab 12.03.2024 eintragen: „rückwirkend (933 Tage)“, bevor etwas gespeichert ist', async () => {
    verdrahte({ messstelle: ms08Angelegt, protokoll: protokollMs08Angelegt });
    vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => ({ ...ahrenbergRegister(), stichtag: EINFUEHRUNG_TAG }));
    render(<MessstelleSeite id={MS_IDS.ms08} onListe={vi.fn()} />);

    expect(await within(await screen.findByTestId('karte-ort', undefined, WARTEN)).findByText('Kein Ort zugeordnet')).toBeInTheDocument();
    expect(await screen.findByText('Seit dem Anlegen am 01.10.2026 keine Änderung.', undefined, WARTEN)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ort ändern ab …' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Ort ändern ab …' }, WARTEN));

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
    const ort = karte('ort');
    expect(await within(ort).findByText('Ort ab 01.03.2027 eingetragen · geplant.', undefined, WARTEN)).toBeInTheDocument();
    await waitFor(() => expect(within(ort).getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024 · endet 28.02.2027')).toBeInTheDocument(), WARTEN);
    expect(within(ort).getByText('ab 01.03.2027: Halle 2 Montage')).toBeInTheDocument();
    expect(within(ort).getByText('Historie (2)')).toBeInTheDocument();
    const historie = [...ort.querySelectorAll('.vp-mss-h')];
    expect(historie[0]).toHaveTextContent('Halle 2 Montage');
    expect(historie[0]).toHaveTextContent('ab 01.03.2027');
    expect(historie[0]).toHaveTextContent('geplant');

    // Das Protokoll lädt neu: der Eintrag von heute steht OBEN, obwohl er erst 2027 gilt.
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
    fireEvent.click(await screen.findByRole('button', { name: 'Ort ändern ab …' }, WARTEN));
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

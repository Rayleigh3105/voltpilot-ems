import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { PFLICHT, SATZ_KENNZEICHEN_FORMAT } from '../messstelleDialog';
import {
  kanaeleK5Frei,
  KOMPONENTE_IDS,
  komponentenHalle1,
  messstelleAngelegt,
  registerAntwort,
  VORSCHLAG,
} from '../test/messstelleDialogFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../test/standorteFixtures';
import { MessstelleDialog } from './MessstelleDialog';

/**
 * Der Messstellen-Dialog (UEMS AP-04 IP-6) gegen eine gestellte Schnittstelle: Vorbelegung,
 * Pflichtfelder, Kennzeichen-Format, die beiden 409 der FEHLER-Tabelle (Kennzeichen belegt,
 * zweiter Hauptzähler) mit ihrem WORTLAUT, der Schritt Quelle und das Bearbeiten.
 */

/** FEHLER-Tabelle AP-04 §5.12, Spalte „Wortlaut“ — wörtlich. */
const WORTLAUT = {
  hauptzaehler:
    'Werk Ahrenberg – Halle 1 hat bereits einen Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.',
  kennzeichenBelegt:
    'MS-01 ist bereits vergeben (Netzbezug Halle 1). Kennzeichen sind je Unternehmen eindeutig — auch archivierte bleiben belegt.',
} as const;

function zeige(over: Partial<Parameters<typeof MessstelleDialog>[0]> = {}) {
  const props = {
    open: true,
    messstelleId: null,
    standortId: FIXTURE_IDS.st1,
    heute: '2026-10-20',
    jetzt: '2026-10-20T09:00:00+02:00',
    onClose: vi.fn(),
    onGespeichert: vi.fn(),
    ...over,
  };
  render(<MessstelleDialog {...props} />);
  return props;
}

const feld = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const tippe = (label: string, wert: string) => fireEvent.change(feld(label), { target: { value: wert } });
const knopf = (name: string) => screen.getByRole('button', { name });
const aktiverSchritt = () => document.querySelector('.vp-step-active .vp-step-label')?.textContent ?? null;

async function waehle(label: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

async function identitaetAusfuellen() {
  await waitFor(() => expect(feld('Kennzeichen').value).toBe(VORSCHLAG));
  tippe('Name *', 'Spritzguss SG01–SG06 Kühlung');
  await waehle('Hauptgröße *', /^Wirkenergie/);
  await waehle('Richtung *', /^Bezug/);
  await waehle('Wertart *', /^Zählerstand/);
}

beforeEach(() => {
  vi.spyOn(api, 'kennzeichenVorschlag').mockResolvedValue({ kennzeichen: VORSCHLAG });
  vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
  vi.spyOn(api, 'standortOrte').mockImplementation(async (id: string) =>
    id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach(),
  );
  vi.spyOn(api, 'messstellenRegister').mockResolvedValue(registerAntwort());
  vi.spyOn(api, 'siteEntities').mockResolvedValue(komponentenHalle1());
  vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(kanaeleK5Frei());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessstelleDialog — anlegen, Schritt Identität', () => {
  it('ist ein zentriertes Modal in drei Schritten; das Kennzeichen ist vorbelegt und „automatisch · änderbar“', async () => {
    zeige();
    expect(screen.getByRole('dialog', { name: 'Messstelle anlegen' })).toBeInTheDocument();
    expect([...document.querySelectorAll('.vp-step-label')].map((l) => l.textContent)).toEqual([
      'Identität',
      'Zuordnung',
      'Quelle',
    ]);
    expect(aktiverSchritt()).toBe('Identität');
    await waitFor(() => expect(feld('Kennzeichen').value).toBe('MS-0022'));
    expect(screen.getByText('automatisch · änderbar')).toBeInTheDocument();
    // Medium nur Strom (AP-00 E11) — nicht wählbar, nur genannt.
    expect(screen.getByText('Strom')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Medium/ })).toBeNull();
  });

  it('Pflichtfelder: leeres Weiter nennt Name und Größe, fokussiert den Namen und sendet nichts', async () => {
    const anlegen = vi.spyOn(api, 'messstelleAnlegen');
    zeige();
    await waitFor(() => expect(feld('Kennzeichen').value).toBe(VORSCHLAG));
    fireEvent.click(knopf('Weiter: Zuordnung'));
    expect(await screen.findByText(PFLICHT.name)).toBeInTheDocument();
    expect(screen.getByText(PFLICHT.groesse)).toBeInTheDocument();
    // Das vorbelegte Kennzeichen fehlt nicht.
    expect(screen.queryByText(SATZ_KENNZEICHEN_FORMAT)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(feld('Name *')));
    expect(anlegen).not.toHaveBeenCalled();
    expect(aktiverSchritt()).toBe('Identität');
  });

  it('Kennzeichen-Format: „ms-01“ wird nicht umgewandelt — der Satz steht am Feld, nichts wird gesendet', async () => {
    const anlegen = vi.spyOn(api, 'messstelleAnlegen');
    zeige();
    await identitaetAusfuellen();
    tippe('Kennzeichen', 'ms-01');
    fireEvent.click(knopf('Weiter: Zuordnung'));
    expect(await screen.findByText(SATZ_KENNZEICHEN_FORMAT)).toBeInTheDocument();
    expect(feld('Kennzeichen').value).toBe('ms-01');
    await waitFor(() => expect(document.activeElement).toBe(feld('Kennzeichen')));
    expect(anlegen).not.toHaveBeenCalled();
  });

  it('Kennzeichen belegt (409): der Wortlaut der Tabelle steht am Feld, der Vorschlag bleibt einen Klick entfernt', async () => {
    const anlegen = vi
      .spyOn(api, 'messstelleAnlegen')
      .mockRejectedValueOnce(
        new ApiError(409, 'Konflikt', {
          code: 'kennzeichen_belegt',
          message: 'Konflikt',
          bestehend: { kennzeichen: 'MS-01', messstelle: 'MS-01', name: 'Netzbezug Halle 1', archiviert: false, frueher: false },
        }),
      )
      .mockResolvedValueOnce(messstelleAngelegt());
    const gespeichert = zeige().onGespeichert;
    await identitaetAusfuellen();
    tippe('Kennzeichen', 'MS-01');
    fireEvent.click(knopf('Weiter: Zuordnung'));
    expect(await screen.findByText(WORTLAUT.kennzeichenBelegt)).toBeInTheDocument();
    expect(aktiverSchritt()).toBe('Identität');
    expect(anlegen).toHaveBeenCalledWith(expect.objectContaining({ kennzeichen: 'MS-01' }));
    expect(gespeichert).not.toHaveBeenCalled();

    fireEvent.click(knopf('Vorschlag MS-0022 übernehmen'));
    expect(feld('Kennzeichen').value).toBe('MS-0022');
    expect(screen.queryByText(WORTLAUT.kennzeichenBelegt)).toBeNull();
    fireEvent.click(knopf('Weiter: Zuordnung'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Zuordnung'));
    // Unverändert = automatisch: das Kennzeichen fehlt in der Anfrage.
    expect(anlegen).toHaveBeenLastCalledWith(expect.not.objectContaining({ kennzeichen: expect.anything() }));
    expect(anlegen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        art: 'gemessen',
        medium: 'Strom',
        hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
      }),
    );
    expect(gespeichert).toHaveBeenCalledTimes(1);
  });

  it('Escape schließt den Dialog', () => {
    const { onClose } = zeige();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('MessstelleDialog — Zuordnung und Quelle', () => {
  async function bisZuordnung() {
    vi.spyOn(api, 'messstelleAnlegen').mockResolvedValue(messstelleAngelegt());
    const props = zeige();
    await identitaetAusfuellen();
    fireEvent.click(knopf('Weiter: Zuordnung'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Zuordnung'));
    // §5.1 „Vorgabe: Standort“ — geöffnet aus Werk Ahrenberg.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ort' }).textContent).toContain('Werk Ahrenberg'));
    return props;
  }

  it('Hauptzähler-Regel: die Schnittstelle antwortet 409 — der Kunde liest den Wortlaut der Tabelle, der Dialog bleibt in „Zuordnung“', async () => {
    const aktiv = messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] });
    const ort = vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(aktiv);
    const stellung = vi
      .spyOn(api, 'messstelleStellungAendern')
      .mockRejectedValueOnce(
        new ApiError(409, 'Konflikt', {
          code: 'hauptzaehler_vorhanden',
          // Ein anderer Satz der Schnittstelle — der Dialog baut den Wortlaut aus den Fakten.
          message: 'Konflikt',
          tag: '2026-10-20',
          bestehend: { kennzeichen: 'MS-01', name: 'Netzbezug Halle 1', anlage: FIXTURE_IDS.an1 },
        }),
      )
      .mockResolvedValueOnce(aktiv);
    const binden = vi.spyOn(api, 'messstelleQuelleBinden');
    await bisZuordnung();
    await waehle('Anlage', /^Werk Ahrenberg – Halle 1/);
    await waehle('Elektrische Stellung', /^Hauptzähler/);
    fireEvent.click(knopf('Weiter: Quelle'));

    expect(await screen.findByText(WORTLAUT.hauptzaehler)).toBeInTheDocument();
    expect(aktiverSchritt()).toBe('Zuordnung');
    expect(stellung).toHaveBeenCalledTimes(1);
    expect(binden).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Komponente' })).toBeNull();

    // Der Weg aus dem Satz: „Unterzähler von MS-01“ — der schon gespeicherte Ort wird nicht noch einmal geschrieben.
    await waehle('Elektrische Stellung', /^Unterzähler/);
    expect(screen.queryByText(WORTLAUT.hauptzaehler)).toBeNull();
    await waehle('Unterzähler von *', /^MS-01 Netzbezug Halle 1/);
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    expect(ort).toHaveBeenCalledTimes(1);
    expect(ort).toHaveBeenCalledWith('ms-neu', { kennzeichen: 'ST-1', gueltig_ab: '2026-10-20' });
    expect(stellung).toHaveBeenLastCalledWith('ms-neu', {
      anlage: FIXTURE_IDS.an1,
      stellung: 'Unterzähler',
      unterzaehler_von: 'MS-01',
      gueltig_ab: '2026-10-20',
    });
  });

  it('Quelle: nur passende Messwerte sind wählbar, „Was geschieht“ steht vor dem Klick, danach der Fertig-Satz', async () => {
    vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] }));
    vi.spyOn(api, 'messstelleStellungAendern').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] }));
    const binden = vi.spyOn(api, 'messstelleQuelleBinden').mockResolvedValue({});
    await bisZuordnung();
    await waehle('Anlage', /^Werk Ahrenberg – Halle 1/);
    await waehle('Elektrische Stellung', /^Unterzähler/);
    await waehle('Unterzähler von *', /^MS-01 Netzbezug Halle 1/);
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));

    await waehle('Komponente', /^Unterzähler Spritzguss SG01–SG06/);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Messwert für die Hauptgröße · Wirkenergie · Bezug' }));
    const leistung = await screen.findByRole('option', { name: /^Wirkleistung/ });
    expect(leistung.getAttribute('aria-disabled')).toBe('true');
    expect(leistung.textContent).toContain('kann die Größe „Wirkenergie · Zählerstand“ nicht liefern');
    fireEvent.click(screen.getByRole('option', { name: /^Wirkenergie Bezug/ }));

    expect(screen.getByTestId('messstelle-folgen').textContent).toContain(
      'MS-0022 liest ab 20.10.2026, 09:00 Uhr Unterzähler Spritzguss SG01–SG06 · Wirkenergie Bezug. Bis zu den ersten Werten steht „wartet auf erste Daten“.',
    );
    fireEvent.click(knopf('Fertigstellen'));
    expect(await screen.findByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist eingerichtet und aktiv · wartet auf erste Daten')).toBeInTheDocument();
    expect(binden).toHaveBeenCalledWith('ms-neu', {
      komponente: KOMPONENTE_IDS.k5,
      kanal: 'active_energy_import',
      rolle: 'fuehrend',
      gueltig_ab: '2026-10-20T09:00:00+02:00',
    });
  });

  it('„Später binden“: eingerichtet ohne Quelle — „keine Datenquelle“, nie eine 0', async () => {
    vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] }));
    const binden = vi.spyOn(api, 'messstelleQuelleBinden');
    await bisZuordnung();
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    fireEvent.click(knopf('Später binden'));
    expect(await screen.findByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist eingerichtet und aktiv · keine Datenquelle')).toBeInTheDocument();
    expect(binden).not.toHaveBeenCalled();
  });
});

describe('MessstelleDialog — bearbeiten', () => {
  it('die Hauptgröße ist fest; PUT schickt Kennzeichen und Anschlussleistung mit, Unverändertes wird nicht geschrieben', async () => {
    const bestand = messstelleAngelegt({
      lebenszyklus: 'aktiv',
      fehlt: [],
      anschlussleistung_kw: 250,
      orte: [{ ort_art: 'bereich', kennzeichen: 'B-1', gueltig_ab: '2024-03-12', gueltig_bis: null }],
      elektrische_stellung: [
        { anlage: FIXTURE_IDS.an1, stellung: 'Unterzähler', unterzaehler_von: 'MS-01', gueltig_ab: '2024-03-12', gueltig_bis: null },
      ],
    });
    vi.spyOn(api, 'messstelle').mockResolvedValue(bestand);
    const put = vi.spyOn(api, 'messstelleBearbeiten').mockResolvedValue({ ...bestand, name: 'Spritzguss SG01–SG06 Kühlkreis' });
    const ort = vi.spyOn(api, 'messstelleOrtAendern');
    const stellung = vi.spyOn(api, 'messstelleStellungAendern');
    zeige({ messstelleId: 'ms-neu' });
    expect(screen.getByRole('dialog', { name: 'Messstelle bearbeiten' })).toBeInTheDocument();
    expect(await screen.findByText('Wirkenergie · Bezug · kWh · Zählerstand')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Hauptgröße *' })).toBeNull();
    expect(api.kennzeichenVorschlag).not.toHaveBeenCalled();

    tippe('Name *', 'Spritzguss SG01–SG06 Kühlkreis');
    fireEvent.click(knopf('Weiter: Zuordnung'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Zuordnung'));
    expect(put).toHaveBeenCalledWith('ms-neu', {
      kennzeichen: 'MS-0022',
      name: 'Spritzguss SG01–SG06 Kühlkreis',
      anschlussleistung_kw: 250,
    });
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    expect(ort).not.toHaveBeenCalled();
    expect(stellung).not.toHaveBeenCalled();
  });
});

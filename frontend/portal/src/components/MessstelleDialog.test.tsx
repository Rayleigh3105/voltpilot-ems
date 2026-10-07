import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import {
  ABLESUNG_ZUKUNFT,
  OHNE_QUELLE_WEITER,
  PFLICHT,
  SATZ_KENNZEICHEN_FORMAT,
  WEG_FRAGE,
  WEG_GESPERRT,
} from '../messstelleDialog';
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
 * zweiter Hauptzähler) mit ihrem WORTLAUT, der Schritt Quelle („Woher kommen die Werte?“ mit den Wegen Gerät und
 * Ablesen) und das Bearbeiten.
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

async function identitaetAusfuellen(wertart: RegExp = /^Zählerstand/) {
  await waitFor(() => expect(feld('Kennzeichen').value).toBe(VORSCHLAG));
  tippe('Name *', 'Spritzguss SG01–SG06 Kühlung');
  await waehle('Hauptgröße *', /^Wirkenergie/);
  await waehle('Richtung *', /^Bezug/);
  await waehle('Wertart *', wertart);
}

const wegKarte = (titel: RegExp) => screen.getByRole('radio', { name: titel }) as HTMLInputElement;
/** `VpTimePicker` übernimmt beim Verlassen des Felds (oder mit Enter). */
function uhrzeit(wert: string) {
  tippe('Uhrzeit *', wert);
  fireEvent.blur(feld('Uhrzeit *'));
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

    // „Woher kommen die Werte?“: zwei gleichwertige Wege, keiner vorgewählt; erst der gewählte zeigt seine Felder.
    expect(screen.getByText(WEG_FRAGE)).toBeInTheDocument();
    expect(wegKarte(/^Automatisch von einem Gerät/).checked).toBe(false);
    expect(wegKarte(/^Von Hand ablesen/).checked).toBe(false);
    expect(screen.queryByRole('combobox', { name: 'Komponente' })).toBeNull();
    fireEvent.click(wegKarte(/^Automatisch von einem Gerät/));
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

  it('„Später festlegen“: eingerichtet ohne Quelle, „noch keine Quelle“ und der Weg dahin, nie eine 0', async () => {
    vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] }));
    const binden = vi.spyOn(api, 'messstelleQuelleBinden');
    const ablesen = vi.spyOn(api, 'ablesungEintragen');
    await bisZuordnung();
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    fireEvent.click(knopf('Später festlegen'));
    expect(await screen.findByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist eingerichtet und aktiv · noch keine Quelle')).toBeInTheDocument();
    expect(screen.getByText(OHNE_QUELLE_WEITER)).toBeInTheDocument();
    expect(binden).not.toHaveBeenCalled();
    expect(ablesen).not.toHaveBeenCalled();
  });

  it('„Von Hand ablesen“: fester Rhythmus „Monatlich“, die erste Ablesung wird eingetragen, danach der Fertig-Satz', async () => {
    vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] }));
    const binden = vi.spyOn(api, 'messstelleQuelleBinden');
    const ablesen = vi.spyOn(api, 'ablesungEintragen').mockResolvedValue({
      urteil: 'eingetragen',
      korrektur: null,
      ablesung: {
        quelle: 'q-1', zeitpunkt: '2026-10-20T08:30:00+02:00', fassung: 1, stand: 1250000, monat: null, woher: 'eingabe',
        urheber: { name: 'Ines Kaltenbach', rolle: null }, korrektur: null, eingetragen_am: '2026-10-20T09:00:00+02:00',
      },
      ablesezeitraum: null,
    });
    const props = await bisZuordnung();
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    fireEvent.click(wegKarte(/^Von Hand ablesen/));
    expect(screen.getByText('Ableserhythmus')).toBeInTheDocument();
    expect(screen.getByText('Monatlich')).toBeInTheDocument();
    expect(screen.getByText('Erste Ablesung')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Komponente' })).toBeNull();
    // Der Ausweg heißt hier „Später eintragen“, nicht „Später binden“.
    expect(knopf('Später eintragen')).toBeInTheDocument();

    // Ohne Stand: der Satz am Feld, der Fokus darauf, nichts gesendet.
    fireEvent.click(knopf('Fertigstellen'));
    expect(await screen.findByText(PFLICHT.stand)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(feld('Zählerstand (kWh) *')));
    expect(ablesen).not.toHaveBeenCalled();

    // Eine Uhrzeit nach „jetzt“ (09:00) liegt in der Zukunft.
    tippe('Zählerstand (kWh) *', '1.250.000');
    uhrzeit('09:30');
    fireEvent.click(knopf('Fertigstellen'));
    expect(await screen.findByText(ABLESUNG_ZUKUNFT)).toBeInTheDocument();
    expect(ablesen).not.toHaveBeenCalled();

    uhrzeit('08:30');
    fireEvent.click(knopf('Fertigstellen'));
    expect(await screen.findByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist eingerichtet und aktiv · wird von Hand abgelesen')).toBeInTheDocument();
    expect(ablesen).toHaveBeenCalledWith('MS-0022', {
      zeitpunkt: '2026-10-20T08:30:00+02:00',
      stand: '1.250.000',
      zuordnung_monat: null,
    });
    expect(binden).not.toHaveBeenCalled();
    expect(props.onGespeichert).toHaveBeenCalled();
  });

  it('„Von Hand ablesen“: lehnt der Server den Stand ab, steht sein Satz am Feld und der Dialog bleibt im Schritt', async () => {
    vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] }));
    const satz = 'Den Zählerstand ab vier Stellen mit Tausenderpunkten eingeben, zum Beispiel 1.250.000 oder 49.451,5.';
    vi.spyOn(api, 'ablesungEintragen').mockRejectedValue(
      new ApiError(422, satz, { code: 'zahl_unlesbar', message: satz, feld: 'stand' }),
    );
    await bisZuordnung();
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    fireEvent.click(wegKarte(/^Von Hand ablesen/));
    tippe('Zählerstand (kWh) *', '1250000');
    uhrzeit('08:30');
    fireEvent.click(knopf('Fertigstellen'));
    expect(await screen.findByText(satz)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(feld('Zählerstand (kWh) *')));
    expect(aktiverSchritt()).toBe('Quelle');
  });

  it('eine Hauptgröße ohne Zählerstand lässt sich nicht ablesen: die Karte bleibt sichtbar und nennt den Grund', async () => {
    vi.spyOn(api, 'messstelleAnlegen').mockResolvedValue(
      messstelleAngelegt({ hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Intervallmenge' } }),
    );
    vi.spyOn(api, 'messstelleOrtAendern').mockResolvedValue(
      messstelleAngelegt({
        lebenszyklus: 'aktiv',
        fehlt: [],
        hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Intervallmenge' },
      }),
    );
    zeige();
    await identitaetAusfuellen(/^Intervallmenge/);
    fireEvent.click(knopf('Weiter: Zuordnung'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Zuordnung'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ort' }).textContent).toContain('Werk Ahrenberg'));
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    expect(wegKarte(/^Von Hand ablesen/).disabled).toBe(true);
    expect(screen.getByText(WEG_GESPERRT.keinZaehlerstand)).toBeInTheDocument();
    expect(wegKarte(/^Automatisch von einem Gerät/).disabled).toBe(false);
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

describe('MessstelleDialog · bearbeiten, Schritt „Woher kommen die Werte?“', () => {
  it('eine Ablesestelle zeigt ihren Weg fest: abgelesen seit …, das Gerät verbindet man auf ihrer Seite', async () => {
    const bestand = messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] });
    vi.spyOn(api, 'messstelle').mockResolvedValue(bestand);
    const register = registerAntwort();
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue({
      ...register,
      register: [
        ...register.register,
        {
          ...register.register[0],
          id: bestand.id,
          kennzeichen: bestand.kennzeichen,
          name: bestand.name,
          quelle: {
            stand: 'ablesung',
            fuehrend: null,
            davor: null,
            vergleichsquellen: 0,
            ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: '2026-10-01T07:15:00+02:00' },
          },
        },
      ],
    });
    const ablesen = vi.spyOn(api, 'ablesungEintragen');
    zeige({ messstelleId: 'ms-neu', schritt: 3 });
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
    await waitFor(() => expect(wegKarte(/^Von Hand ablesen/).checked).toBe(true));
    expect(wegKarte(/^Automatisch von einem Gerät/).disabled).toBe(true);
    expect(screen.getByText(WEG_GESPERRT.schonAbgelesen)).toBeInTheDocument();
    expect(screen.getByText('Wird seit 01.10.2024 von Hand abgelesen, zuletzt am 01.10.2026.')).toBeInTheDocument();
    expect(screen.queryByText('Erste Ablesung')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Später/ })).toBeNull();
    fireEvent.click(knopf('Fertigstellen'));
    expect(await screen.findByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist gespeichert')).toBeInTheDocument();
    expect(ablesen).not.toHaveBeenCalled();
  });
});

describe('MessstelleDialog · öffnen ab einem Schritt (UEMS AP-13 IP-6: „Quelle zuordnen“ aus den Werten)', () => {
  it('beim Bearbeiten öffnet `schritt={3}` gleich die Quelle', async () => {
    vi.spyOn(api, 'messstelle').mockResolvedValue(messstelleAngelegt({ lebenszyklus: 'eingerichtet' }));
    zeige({ messstelleId: 'ms-neu', schritt: 3 });
    expect(screen.getByRole('dialog', { name: 'Messstelle bearbeiten' })).toBeInTheDocument();
    await waitFor(() => expect(aktiverSchritt()).toBe('Quelle'));
  });

  it('beim Anlegen gilt er nicht — eine neue Messstelle beginnt immer mit dem ersten Schritt', async () => {
    zeige({ schritt: 3 });
    await waitFor(() => expect(feld('Kennzeichen').value).toBe(VORSCHLAG));
    expect(aktiverSchritt()).not.toBe('Quelle');
  });
});

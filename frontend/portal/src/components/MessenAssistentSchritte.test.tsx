import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type FunktionStandort, type Messstelle, type MessstellenRegister } from '../api';
import { entwurfLesen, entwurfSchreiben, type EntwurfSpeicher, type MessenSchritt } from '../messenAssistent';
import { ahrenbergFunktionen, funktionWerkLindach } from '../test/funktionenFixtures';
import {
  ahrenbergMessen,
  geraeteAhrenberg,
  registerNachUebernahme,
  uebernommen,
  vorschlagHalle2,
} from '../test/messenAssistentFixtures';
import { ortsbaumAhrenberg } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS } from '../test/standorteFixtures';
import { MessenAssistent } from './MessenAssistent';

/**
 * Die Schritte 3 bis 5 des Assistenten „Messen & Auswerten" (UEMS AP-01 IP-9b) als Fläche: die
 * Vorschlagsliste für WAGO C-1 (Halle 2), die Übernahme über die AP-04-Routen, die Hauptzähler-Regel,
 * die Prüfliste aus Fakten und „Fertig". Die Cloud ist gemockt; die Antworten bildet die Regel aus
 * dem Referenzunternehmen Ahrenberg (`test/messenAssistentFixtures.ts`).
 */

const AHRENBERG = FIXTURE_IDS.st1;

function speicher(): EntwurfSpeicher {
  const daten = new Map<string, string>();
  return {
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k),
  };
}

const funktionenMit = (werk: FunktionStandort) => ahrenbergFunktionen({ standorte: [werk, funktionWerkLindach('bestand')] });

function registerAntwort(register = registerNachUebernahme()): MessstellenRegister {
  return {
    messstellen: [],
    register,
    stichtag: '2026-10-20',
    zeitpunkt: '2026-10-20T08:15:30Z',
    teilansicht: false,
    aggregat: { unternehmen: { erfuellt: 0, gesamt: 0, text: '' }, standorte: [] },
  };
}

let uebernehmen: ReturnType<typeof vi.spyOn<typeof api, 'messstellenVorschlagUebernehmen'>>;
let ortAendern: ReturnType<typeof vi.spyOn<typeof api, 'messstelleOrtAendern'>>;

beforeEach(() => {
  const wartet = registerNachUebernahme({ wartet: ['MS-0003'] });
  vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
  vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen());
  vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit(ahrenbergMessen(wartet)));
  vi.spyOn(api, 'messstellenVorschlag').mockResolvedValue(vorschlagHalle2());
  vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
  uebernehmen = vi
    .spyOn(api, 'messstellenVorschlagUebernehmen')
    .mockImplementation(async (_id, anfrage) => uebernommen(vorschlagHalle2(), anfrage));
  ortAendern = vi.spyOn(api, 'messstelleOrtAendern').mockImplementation(async (id) => ({ id }) as Messstelle);
  vi.spyOn(api, 'messstellenRegister').mockResolvedValue(registerAntwort(wartet));
  vi.spyOn(api, 'listDevices').mockResolvedValue(geraeteAhrenberg(new Date()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const assistent = () => screen.getByRole('dialog', { name: /^Messen & Auswerten/ });
const ansage = () => document.querySelector('.vp-anlegen-sr')?.textContent;
const klick = (name: string) => fireEvent.click(within(assistent()).getByRole('button', { name }));
const schritt3 = () => screen.findByRole('heading', { name: 'Was bedeutet jeder Messkanal?' });
const schritt4 = () => screen.findByRole('heading', { name: 'Ist alles da?' });
const vorschlaege = () => within(assistent()).getByRole('list', { name: 'Vorschläge für Werk Ahrenberg – Halle 2' });
const SATZ_EK2 =
  '„Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)“ ist als Unterzähler von MS-0001 vorgeschlagen — übernehmen Sie diesen Hauptzähler mit.';

/** Öffnet den Assistenten so, wie ihn der Entwurf eines Abbruchs in Schritt `schritt` hinterließ. */
function zeige(schritt: MessenSchritt) {
  const ablage = speicher();
  entwurfSchreiben(ablage, { standortId: AHRENBERG, schritt });
  const onClose = vi.fn();
  render(<MessenAssistent speicher={ablage} onClose={onClose} />);
  return { ablage, onClose };
}

describe('MessenAssistent — Schritt 3 · Messstellen (WAGO C-1)', () => {
  it('zeigt vier Vorschläge: Kennzeichen automatisch, Name, Stellung und Ort', async () => {
    zeige(3);
    await schritt3();
    expect(ansage()).toBe('Schritt 3 von 5: Messstellen');
    await within(assistent()).findByText('4 von 4 Vorschlägen gewählt');
    const karten = within(vorschlaege()).getAllByRole('listitem');
    expect(karten.map((k) => k.getAttribute('data-vorschlag'))).toEqual(['MS-0001', 'MS-0002', 'MS-0003', 'MS-0004']);
    expect(within(karten[0]).getByText('Hauptzähler')).toBeInTheDocument();
    for (const k of karten.slice(1)) expect(within(k).getByText('Unterzähler von MS-0001')).toBeInTheDocument();
    expect(within(karten[0]).getByText('automatisch')).toBeInTheDocument();
    expect((within(karten[1]).getByLabelText('Name') as HTMLInputElement).value).toBe('Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)');
    await waitFor(() => expect(within(karten[0]).getByRole('combobox', { name: 'Ort' }).textContent).toContain('Werk Ahrenberg'));
    expect(within(assistent()).getByText('Nicht vorgeschlagen (4)')).toBeInTheDocument();
  });

  it('übernimmt über die AP-04-Routen: die Zeilen wie gezeigt mit neuem Namen, danach das Gebäude als Korrektur', async () => {
    zeige(3);
    await schritt3();
    const erste = (await within(assistent()).findAllByRole('listitem')).find((k) => k.getAttribute('data-vorschlag') === 'MS-0001')!;
    fireEvent.change(within(erste).getByLabelText('Name'), { target: { value: 'Netzbezug Halle 2' } });
    fireEvent.click(within(erste).getByRole('combobox', { name: 'Ort' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Halle 2\s*Gebäude/ }));
    klick('Übernehmen');
    await schritt4();
    expect(uebernehmen).toHaveBeenCalledTimes(1);
    const [standort, anfrage] = uebernehmen.mock.calls[0];
    expect(standort).toBe(AHRENBERG);
    expect(anfrage.vorschlaege.map((b) => [b.stellung, b.name ?? null])).toEqual([
      ['Hauptzähler', 'Netzbezug Halle 2'],
      ['Unterzähler', null],
      ['Unterzähler', null],
      ['Unterzähler', null],
    ]);
    expect(ortAendern).toHaveBeenCalledTimes(1);
    expect(ortAendern).toHaveBeenCalledWith('ms-ms-0001', { kennzeichen: 'G-2', gueltig_ab: '2026-10-01', korrektur: true });
  });

  it('Hauptzähler-Regel: ohne MS-0001 nennen seine drei Unterzähler den Satz des Servers — und nichts wird gesendet', async () => {
    zeige(3);
    await schritt3();
    fireEvent.click(await within(assistent()).findByRole('checkbox', { name: /MS-0001/ }));
    expect(within(assistent()).getByText('3 von 4 Vorschlägen gewählt')).toBeInTheDocument();
    expect(within(assistent()).getAllByText(/übernehmen Sie diesen Hauptzähler mit\.$/)).toHaveLength(3);
    klick('Übernehmen');
    expect(await within(assistent()).findByRole('alert')).toHaveTextContent(SATZ_EK2);
    expect(uebernehmen).not.toHaveBeenCalled();
    fireEvent.click(within(assistent()).getByRole('checkbox', { name: /MS-0001/ }));
    expect(within(assistent()).queryAllByText(/übernehmen Sie diesen Hauptzähler mit\.$/)).toHaveLength(0);
  });

  it('ein geänderter Vorschlag (409) lädt die Liste neu und nennt den Satz des Servers', async () => {
    uebernehmen.mockRejectedValueOnce(
      new ApiError(409, 'Die Vorschlagsliste hat sich soeben geändert — bitte neu laden.', { code: 'vorschlag_geaendert' }),
    );
    zeige(3);
    await schritt3();
    await within(assistent()).findByText('4 von 4 Vorschlägen gewählt');
    klick('Übernehmen');
    expect(await within(assistent()).findByRole('alert')).toHaveTextContent('Die Vorschlagsliste hat sich soeben geändert — bitte neu laden.');
    await waitFor(() => expect(api.messstellenVorschlag).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { name: 'Was bedeutet jeder Messkanal?' })).toBeInTheDocument();
  });

  it('scheitert ein Ort, stehen die Messstellen trotzdem — der Schritt nennt, welche am Standort bleibt', async () => {
    ortAendern.mockRejectedValueOnce(new ApiError(422, 'Halle 2 gab es an diesem Tag noch nicht.', { code: 'ort_ungueltig' }));
    zeige(3);
    await schritt3();
    const erste = (await within(assistent()).findAllByRole('listitem')).find((k) => k.getAttribute('data-vorschlag') === 'MS-0001')!;
    fireEvent.click(within(erste).getByRole('combobox', { name: 'Ort' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Halle 2\s*Gebäude/ }));
    klick('Übernehmen');
    const hinweis = await within(assistent()).findByTestId('messen-ort-fehler');
    expect(hinweis).toHaveTextContent('4 Messstellen übernommen');
    expect(hinweis).toHaveTextContent('MS-0001 bleibt am Standort Werk Ahrenberg: Halle 2 gab es an diesem Tag noch nicht.');
    klick('Weiter');
    await schritt4();
  });
});

describe('MessenAssistent — Schritt 4 · Prüfen und Schritt 5 · Fertig', () => {
  it('Prüfliste aus Fakten; erst wenn die Regel „aktiv" sagt, geht es weiter — „Fertig" löscht den Entwurf', async () => {
    const { ablage, onClose } = zeige(4);
    await schritt4();
    expect(ansage()).toBe('Schritt 4 von 5: Prüfen');
    const liste = await within(assistent()).findByRole('list', { name: 'Prüfliste' });
    const zeilen = within(liste).getAllByRole('listitem').filter((li) => li.parentElement === liste);
    expect(zeilen.map((z) => [z.getAttribute('data-pruefung'), z.getAttribute('data-bestanden')])).toEqual([
      ['standort', 'ja'],
      ['box', 'ja'],
      ['datenlage', 'nein'],
      ['hauptzaehler', 'ja'],
    ]);
    expect(zeilen[1]).toHaveTextContent('Box Halle 1 und Box Halle 2 verbunden');
    expect(zeilen[2]).toHaveTextContent('4 von 5 Messstellen liefern Daten');
    expect(zeilen[2]).toHaveTextContent('MS-0003 Montage Linie M1: Wartet auf erste Daten · Zähler Energiekarte EK-3 (Montage M1)');
    expect(zeilen[3]).toHaveTextContent('Hauptzähler MS-01 (Werk Ahrenberg – Halle 1), MS-0001 (Werk Ahrenberg – Halle 2)');
    expect(within(assistent()).queryByRole('button', { name: 'Weiter' })).toBeNull();
    expect(within(assistent()).getByRole('button', { name: 'Später fortsetzen' })).toBeInTheDocument();
    expect(entwurfLesen(ablage)).toEqual({ standortId: AHRENBERG, schritt: 4 });

    // Die Karte liefert: dieselben Fakten, jetzt erfüllt.
    const alle = registerNachUebernahme();
    vi.mocked(api.funktionen).mockResolvedValue(funktionenMit(ahrenbergMessen(alle)));
    vi.mocked(api.messstellenRegister).mockResolvedValue(registerAntwort(alle));
    klick('Erneut prüfen');
    await within(assistent()).findByRole('button', { name: 'Weiter' });
    expect(within(assistent()).getByText('5 von 5 Messstellen liefern Daten')).toBeInTheDocument();
    klick('Weiter');
    expect(
      await screen.findByRole('heading', { name: 'Messen & Auswerten ist für Werk Ahrenberg eingerichtet und aktiv.' }),
    ).toBeInTheDocument();
    expect(ansage()).toBe('Schritt 5 von 5: Fertig');
    expect(entwurfLesen(ablage)).toBeNull();
    expect(within(assistent()).queryByRole('button', { name: 'Zurück' })).toBeNull();
    expect(within(assistent()).queryByRole('button', { name: 'Einen Schritt zurück' })).toBeNull();
    expect(within(assistent()).queryByRole('button', { name: /starten/i })).toBeNull();
    expect(within(assistent()).getByRole('button', { name: 'Messstellen ansehen' })).toBeInTheDocument();
    klick('Fertig');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('der Weg einer roten Zeile führt in ihren Schritt', async () => {
    zeige(4);
    await schritt4();
    klick(await within(assistent()).findByRole('button', { name: 'Zur Datenquelle' }).then((b) => b.textContent ?? ''));
    expect(await screen.findByRole('heading', { name: 'Womit wird gemessen?' })).toBeInTheDocument();
  });

  it('kein Schritt spricht von Steuern, Betriebsmodell, Netzladen, Einspeisung oder Geld', async () => {
    const verboten = /steuer|optimier|betriebsmodell|netzladen|einspeis|erlös|€|tarif/i;
    zeige(3);
    await schritt3();
    await within(assistent()).findByText('4 von 4 Vorschlägen gewählt');
    expect(assistent().textContent).not.toMatch(verboten);
    klick('Übernehmen');
    await schritt4();
    await within(assistent()).findByRole('list', { name: 'Prüfliste' });
    expect(assistent().textContent).not.toMatch(verboten);
  });
});

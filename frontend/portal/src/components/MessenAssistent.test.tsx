import { sichtbareListe } from '../test/rollenFixtures';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type ComponentTemplate, type Device, type EdgeVersion, type Site, type SiteComponents } from '../api';
import { entwurfLesen, entwurfSchreiben, messenEinstieg, type EntwurfSpeicher } from '../messenAssistent';
import {
  ahrenbergFunktionen,
  funktionMessenEntwurf,
  funktionWerkAhrenberg,
  funktionWerkLindach,
} from '../test/funktionenFixtures';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandEineAnlage,
  FIXTURE_IDS,
  werkAhrenberg,
  werkLindach,
} from '../test/standorteFixtures';
import { MessenAssistent } from './MessenAssistent';

/**
 * Der Assistent „Messen & Auswerten" (UEMS AP-01 IP-9a) als Fläche — der
 * Prüfnachweis des Reports: Schrittfolge vorwärts und rückwärts mit „Schritt n
 * von 5", Abbruch bewahrt den Entwurf und der Wiedereinstieg landet auf dem
 * richtigen Schritt, Schritt 1 erzeugt die Standort-Funktion genau einmal. Dazu
 * die Wege aus Schritt 2 und die Steuern-/Geld-Regel. Die Cloud ist gemockt, die
 * Antworten sind die des Referenzunternehmens Ahrenberg.
 */

const LINDACH = FIXTURE_IDS.st2;

function speicher(): EntwurfSpeicher {
  const daten = new Map<string, string>();
  return {
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k),
  };
}

const ohneMessen = () => ahrenbergFunktionen({ messen: 'bestand' });
const lindachImEntwurf = () =>
  ahrenbergFunktionen({
    standorte: [funktionWerkAhrenberg('bestand'), funktionMessenEntwurf(funktionWerkLindach('bestand'))],
  });

let einrichten: ReturnType<typeof vi.spyOn<typeof api, 'funktionMessenEinrichten'>>;

beforeEach(() => {
  vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
  vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen());
  vi.spyOn(api, 'funktionen').mockResolvedValue(ohneMessen());
  einrichten = vi.spyOn(api, 'funktionMessenEinrichten').mockResolvedValue({
    aktion: 'einrichten',
    standort: funktionMessenEntwurf(funktionWerkLindach('bestand')),
  });
  vi.spyOn(api, 'listSites').mockResolvedValue(sichtbareListe([{ id: FIXTURE_IDS.an3, name: 'Werk Lindach' } as Site]));
  vi.spyOn(api, 'siteComponents').mockResolvedValue({
    componentAuthority: 'cloud',
    components: [{ id: 'k-1' }, { id: 'k-2' }],
  } as unknown as SiteComponents);
  vi.spyOn(api, 'standortKurzzeichenVorschlag').mockResolvedValue({ kurzzeichen: 'ST-3' });
  vi.spyOn(api, 'componentTemplates').mockResolvedValue([] as ComponentTemplate[]);
  vi.spyOn(api, 'listDevices').mockResolvedValue(sichtbareListe([{
    id: 'box-lindach', siteId: FIXTURE_IDS.an3, externalRef: 'VP-LINDACH', kind: 'edge', name: 'Box Lindach',
    status: 'online', lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  } as Device]));
  vi.spyOn(api, 'edgeVersions').mockResolvedValue(sichtbareListe([{
    deviceId: 'box-lindach', siteId: FIXTURE_IDS.an3, coreVersion: '2.8.0', paletteVersion: '1.14.0',
    reportedAt: new Date().toISOString(), capabilities: ['data_sources', 'events'],
  } as EdgeVersion]));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

/** Die Ansage der Schale: „Schritt 2 von 5: Datenquelle". */
const ansage = () => document.querySelector('.vp-anlegen-sr')?.textContent;
/** Am Rechner „Messen & Auswerten einrichten", am Telefon „Messen & Auswerten". */
const assistent = () => screen.getByRole('dialog', { name: /^Messen & Auswerten/ });
const schritt1 = () => screen.findByRole('heading', { name: 'Wo wird gemessen?' });
const schritt2 = () => screen.findByRole('heading', { name: 'Womit wird gemessen?' });
const klick = (name: string) => fireEvent.click(within(assistent()).getByRole('button', { name }));

function zeige(props: Partial<Parameters<typeof MessenAssistent>[0]> = {}) {
  const ablage = props.speicher ?? speicher();
  const onClose = vi.fn();
  const r = render(<MessenAssistent speicher={ablage} onClose={onClose} {...props} />);
  return { ablage, onClose, ...r };
}

describe('MessenAssistent — Schrittfolge', () => {
  it('geht vorwärts und rückwärts, und „Schritt n von 5" stimmt', async () => {
    zeige({ standortId: LINDACH });
    await schritt1();
    expect(ansage()).toBe('Schritt 1 von 5: Standort');
    const leiste = () => within(assistent()).getByRole('list', { name: 'Schritte' });
    expect(within(leiste()).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1Standort',
      '2Datenquelle',
      '3Messstellen',
      '4Prüfen',
      '5Fertig',
    ]);
    expect(within(leiste()).getByText('Standort').closest('li')).toHaveAttribute('aria-current', 'step');

    klick('Weiter');
    await schritt2();
    expect(ansage()).toBe('Schritt 2 von 5: Datenquelle');
    expect(within(leiste()).getByText('Datenquelle').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(within(leiste()).getByText('Standort').closest('li')).toHaveClass('is-done');

    klick('Zurück');
    await schritt1();
    expect(ansage()).toBe('Schritt 1 von 5: Standort');
  });

  it('am Telefon steht „Schritt n von 5" sichtbar im Kopf, und der Pfeil geht einen Schritt zurück', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('720px'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    zeige({ standortId: LINDACH });
    await schritt1();
    // Neben Pfeil und Kreuz passt nur die Funktion — „… einrichten" würde gekürzt.
    expect(screen.getByRole('dialog', { name: 'Messen & Auswerten' })).toBeInTheDocument();
    expect(document.querySelector('.vp-anlegen-zaehler')?.textContent).toBe('Schritt 1 von 5');
    expect(within(assistent()).queryByRole('button', { name: 'Einen Schritt zurück' })).toBeNull();
    klick('Weiter');
    await schritt2();
    expect(document.querySelector('.vp-anlegen-zaehler')?.textContent).toBe('Schritt 2 von 5');
    expect(within(assistent()).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    klick('Einen Schritt zurück');
    await schritt1();
    expect(document.querySelector('.vp-anlegen-zaehler')?.textContent).toBe('Schritt 1 von 5');
  });

  it('ohne gebauten Schritt 3 endet Schritt 2 mit „Später fortsetzen" — nie mit einem „Weiter" ins Leere', async () => {
    const { onClose } = zeige({ standortId: LINDACH, gebaut: [1, 2] });
    await schritt1();
    klick('Weiter');
    await schritt2();
    expect(within(assistent()).queryByRole('button', { name: 'Weiter' })).toBeNull();
    expect(
      screen.getByText('Ihre Angaben bleiben erhalten. Sie setzen die Einrichtung dort fort, wo Sie aufgehört haben.'),
    ).toBeInTheDocument();
    klick('Später fortsetzen');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MessenAssistent — Abbruch und Wiedereinstieg', () => {
  it('Abbruch bewahrt den Entwurf, und der Wiedereinstieg landet auf dem richtigen Schritt', async () => {
    const ablage = speicher();
    const erst = zeige({ standortId: LINDACH, speicher: ablage });
    await schritt1();
    klick('Weiter');
    await schritt2();
    klick('Schließen');
    expect(erst.onClose).toHaveBeenCalledTimes(1);
    erst.unmount();
    expect(entwurfLesen(ablage)).toEqual({ standortId: LINDACH, schritt: 2 });

    // Später: der Server kennt die Funktion im Entwurf. Die Karte nennt den Schritt …
    vi.mocked(api.funktionen).mockResolvedValue(lindachImEntwurf());
    const lindach = lindachImEntwurf().standorte.find((s) => s.id === LINDACH)!;
    expect(messenEinstieg(lindach, entwurfLesen(ablage))?.text).toBe('Einrichtung fortsetzen (Schritt 2 von 5)');

    // … und der Assistent öffnet genau dort — ohne Vorwahl, nur aus dem Entwurf.
    zeige({ speicher: ablage });
    await schritt2();
    expect(ansage()).toBe('Schritt 2 von 5: Datenquelle');
    expect(within(assistent()).getByText('Werk Lindach (ST-2)')).toBeInTheDocument();
    expect(einrichten).toHaveBeenCalledTimes(1);
  });

  it('ein Abbruch in Schritt 1 behält die Wahl, und der Wiedereinstieg steht wieder auf Schritt 1', async () => {
    const ablage = speicher();
    entwurfSchreiben(ablage, { standortId: LINDACH, schritt: 1 });
    const erst = zeige({ speicher: ablage });
    await schritt1();
    klick('Abbrechen');
    erst.unmount();
    expect(entwurfLesen(ablage)).toEqual({ standortId: LINDACH, schritt: 1 });
    zeige({ speicher: ablage });
    await schritt1();
    expect(within(assistent()).getByRole('combobox', { name: 'Standort' }).textContent).toContain('Werk Lindach');
    expect(einrichten).not.toHaveBeenCalled();
  });

  it('der Server entscheidet vor dem Browser: ist die Funktion schon da, beginnt der Assistent auf Schritt 2', async () => {
    vi.mocked(api.funktionen).mockResolvedValue(lindachImEntwurf());
    zeige({ standortId: LINDACH });
    await schritt2();
    expect(ansage()).toBe('Schritt 2 von 5: Datenquelle');
  });
});

describe('MessenAssistent — Schritt 1 erzeugt die Standort-Funktion genau einmal', () => {
  it('auch bei zweimaligem Durchlaufen', async () => {
    zeige({ standortId: LINDACH });
    await schritt1();
    klick('Weiter');
    await schritt2();
    klick('Zurück');
    await schritt1();
    klick('Weiter');
    await schritt2();
    expect(einrichten).toHaveBeenCalledTimes(1);
    expect(einrichten).toHaveBeenCalledWith(LINDACH);
  });

  it('war ein anderer Weg schneller (409 „bereits angelegt"), geht es ohne Fehler und ohne zweiten Aufruf weiter', async () => {
    einrichten.mockRejectedValue(
      new ApiError(409, 'Messen & Auswerten ist hier bereits angelegt', {
        code: 'bereits_angelegt',
        message: 'Messen & Auswerten ist hier bereits angelegt',
        fehlt: [],
        wege: [],
      }),
    );
    zeige({ standortId: LINDACH });
    await schritt1();
    klick('Weiter');
    await schritt2();
    expect(within(assistent()).queryByRole('alert')).toBeNull();
    klick('Zurück');
    await schritt1();
    klick('Weiter');
    await schritt2();
    expect(einrichten).toHaveBeenCalledTimes(1);
  });

  it('jede andere Ablehnung bleibt auf Schritt 1 und nennt den Satz des Servers', async () => {
    einrichten.mockRejectedValue(
      new ApiError(409, 'Der Standort ist archiviert', {
        code: 'standort_archiviert',
        message: 'Der Standort ist archiviert',
        fehlt: [],
        wege: [],
      }),
    );
    zeige({ standortId: LINDACH });
    await schritt1();
    klick('Weiter');
    expect(await within(assistent()).findByRole('alert')).toHaveTextContent('Der Standort ist archiviert');
    expect(ansage()).toBe('Schritt 1 von 5: Standort');
  });

  it('ohne gewählten Standort sagt Schritt 1, was fehlt, und fragt den Server nicht', async () => {
    zeige();
    await schritt1();
    klick('Weiter');
    expect(await within(assistent()).findByText('Bitte wählen Sie einen Standort.')).toBeInTheDocument();
    expect(einrichten).not.toHaveBeenCalled();
    expect(ansage()).toBe('Schritt 1 von 5: Standort');
  });

  it('nennt unter der Wahl den Zustand von Messen & Auswerten, wie der Server ihn sagt', async () => {
    zeige({ standortId: LINDACH });
    await schritt1();
    expect(within(assistent()).getByText('Messen & Auswerten — noch nicht eingerichtet')).toBeInTheDocument();
  });
});

describe('MessenAssistent — die bestehenden Dialoge', () => {
  it('zeigt heute keinem Kunden den WAGO-Einstieg, solange keine Box den ruhenden Leser meldet', async () => {
    vi.mocked(api.funktionen).mockResolvedValue(lindachImEntwurf());
    zeige({ standortId: LINDACH });
    await schritt2();
    await within(assistent()).findByText('2 Komponenten angebunden');
    expect(within(assistent()).queryByRole('button', { name: /WAGO-Steuerung anbinden/ })).toBeNull();
  });

  it('ohne Standort legt Schritt 1 ihn über den Standort-Dialog aus AP-02 an', async () => {
    vi.mocked(api.standorte).mockResolvedValue({ ...ahrenbergHeute(), standorte: [] });
    zeige();
    await schritt1();
    expect(within(assistent()).getByText('Es gibt noch keinen Standort. Legen Sie ihn zuerst an.')).toBeInTheDocument();
    klick('Neuen Standort anlegen');
    const dialog = await screen.findByRole('dialog', { name: 'Standort anlegen' });
    // Der Unterablauf ERSETZT die Schale (das Haus-Modal läge sonst unter ihr) …
    expect(screen.queryByRole('dialog', { name: 'Messen & Auswerten einrichten' })).toBeNull();
    // … und nach dem Schließen steht der Assistent wieder auf seinem Schritt.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await schritt1();
    expect(ansage()).toBe('Schritt 1 von 5: Standort');
  });

  it('einem Standort im Entwurf fehlt die Adresse — „Adresse nachtragen" öffnet denselben Dialog', async () => {
    const liste = bestandEineAnlage();
    vi.mocked(api.standorte).mockResolvedValue(liste);
    vi.mocked(api.funktionen).mockResolvedValue(ahrenbergFunktionen({ standorte: [] }));
    zeige();
    await schritt1();
    const name = liste.standorte[0].name;
    expect(within(assistent()).getByText(`Für ${name} fehlt noch die Adresse.`)).toBeInTheDocument();
    klick('Adresse nachtragen');
    expect(await screen.findByRole('dialog', { name: 'Standort vervollständigen' })).toBeInTheDocument();
  });

  it('Schritt 2 öffnet je Anlage „Gerät verbinden" und den Komponenten-Assistenten — und steht danach wieder da', async () => {
    vi.mocked(api.funktionen).mockResolvedValue(lindachImEntwurf());
    zeige({ standortId: LINDACH });
    await schritt2();
    expect(await within(assistent()).findByText('2 Komponenten angebunden')).toBeInTheDocument();

    klick('Gerät verbinden für Werk Lindach');
    const geraet = await screen.findByRole('dialog', { name: /Gerät hinzufügen/ });
    expect(screen.queryByRole('dialog', { name: 'Messen & Auswerten einrichten' })).toBeNull();
    fireEvent.click(within(geraet).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Gerät hinzufügen/ })).toBeNull());
    await schritt2();
    expect(ansage()).toBe('Schritt 2 von 5: Datenquelle');

    klick('Gerät anbinden für Werk Lindach');
    const anbinden = await screen.findByRole('dialog', { name: 'Gerät anbinden' });
    expect(screen.queryByRole('dialog', { name: 'Messen & Auswerten einrichten' })).toBeNull();
    fireEvent.click(within(anbinden).getByRole('button', { name: 'Schließen' }));
    await schritt2();
    expect(ansage()).toBe('Schritt 2 von 5: Datenquelle');
  });
});

describe('MessenAssistent — Standort ohne Anlage (Captain 15.09.2026, Empfehlung A)', () => {
  it('nennt den Zustand und den Knopf „Messanlage anlegen" — mit „Anderen Standort wählen" und „Später fortsetzen"', async () => {
    vi.mocked(api.standorte).mockResolvedValue({
      ...ahrenbergHeute(),
      standorte: [werkAhrenberg(), werkLindach({ anlagen: [], anlagenZahl: 0 })],
    });
    vi.mocked(api.funktionen).mockResolvedValue(lindachImEntwurf());
    const { onClose, ablage } = zeige({ standortId: LINDACH });
    await schritt2();
    const leer = within(assistent()).getByTestId('messen-keine-anlage');
    expect(leer).toHaveTextContent('An Werk Lindach hängt noch keine Anlage.');
    expect(leer).toHaveTextContent(
      'Nächster Schritt: Legen Sie hier eine Messanlage an. Sie gehört dann zu Werk Lindach, und die Einrichtung geht hier weiter.',
    );
    expect(within(leer).getAllByRole('button').map((b) => b.textContent)).toEqual(['Messanlage anlegen']);
    expect(within(assistent()).getByRole('button', { name: 'Zurück' })).toBeInTheDocument();

    klick('Später fortsetzen');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(entwurfLesen(ablage)).toEqual({ standortId: LINDACH, schritt: 2 });
    klick('Anderen Standort wählen');
    await schritt1();
  });
});

describe('MessenAssistent — Steuern- und Geld-Regel', () => {
  it('kein Schritt spricht von Steuern, Betriebsmodell, Netzladen, Einspeisung oder Geld', async () => {
    const verboten = /steuer|optimier|betriebsmodell|netzladen|einspeis|erlös|€|tarif/i;
    zeige({ standortId: LINDACH });
    await schritt1();
    expect(assistent().textContent).not.toMatch(verboten);
    klick('Weiter');
    await schritt2();
    await within(assistent()).findByText('2 Komponenten angebunden');
    expect(assistent().textContent).not.toMatch(verboten);
  });
});

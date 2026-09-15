import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Messstelle } from '../api';
import {
  ahrenbergBezugsgroessen,
  ahrenbergKostenstellen,
  ahrenbergProzesse,
  angelegteKennzahl,
  kennzahlVorschauAntwort,
} from '../test/kennzahlAnlegenFixtures';
import { ahrenbergKennzahlen } from '../test/kennzahlenFixtures';
import { fassungenVon } from '../test/kennzahlWerteFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS, werkLindach } from '../test/standorteFixtures';
import { KennzahlAnlegenDialog } from './KennzahlAnlegenDialog';

/**
 * Der Assistent „Kennzahl anlegen“ und das Kopieren (UEMS AP-11 IP-14, §5.1, §5.2, §5.6) mit den Antworten des
 * Referenzunternehmens Ahrenberg. Die wichtigste Zusicherung: vor „Anlegen“ ruft der Assistent NUR die Vorschau —
 * `POST /api/v1/kennzahlen` fällt genau einmal, auf den Knopf, mit derselben Anfrage (K1, K20).
 *
 * Der Gesamtwert-Assistent ist hier eine Attrappe: sein eigener Test ist `GesamtwertDialog.test.tsx`; geprüft wird nur,
 * dass der Hebel ihn für die richtige Anlage öffnet und mit dem neuen Gesamtwert zurückkehrt.
 */
vi.mock('./GesamtwertDialog', async () => {
  const { createElement } = await import('react');
  const neu = { id: 'c0de0000-0000-4000-8000-0000000d0023', kennzeichen: 'MS-23', name: 'Montage gesamt', art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [], notiz: null };
  return {
    GesamtwertDialog: (p: { siteId: string; onClose: () => void; onGespeichert?: (m: Messstelle) => void }) =>
      createElement(
        'div',
        { 'data-testid': 'gesamtwert-attrappe', 'data-anlage': p.siteId },
        createElement('button', { type: 'button', onClick: () => { p.onGespeichert?.(neu); p.onClose(); } }, 'Gesamtwert speichern'),
      ),
  };
});

const NB = String.fromCharCode(160);
const JETZT = new Date('2026-11-10T08:00:00Z');

function verdrahte() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(JETZT);
  const register = vi.spyOn(api, 'messstellenRegister').mockImplementation(async () => ahrenbergRegister());
  vi.spyOn(api, 'bezugsgroessen').mockImplementation(async () => ahrenbergBezugsgroessen());
  vi.spyOn(api, 'unternehmen').mockImplementation(async () => ahrenbergUnternehmen());
  vi.spyOn(api, 'standorte').mockImplementation(async () => ahrenbergHeute());
  vi.spyOn(api, 'standortOrte').mockImplementation(async (id) => (id === werkLindach().id ? ortsbaumLindach() : ortsbaumAhrenberg()));
  vi.spyOn(api, 'prozesse').mockImplementation(async () => ({ stichtag: null, prozesse: ahrenbergProzesse() }));
  vi.spyOn(api, 'kostenstellen').mockImplementation(async () => ({ stichtag: null, kostenstellen: ahrenbergKostenstellen() }));
  vi.spyOn(api, 'kennzahlen').mockImplementation(async () => ({ kennzahlen: ahrenbergKennzahlen() }));
  const vorschau = vi.spyOn(api, 'kennzahlVorschau').mockImplementation(async (a) => kennzahlVorschauAntwort(a, Date.now()));
  const anlegen = vi.spyOn(api, 'kennzahlAnlegen').mockImplementation(async (a) =>
    angelegteKennzahl(a, 'KZ-0009', 'Halle 2', Date.now(), 'Ines Kaltenbach'),
  );
  return { register, vorschau, anlegen };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const weiterKnopf = () => screen.getByRole('button', { name: 'Weiter' }) as HTMLButtonElement;
const weiter = () => fireEvent.click(weiterKnopf());

async function waehle(feld: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: feld }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

async function bisSchritt4(vorlage = /^Stromeinsatz je Stück/) {
  fireEvent.click(await screen.findByRole('radio', { name: vorlage }));
  weiter();
  await waehle('Menge', /^MS-12 Montage Linie M1/);
  weiter();
  await waehle('Bezugsgröße', /^BZ-6 Gutteile Montage Halle 2/);
  await screen.findByText('BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
  weiter();
  await screen.findByDisplayValue('Stromeinsatz je Stück — Halle 2');
}

describe('KennzahlAnlegenDialog', () => {
  it('KZ aus der Vorlage „Stromeinsatz je Stück“ — K13 sofort unter der Auswahl, vor „Anlegen“ nur die Vorschau', async () => {
    const { vorschau, anlegen } = verdrahte();
    const angelegt = vi.fn();
    render(<KennzahlAnlegenDialog open angemeldet="Ines Kaltenbach" onClose={() => undefined} onAngelegt={angelegt} />);

    expect(screen.getByText('Eine Vorlage wählen — oder ohne Vorlage')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(weiterKnopf().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /^Stromeinsatz je Stück/ }));
    weiter();

    expect(await screen.findByText('Schritt 2 von 5 · Menge')).toBeTruthy();
    await waehle('Menge', /^MS-12 Montage Linie M1/);
    weiter();

    await waehle('Bezugsgröße', /^BZ-6 Gutteile Montage Halle 2/);
    expect(await screen.findByText('BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet')).toBeTruthy();
    expect(screen.getByText('Einheit aus den Eingängen: kWh je Stück')).toBeTruthy();
    // K13 Versuch 1: je Tag — der rote Satz des Zwillings, „Weiter“ gesperrt.
    fireEvent.click(screen.getByRole('radio', { name: 'Tag' }));
    expect(
      screen.getByText('BZ-6 Gutteile Montage Halle 2 führt Monatswerte. Eine Kennzahl je Tag ist damit nicht bildbar — ein Monatswert wird nie auf Tage verteilt.'),
    ).toBeTruthy();
    expect(weiterKnopf().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Monat' }));
    expect(weiterKnopf().disabled).toBe(false);
    weiter();

    // Schritt 4: Halle 2 vorgeschlagen, Name und Verantwortlich vorbelegt, der Rechte-Geltungsbereich angezeigt.
    expect(await screen.findByDisplayValue('Stromeinsatz je Stück — Halle 2')).toBeTruthy();
    expect(screen.getByDisplayValue('Ines Kaltenbach')).toBeTruthy();
    expect(screen.getByDisplayValue('Spezifischer Stromeinsatz je gutem Stück')).toBeTruthy();
    expect(screen.getByTestId('kennzahl-rechte').textContent).toContain('Standort Werk Ahrenberg');
    expect(vorschau).not.toHaveBeenCalled();
    weiter();

    // Schritt 5: die letzten drei abgeschlossenen Perioden, read-only.
    const perioden = await screen.findAllByTestId('kennzahl-vorschau-periode');
    expect(perioden.map((p) => p.textContent?.split(NB).join(' '))).toEqual([
      'Oktober 2026vollständig0,15 kWh je Stückberechnet (Kennzahl)',
      'September 2026vor dem Bestehen—',
      'August 2026vor dem Bestehen—',
    ]);
    expect(vorschau).toHaveBeenCalledTimes(1);
    expect(anlegen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    expect(await screen.findByText('KZ-0009 angelegt · Fassung 1 gilt seit Beginn')).toBeTruthy();
    expect(anlegen).toHaveBeenCalledTimes(1);
    expect(anlegen.mock.calls[0][0]).toEqual(vorschau.mock.calls[0][0]);
    expect(anlegen.mock.calls[0][0]).toMatchObject({
      kennzeichen: null,
      name: 'Stromeinsatz je Stück — Halle 2',
      rechenform: 'quotient',
      geltung_art: 'gebaeude',
      verantwortlich_name: 'Ines Kaltenbach',
      periode_art: null,
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', kennzeichen: 'MS-12' },
        { rolle: 'nenner', art: 'bezugsgroesse', kennzeichen: 'BZ-6' },
      ],
    });
    expect(angelegt).toHaveBeenCalledTimes(1);
  });

  it('zwei Messstellen: der Hebel öffnet den Gesamtwert-Assistenten für die Anlage und kehrt mit dem Gesamtwert zurück', async () => {
    const { register } = verdrahte();
    const mitNeuem = ahrenbergRegister();
    const ms15 = mitNeuem.register.find((z) => z.kennzeichen === 'MS-15')!;
    mitNeuem.register.push({ ...ms15, id: 'c0de0000-0000-4000-8000-0000000d0023', kennzeichen: 'MS-23', name: 'Montage gesamt' });
    register.mockImplementation(async () => (register.mock.calls.length > 1 ? mitNeuem : ahrenbergRegister()));
    render(<KennzahlAnlegenDialog open angemeldet="Ines Kaltenbach" onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('radio', { name: /^Stromeinsatz je Stück/ }));
    weiter();
    await waehle('Menge', /^MS-12 Montage Linie M1/);
    fireEvent.click(await screen.findByRole('option', { name: /^MS-18 Montagehalle Lindach gesamt/ }));

    const hebel = await screen.findByTestId('kennzahl-hebel-gesamtwert');
    expect(hebel.textContent).toContain('Mehrere Messstellen? Legen Sie zuerst einen Gesamtwert an');
    expect(hebel.textContent).toContain('Der Gesamtwert entsteht an der Anlage Werk Ahrenberg – Halle 2.');
    expect(weiterKnopf().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Gesamtwert anlegen' }));
    const attrappe = screen.getByTestId('gesamtwert-attrappe');
    expect(attrappe.getAttribute('data-anlage')).toBe(FIXTURE_IDS.an2);
    fireEvent.click(screen.getByRole('button', { name: 'Gesamtwert speichern' }));

    await waitFor(() => expect(screen.queryByTestId('gesamtwert-attrappe')).toBeNull());
    await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(weiterKnopf().disabled).toBe(false));
    expect(screen.queryByTestId('kennzahl-hebel-gesamtwert')).toBeNull();
    expect(screen.getByTestId('kennzahl-anlegen').textContent).toContain('MS-23 Montage gesamt');
  });

  it('Kopieren: Form, Name mit dem neuen Geltungsbereich und Zweck übernommen — Eingänge und Verantwortlich neu', async () => {
    const { vorschau } = verdrahte();
    const kz1 = ahrenbergKennzahlen()[0];
    render(
      <KennzahlAnlegenDialog open quelle={{ kennzahl: kz1, fassungen: fassungenVon(kz1.id) }} angemeldet="Peter Hollerbach" onClose={() => undefined} />,
    );
    expect(screen.getByText('Kopie von KZ-0001')).toBeTruthy();
    expect(screen.getByText('Kennzahl kopieren')).toBeTruthy();
    expect(screen.getByTestId('kennzahl-kopie-quelle').textContent).toContain('Stromeinsatz Montage je Stück — Halle 2');
    expect(weiterKnopf().disabled).toBe(false);
    weiter();

    await waehle('Menge', /^MS-18 Montagehalle Lindach gesamt/);
    weiter();
    await waehle('Bezugsgröße', /^BZ-7 Gutteile Montage Lindach/);
    await screen.findByText('BZ-7 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
    weiter();

    expect(await screen.findByDisplayValue('Stromeinsatz Montage je Stück — Montagehalle Lindach')).toBeTruthy();
    expect(screen.getByDisplayValue(kz1.zweck!)).toBeTruthy();
    expect(screen.getByDisplayValue('Peter Hollerbach')).toBeTruthy();
    expect(screen.getByTestId('kennzahl-rechte').textContent).toContain('Standort Werk Lindach');
    weiter();

    const oktober = (await screen.findAllByTestId('kennzahl-vorschau-periode'))[0];
    expect(oktober.textContent?.split(NB).join(' ')).toBe('Oktober 2026vollständig0,50 kWh je Stückberechnet (Kennzahl) · ab 15.10.2026');
    expect(vorschau.mock.calls[0][0]).toMatchObject({
      name: 'Stromeinsatz Montage je Stück — Montagehalle Lindach',
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', kennzeichen: 'MS-18' },
        { rolle: 'nenner', art: 'bezugsgroesse', kennzeichen: 'BZ-7' },
      ],
    });
  });

  it('eine abgelehnte Vorschau (403) spricht den Satz der Route und lässt „Anlegen“ gesperrt', async () => {
    const { vorschau, anlegen } = verdrahte();
    vorschau.mockRejectedValue(new ApiError(403, 'Dafür braucht es die Rolle Energiemanager oder Kundenadministrator.'));
    render(<KennzahlAnlegenDialog open angemeldet="Murat Demirci" onClose={() => undefined} />);
    await bisSchritt4();
    weiter();
    expect(await screen.findByText('Dafür braucht es die Rolle Energiemanager oder Kundenadministrator.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Anlegen' }) as HTMLButtonElement).disabled).toBe(true);
    expect(anlegen).not.toHaveBeenCalled();
  });

  it('Kennzahlen zusammenfassen: Schritt 2 wählt Kennzahlen, Schritt 3 entfällt, das Unternehmen ist vorgeschlagen', async () => {
    verdrahte();
    render(<KennzahlAnlegenDialog open angemeldet="Ines Kaltenbach" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Ohne Vorlage/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Kennzahlen zusammenfassen/ }));
    weiter();

    expect(await screen.findByText('Schritt 2 von 5 · Kennzahlen')).toBeTruthy();
    await waehle('Kennzahlen', /^KZ-0001/);
    expect(await screen.findByText('Eine Zusammenfassung braucht mindestens zwei Kennzahlen.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('option', { name: /^KZ-0002/ }));
    expect(await screen.findByText('gewichtet (Summe ÷ Summe) · kWh je Stück')).toBeTruthy();
    weiter();

    expect(await screen.findByText('Schritt 4 von 5 · Geltungsbereich')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Geltungsbereich' }).textContent).toContain('Kunststoffwerk Ahrenberg GmbH'));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    expect(await screen.findByText('Schritt 2 von 5 · Kennzahlen')).toBeTruthy();
  });
});

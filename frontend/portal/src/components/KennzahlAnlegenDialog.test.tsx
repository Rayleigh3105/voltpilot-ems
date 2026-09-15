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
import { fassungenK17, K17_BEGRUENDUNG, k17VorschauAntwort, KZ4_ID, kz0004, mitMs24 } from '../test/kennzahlAendernFixtures';
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

/**
 * AP-11 IP-15 (§5.4, K17): derselbe Assistent als „Berechnung ändern ab …“ an KZ-0004 — Zahlen aus Ahrenberg und K17
 * (`test/kennzahlAendernFixtures.ts`). Die Zusicherung wie beim Anlegen: vor „Speichern“ ruft er NUR die Vorschau
 * (zweimal: neu und bisher); `POST …/fassungen` fällt genau einmal, auf den Knopf.
 */
describe('KennzahlAnlegenDialog · „Berechnung ändern ab …“ (IP-15)', () => {
  const APRIL = new Date('2027-04-01T09:31:00+02:00');
  const MS24 = [
    { rolle: 'zaehler', art: 'messstelle', kennzeichen: 'MS-24' },
    { rolle: 'nenner', art: 'bezugsgroesse', kennzeichen: 'BZ-1' },
  ];
  const speichernKnopf = () => screen.getByRole('button', { name: 'Speichern' }) as HTMLButtonElement;
  const begruendung = () => screen.getByLabelText('Begründung') as HTMLInputElement;

  function verdrahteK17(jetzt: Date) {
    const alle = verdrahte();
    vi.setSystemTime(jetzt);
    alle.register.mockImplementation(async () => mitMs24(ahrenbergRegister()));
    vi.spyOn(api, 'kennzahlen').mockImplementation(async () => ({ kennzahlen: [...ahrenbergKennzahlen(), kz0004('vorher')] }));
    alle.vorschau.mockImplementation(async (a) => k17VorschauAntwort(a, Date.now()) ?? kennzahlVorschauAntwort(a, Date.now()));
    const eintragen = vi
      .spyOn(api, 'kennzahlFassungEintragen')
      .mockImplementation(async (id) => ({ kennzahl_id: id, kennzeichen: 'KZ-0004', fassungen: fassungenK17('nachher') }));
    return { ...alle, eintragen };
  }

  it('K17: der Tag mit „rückwirkend (31 Tage)“, MS-24 statt MS-20, neu und bisher nebeneinander, Begründung Pflicht — nur „Speichern“ schreibt', async () => {
    const { vorschau, anlegen, eintragen } = verdrahteK17(APRIL);
    const geaendert = vi.fn();
    render(
      <KennzahlAnlegenDialog
        open
        aendern={{ kennzahl: kz0004('vorher'), fassungen: fassungenK17('vorher') }}
        angemeldet="Ines Kaltenbach"
        onClose={() => undefined}
        onGeaendert={geaendert}
      />,
    );

    expect(screen.getByText('Schritt 1 von 4 · Gilt ab')).toBeTruthy();
    expect(screen.getByTestId('kennzahl-heute-gilt').textContent).toBe('Heute gilt: Menge je Bezugsgröße · MS-20 je BZ-1 · Fassung 1 gilt seit Beginn');
    expect(screen.getByTestId('kennzahl-gilt-ab').textContent).toBe('Fassung 2 gilt ab heute — Fassung 1 endet am 31.03.2027.');
    fireEvent.click(screen.getByRole('combobox', { name: 'Gilt ab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Voriger Monat' }));
    fireEvent.click(screen.getAllByRole('gridcell', { name: '1' })[0]);
    await waitFor(() =>
      expect(screen.getByTestId('kennzahl-gilt-ab').textContent).toBe('Fassung 2 gilt ab 01.03.2027 — Fassung 1 endet am 28.02.2027.rückwirkend (31 Tage)'),
    );
    weiter();

    expect(await screen.findByText('Schritt 2 von 4 · Menge')).toBeTruthy();
    expect(screen.getByText('Vorbelegt mit den Eingängen von heute — ändern Sie, was die neue Fassung anders rechnet.')).toBeTruthy();
    expect(weiterKnopf().disabled).toBe(false);
    await waehle('Menge', /^MS-24 Spritzguss inkl. Kühlung/);
    fireEvent.click(await screen.findByRole('option', { name: /^MS-20 Prozess Spritzguss gesamt/ }));
    await waitFor(() => expect(weiterKnopf().disabled).toBe(false));
    weiter();

    expect(await screen.findByText('Schritt 3 von 4 · Bezugsgröße')).toBeTruthy();
    expect(await screen.findByText('BZ-1 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet')).toBeTruthy();
    expect(vorschau).not.toHaveBeenCalled();
    weiter();

    expect(await screen.findByText('Schritt 4 von 4 · Vorschau')).toBeTruthy();
    expect((await screen.findByTestId('kennzahl-vergleich-satz')).textContent).toBe('März 2027: 0,30 statt 0,29');
    expect(screen.getByTestId('kennzahl-wirkung').textContent).toBe('Ab März 2027 gilt Fassung 2 — Februar 2027 und früher bleiben bei Fassung 1.');
    expect(screen.getAllByTestId('kennzahl-vergleich-seite').map((s) => s.textContent)).toEqual([
      'Fassung 2 · neuvollständig0,30',
      'Fassung 1 · bishervollständig0,29',
    ]);
    expect(vorschau).toHaveBeenCalledTimes(2);
    expect(vorschau.mock.calls.map(([a]) => a.eingaenge.map((e) => e.kennzeichen).join(' je ')).sort()).toEqual(['MS-20 je BZ-1', 'MS-24 je BZ-1']);
    expect(speichernKnopf().disabled).toBe(true);
    fireEvent.change(begruendung(), { target: { value: 'Kühlung' } });
    expect(screen.getByText('Noch 3 Zeichen — warum rechnet die Kennzahl ab diesem Tag anders?')).toBeTruthy();
    expect(speichernKnopf().disabled).toBe(true);
    fireEvent.change(begruendung(), { target: { value: K17_BEGRUENDUNG } });
    expect(speichernKnopf().disabled).toBe(false);
    expect(eintragen).not.toHaveBeenCalled();
    fireEvent.click(speichernKnopf());

    const fertig = await screen.findByTestId('kennzahl-fertig');
    expect(eintragen).toHaveBeenCalledTimes(1);
    expect(eintragen).toHaveBeenCalledWith(KZ4_ID, {
      gueltig_ab: '2027-03-01',
      begruendung: K17_BEGRUENDUNG,
      periode_art: null,
      komplement: null,
      eingaenge: MS24,
    });
    expect(fertig.textContent).toContain('Fassung 2 gilt seit 01.03.2027');
    expect(fertig.textContent).toContain('rückwirkend (19 Tage)');
    expect(geaendert).toHaveBeenCalledTimes(1);
    expect(anlegen).not.toHaveBeenCalled();
    expect(vorschau).toHaveBeenCalledTimes(2);
  });

  it('dieselben Eingänge wie heute: der Satz steht und „Speichern“ bleibt aus — auch mit Begründung', async () => {
    const { eintragen } = verdrahteK17(APRIL);
    render(<KennzahlAnlegenDialog open aendern={{ kennzahl: kz0004('vorher'), fassungen: fassungenK17('vorher') }} onClose={() => undefined} />);
    weiter();
    weiter();
    await screen.findByText('BZ-1 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
    weiter();
    expect(await screen.findByTestId('kennzahl-unveraendert')).toBeTruthy();
    expect((await screen.findByTestId('kennzahl-vergleich-satz')).textContent).toBe('März 2027: 0,29 — wie bisher');
    fireEvent.change(begruendung(), { target: { value: K17_BEGRUENDUNG } });
    expect(speichernKnopf().disabled).toBe(true);
    expect(eintragen).not.toHaveBeenCalled();
  });

  it('K17 noch einmal ab 01.03.2027: „Ab diesem Tag gilt schon Fassung 2.“ — „Weiter“ bleibt aus', async () => {
    verdrahteK17(new Date('2027-03-01T09:40:00+01:00'));
    render(<KennzahlAnlegenDialog open aendern={{ kennzahl: kz0004('nachher'), fassungen: fassungenK17('nachher') }} onClose={() => undefined} />);
    expect(await screen.findByText('Ab diesem Tag gilt schon Fassung 2.')).toBeTruthy();
    expect(screen.queryByTestId('kennzahl-gilt-ab')).toBeNull();
    expect(weiterKnopf().disabled).toBe(true);
  });
});

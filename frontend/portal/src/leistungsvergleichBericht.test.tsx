import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type BerichtAnlegen } from './api';
import { anlegenAnfrage, anlegenFehler, anlegenPruefen, vorlageKarten, type BerichtRechte } from './berichtDialoge';
import { BerichtAnlegenDialog } from './components/BerichtAnlegenDialog';
import { LeistungsvergleichBericht } from './components/LeistungsvergleichBericht';
import { UEMS_NORMGRENZE } from './glossar';
import {
  ABSCHNITTE,
  basisZeilen,
  FEHLT_KENNZAHL,
  KEINE_ENERGIELEISTUNG,
  kennzahlWahlen,
  kopfZeilen,
  quellenZeilen,
  standSatz,
} from './leistungsvergleichBericht';
import { BerichtSeite } from './pages/BerichtSeite';
import { setSelbstauskunft } from './rollen';
import { selbstauskunftFuer } from './test/berichtFixtures';
import { abzugR8, basisFehlt, KZ4, lvBuehne, lvDetail, lvKennzahlen, lvStand } from './test/leistungsvergleichFixtures';
import { ahrenbergUnternehmen, werkAhrenberg } from './test/standorteFixtures';

const RECHTE: BerichtRechte = { standorte: new Map(), unternehmen: ['bericht.unternehmen', 'export.unternehmen'] };
const JETZT = Date.parse('2028-01-12T08:00:00Z');

afterEach(() => {
  vi.restoreAllMocks();
  setSelbstauskunft(null);
});

describe('AP-17 IP-24 · Kennzahl-Wahl des Leistungsvergleichs', () => {
  it('bietet nur Kennzahlen mit freigegebener Bezugsbasis an — beantragt und ohne Basis fehlen', () => {
    const wahl = kennzahlWahlen(lvKennzahlen(), 'unternehmen', 'u');
    expect(wahl.map((k) => k.kennzeichen)).toEqual(['KZ-0004']);
    expect(wahl[0].basis).toBe('Bezugsbasis BB-0001, Fassung 2');
    // Am Standort nur die Kennzahlen dieses Standorts (der Leser antwortet sonst 404).
    expect(kennzahlWahlen(lvKennzahlen(), 'standort', werkAhrenberg().id)).toEqual([]);
  });

  it('die Karte „Leistungsvergleich“ bietet Unternehmen und Standort, Monat, Jahr und Datengrundlage', () => {
    const karte = vorlageKarten(RECHTE, []).find((k) => k.schluessel === 'leistungsvergleich')!;
    expect(karte.geltungArten).toEqual(['unternehmen', 'standort']);
    expect(karte.zeitraumArten).toEqual(['monat', 'jahr', 'datengrundlage']);
    expect(karte.abschnitte).toContain('Vergleich je Periode');
  });

  it('Kennzahl ist Pflicht (sonst 400) und reist allein — ohne Abwahl', () => {
    const w = { vorlage: 'leistungsvergleich', geltungId: 'u', zeitraum: '2027-12', abgewaehlt: ['x'] };
    expect(anlegenPruefen(w)).toEqual({ kennzahl: FEHLT_KENNZAHL });
    expect(anlegenPruefen({ ...w, kennzahl: KZ4 })).toEqual({});
    expect(anlegenAnfrage({ ...w, kennzahl: KZ4 }, ['x'])).toEqual({ vorlage: 'leistungsvergleich', geltung_id: 'u', zeitraum: '2027-12', kennzahl: KZ4 });
    // Jede andere Vorlage bleibt, wie sie war — ohne `kennzahl`.
    expect(anlegenAnfrage({ ...w, vorlage: 'monatsbericht_unternehmen', kennzahl: KZ4 }, ['x'])).toEqual({
      vorlage: 'monatsbericht_unternehmen', geltung_id: 'u', zeitraum: '2027-12', kennzahlen_abgewaehlt: ['x'],
    });
  });

  it('422 basis_fehlt spricht den Satz der Route', () => {
    expect(anlegenFehler(basisFehlt()).satz).toMatch(/^ungesichert — noch kein Stand/);
  });
});

describe('AP-17 IP-24 · Anlegen-Dialog', () => {
  const oeffne = (kennzahlen = lvKennzahlen()) => {
    vi.spyOn(api, 'standorte').mockResolvedValue({ standorte: [werkAhrenberg()] } as Awaited<ReturnType<typeof api.standorte>>);
    vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen());
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen } as Awaited<ReturnType<typeof api.kennzahlen>>);
    const angelegt: BerichtAnlegen[] = [];
    vi.spyOn(api, 'berichtAnlegen').mockImplementation(async (b) => {
      angelegt.push(b);
      return lvDetail(null).bericht;
    });
    const onAngelegt = vi.fn();
    render(<BerichtAnlegenDialog open onClose={() => undefined} rechte={RECHTE} jetzt={() => JETZT} onAngelegt={onAngelegt} onOeffnen={() => undefined} />);
    return { angelegt, onAngelegt };
  };

  it('verlangt die Kennzahl, bevor es sendet, und schickt sie dann mit', async () => {
    const { angelegt, onAngelegt } = oeffne();
    // Wie die Spec: genau eine Karte beginnt mit „Leistungsvergleich“, genau ein Knopf heißt „Anlegen“.
    expect(await screen.findAllByRole('radio', { name: /^Leistungsvergleich/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Anlegen' })).toHaveLength(1);
    fireEvent.click(await screen.findByRole('radio', { name: /Leistungsvergleich/ }));
    const gruppe = await screen.findByTestId('bericht-anlegen-kennzahl');
    expect(within(gruppe).getAllByRole('radio')).toHaveLength(1);
    expect(within(gruppe).getByText('KZ-0004')).toBeTruthy();
    expect(screen.queryByTestId('bericht-anlegen-kennzahlen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    expect(await within(gruppe).findByText(FEHLT_KENNZAHL)).toBeTruthy();
    expect(angelegt).toEqual([]);
    fireEvent.click(within(gruppe).getByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => expect(onAngelegt).toHaveBeenCalled());
    expect(angelegt).toEqual([{ vorlage: 'leistungsvergleich', geltung_id: ahrenbergUnternehmen().id, zeitraum: '2027-12', kennzahl: KZ4 }]);
  });

  it('ohne Energieleistungskennzahl steht der Leer-Satz mit dem Weg zum Reiter Bezugsbasis', async () => {
    oeffne(lvKennzahlen().filter((k) => k.id !== KZ4));
    fireEvent.click(await screen.findByRole('radio', { name: /Leistungsvergleich/ }));
    expect((await screen.findByTestId('bericht-anlegen-kennzahl-leer')).textContent).toBe(KEINE_ENERGIELEISTUNG);
    expect(KEINE_ENERGIELEISTUNG).toMatch(/^ungesichert — noch kein Stand/);
  });
});

describe('AP-17 IP-24 · der Abzug in der Bericht-Fläche (R8)', () => {
  it('Kopf mit Berichts- und Referenzperiode, Basis in Kundenwort, Quellen mit Version bzw. Fassung', () => {
    const a = abzugR8();
    expect(kopfZeilen(a)).toContainEqual({ name: 'Berichtsperiode', wert: 'Dezember 2027' });
    expect(kopfZeilen(a)).toContainEqual({ name: 'Referenzperiode', wert: 'November 2026 bis Oktober 2027' });
    const basis = basisZeilen(a);
    expect(basis).toContainEqual({ name: 'Methode', wert: 'Modell mit einer Einflussgröße' });
    expect(basis).toContainEqual({ name: 'Koeffizienten', wert: 'Grundlast 10 523 · b 0,2343' });
    expect(basis).toContainEqual({ name: 'Streuung', wert: '± 0,8 %' });
    expect(basis).toContainEqual({ name: 'Freigegeben', wert: 'Ines Kaltenbach (energiemanager) am 24.11.2027' });
    expect(quellenZeilen(a).map((q) => q.wert)).toEqual([
      'Stromeinsatz Spritzguss je kg · Version 1 · unmittelbar · 01.12.2027–31.12.2027',
      'Spritzguss Halle 1 · Version 1 · mittelbar · 01.12.2027–31.12.2027',
      'Produktionsmenge · Fassung 1 · mittelbar · 01.12.2027–31.12.2027',
      'Bezugsbasis BB-0001 · Fassung 2 · Vergleich · 01.12.2027–31.12.2027',
    ]);
  });

  it('der Stand-Satz aus §5.8 — und am Entwurf ohne Stand „ungesichert — noch kein Stand“', () => {
    const a = abzugR8();
    expect(standSatz(a, lvDetail(1), lvStand())).toBe(
      'Leistungsvergleich Stromeinsatz Spritzguss je kg, Dezember 2027 · Stand Nr. 1 vom 12.01.2028 · Bezugsbasis BB-0001, Fassung 2 · Prüfsumme 4e2d…',
    );
    expect(standSatz(a, lvDetail(null), null)).toBe('ungesichert — noch kein Stand');
    expect(standSatz(a, lvDetail(1), null)).toBeNull();
  });

  it('rendert die acht Abschnitte mit der Tafel von IP-20: roh ohne Urteil, bereinigt mit Band', () => {
    render(<LeistungsvergleichBericht abzug={abzugR8()} detail={lvDetail(null)} stand={null} rechte={RECHTE} />);
    for (const s of ABSCHNITTE) expect(screen.getByTestId(`bericht-abschnitt-${s}`)).toBeTruthy();
    expect(ABSCHNITTE).toHaveLength(8);
    const monat = screen.getByTestId('monat-2027-12');
    expect(within(monat).getByTestId('roh-urteil').textContent).toBe('ohne Urteil');
    expect(within(monat).getByTestId('erwartet').textContent).toBe('69 098 kWh');
    expect(within(monat).getByTestId('urteil').textContent).toBe('schlechter (± 2 %)');
    expect(within(screen.getByTestId('bericht-abschnitt-urteil')).getByTestId('zeitraum-satz').textContent).toMatch(/12,9 % mehr/);
    expect(screen.getByTestId('leistungsvergleich-stand').textContent).toBe('ungesichert — noch kein Stand');
    expect(screen.getByTestId('leistungsvergleich-grenze').textContent).toBe(UEMS_NORMGRENZE);
    // Ein Entwurf ist nie eine Datei (EW4).
    expect(screen.queryByTestId('leistungsvergleich-dateien')).toBeNull();
  });

  it('am Stand: PDF und CSV — eine Ablehnung spricht ihren Satz', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    const datei = vi.spyOn(api, 'berichtDatei').mockResolvedValueOnce(new Blob(['%PDF']));
    render(<LeistungsvergleichBericht abzug={abzugR8()} detail={lvDetail(1)} stand={lvStand()} rechte={RECHTE} />);
    const knoepfe = within(screen.getByTestId('leistungsvergleich-dateien')).getAllByRole('button');
    expect(knoepfe.map((k) => k.textContent)).toEqual(['PDF', 'CSV']);
    await act(async () => fireEvent.click(knoepfe[0]));
    expect(datei).toHaveBeenCalledWith('BR-2028-0001', 1, 'pdf');
    expect(screen.getByTestId('leistungsvergleich-abruf').textContent).toBe('PDF von Stand Nr. 1 abgerufen — der Abruf ist protokolliert.');
    datei.mockRejectedValueOnce(new ApiError(422, 'Für diesen Bericht gibt es noch keine Datei.', { code: 'ausgabe_fehlt' }));
    await act(async () => fireEvent.click(knoepfe[1]));
    expect(screen.getByRole('alert').textContent).toBe('Für diesen Bericht gibt es noch keine Datei.');
    // Ohne `export.*` gibt es nur das PDF.
    render(<LeistungsvergleichBericht abzug={abzugR8()} detail={lvDetail(1)} stand={lvStand()} rechte={{ standorte: new Map(), unternehmen: ['bericht.unternehmen'] }} />);
    expect(within(screen.getAllByTestId('leistungsvergleich-dateien')[1]).getAllByRole('button').map((k) => k.textContent)).toEqual(['PDF']);
  });
});

describe('AP-17 IP-24 · Berichtsseite mit Leistungsvergleich', () => {
  beforeEach(() => setSelbstauskunft(selbstauskunftFuer('Ines Kaltenbach')));

  it('Entwurf: Freigabe-Knopf und die acht Abschnitte; Stand Nr. 1: Prüfsumme, Stand-Satz und Dateien', async () => {
    const zustand = { nr: null as number | null, anlegen: [], dateien: [] };
    Object.entries(lvBuehne(zustand)).forEach(([k, f]) => vi.spyOn(api, k as keyof typeof api).mockImplementation(f as never));
    const { unmount } = render(<BerichtSeite kennung="BR-2028-0001" onListe={() => undefined} jetzt={() => JETZT} />);
    expect(await screen.findByTestId('leistungsvergleich')).toBeTruthy();
    expect(screen.getByTestId('leistungsvergleich-stand').textContent).toBe('ungesichert — noch kein Stand');
    expect(within(screen.getByTestId('bericht-hebel')).getByRole('button', { name: /freigeben/ })).toBeTruthy();
    const abschnitte = [...screen.getByTestId('leistungsvergleich').querySelectorAll('section.vp-br-block')].map((s) => s.getAttribute('aria-label'));
    expect(abschnitte).toEqual([
      'Kopf', 'Kennzahl', 'Bezugsbasis', 'Vergleich je Periode', 'Urteil', 'Grenzen und Vorbehalte', 'Statische Faktoren', 'Quellenverzeichnis',
    ]);
    // Wie die Spec: der Hebel heißt genau so, und der Knopf im Dialog ist frei (F1 am 12.01.2028).
    fireEvent.click(within(screen.getByTestId('bericht-hebel')).getByRole('button', { name: 'Als Berichtsstand freigeben' }));
    const knopf = await screen.findByTestId('bericht-freigeben-knopf');
    expect((knopf as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(knopf);
    expect(await screen.findByTestId('bericht-pruefsumme')).toBeTruthy();
    expect(zustand.nr).toBe(1);
    unmount();
    render(<BerichtSeite kennung="BR-2028-0001" onListe={() => undefined} jetzt={() => JETZT} />);
    expect(await screen.findByTestId('bericht-pruefsumme')).toBeTruthy();
    expect((await screen.findByTestId('leistungsvergleich-stand')).textContent).toMatch(/^Leistungsvergleich Stromeinsatz Spritzguss je kg, Dezember 2027 · Stand Nr\. 1 vom 12\.01\.2028/);
    expect(screen.getByTestId('leistungsvergleich-dateien')).toBeTruthy();
  });
});

describe('AP-17 IP-24 · Titel in Liste und Kopf', () => {
  it('heißt „Leistungsvergleich …“, nicht „Monatsbericht …“', async () => {
    const { berichtTitel, listenKarte } = await import('./berichtSeite');
    expect(berichtTitel(lvDetail(null).bericht)).toBe('Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027');
    expect(listenKarte(lvDetail(1).bericht).unter).toBe('Leistungsvergleich · Fassung 1');
  });
});

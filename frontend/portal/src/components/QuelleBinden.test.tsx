import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type MesskanalListe } from '../api';
import { KEINE_VERGLEICHSQUELLE, OHNE_BEWERTUNG, quelleKarte } from '../quelleBinden';
import { komponentenHalle1, registerAntwort } from '../test/messstelleDialogFixtures';
import { JETZT, JETZT_NACH_WECHSEL, K1_ID, K3_ID, kanaeleK1, kanaeleK3, quellenMs01, quellenMs06 } from '../test/quelleBindenFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { QuelleBindenDialog } from './QuelleBindenDialog';
import { QuelleKarte } from './QuelleKarte';

/**
 * Die beiden Flächen von UEMS AP-04 IP-14 an ihren echten Bausteinen: die Quelle-Karte zeigt BEIDE
 * Werte nebeneinander (E3, A8) und ihre Historie mit der Lücke; der Dialog lässt nur Passendes
 * wählen und lässt das Übrige GRAU MIT GRUND stehen.
 *
 * ⚠ Zahl und Einheit trennt im Wert ein GESCHÜTZTES Leerzeichen — die Testing Library normalisiert
 * es beim Suchen zu einem gewöhnlichen, `textContent` behält es. Darum hier ohne, in
 * `quelleBinden.test.ts` (reiner Text) mit.
 */

const kanalListe = (komponente: string, messkanaele: MesskanalListe['messkanaele']): MesskanalListe => ({
  site_id: FIXTURE_IDS.an1,
  komponente,
  inhaltsstand: null,
  messkanaele,
});

beforeEach(() => {
  vi.spyOn(api, 'standorte').mockResolvedValue({
    stichtag: '2026-10-20',
    standorte: [
      {
        id: FIXTURE_IDS.st1,
        name: 'Werk Ahrenberg',
        zustand: 'aktiv',
        anlagen: [{ id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' }],
      },
    ],
    nochNichtZugeordnet: null,
  } as never);
  vi.spyOn(api, 'siteEntities').mockResolvedValue(komponentenHalle1());
  vi.spyOn(api, 'messstellenRegister').mockResolvedValue(registerAntwort());
  vi.spyOn(api, 'komponenteMesskanaele').mockImplementation(async (_site: string, entity: string) =>
    kanalListe(entity, entity === K1_ID ? kanaeleK1() : kanaeleK3()),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Quelle-Karte — beide Werte nebeneinander (E3, Abnahmefall A8)', () => {
  it('MS-01: führend 312,4 kW und Vergleich 309,8 kW stehen NEBENEINANDER, ohne Bewertung', () => {
    render(
      <QuelleKarte karten={quelleKarte(quellenMs01(), JETZT)} darfBinden onBinden={vi.fn()} onVergleich={vi.fn()} />,
    );
    const leistung = screen.getByTestId('quelle-groesse-Wirkleistung|Bezug');
    const werte = within(leistung).getByTestId('quelle-werte');
    // EINE Liste, zwei Einträge — nebeneinander im selben Raster, nicht zwei Blöcke untereinander.
    expect(within(werte).getAllByRole('listitem')).toHaveLength(2);
    expect(within(werte).getByText('312,4 kW')).toBeInTheDocument();
    expect(within(werte).getByText('309,8 kW')).toBeInTheDocument();
    expect(within(leistung).getByText('führend')).toBeInTheDocument();
    expect(within(leistung).getByText('Vergleich · Plausibilität')).toBeInTheDocument();
    expect(within(leistung).getByText(OHNE_BEWERTUNG)).toBeInTheDocument();
    // AP-16 IP-18: nur der Brückensatz nennt die Befund-Zeile darunter; die Karte selbst bewertet weiter nichts.
    expect(leistung.textContent!.replace(OHNE_BEWERTUNG, '')).not.toMatch(/Abweichung|Toleranz|%/);
  });

  it('ohne Vergleichsquelle sagt die Karte es — und bietet „Vergleichsquelle hinzufügen“ an', () => {
    render(
      <QuelleKarte karten={quelleKarte(quellenMs01(), JETZT)} darfBinden onBinden={vi.fn()} onVergleich={vi.fn()} />,
    );
    const haupt = screen.getByTestId('quelle-groesse-Wirkenergie|Bezug');
    expect(within(haupt).getByText(KEINE_VERGLEICHSQUELLE)).toBeInTheDocument();
    expect(within(haupt).getByRole('button', { name: 'Vergleichsquelle hinzufügen' })).toBeInTheDocument();
    // Eine führende Quelle läuft — „Quelle binden“ steht hier NICHT (das wäre ein Zählerwechsel).
    expect(within(haupt).queryByRole('button', { name: 'Quelle binden' })).toBeNull();
  });

  it('die Historie zeigt Z-5a, die Lücke und Z-5b — die Lücke bleibt sichtbar', () => {
    render(
      <QuelleKarte
        karten={quelleKarte(quellenMs06(), JETZT_NACH_WECHSEL)}
        darfBinden
        onBinden={vi.fn()}
        onVergleich={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Historie (3)'));
    const zeilen = screen.getAllByRole('listitem').filter((li) => li.className.startsWith('vp-qk-h'));
    expect(zeilen.map((z) => z.textContent)).toEqual([
      'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5b · Wirkenergie Bezugseit 18.11.2026, 10:47 Uhrgilt heute',
      'Lücke18.11.2026, 10:40 Uhr bis 18.11.2026, 10:47 Uhr',
      'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a · Wirkenergie Bezug12.03.2024 bis 18.11.2026, 10:40 Uhr',
    ]);
  });
});

describe('„Quelle binden“ — nur Passendes wählbar, das Übrige grau mit Grund', () => {
  const ausMessstelle = {
    art: 'messstelle' as const,
    messstelleId: 'ms-01',
    kennzeichen: 'MS-01',
    groesse: { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert' },
    hauptgroesse: false,
  };

  async function oeffneMesswerte() {
    render(
      <QuelleBindenDialog
        open
        rolle="fuehrend"
        ziel={ausMessstelle}
        jetzt={JETZT}
        onClose={vi.fn()}
        onGebunden={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('combobox', { name: 'Komponente' }));
    fireEvent.click(await screen.findByRole('option', { name: /Netzzähler Halle 1/ }));
    const messwert = await screen.findByRole('combobox', { name: 'Messwert' });
    fireEvent.click(messwert);
    const id = messwert.getAttribute('id');
    return within(document.getElementById(`${id}-liste`)!);
  }

  it('zeigt jeden Messwert — die unpassenden ausgegraut und mit ihrem Grund', async () => {
    const liste = await oeffneMesswerte();
    await waitFor(() => expect(liste.getAllByRole('option')).toHaveLength(4));
    const optionen = liste.getAllByRole('option');
    expect(optionen.map((o) => o.getAttribute('aria-disabled'))).toEqual([null, 'true', 'true', 'true']);
    expect(optionen[0].textContent).toContain('Wirkleistung');
    expect(optionen[0].textContent).toContain('liest den Bezugs-Teil des Werts');
    expect(optionen[1].textContent).toContain('kann die Größe „Wirkleistung · Momentanwert“ nicht liefern');
  });

  it('nach der Wahl sagt „Was geschieht“ nur Fakten und schickt Rolle, Anteil und Zeitpunkt', async () => {
    const binden = vi.spyOn(api, 'messstelleQuelleBinden').mockResolvedValue({} as never);
    const liste = await oeffneMesswerte();
    // Der erste Eintrag ist der EINZIGE wählbare — die drei anderen stehen grau darunter.
    fireEvent.click((await liste.findAllByRole('option'))[0]);
    expect(await screen.findByTestId('quelle-folgen')).toHaveTextContent(
      'MS-01 liest ab 20.10.2026, 10:15 Uhr Netzzähler Halle 1 · Wirkleistung (liest den Bezugs-Teil des Werts).',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Binden' }));
    await waitFor(() => expect(binden).toHaveBeenCalled());
    expect(binden.mock.calls[0][1]).toEqual({
      groesse: { groesse: 'Wirkleistung', richtung: 'Bezug' },
      komponente: K3_ID,
      kanal: 'sunspec.model_203.w',
      rolle: 'fuehrend',
      anteil: 'positiv',
      gueltig_ab: '2026-10-20T10:15:00+02:00',
    });
  });

  it('„Vergleichsquelle hinzufügen“ verlangt einen Zweck (E3)', async () => {
    const binden = vi.spyOn(api, 'messstelleQuelleBinden').mockResolvedValue({} as never);
    render(
      <QuelleBindenDialog
        open
        rolle="vergleich"
        ziel={ausMessstelle}
        jetzt={JETZT}
        onClose={vi.fn()}
        onGebunden={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Vergleichsquelle hinzufügen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Bitte wählen Sie den Zweck der Vergleichsquelle.')).toBeInTheDocument();
    expect(binden).not.toHaveBeenCalled();
  });
});

describe('„Als Messstelle verwenden“ — derselbe Dialog vom Messwert aus', () => {
  it('bietet die Messstellen-Größen an, die diesen Messwert lesen können — die übrigen grau', async () => {
    render(
      <QuelleBindenDialog
        open
        rolle="fuehrend"
        ziel={{ art: 'messwert', anlageId: FIXTURE_IDS.an1, entityId: K3_ID, kanal: kanaeleK3()[0] }}
        jetzt={JETZT}
        onClose={vi.fn()}
        onGebunden={vi.fn()}
      />,
    );
    // Kundenwörter, nie das Katalogwort `counter`.
    expect(screen.getByTestId('quelle-messwert')).toHaveTextContent('Wirkenergie Bezug · Zählerstand · kWh · alle 15 min');
    const feld = await screen.findByRole('combobox', { name: 'Messstelle und Messgröße' });
    fireEvent.click(feld);
    const liste = within(document.getElementById(`${feld.getAttribute('id')}-liste`)!);
    await waitFor(() => expect(liste.getAllByRole('option').length).toBeGreaterThan(1));
    const optionen = liste.getAllByRole('option');
    expect(optionen[0].textContent).toContain('MS-01 · Netzbezug Halle 1');
    const abgabe = optionen.find((o) => o.textContent?.includes('MS-02'))!;
    expect(abgabe.getAttribute('aria-disabled')).toBe('true');
    expect(abgabe.textContent).toContain('kann die Größe „Wirkenergie · Abgabe“ nicht liefern');
  });
});

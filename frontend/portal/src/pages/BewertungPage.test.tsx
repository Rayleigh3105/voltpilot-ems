import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { setSelbstauskunft } from '../rollen';
import { bewertungBuehne } from '../test/bewertungFixtures';
import { bewertungStandBuehne, type BewertungsLage } from '../test/bewertungStandBuehne';
import { rechteSeed } from '../test/rollenFixtures';
import { BewertungPage } from './BewertungPage';

/**
 * „Energetische Bewertung“ als Ergebnis-Seite (Konzept Auswerten a1 §6.7) auf den Routen des Referenzunternehmens
 * (`test/bewertungFixtures.ts`, Bericht-Routen aus `test/bewertungStandBuehne.ts`): Antwort zuerst, Bereiche nach der
 * Einstufung einer Person, Kriterien in Worten - kein Kürzel K1 bis K8 auf der Seite (§10.10) - und die Vier-Augen-
 * Entscheidung über beantragte Kriterien (Befund 6).
 */
function verdrahte(person = 'IK', lage: BewertungsLage = 'nr2', kriterien: { vieraugen?: boolean; antragVon?: string } = {}) {
  setSelbstauskunft(rechteSeed(person).me);
  const buehne = bewertungBuehne('voll', person, '2026-11-20', false, false, false, kriterien);
  const stand = bewertungStandBuehne(lage);
  for (const [name, f] of Object.entries({ ...buehne, ...stand })) {
    if (name in api) vi.spyOn(api as unknown as Record<string, () => unknown>, name).mockImplementation(f as () => unknown);
  }
  vi.spyOn(api, 'messbedarfeAlle').mockResolvedValue({ messbedarfe: [] });
  return render(<BewertungPage onOeffnen={() => undefined} onListe={() => undefined} />);
}

afterEach(() => {
  setSelbstauskunft(null);
  vi.restoreAllMocks();
});

describe('BewertungPage - das Ergebnis', () => {
  it('antwortet zuerst, gruppiert nach der Einstufung und nennt nie ein Kürzel', async () => {
    const { container } = verdrahte();
    const antwort = await screen.findByTestId('bewertung-antwort');
    expect(antwort).toHaveTextContent('2 von 7 Bereichen sind wesentlich - zusammen 50 % des Stroms.');
    expect(antwort).toHaveTextContent('Datengrundlage November 2025 bis Oktober 2026 · Strom aus 3 Anlagen · Gas ohne Anteil');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Energetische Bewertung');
    expect(screen.getByTestId('bewertung-status')).toHaveTextContent('Gilt · Stand Nr. 2 vom 17.11.2026nächste Überprüfung bis 17.11.2027');
    expect(within(screen.getByTestId('bereiche-wesentlich')).getAllByRole('link').map((a) => a.getAttribute('data-testid'))).toEqual(['bereich-EE-1', 'bereich-EE-3']);
    expect(screen.getByTestId('bereich-EE-3')).toHaveTextContent('weicht vom Vorschlag ab');
    expect(screen.getByTestId('bereich-EE-1').getAttribute('href')).toBe('#/portfolio/bewertung/ee000000-0000-4000-8000-000000000001');
    await screen.findByText('Er braucht mindestens 10 % des Stroms.');
    // Die Rangliste mit Kürzelspalten, die Messabdeckung je Einsatz und Ort und die zweite Liste sind weg.
    expect(screen.queryByTestId('rangliste')).toBeNull();
    expect(screen.queryByTestId('einsatz-karte')).toBeNull();
    expect(container.textContent).not.toMatch(/(^|[^\p{L}\p{N}])K[1-8]([^\p{L}\p{N}]|$)/u);
    expect(container.textContent).not.toMatch(/Rangliste|Roh|Urteil \(Band\)|Europe\/Berlin/);
  });

  it('eine fällige Bewertung macht die Statuszeile zur Hinweiskarte mit „Neuen Stand freigeben“', async () => {
    verdrahte('IK', 'faellig');
    const karte = await screen.findByTestId('bewertung-faellig');
    expect(karte).toHaveTextContent('Überprüfung fällig seit 17.11.2027');
    expect(within(karte).getByRole('button', { name: /Neuen Stand freigeben/ })).toBeInTheDocument();
    expect(screen.queryByTestId('bewertung-status')).toBeNull();
    // Die Marke der Wiedervorlage bleibt am Bewertungsstand.
    expect(await screen.findByTestId('bewertung-stand')).toHaveAttribute('data-entscheid', 'bewertung_ueberpruefung');
  });
});

describe('BewertungPage - Kriterien mit Vier-Augen (Befund 6)', () => {
  it('nach dem Speichern sagt die Meldung, dass die neue Fassung auf eine zweite Person wartet - nicht „gilt ab sofort“', async () => {
    verdrahte('IK', 'nr2', { vieraugen: true });
    fireEvent.click(await screen.findByTestId('kriterien-oeffnen'));
    const dialog = await screen.findByTestId('kriterien-dialog');
    fireEvent.change(within(dialog).getByLabelText('Anteil am Strom, ab dem VoltPilot vorschlägt (K1)'), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Früher prüfen.' } });
    fireEvent.click(screen.getByTestId('kriterien-speichern'));
    expect(await screen.findByTestId('kriterien-hinweis')).toHaveTextContent(
      'Die neuen Kriterien (Fassung 2) warten auf die Freigabe durch eine zweite Person. Bis dahin gelten die bisherigen.',
    );
    const antrag = await screen.findByTestId('kriterien-antrag');
    expect(antrag).toHaveTextContent('Anteil am Strom, ab dem VoltPilot vorschlägt: 10 % → 5 %');
    expect(antrag).toHaveTextContent('Freigeben oder ablehnen kann eine zweite Person, die Kriterien ändern darf.');
    expect(within(antrag).queryByRole('button', { name: 'Freigeben' })).toBeNull();
    // Solange eine Fassung beantragt ist, gibt es kein zweites „Kriterien ändern“ (sonst 409 `freigabe_offen`).
    expect(screen.queryByTestId('kriterien-oeffnen')).toBeNull();
  });

  it('die zweite Person gibt frei - danach gelten die neuen Kriterien und der Vorschlag wird neu gelesen', async () => {
    verdrahte('JW', 'nr2', { antragVon: 'IK' });
    const antrag = await screen.findByTestId('kriterien-antrag');
    const rangliste = vi.mocked(api.bewertungRangliste);
    const vorher = rangliste.mock.calls.length;
    fireEvent.click(within(antrag).getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByTestId('kriterien-hinweis')).toHaveTextContent('Die neuen Kriterien gelten ab sofort für den Vorschlag (Fassung 2).');
    await waitFor(() => expect(screen.queryByTestId('kriterien-antrag')).toBeNull());
    expect(await screen.findByText('Er braucht mindestens 8 % des Stroms.')).toBeInTheDocument();
    await waitFor(() => expect(rangliste.mock.calls.length).toBeGreaterThan(vorher));
  });

  it('die zweite Person lehnt nur begründet ab - danach gelten weiter die bisherigen', async () => {
    verdrahte('JW', 'nr2', { antragVon: 'IK' });
    fireEvent.click(within(await screen.findByTestId('kriterien-antrag')).getByRole('button', { name: 'Ablehnen' }));
    const dialog = await screen.findByTestId('kriterien-ablehnen-dialog');
    fireEvent.click(screen.getByTestId('kriterien-ablehnen-senden'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Bitte begründen Sie die Ablehnung.');
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Erst nach dem Sommer neu bewerten.' } });
    fireEvent.click(screen.getByTestId('kriterien-ablehnen-senden'));
    expect(await screen.findByTestId('kriterien-hinweis')).toHaveTextContent('Die beantragten Kriterien (Fassung 2) sind abgelehnt. Es gelten weiter die bisherigen.');
    expect(await screen.findByText('Er braucht mindestens 10 % des Stroms.')).toBeInTheDocument();
  });

  it('wer Kriterien nicht ändern darf, liest den Antrag und wer entscheidet', async () => {
    verdrahte('PH', 'nr2', { antragVon: 'IK' });
    const antrag = await screen.findByTestId('kriterien-antrag');
    expect(antrag).toHaveTextContent('Freigeben oder ablehnen dürfen Kundenadministratoren und Energiemanager');
    expect(within(antrag).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('kriterien-oeffnen')).toBeNull();
    expect(screen.getByTestId('bewertung-nur-lesen')).toBeInTheDocument();
  });
});

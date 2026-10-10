import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { KundenbereichEndeHinweis } from './KundenbereichEndeHinweis';

vi.mock('../auth', async (original) => ({ ...(await original<typeof import('../auth')>()), freshToken: async () => 'token' }));

const text = 'Ihr Vertrag ist am 30.06.2029 beendet. Ihre Daten können Sie nur noch lesen; gelöscht werden sie frühestens am 28.09.2029. Bis dahin können Sie den Gesamtabzug laden.';

afterEach(() => vi.restoreAllMocks());

it('AP-20 IP-16: ein aktiver Kundenbereich zeigt nichts — auch nicht mit einer älteren Selbstauskunft ohne das Feld', () => {
  expect(render(<KundenbereichEndeHinweis beendet={null} />).container).toBeEmptyDOMElement();
  expect(render(<KundenbereichEndeHinweis />).container).toBeEmptyDOMElement();
});

it('AP-20 IP-17: der Kundenadministrator sieht den Satz der API (RF-08) und den Knopf „Gesamtabzug laden“ mit Erklärung (§5.8)', () => {
  render(<KundenbereichEndeHinweis beendet={{ beendet_am: '2029-06-30', loeschung_fruehestens: '2029-09-28', liest: true, text }} />);
  const hinweis = screen.getByRole('status');
  expect(hinweis).toHaveTextContent('Vertrag beendet');
  expect(hinweis).toHaveTextContent(text);
  expect(hinweis).toHaveTextContent('Gesamtabzug laden — alle Stände, Berichte, Nachweise und Messreihen Ihres Unternehmens, mit Prüfsumme je Datei.');
  expect(screen.getByRole('button', { name: 'Gesamtabzug laden' })).toBeEnabled();
});

it('AP-20 IP-17: jede andere Person liest nicht mehr — kein Knopf', () => {
  render(<KundenbereichEndeHinweis beendet={{ beendet_am: '2029-06-30', loeschung_fruehestens: '2029-09-28', liest: false,
    text: 'Ihr Vertrag ist am 30.06.2029 beendet. Nur Ihr Kundenadministrator kann die Daten bis zur Löschung noch lesen.' }} />);
  expect(screen.getByRole('status')).not.toHaveTextContent('Gesamtabzug');
  expect(screen.queryByRole('button')).toBeNull();
});

it('AP-20 IP-17: der Knopf lädt den Abzug von der Route und zeigt eine Ablehnung mit dem Satz der API', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'recht_fehlt',
    message: 'Den Gesamtabzug lädt nur der Kundenadministrator.' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  render(<KundenbereichEndeHinweis beendet={{ beendet_am: '2029-06-30', loeschung_fruehestens: '2029-09-28', liest: true, text }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gesamtabzug laden' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Den Gesamtabzug lädt nur der Kundenadministrator.');
  expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/v1\/unternehmen\/abzug$/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Gesamtabzug laden' })).toBeEnabled());
});

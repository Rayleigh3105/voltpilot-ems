import { afterEach, expect, it, vi } from 'vitest';
import { api, type BezugsdatenZuordnung } from './api';
vi.mock('./auth', () => ({ freshToken: async () => 'test', AuthRedirectError: class extends Error {} }));
afterEach(() => vi.unstubAllGlobals());
it('IP-9 verwendet die bestehenden Listen-, Anlege- und Archivierungsrouten', async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ bezugsgroessen: [], bezugsflaechen: [] }) }));
  vi.stubGlobal('fetch', fetch);
  expect(await api.bezugsgroessen()).toEqual({ bezugsgroessen: [], bezugsflaechen: [] });
  const body = { name: 'Produktion', wertart: 'periodenwert' as const, einheit: 'kg', periode_art: 'monat' as const, geltung_art: 'standort' as const, geltung_id: 'standort' };
  await api.bezugsgroesseAnlegen(body);
  await api.bezugsgroesseArchivieren('bezugs-id');
  expect(fetch.mock.calls).toMatchObject([
    [expect.stringContaining('/api/v1/bezugsgroessen'), expect.anything()],
    [expect.stringContaining('/api/v1/bezugsgroessen'), { method: 'POST', body: JSON.stringify(body) }],
    [expect.stringContaining('/api/v1/bezugsgroessen/bezugs-id/archivieren'), { method: 'POST' }],
  ]);
});
it('IP-10 sendet Texte und eine ausdrückliche leere Monatszuordnung an die bestehenden Routen', async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })); vi.stubGlobal('fetch', fetch);
  await api.bezugswertEingeben('bz', { periode: '2026-10', wert: '48.200' });
  await api.bezugswertBerichtigen('bz', '2026-10', { wert: '48.200', begruendung: 'Eine Null fehlte.' });
  await api.ablesungen('MS/21');
  await api.ablesungEintragen('MS/21', { zeitpunkt: '2026-10-25T02:30:00+01:00', stand: '49.451', zuordnung_monat: null });
  await api.ablesungBerichtigen('MS/21', '2026-10-25T02:30:00+01:00', { stand: '49.451', zuordnung_monat: '2026-10', begruendung: 'Monat berichtigen.' });
  expect(fetch.mock.calls).toMatchObject([
    [expect.stringContaining('/bezugsgroessen/bz/werte'), { method: 'POST', body: '{"periode":"2026-10","wert":"48.200"}' }],
    [expect.stringContaining('/bezugsgroessen/bz/werte/2026-10/berichtigung'), { method: 'POST' }],
    [expect.stringContaining('/messstellen/MS%2F21/ablesungen'), expect.anything()],
    [expect.stringContaining('/messstellen/MS%2F21/ablesungen'), { method: 'POST', body: expect.stringContaining('"zuordnung_monat":null') }],
    [expect.stringContaining('/ablesungen/2026-10-25T02%3A30%3A00%2B01%3A00/berichtigung'), { method: 'POST' }],
  ]);
});

it('IP-15 sendet Datei, Zuordnung und Bestätigung als echtes Multipart ohne JSON-Kopf', async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })); vi.stubGlobal('fetch', fetch);
  const datei = new File(['Periode;Wert\n2026-10;12'], 'werte.csv', { type: 'text/csv' });
  const zuordnung: BezugsdatenZuordnung = {
    csv: null, spalten: { periode: 1, bis: null, wert: 2, einheit: null, bezug: null, bemerkung: null },
    deutung: 'periode', zahlformat: 'auto', einheit: null, bezugsgroesse: 'BZ-1', bezug_tabelle: {}, synonyme: {},
  };
  await api.bezugsdatenVorschau(datei, zuordnung);
  await api.bezugsdatenImportieren(datei, zuordnung, null, { vorschau: 'VS1.test', entscheidungen: {}, begruendung: null, teiluebernahme: '1 von 2 Zeilen übernehmen' });
  const [vorschau, uebernahme] = fetch.mock.calls.map(([, init]) => init as RequestInit);
  for (const init of [vorschau, uebernahme]) {
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.body as FormData).get('datei')).toBe(datei);
    expect((init.body as FormData).get('zuordnung')).toBe(JSON.stringify(zuordnung));
  }
  expect((uebernahme.body as FormData).get('bestaetigung')).toBe('{"vorschau":"VS1.test","entscheidungen":{},"begruendung":null,"teiluebernahme":"1 von 2 Zeilen übernehmen"}');
});

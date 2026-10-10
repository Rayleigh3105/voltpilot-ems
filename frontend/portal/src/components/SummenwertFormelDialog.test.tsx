import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type Messstelle } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { SummenwertFormelDialog } from './SummenwertFormelDialog';
const m: Messstelle = { id: 'm1', name: 'Dach', kennzeichen: 'MS-0001', art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [], notiz: null };
afterEach(() => vi.restoreAllMocks());
it('schreibt eine neue Fassung und erhält Quellenidentität sowie Erzeugungsentscheidung', async () => {
  vi.spyOn(api, 'messstelleFormel').mockResolvedValue({ messstelle_id: 'm1', schema_version: '1.0', hauptgroesse: null, formel_vorhanden: true, eingaenge_eingerichtet: true,
    terme: [{ position: 0, eingang_art: 'messkanal', entity_id: 'e1', point_key: 'gen-port', quell_messstelle_id: null, vorzeichen: '+', faktor: 1, gilt_als_erzeugung: true, groesse: null, eingerichtet: true }] });
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [] } as unknown as Awaited<ReturnType<typeof api.siteEntities>>);
  const speichern = vi.spyOn(api, 'messstelleFormelFassungEintragen').mockResolvedValue({} as Awaited<ReturnType<typeof api.messstelleFormelFassungEintragen>>);
  const anlegen = vi.spyOn(api, 'berechneteMessstelleAnlegen');
  render(<SummenwertFormelDialog siteId="s1" messstelle={m} onClose={() => {}} onGespeichert={() => {}} />);
  await screen.findByText('Eingang 1'); fireEvent.click(screen.getByText('Feineinstellung'));
  fireEvent.change(screen.getByLabelText('Faktor für Eingang 1'), { target: { value: '0.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
  await waitFor(() => expect(speichern).toHaveBeenCalledWith('m1', expect.objectContaining({ terme: [{ eingang_art: 'messkanal', entity_id: 'e1', point_key: 'gen-port', vorzeichen: '+', faktor: .5, gilt_als_erzeugung: true }] })));
  expect(anlegen).not.toHaveBeenCalled();
});

it('ein Leser bekommt auch im schon geöffneten Formeldialog keinen Schreibknopf', async () => {
  vi.spyOn(api, 'messstelleFormel').mockResolvedValue({ terme: [] } as unknown as Awaited<ReturnType<typeof api.messstelleFormel>>);
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [] } as unknown as Awaited<ReturnType<typeof api.siteEntities>>);
  const speichern = vi.spyOn(api, 'messstelleFormelFassungEintragen');
  render(<SummenwertFormelDialog siteId="s1" messstelle={m} onClose={() => {}} onGespeichert={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Wird geladen …')).toBeNull());
  act(() => setSelbstauskunft(rechteSeed('CB').me));
  expect(screen.queryByRole('button', { name: 'Übernehmen' })).toBeNull();
  expect(speichern).not.toHaveBeenCalled();
});

it('mit Eingängen außerhalb des Zugriffs: Hinweis statt Übernehmen, nie eine Formel ohne sie (AP-03 R-A6)', async () => {
  vi.spyOn(api, 'messstelleFormel').mockResolvedValue({ messstelle_id: 'm1', schema_version: '1.0', hauptgroesse: null, formel_vorhanden: true, eingaenge_eingerichtet: true,
    terme: [{ position: 0, eingang_art: 'messkanal', entity_id: 'e1', point_key: 'gen-port', quell_messstelle_id: null, vorzeichen: '+', faktor: 1, gilt_als_erzeugung: true, groesse: null, eingerichtet: true }],
    ausserhalb_zugriff: 'umfasst Standorte außerhalb Ihres Zugriffs' });
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [] } as unknown as Awaited<ReturnType<typeof api.siteEntities>>);
  const speichern = vi.spyOn(api, 'messstelleFormelFassungEintragen');
  render(<SummenwertFormelDialog siteId="s1" messstelle={m} onClose={() => {}} onGespeichert={() => {}} />);
  await screen.findByText('Die Formel umfasst Standorte außerhalb Ihres Zugriffs.');
  const knopf = screen.getByRole('button', { name: 'Übernehmen' });
  expect(knopf).toBeDisabled();
  fireEvent.click(knopf);
  expect(speichern).not.toHaveBeenCalled();
});

it('AP-07 IP-18b: zwei Eingänge am selben Register der Box — Warnung im Dialog, Übernehmen bleibt möglich', async () => {
  const term = (position: number, entity_id: string) => ({ position, eingang_art: 'messkanal', entity_id, point_key: 'gen-port', quell_messstelle_id: null, vorzeichen: '+', faktor: 1, gilt_als_erzeugung: false, groesse: null, eingerichtet: true });
  vi.spyOn(api, 'messstelleFormel').mockResolvedValue({ messstelle_id: 'm1', schema_version: '1.0', hauptgroesse: null, formel_vorhanden: true, eingaenge_eingerichtet: true,
    terme: [term(0, 'e1'), term(1, 'e2')], geteilte_register: [{ register: 'gen-port', positionen: [0, 1] }] });
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [] } as unknown as Awaited<ReturnType<typeof api.siteEntities>>);
  render(<SummenwertFormelDialog siteId="s1" messstelle={m} onClose={() => {}} onGespeichert={() => {}} />);
  const note = await screen.findByRole('note');
  expect(note).toHaveTextContent('Möglicherweise doppelt gezählt: Eingang 1 und Eingang 2 hängen am selben Register der VoltPilot-Box.');
  expect(note).not.toHaveTextContent('gen-port');
  expect(screen.getByRole('button', { name: 'Übernehmen' })).not.toBeDisabled();
});

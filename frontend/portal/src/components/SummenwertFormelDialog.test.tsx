import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type Messstelle } from '../api';
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

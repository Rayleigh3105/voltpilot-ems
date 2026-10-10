import type { BenutzerEintrag } from '../benutzer';
import { rechteSeed, STANDORT_IDS } from './rollenFixtures';
/** Ausschließlich Personen und Rollen aus den Ahrenberg-Vertragsvektoren. */
export function benutzerFixture(): BenutzerEintrag[] {
  return ['JW', 'IK', 'PH', 'SR', 'MD', 'CB'].map(kennung => {
    const { benutzer, kundenbereich } = rechteSeed(kennung);
    return { sub: benutzer.kennung, anzeigename: benutzer.name, email: `${kennung.toLowerCase()}@ahrenberg.example`, zustand: benutzer.zustand,
      zuweisungen: benutzer.zuweisungen.flatMap((z, i) => (z.standorte ?? [null]).map((id, j) => ({
        id: `${kennung}-${i}-${j}`, rolle: z.rolle, standort_id: id ? STANDORT_IDS[id] : null,
        standort_name: kundenbereich.standorte.find(s => s.kennzeichen === id)?.name ?? null,
        gueltig_ab: z.gueltigAb, gueltig_bis: z.gueltigBis,
      }))) };
  });
}

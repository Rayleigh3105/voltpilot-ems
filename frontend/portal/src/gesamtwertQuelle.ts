/**
 * Die Gesamtwerte (berechnete Messstellen, AP-10) EINER Anlage — die eine
 * Stelle, an der die Anzeige-Flächen (Cockpit-Karten, Verlauf-Ast) sie finden.
 *
 * Eine berechnete Messstelle trägt keinen Ort (Konzept §2.2) — sie „gehört" zu
 * einer Anlage über ihre Formel: einer ihrer Terme liest eine Komponente dieser
 * Anlage. Genau danach filtert diese Funktion, damit ein Gesamtwert der Anlage A
 * nicht auf dem Cockpit der Anlage B auftaucht. Reine Orchestrierung (Netz), die
 * Regeln wohnen in `gesamtwert.ts`.
 */
import { api, type Messstelle, type MessstelleFormel } from './api';

export interface GesamtwertQuelle {
  messstelle: Messstelle;
  formel: MessstelleFormel | null;
}

/** Alle nicht-archivierten Gesamtwerte, deren Formel eine Komponente dieser Anlage liest. */
export async function ladeSiteGesamtwerte(siteId: string): Promise<GesamtwertQuelle[]> {
  const [liste, entities] = await Promise.all([api.messstellen(), api.siteEntities(siteId)]);
  const siteEntityIds = new Set(entities.entities.map((e) => e.id));
  const berechnet = liste.messstellen.filter(
    (m) => m.art === 'berechnet' && m.lebenszyklus !== 'archiviert',
  );
  const zeilen = await Promise.all(
    berechnet.map(async (m): Promise<GesamtwertQuelle | null> => {
      const formel = await api.messstelleFormel(m.id).catch(() => null);
      // ⚠ snake_case: das Backend #688 liefert `entity_id` (belegt in
      // `MessstelleFormelApiTest`), NICHT `entityId` — sonst ist die Zuordnung
      // immer leer und kein Gesamtwert erschiene je (Review B1).
      const gehoertHierher =
        formel?.terme?.some((t) => t.entity_id != null && siteEntityIds.has(t.entity_id)) ?? false;
      return gehoertHierher ? { messstelle: m, formel } : null;
    }),
  );
  return zeilen.filter((z): z is GesamtwertQuelle => z != null);
}

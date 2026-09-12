import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ladeSiteGesamtwerte } from './gesamtwertQuelle';

/**
 * KONTRAKTTEST gegen die ECHTE #688-Serialisierung (snake_case).
 *
 * Das Backend #688 trägt `@JsonNaming(SnakeCaseStrategy)` auf den Formel-DTOs;
 * `MessstelleFormelApiTest` belegt die reale JSON-Form (`/terme/0/point_key`,
 * `/eingang_art`, `/quell_messstelle_id`). `request()` wandelt NICHT um — die
 * Site-Zuordnung MUSS deshalb `entity_id` lesen, nicht `entityId`.
 *
 * Genau dieser Test hätte den Review-Blocker B1 gefangen: die Fixtures unten
 * sprechen snake_case (wie das echte Backend); läse der Filter wieder `entityId`,
 * fände er keinen Term und die Liste wäre leer.
 */

/** Ein Formel-Term, EXAKT wie das Backend ihn serialisiert (snake_case). */
function term(entityId: string, pointKey: string) {
  return {
    position: 0,
    eingang_art: 'messkanal',
    entity_id: entityId,
    point_key: pointKey,
    quell_messstelle_id: null,
    vorzeichen: '+',
    faktor: 1,
    groesse: { groesse: 'Wirkleistung', richtung: 'Erzeugung', einheit: 'kW', wertart: 'Momentanwert' },
    eingerichtet: true,
  };
}

function formel(terme: unknown[]) {
  return {
    messstelle_id: 'x',
    schema_version: '1.0',
    hauptgroesse: { groesse: 'Wirkleistung', richtung: 'Erzeugung', einheit: 'kW', wertart: 'Momentanwert' },
    terme,
    formel_vorhanden: true,
    eingaenge_eingerichtet: true,
  };
}

function messstelle(id: string, art: string, lebenszyklus = 'aktiv') {
  return { id, kennzeichen: 'MS-' + id, name: id, art, medium: 'Strom', lebenszyklus, fehlt: [], notiz: null };
}

afterEach(() => vi.restoreAllMocks());

describe('gesamtwertQuelle · Kontrakt gegen #688 (snake_case)', () => {
  it('findet den Gesamtwert dieser Anlage über terme[].entity_id (snake_case)', async () => {
    vi.spyOn(api, 'messstellen').mockResolvedValue({
      messstellen: [
        messstelle('gw-hier', 'berechnet'), // Formel liest inv (in dieser Anlage)
        messstelle('gw-fremd', 'berechnet'), // Formel liest eine fremde Komponente
        messstelle('gw-weg', 'berechnet', 'archiviert'), // archiviert → raus
        messstelle('ms-gemessen', 'gemessen'), // kein Gesamtwert
      ],
    } as never);
    vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [{ id: 'inv' }] } as never);
    vi.spyOn(api, 'messstelleFormel').mockImplementation((id: string) =>
      Promise.resolve(
        (id === 'gw-hier'
          ? formel([term('inv', 'pv1_power_kw')])
          : formel([term('fremd-inv', 'pv1_power_kw')])) as never,
      ),
    );

    const zeilen = await ladeSiteGesamtwerte('s-1');
    expect(zeilen.map((z) => z.messstelle.id)).toEqual(['gw-hier']);
    // Und die abgeleitete Hauptgröße kommt aus der snake_case-Formel.
    expect(zeilen[0].formel?.hauptgroesse?.groesse).toBe('Wirkleistung');
  });

  it('REGRESSION: der camelCase-Vertrag (entityId) fände NICHTS', async () => {
    // Beweis, dass der Test den Blocker fängt: dieselbe Anlage, aber die Formel
    // trägt das FALSCHE camelCase-Feld — der snake_case-Filter greift dann nicht.
    const camel = {
      messstelle_id: 'x',
      schema_version: '1.0',
      hauptgroesse: null,
      terme: [{ position: 0, eingangArt: 'messkanal', entityId: 'inv', pointKey: 'pv1_power_kw', quellMessstelleId: null, vorzeichen: '+', faktor: 1, groesse: null, eingerichtet: true }],
      formel_vorhanden: true,
      eingaenge_eingerichtet: true,
    };
    vi.spyOn(api, 'messstellen').mockResolvedValue({ messstellen: [messstelle('gw', 'berechnet')] } as never);
    vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [{ id: 'inv' }] } as never);
    vi.spyOn(api, 'messstelleFormel').mockResolvedValue(camel as never);

    expect((await ladeSiteGesamtwerte('s-1')).length).toBe(0);
  });
});

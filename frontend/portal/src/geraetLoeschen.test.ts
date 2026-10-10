import { describe, expect, it } from 'vitest';
import type { SiteEntity } from './api';
import { plantModel } from './komponenten';
import {
  batterieAbmeldenFolgen,
  berichtsBelegAus,
  gefahrenzone,
  komponenteEntfernenFolgen,
} from './geraetLoeschen';

/** A minimal v2 entity - same shape the komponenten tests use. */
function entity(id: string, entityType: string, overrides: Partial<SiteEntity> = {}): SiteEntity {
  return {
    id,
    entityType,
    typeLabel: entityType,
    role: entityType,
    label: null,
    control: false,
    deviceId: 'gw',
    capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
    guards: null,
    syncStatus: 'in_sync',
    observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    edgeSourceId: null,
    ...overrides,
  };
}

/** The components of a one-entity plant, plus a lookup by id. */
function plant(entities: SiteEntity[]) {
  const model = plantModel(entities, null, []);
  return { components: model.components, entityOf: (id: string) => entities.find((e) => e.id === id) };
}

describe('gefahrenzone — was die Geräteseite anbietet', () => {
  it('offers deleting a pinned customer producer, with an honest keep/gone list', () => {
    const p = entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' });
    const { components, entityOf } = plant([p]);
    const z = gefahrenzone(components, entityOf);
    expect(z?.kind).toBe('entfernen');
    if (z?.kind !== 'entfernen') throw new Error('unreachable');
    // What stays is named as loudly as what goes (E3/E4).
    expect(z.folgen.some((f) => f.art === 'keep' && /bleiben/.test(f.text))).toBe(true);
    expect(z.folgen.some((f) => f.art === 'gone' && /Live-Messung endet/.test(f.text))).toBe(true);
    // A pinned component names that the device becomes free again.
    expect(z.folgen.some((f) => /Leseplan/.test(f.text))).toBe(true);
  });

  it('offers deleting a customer producer that was NEVER connected (E2)', () => {
    // No pin, no `composed` marker → deletable, not stuck as Grundausstattung.
    const p = entity('p', 'producer', { label: 'PV Scheune' });
    const { components, entityOf } = plant([p]);
    const z = gefahrenzone(components, entityOf);
    expect(z?.kind).toBe('entfernen');
    // With no pin, the freed-device line is NOT promised (there was none).
    if (z?.kind !== 'entfernen') throw new Error('unreachable');
    expect(z.folgen.some((f) => /Leseplan/.test(f.text))).toBe(false);
  });

  it('shows the battery the Grund+Weg path, never a direct delete', () => {
    const b = entity('b', 'battery-hybrid', {
      capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }] },
    });
    const { components, entityOf } = plant([b]);
    const z = gefahrenzone(components, entityOf);
    expect(z?.kind).toBe('batterie');
    if (z?.kind !== 'batterie') throw new Error('unreachable');
    // The one battery line the concept requires.
    expect(z.folgen.some((f) => f.text === 'Die Optimierung plant ohne diesen Speicher.')).toBe(true);
  });

  it('finds the battery even when the gateway also carries grid/house', () => {
    // A hybrid gateway hosts battery-hybrid + a synthesized grid-meter: the
    // battery path wins over the ambiguous "one main component" fallback.
    const b = entity('b', 'battery-hybrid', {
      capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }] },
    });
    const netz = entity('netz', 'grid-meter', { sourceKind: 'composed' });
    const { components, entityOf } = plant([b, netz]);
    expect(gefahrenzone(components, entityOf)?.kind).toBe('batterie');
  });

  it('shows only the reason for a synthesized base row, never a dead button', () => {
    const netz = entity('netz', 'grid-meter', { label: 'Netzanschluss', sourceKind: 'composed' });
    const { components, entityOf } = plant([netz]);
    const z = gefahrenzone(components, entityOf);
    expect(z?.kind).toBe('geschuetzt');
    if (z?.kind !== 'geschuetzt') throw new Error('unreachable');
    expect(z.grund).toMatch(/Grundausstattung/);
  });

  it('protects a legacy synthesized grid-meter even without a sourceKind marker (SF-1)', () => {
    // No pin, no 'composed' marker (composed before the column existed): the
    // role alone must keep it in the protected state, never offered for delete.
    const legacy = entity('netz', 'grid-meter', { label: 'Netzanschluss' });
    const { components, entityOf } = plant([legacy]);
    expect(gefahrenzone(components, entityOf)?.kind).toBe('geschuetzt');
  });

  it('offers nothing on the bare box (no components)', () => {
    expect(gefahrenzone([], () => undefined)).toBeNull();
  });
});

describe('die Folgenlisten', () => {
  it('names the kWp that leaves the plant total when a producer carries one', () => {
    const p = entity('p', 'producer', { edgeSourceId: 'src-1', capacityKwp: 9.8 });
    const { components } = plant([p]);
    const folgen = komponenteEntfernenFolgen(components[0], p);
    expect(folgen.some((f) => /kWp/.test(f.text))).toBe(true);
  });

  it('keeps the battery consequences honest: history stays, planning drops it', () => {
    const folgen = batterieAbmeldenFolgen();
    expect(folgen.filter((f) => f.art === 'keep')).toHaveLength(1);
    expect(folgen.some((f) => /Steuerung enden/.test(f.text))).toBe(true);
    expect(folgen.at(-1)?.text).toBe('Die Optimierung plant ohne diesen Speicher.');
  });

  it('names the lost PV-Produktion only when the device carries the assignment (vp-agg)', () => {
    const p = entity('p', 'producer', { label: 'Deye SUN-30K' });
    const { components } = plant([p]);
    const pv = /PV-Produktion/;
    // Ohne Zuordnung wird die Folge NICHT versprochen (die Vorgabe ist false).
    expect(komponenteEntfernenFolgen(components[0], p).some((f) => pv.test(f.text))).toBe(false);
    // Mit Zuordnung steht die ehrliche Folge da - als „endet" (gone).
    const mit = komponenteEntfernenFolgen(components[0], p, true);
    expect(mit.some((f) => f.art === 'gone' && pv.test(f.text))).toBe(true);
  });
});

describe('berichtsBelegAus — die Ablehnung „Beleg freigegebener Berichtsstände“ (UEMS AP-12 IP-12)', () => {
  const staende = [{ kennung: 'BR-2026-0001', nr: 1 }];
  const ms10 = { id: 'ms-10', kennzeichen: 'MS-10', name: 'Netzbezug Halle 2' };

  it('liest 409 berichts_belege: der Vertragssatz und die zitierten Messstellen', () => {
    expect(berichtsBelegAus(409, {
      code: 'berichts_belege', codes: ['berichts_belege'], message: 'vom Server', messstellen: [ms10], berichtsstaende: staende,
    })).toEqual({
      satz: 'Diese Komponente ist Beleg in einem freigegebenen Berichtsstand (BR-2026-0001 Nr. 1). '
        + 'Löschen ist nicht möglich — beenden Sie die Bindung stattdessen.',
      messstellen: [ms10],
    });
  });

  it('erkennt den Grund auch als zweiten Code neben messstellen_belege (Purge, Anlage)', () => {
    const b = berichtsBelegAus(409, {
      code: 'messstellen_belege', codes: ['messstellen_belege', 'berichts_belege'], messstellen: [ms10], berichtsstaende: staende,
    });
    expect(b?.satz).toContain('(BR-2026-0001 Nr. 1)');
  });

  it('jede andere Ablehnung ist kein Beleg', () => {
    expect(berichtsBelegAus(409, { code: 'messstellen_belege', codes: ['messstellen_belege'], messstellen: [ms10], berichtsstaende: [] }))
      .toBeNull();
    expect(berichtsBelegAus(409, { message: 'Dieser Verbraucher ist noch mit einem Gerät verbunden. Bitte zuerst trennen.' }))
      .toBeNull();
    expect(berichtsBelegAus(422, { code: 'berichts_belege', codes: ['berichts_belege'], berichtsstaende: staende })).toBeNull();
    expect(berichtsBelegAus(409, undefined)).toBeNull();
    expect(berichtsBelegAus(409, { code: 'berichts_belege', berichtsstaende: [{ kennung: 1, nr: '1' }] })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { SiteTopology } from '../api';
import { CUSTOMER_TEMPLATES } from './customerTemplates';
import type { EditorEntity } from './model';
import {
  fitsPlant,
  hiddenDisclosure,
  missingReason,
  partition,
  plantRoles,
} from './templateFilter';

function ent(
  id: string,
  entityType: string,
  measure: string[],
  actuate: string[] = [],
): EditorEntity {
  return { id, entityType, label: id, measure, actuate };
}

const BATTERY = ent('e-batt', 'battery-hybrid', ['soc_pct', 'pv_power_kw'], ['setpoint_kw']);
const GRID = ent('e-grid', 'grid-meter', ['power_kw']);
const WALLBOX = ent('e-wb', 'wallbox', ['power_kw'], ['on_off']);
const PV = ent('e-pv', 'producer', ['pv_power_kw']);

const PV_SURPLUS = CUSTOMER_TEMPLATES.find((t) => t.id === 'pv-surplus-consumer')!;
const SCHEDULE = CUSTOMER_TEMPLATES.find((t) => t.id === 'schedule-consumer')!;

describe('plantRoles', () => {
  it('derives the roles from the entities capabilities, not a type list', () => {
    const roles = plantRoles({ entities: [BATTERY, GRID, WALLBOX, PV] });
    expect([...roles].sort()).toEqual(['consumer', 'grid', 'pv', 'storage']);
  });

  it('a consumer that cannot be switched is NOT a consumer role', () => {
    // Measured only (no on_off) - the templates need a switchable device, so
    // classifying it as fitting would offer a template that cannot resolve.
    const measured = ent('e-heat', 'generic-load', ['power_kw']);
    expect(plantRoles({ entities: [measured] }).has('consumer')).toBe(false);
  });

  it('an empty plant has no role at all', () => {
    expect(plantRoles({ entities: [] }).size).toBe(0);
  });

  it('takes the category from the topology read-model when it is loaded', () => {
    // An entity whose capabilities alone would read as a meter, but whose
    // registry category says consumer - the topology wins.
    const odd = ent('e-x', 'irgendwas', ['power_kw'], ['on_off']);
    const topology = {
      schemaVersion: '1.0',
      entities: [
        {
          id: 'e-x',
          entityType: 'irgendwas',
          typeLabel: 'x',
          label: 'x',
          category: 'consumer',
          health: 'ok',
          capabilities: [],
        },
      ],
      topology: { schema_version: '1.0', nodes: [] },
    } as unknown as SiteTopology;
    expect(plantRoles({ entities: [odd], topology }).has('consumer')).toBe(true);
    expect(plantRoles({ entities: [odd], topology }).has('grid')).toBe(false);
  });
});

describe('fitsPlant / missingReason', () => {
  it('a plant with wallbox + grid meter fits both templates', () => {
    const plant = { entities: [BATTERY, GRID, WALLBOX] };
    expect(fitsPlant(PV_SURPLUS, plant)).toBe(true);
    expect(fitsPlant(SCHEDULE, plant)).toBe(true);
    expect(missingReason(PV_SURPLUS, plant)).toBeNull();
  });

  it('a wallbox-less plant does not fit, and the reason names what is missing', () => {
    const plant = { entities: [BATTERY, GRID] };
    expect(fitsPlant(SCHEDULE, plant)).toBe(false);
    expect(missingReason(SCHEDULE, plant)).toBe(
      'Dafür fehlt Ihrer Anlage noch ein steuerbares Gerät.',
    );
  });

  it('names BOTH missing roles when neither is there', () => {
    expect(missingReason(PV_SURPLUS, { entities: [BATTERY] })).toBe(
      'Dafür fehlt Ihrer Anlage noch ein steuerbares Gerät und ein Netz-Zähler.',
    );
  });

  it('a plant with a wallbox but no grid meter fits only the schedule template', () => {
    const plant = { entities: [WALLBOX] };
    expect(fitsPlant(SCHEDULE, plant)).toBe(true);
    expect(fitsPlant(PV_SURPLUS, plant)).toBe(false);
    expect(missingReason(PV_SURPLUS, plant)).toBe(
      'Dafür fehlt Ihrer Anlage noch ein Netz-Zähler.',
    );
  });
});

describe('partition / hiddenDisclosure', () => {
  it('hides what does not fit behind a counted, honest line', () => {
    const part = partition(CUSTOMER_TEMPLATES, { entities: [BATTERY, GRID] });
    expect(part.fitting).toEqual([]);
    expect(part.notFitting).toHaveLength(2);
    expect(hiddenDisclosure(part)).toBe('2 weitere Vorlagen passen nicht zu Ihrer Anlage');
    for (const row of part.notFitting) expect(row.reason).toContain('fehlt');
  });

  it('counts a single hidden template in the singular', () => {
    const part = partition(CUSTOMER_TEMPLATES, { entities: [WALLBOX] });
    expect(part.fitting.map((t) => t.id)).toEqual(['schedule-consumer']);
    expect(hiddenDisclosure(part)).toBe('1 weitere Vorlage passt nicht zu Ihrer Anlage');
  });

  it('hides nothing when everything fits', () => {
    const part = partition(CUSTOMER_TEMPLATES, { entities: [GRID, WALLBOX] });
    expect(part.notFitting).toEqual([]);
    expect(hiddenDisclosure(part)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { tenantPulse } from './adminPulse';
import type { Tenant } from './admin/adminApi';

function t(id: string, segment: string): Tenant {
  return { id, name: `T-${id}`, segment, plan: 'basic', createdAt: '2026-01-01T00:00:00Z' };
}

describe('tenantPulse', () => {
  it('counts total and splits B2C (Privat) vs CI (Gewerbe)', () => {
    const p = tenantPulse([t('1', 'B2C'), t('2', 'CI'), t('3', 'B2C'), t('4', 'CI'), t('5', 'CI')]);
    expect(p).toEqual({ total: 5, privat: 2, gewerbe: 3, andere: 0 });
  });

  it('folds unknown segments into "andere" without inflating the split', () => {
    const p = tenantPulse([t('1', 'B2C'), t('2', 'GOV'), t('3', '')]);
    expect(p).toEqual({ total: 3, privat: 1, gewerbe: 0, andere: 2 });
  });

  it('is all-zero for an empty platform', () => {
    expect(tenantPulse([])).toEqual({ total: 0, privat: 0, gewerbe: 0, andere: 0 });
  });
});

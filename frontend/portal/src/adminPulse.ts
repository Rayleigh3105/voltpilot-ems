import type { Tenant } from './admin/adminApi';

/**
 * At-a-glance platform pulse for the Mandanten page (the de-facto admin
 * landing). Derived PURELY from the tenants already in hand - no extra API
 * call, no new data - so it stays honest: it can only report what a tenant row
 * carries (its segment). The bigger cross-tenant health dashboard (devices
 * online platform-wide, pending enrollments, …) needs a backend endpoint and is
 * a separate, captain-decided swing (see docs/admin-ux-assessment.md).
 */
export interface TenantPulse {
  total: number;
  /** Segment B2C. */
  privat: number;
  /** Segment CI (Gewerbe & Industrie). */
  gewerbe: number;
  /** Any other/unknown segment value - only surfaced when > 0. */
  andere: number;
}

export function tenantPulse(tenants: Tenant[]): TenantPulse {
  let privat = 0;
  let gewerbe = 0;
  let andere = 0;
  for (const t of tenants) {
    if (t.segment === 'B2C') privat += 1;
    else if (t.segment === 'CI') gewerbe += 1;
    else andere += 1;
  }
  return { total: tenants.length, privat, gewerbe, andere };
}

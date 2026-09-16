import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const pv1 = 'deye.hybrid_3p.pv.pv1-power';
// Die Abnahme verwendet exportierte echte API-Seiten aus UemsSummenwertAbnahmeTest.
// Ohne Export bleibt der Test mit dem paketierten Katalog ausführbar; nur PV1 braucht Semantik.
const dist = resolve('../../catalog/measurement-points/dist');
const raw = JSON.parse(readFileSync(resolve(dist, readdirSync(dist).find(p => p.endsWith('.json'))!), 'utf8'));
const points = raw.points.filter((p: any) => p.family === 'hybrid_3p').map((p: any) => ({
  pointKey: p.point_key, labelDe: p.label_de, labelSource: p.label_source, family: p.family,
  group: p.group, unit: p.unit, aggregationKind: p.aggregation_kind, selected: false,
  quantity: p.point_key === pv1 ? 'active_power' : null, direction: p.point_key === pv1 ? 'generation' : null,
  lastReadAt: null, decodedValue: null, estimatedDataPerYearBytes: 400_000_000,
}));
const pages = process.env.SUMMENWERT_API_SEITEN
  ? JSON.parse(readFileSync(process.env.SUMMENWERT_API_SEITEN, 'utf8'))
  : [0, 250, 500].map(offset => ({ points: points.slice(offset, offset + 250), total: points.length, offset, limit: 250 }));

for (const width of [375, 1440]) {
  test(`Deye ohne gespeicherte Familie: eigene Register und PV1 bei ${width}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [], catalogEntities: string[] = [], offsets: number[] = [], sources: URL[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (p.endsWith('/entities')) return route.fulfill({ json: {
        registry: null, staleOnDevice: [], entities: [
          { id: 'inv', entityType: 'battery-hybrid', typeLabel: 'Batteriespeicher', role: 'storage', label: null, control: false,
            deviceId: 'd1', capabilities: { measure: [{ channel: 'soc_pct' }] }, guards: null, observed: null, edgeSourceId: null, sourceKind: 'composed' },
          { id: 'other', entityType: 'producer', typeLabel: 'Erzeuger', role: 'pv', label: 'Anderes Gerät', control: false,
            deviceId: 'd1', capabilities: { measure: [] }, guards: null, observed: null, edgeSourceId: 'src-other' },
        ], localSetup: [
          { id: 'inverter', kind: 'inverter', model: 'SUN-30K-SG01HP3-EU', brand: 'deye', family: 'hybrid_3p', label: null, reportedAt: new Date().toISOString() },
          { id: 'src-other', kind: 'source', family: 'string', label: 'Anderes Gerät', adoptedEntityId: 'other', reportedAt: new Date().toISOString() },
        ],
      } });
      if (p.endsWith('/components')) return route.fulfill({ json: { componentAuthority: 'box', components: [] } });
      if (p.endsWith('/sources') || p.endsWith('/summenwerte') || p.endsWith('/register-write/targets')) return route.fulfill({ json: [] });
      if (p.endsWith('/summenwert-quellen')) {
        sources.push(url);
        const own = { entityId: 'inv', deviceId: 'd1', name: 'SUN-30K-SG01HP3-EU', grund: null };
        return route.fulfill({ json: url.searchParams.get('geraetId') === 'inverter' ? [own]
          : [own, { entityId: 'other', deviceId: 'd1', name: 'Anderes Gerät', grund: null }] });
      }
      if (p.endsWith('/measurement-selection/catalog')) {
        // Die normale Registeransicht darf ihren eigenen Abruf behalten.
        if (url.searchParams.get('availableOnly') !== 'true') return route.fulfill({ json: { points: [], total: 0, groups: [], semanticStatuses: [] } });
        catalogEntities.push(url.searchParams.get('entityId')!);
        offsets.push(Number(url.searchParams.get('offset')));
        return route.fulfill({ json: pages.find((p: any) => p.offset === Number(url.searchParams.get('offset'))) });
      }
      if (p.endsWith('/measurement-selection/lesen')) return route.fulfill({ json: { wert: null, einheit: 'W', gelesen_am: null, grund: 'box_offline' } });
      if (p.endsWith('/measurement-selection')) return route.fulfill({ json: { selections: [], events: [], desiredRevision: 0,
        volumeEstimate: { totalGbPerYear: 0 }, statusReason: 'Noch keine Register beobachtet.' } });
      if (p.endsWith('/chargers')) return route.fulfill({ json: { budget: null, chargers: [] } });
      return route.fulfill({ status: 204 });
    });
    await page.goto('/e2e/summenwert-geraet-kontext.html');
    await page.getByRole('button', { name: 'Summenwert anlegen', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Summenwert/ });
    await expect(dialog.locator('summary')).toHaveText('Alle Register des Geräts · 624 weitere');
    expect(sources).toHaveLength(1);
    expect(sources[0].searchParams.get('boxId')).toBe('d1');
    expect(catalogEntities).toEqual(['inv', 'inv', 'inv']);
    expect(offsets).toEqual([0, 250, 500]);
    await expect(dialog.getByText('Weitere Geräte dieser Anlage')).toHaveCount(0);
    await expect(dialog.getByText('Anderes Gerät', { exact: true })).toHaveCount(0);
    if (process.env.SUMMENWERT_BILDER) {
      mkdirSync(process.env.SUMMENWERT_BILDER, { recursive: true });
      await dialog.screenshot({ path: `${process.env.SUMMENWERT_BILDER}/katalog-${width}.png`, animations: 'disabled' });
    }
    await dialog.getByRole('searchbox', { name: 'Register durchsuchen' }).fill('PV1 Leistung');
    await dialog.getByRole('button', { name: 'PV1 Leistung mitzählen' }).click();
    await expect(dialog.getByText(/die Box antwortet nicht/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled();
    expect(await dialog.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    if (process.env.SUMMENWERT_BILDER) {
      mkdirSync(process.env.SUMMENWERT_BILDER, { recursive: true });
      await dialog.screenshot({ path: `${process.env.SUMMENWERT_BILDER}/nachher-${width}.png`, animations: 'disabled' });
    }
    expect(errors).toEqual([]);
  });
}

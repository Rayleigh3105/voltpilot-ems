import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteTopology, TopologyEntity } from '../api';
import { derive } from '../topology';
import { RollenZuordnung } from './TechnischeKarten';

/**
 * „maßgeblich setzen“ nur für Netz und Ladestand (Schramm „Zuhause“, 07.11.2026): am PIKO gesetzt legte es eine
 * PV-Zuordnung an, die Cockpit und Übersicht als ganze Sonne lasen - PV und Verbrauch summieren ihre Mitglieder,
 * dort bedeutet „maßgeblich“ nichts. Fiktive Geräte.
 */
const geraet = (id: string, entityType: string, category: string, label: string,
  caps: [channel: string, role: string, primary: boolean, value: number][]): TopologyEntity => ({
  id, entityType, typeLabel: entityType, label, category, health: 'ok',
  capabilities: caps.map(([channel, role, primary, value]) => ({
    channel, unit: channel === 'soc_pct' ? '%' : 'kW', role, primary, value,
  })),
});

const ENTITAETEN: TopologyEntity[] = [
  geraet('wr-a', 'producer', 'producer', 'WR Scheune', [['pv_power_kw', 'pv', true, 1.2]]),
  geraet('wr-b', 'producer', 'producer', 'WR Halle', [['pv_power_kw', 'pv', false, 2.5]]),
  geraet('netz-a', 'grid-meter', 'meter', 'Netz Hof', [['power_kw', 'grid', true, 5.9]]),
  geraet('netz-b', 'grid-meter', 'meter', 'Netz Halle', [['power_kw', 'grid', false, 5.8]]),
  geraet('sp-a', 'battery-hybrid', 'storage', 'Speicher Ost', [['soc_pct', 'storage', true, 60], ['battery_power_kw', 'storage', true, 1]]),
  geraet('sp-b', 'battery-hybrid', 'storage', 'Speicher West', [['soc_pct', 'storage', false, 58], ['battery_power_kw', 'storage', false, 0.5]]),
  geraet('uv-a', 'sub-meter', 'consumer', 'UV Halle', [['power_kw', 'consumer', true, 7.9]]),
  geraet('uv-b', 'sub-meter', 'consumer', 'UV Keller', [['power_kw', 'consumer', false, 0.1]]),
];

const TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: ENTITAETEN,
  topology: derive({
    entities: ENTITAETEN.map((e) => ({
      id: e.id, type: e.entityType, label: e.label ?? '', category: e.category, health: e.health,
      capabilities: e.capabilities.map((c) => ({ channel: c.channel, role: c.role ?? '', primary: c.primary, value: c.value })),
    })),
  }),
};

function kasten(container: HTMLElement, rolle: string): HTMLElement {
  const k = container.querySelector<HTMLElement>(`.vp-role-box.vp-role-${rolle}`);
  if (!k) throw new Error(`kein Kasten ${rolle}`);
  return k;
}

describe('„maßgeblich“ nur für Netz und Ladestand', () => {
  it('PV und Verbrauch: kein Knopf und kein Häkchen - sie summieren ihre Mitglieder', () => {
    const { container } = render(<RollenZuordnung siteId="s" topology={TOPO} onChanged={() => {}} />);
    for (const rolle of ['pv', 'consumer']) {
      const k = within(kasten(container, rolle));
      expect(k.queryByRole('button', { name: 'maßgeblich setzen' })).toBeNull();
      expect(k.queryByText('maßgeblich ✓')).toBeNull();
    }
  });

  it('Netz: der zweite Zähler lässt sich maßgeblich setzen', () => {
    const { container } = render(<RollenZuordnung siteId="s" topology={TOPO} onChanged={() => {}} />);
    const k = within(kasten(container, 'grid'));
    expect(k.getAllByText('maßgeblich ✓')).toHaveLength(1);
    expect(k.getAllByRole('button', { name: 'maßgeblich setzen' })).toHaveLength(1);
  });

  it('Speicher: nur der Ladestand ist wählbar, nicht die Batterieleistung (sie summiert)', () => {
    const { container } = render(<RollenZuordnung siteId="s" topology={TOPO} onChanged={() => {}} />);
    const k = kasten(container, 'storage');
    const zeilen = [...k.querySelectorAll<HTMLElement>('.vp-role-member')];
    const mitKnopf = zeilen.filter((z) => within(z).queryByRole('button', { name: 'maßgeblich setzen' }));
    const mitHaken = zeilen.filter((z) => within(z).queryByText('maßgeblich ✓'));
    expect(mitKnopf.map((z) => z.textContent)).toEqual([expect.stringContaining('%')]);
    expect(mitHaken.map((z) => z.textContent)).toEqual([expect.stringContaining('%')]);
  });
});

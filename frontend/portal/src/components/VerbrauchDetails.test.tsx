import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteTopology, TopologyEntity } from '../api';
import type { ChargePoint } from '../ladepunkte';
import { NO_DATA } from '../nodata';
import type { FlowMember } from '../topology';
import { verbrauchKomposition } from '../verbrauchKomposition';
import { VerbrauchDetails } from './VerbrauchDetails';

function entity(over: Partial<TopologyEntity> & { id: string }): TopologyEntity {
  return {
    id: over.id,
    entityType: over.entityType ?? 'generic-load',
    typeLabel: over.typeLabel ?? 'Steuerbare Last',
    label: over.label ?? null,
    category: 'consumer',
    health: over.health ?? 'ok',
    capabilities: [],
  };
}

function topo(members: FlowMember[], entities: TopologyEntity[]): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities,
    topology: {
      schema_version: '1.0',
      nodes: [{ role: 'consumer', flow_active: true, direction: 'out', members }],
    },
  };
}

const ENTITIES = [
  entity({ id: 'haus', entityType: 'house-load', typeLabel: 'Hausverbrauch' }),
  entity({ id: 'rod', entityType: 'heating-rod', typeLabel: 'Heizstab' }),
];
const MEMBERS: FlowMember[] = [
  { entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 14.1 },
  { entity_id: 'rod', label: 'Heizstab Warmwasser', primary: false, value_kw: 1.9 },
];
const WALLBOX: ChargePoint = {
  deviceId: 'd1',
  chargePointId: 'GARAGE-1',
  label: 'Wallbox Garage',
  priority: false,
  connected: true,
  ready: true,
  lastSeen: '2026-08-28T09:41:00Z',
  entityId: null,
  reportedAt: '2026-08-28T09:41:00Z',
  connectors: [
    { connectorId: 1, status: 'Charging', charging: true, powerKw: 11, sessionSince: '2026-08-28T12:10:00Z' },
  ],
};

function baue(over: Parameters<typeof verbrauchKomposition>[0] | null = null) {
  return verbrauchKomposition(
    over ?? { topology: topo(MEMBERS, ENTITIES), chargers: [WALLBOX] },
  )!;
}

describe('VerbrauchDetails', () => {
  it('nennt jede Gruppe, jedes Gerät und den Rest', () => {
    render(<VerbrauchDetails komposition={baue()} now={new Date('2026-08-28T09:42:00Z')} />);
    expect(screen.getByText('Verbrauch setzt sich zusammen aus')).toBeInTheDocument();
    expect(screen.getByText('2 Verbraucher')).toBeInTheDocument();
    expect(screen.getByText('Laden')).toBeInTheDocument();
    expect(screen.getByText('Wärme')).toBeInTheDocument();
    expect(screen.getByText('Wallbox Garage')).toBeInTheDocument();
    expect(screen.getByText('Heizstab Warmwasser')).toBeInTheDocument();
    expect(screen.getByText('übriger Haushalt')).toBeInTheDocument();
  });

  it('zeigt ohne Messwert das WORT statt einer Null', () => {
    const k = baue({
      topology: topo(MEMBERS, ENTITIES),
      chargers: [{
        ...WALLBOX,
        connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: null }],
      }],
    });
    render(<VerbrauchDetails komposition={k} />);
    expect(screen.getByText('Lädt — Leistung nicht messbar')).toBeInTheDocument();
    // Und der Rest sagt seinen GRUND, statt die Lücke des Nachbarn zu schlucken.
    expect(
      screen.getByText('nicht bestimmbar (Wallbox Garage ohne Leistungsmessung)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0,0 kW/)).not.toBeInTheDocument();
  });

  it('der Rest trägt weder Punkt noch Sprung - er ist kein Gerät', () => {
    const { container } = render(<VerbrauchDetails komposition={baue()} />);
    const rest = container.querySelector('.vp-vbcomp-row.rest')!;
    expect(rest).toBeTruthy();
    expect(rest.querySelector('.vp-pvsplit-dot')).toBeNull();
    expect(rest.querySelector('a')).toBeNull();
  });

  it('verlinkt eine Zeile nur, wenn es ein Ziel gibt', () => {
    const ohne = render(<VerbrauchDetails komposition={baue()} />);
    expect(ohne.container.querySelectorAll('.vp-vbcomp-link')).toHaveLength(0);
    ohne.unmount();

    const mit = baue({
      topology: topo(MEMBERS, ENTITIES),
      chargers: [WALLBOX],
      links: { charger: (id) => `#/anlage/s1/geraet/box/cp-${id}` },
    });
    const { container } = render(<VerbrauchDetails komposition={mit} />);
    const link = container.querySelector('.vp-vbcomp-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/anlage/s1/geraet/box/cp-GARAGE-1');
  });

  it('E4: die kollabierte Laden-Gruppe SAGT, wo ihre Zeilen stehen', () => {
    const k = baue({
      topology: topo(MEMBERS, ENTITIES),
      chargers: [WALLBOX],
      ladenKachelSichtbar: true,
    });
    const { container } = render(<VerbrauchDetails komposition={k} />);
    expect(screen.getByText('1 Ladepunkt')).toBeInTheDocument();
    expect(screen.getByText(/in der Kachel „Laden"/)).toBeInTheDocument();
    // Die Summe der Gruppe steht weiter da - kollabiert heisst zusammengefasst.
    expect(screen.getByText('1 von 1 lädt · 11,0 kW')).toBeInTheDocument();
    expect(screen.queryByText('Wallbox Garage')).not.toBeInTheDocument();
    // Und der Balken zeigt nur noch, was hier auch als Zeile steht.
    const segs = container.querySelectorAll('.vp-vbcomp-seg');
    expect(segs.length).toBe(2); // Heizstab + Rest
  });

  it('zeigt „—" statt einer erfundenen Tagessumme', () => {
    const { container } = render(<VerbrauchDetails komposition={baue()} />);
    const heute = container.querySelectorAll('.vp-vbcomp-today');
    expect(heute.length).toBeGreaterThan(0);
    for (const h of heute) expect(within(h as HTMLElement).getByText(NO_DATA)).toBeInTheDocument();
  });
});

import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CockpitHero } from './CockpitHero';
import { ControlStrip } from './ControlStrip';
import type { LiveSnapshot } from '../live';
import type { SiteTopology } from '../api';

/**
 * **Die Bühne** (abgenommenes Konzept `data/vp-cockpit-konzept-f4`, Richtung A).
 *
 * Hier wird der Aufbau festgenagelt, den der Captain abgenommen hat:
 *
 *  - Fluss links, **Bilanz-Leiste rechts** (seit P5: die Erlöskarte im
 *    C-Kleid → Fahrplan-Zeile) — die Leiste verteilt die
 *    VORHANDENEN Blöcke über die volle Bühnenhöhe, deshalb gibt es die tote
 *    Zone unter dem Geldblock nicht mehr.
 *  - Die Steuerung ist der **Bühnenfuß** über die volle Kartenbreite, kein
 *    Karte-in-Karte-Rahmen und keine leere Hälfte daneben.
 *  - **Komposition-getrieben:** was ein Gesicht nicht beisteuert, erzeugt
 *    keinen leeren Rahmen — und eine Komposition ganz ohne Leisten-Block
 *    bekommt gar keine Leiste.
 */

// jsdom kennt keinen ResizeObserver (der Fluss misst seinen Container).
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;

const SNAP: LiveSnapshot = {
  pvKw: 38.1,
  loadKw: 6,
  gridKw: -30,
  battKw: 2.1,
  socPct: 93,
  socAt: '2026-07-30T12:00:00Z',
};

function renderStage(
  over: {
    seite?: React.ReactNode;
    showRail?: boolean;
    footer?: React.ReactNode;
    topology?: SiteTopology | null;
  } = {},
) {
  return render(
    <CockpitHero
      topology={over.topology ?? null}
      snapshot={SNAP}
      onOpenSub={() => {}}
      seite={over.seite ?? null}
      showRail={over.showRail ?? true}
      footer={over.footer ?? null}
    />,
  );
}

describe('Die Leitkachel neben dem Fluss (Konzept „Cockpit als Tagesfilm“)', () => {
  it('steht rechts neben dem Fluss, die Bühne wird zweispaltig', () => {
    const { container } = renderStage({ seite: <div className="leit">Unterm Strich</div> });
    const rail = container.querySelector('.vp-hero-side');
    expect(rail?.querySelector('.leit')?.textContent).toBe('Unterm Strich');
    expect(container.querySelector('.vp-cockpit-hero.vp-stage-norail')).toBeNull();
  });

  it('ohne Leitkachel gibt es keine leere zweite Spalte', async () => {
    const { container } = renderStage();
    expect(container.querySelector('.vp-hero-side')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero.vp-stage-norail')).not.toBeNull();
    // Die Bühne lädt nach (eigenes Stück); der Fluss ist danach da.
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-lp')).not.toBeNull());
  });

  it('am Telefon (showRail = false) steht sie nicht in der Bühne, sondern im Raster', () => {
    const { container } = renderStage({ seite: <div className="leit" />, showRail: false });
    expect(container.querySelector('.vp-hero-side')).toBeNull();
  });
});

describe('Der Bühnenfuß', () => {
  it('trägt die Steuerung über die volle Breite - nicht mehr in der Fluss-Spalte', () => {
    const { container } = renderStage({
      seite: <div className="leit" />,
      footer: (
        <ControlStrip
          variant="bare"
          view={{
            state: 'healthy',
            tone: 'ok',
            sentence: 'Ihr Gerät regelt gerade auf 2,1 kW → Wechselrichter bestätigt 2,1 kW',
            agoNote: 'geprüft vor 12 s',
            reason: 'Mittags-PV wird gespeichert und am Abend verkauft.',
          }}
        />
      ),
    });
    const foot = container.querySelector('.vp-stage-foot');
    expect(foot).not.toBeNull();
    // Der Fuß ist ein Geschwister der beiden Spalten (grid-column: 1/-1),
    // NICHT ein Kind der Fluss-Spalte - das war die leere Hälfte (Befund P4).
    expect(container.querySelector('.vp-hero-flow .vp-stage-foot')).toBeNull();
    expect(container.querySelector('.vp-hero-side .vp-stage-foot')).toBeNull();
    // Sollwert → Bestätigung → Grund, ohne eigenen Kartenrahmen (P5).
    expect(foot?.textContent).toContain('regelt gerade auf');
    expect(foot?.querySelector('.vp-control-reason')?.textContent).toContain('Abend verkauft');
    expect(foot?.querySelector('.vp-card')).toBeNull();
  });

  it('fehlt ganz, wenn es keine Steuerung zu zeigen gibt', () => {
    const { container } = renderStage();
    expect(container.querySelector('.vp-stage-foot')).toBeNull();
  });
});


describe('H-3: der adaptive Fluss liest dieselben Rollen wie die Aufschlüsselung', () => {
  it('zeigt bei zugeordneter stummer PV nie wieder die rohe PV-Zahl', async () => {
    const topology: SiteTopology = { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [
      { role: 'pv', value_kw: 99, flow_active: true, members: [{ entity_id: 'pv', label: 'Wechselrichter', primary: true, value_kw: 99 }] },
      { role: 'grid', value_kw: 3.5, flow_active: true, members: [{ entity_id: 'netz', label: 'Netz', primary: true, value_kw: 3.5 }] },
    ] } };
    const { container } = render(<CockpitHero topology={topology} snapshot={SNAP} onOpenSub={() => {}}
      pvRollen={{ role: 'pv', wert: null, einheit: 'kW', stand: null, zuordnung_vorhanden: true, unvollstaendig: true,
        geraete: [{ entity_id: 'pv', name: 'Wechselrichter', art: 'gesamtwert', wert: null, liefernd: false, grund: 'veraltet' }] }} />);
    await waitFor(() => expect(container.querySelector('.vp-lp')).not.toBeNull());
    const fluss = container.querySelector('.vp-lp');
    expect(fluss!.textContent).not.toContain('99');
    // Die Aufschlüsselung je Gerät steht im Blatt des Sonnen-Knotens.
    fireEvent.click(container.querySelector('.vp-lp-k-pv')!);
    await waitFor(() => expect(document.body.querySelector('.vp-rolle-pv')?.textContent).toContain('Stand unbekannt'));
    expect(topology.topology.nodes[0].value_kw).toBe(99);
  });
});

describe('Laden bei Bezug unter dem Fluss (K8/B2)', () => {
  it('steht als Hinweis unter dem Fluss, nur wenn es einen Satz gibt', () => {
    const satz = 'Eine Wolke hat die Sonne gerade verdeckt – der Speicher regelt in den nächsten Sekunden nach.';
    const mit = render(
      <CockpitHero topology={null} snapshot={SNAP} onOpenSub={() => {}} ladenHinweis={satz} />,
    );
    const p = mit.container.querySelector('.vp-hero-flow .vp-hero-hinweis');
    expect(p?.textContent).toBe(satz);
    expect(p?.getAttribute('role')).toBe('status');
    mit.unmount();
    const ohne = renderStage();
    expect(ohne.container.querySelector('.vp-hero-hinweis')).toBeNull();
  });
});

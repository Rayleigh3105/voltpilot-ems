import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CockpitHero } from './CockpitHero';
import { ControlStrip } from './ControlStrip';
import type { CockpitHeroView } from '../cockpitWidgets';
import type { LiveSnapshot } from '../live';
import type { SiteTopology } from '../api';

/**
 * **Die Bühne** (abgenommenes Konzept `data/vp-cockpit-konzept-f4`, Richtung A).
 *
 * Hier wird der Aufbau festgenagelt, den der Captain abgenommen hat:
 *
 *  - Fluss links, **Bilanz-Leiste rechts** (Zeitraum-Segment → Geld mit
 *    Zurechnung → Ringe → Fahrplan-Zeile) — die Leiste verteilt die
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

/** Pilsting: Direktvermarktung, alle vier Leisten-Blöcke. */
function pilstingView(over: Partial<CockpitHeroView> = {}): CockpitHeroView {
  return {
    rings: [
      { id: 'autarkie', label: 'Autarkie · Heute', pct: 88, valueText: '88 %', hue: 'var(--vp-flow-pv)' },
      {
        id: 'eigenverbrauch',
        label: 'Eigenverbrauch · Heute',
        pct: 32,
        valueText: '32 %',
        hue: 'var(--vp-flow-batt)',
      },
    ],
    ringsNote: null,
    money: {
      label: 'Verdient · Heute',
      value: '371,43 €',
      attribution: 'davon 79,87 € durch VoltPilots Steuerung',
    },
    planSentence: 'Nachmittags laden, abends verkaufen (19–24 Uhr).',
    ...over,
  };
}

function renderStage(
  view: CockpitHeroView,
  over: {
    periodSeg?: React.ReactNode;
    footer?: React.ReactNode;
    topology?: SiteTopology | null;
  } = {},
) {
  return render(
    <CockpitHero
      view={view}
      topology={over.topology ?? null}
      snapshot={SNAP}
      onOpenSub={() => {}}
      periodSeg={over.periodSeg ?? null}
      footer={over.footer ?? null}
    />,
  );
}

describe('Die Bilanz-Leiste', () => {
  it('trägt Zeitraum → Geld → Ringe → Fahrplan in dieser Reihenfolge (Pilsting)', () => {
    const { container } = renderStage(pilstingView(), {
      periodSeg: <div className="vp-seg vp-seg-compact" />,
    });
    const rail = container.querySelector('.vp-hero-side');
    expect(rail).not.toBeNull();
    const blocks = [...rail!.querySelectorAll(':scope > .vp-rail-blk')];
    expect(blocks).toHaveLength(4);
    // 1 · das kompakte Segment steht bei den Zahlen, die es regiert.
    expect(blocks[0].querySelector('.vp-seg')).not.toBeNull();
    expect(blocks[0].textContent).toContain('Bilanz');
    // 2 · Geld mit der Zurechnung als UNTERZEILE (nie ein eigener Summand).
    expect(blocks[1].classList.contains('vp-hero-money')).toBe(true);
    expect(blocks[1].querySelector('.vp-hero-money-value')?.textContent).toBe('371,43 €');
    expect(blocks[1].querySelector('.vp-hero-money-attr')?.textContent).toContain(
      'durch VoltPilots Steuerung',
    );
    // 3 · die Ringe, 4 · die Fahrplan-Zeile.
    expect(blocks[2].querySelectorAll('.vp-hero-ring')).toHaveLength(2);
    expect(blocks[3].querySelector('.vp-hero-plan')?.textContent).toContain('abends verkaufen');
    // Die Bühne bleibt zweispaltig.
    expect(container.querySelector('.vp-cockpit-hero.vp-stage-norail')).toBeNull();
  });

  it('rendert laufenden Geldfluss und geplanten Speicherbestand als zwei getrennte Zeilen', () => {
    const { container } = renderStage(
      pilstingView({
        money: {
          label: 'Verdient · Heute',
          value: '39,26 €',
          attribution: 'Zwischenstand Steuerung: −2,84 € bisher',
          attributionInterim: true,
          bestand: {
            text: 'dazu 44,2 kWh im Speicher für später — nach dem Plan ≈ +8,35 €',
            badge: 'Geplant',
            titel: 'Die Kilowattstunden sind gemessen, der Betrag ist geplant.',
            deltaKwh: 44.2,
            wertEur: 8.35,
          },
        },
      }),
    );
    expect(container.querySelector('.vp-hero-money-attr.is-interim')?.textContent).toContain('−2,84');
    expect(container.querySelector('.vp-hero-money-bestand')?.textContent).toContain('44,2 kWh');
    expect(container.querySelector('.vp-hero-money-bestand-badge')?.textContent).toBe('Geplant');
  });

  it('Haushalt: ohne Zeitraum-Segment bleibt die Leiste voll (Ringe führen)', () => {
    // Ein Eigenverbrauchs-Haushalt hat keinen zeitraum-bezogenen Geld-Modus →
    // kein Segment. Es entsteht KEIN leerer Rahmen, die Leiste trägt den Rest.
    const { container } = renderStage(pilstingView({ money: null }));
    const rail = container.querySelector('.vp-hero-side')!;
    expect(rail.querySelector('.vp-seg')).toBeNull();
    expect(rail.querySelector('.vp-hero-money')).toBeNull();
    expect(rail.querySelectorAll(':scope > .vp-rail-blk')).toHaveLength(2);
    expect(rail.querySelectorAll('.vp-hero-ring')).toHaveLength(2);
  });

  it('hält den Ring-Platz mit dem ehrlichen Satz statt mit „0 %"', () => {
    const { container } = renderStage(
      pilstingView({ rings: [], ringsNote: 'Autarkie und Eigenverbrauch gibt es je Zeitraum.' }),
    );
    expect(container.querySelector('.vp-hero-ring')).toBeNull();
    expect(container.querySelector('.vp-hero-rings-empty')?.textContent).toContain(
      'je Zeitraum',
    );
    expect(container.textContent).not.toContain('0 %');
  });

  it('eine Komposition ohne einen einzigen Block bekommt GAR KEINE Leiste', () => {
    // Neu/leer: kein Geld, keine Ringe, kein Plan - dann gehört die Bühne dem
    // Fluss allein, statt eine leere zweite Spalte zu reservieren.
    const { container } = renderStage({
      rings: [],
      ringsNote: null,
      money: null,
      planSentence: null,
    });
    expect(container.querySelector('.vp-hero-side')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero.vp-stage-norail')).not.toBeNull();
    // Der Fluss ist trotzdem da.
    expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')).not.toBeNull();
  });
});

describe('Der Bühnenfuß', () => {
  it('trägt die Steuerung über die volle Breite - nicht mehr in der Fluss-Spalte', () => {
    const { container } = renderStage(pilstingView(), {
      periodSeg: <div className="vp-seg vp-seg-compact" />,
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
    const { container } = renderStage(pilstingView());
    expect(container.querySelector('.vp-stage-foot')).toBeNull();
  });
});

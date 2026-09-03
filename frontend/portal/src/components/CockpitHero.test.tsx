import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CockpitHero } from './CockpitHero';
import { ControlStrip } from './ControlStrip';
import type { CockpitHeroView } from '../cockpitWidgets';
import type { LiveSnapshot } from '../live';
import type { SiteEarnings, SiteTopology } from '../api';
import FIXTURES from '../erloeseFixtures.json';
import { speicherAussage } from '../speicherAussage';

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

/**
 * DIESELBE Speicher-Aussage, die die Erlöse-Seite zeigt (§3.5/§3.6): das
 * Fixture `dv-tag-laufend` — laufender Tag, Speicher unter Null, Steuerung
 * darüber, gemessener Bestand ohne Abzug. Sie wird ABGELEITET, nie
 * abgeschrieben — zwei Formulierungen über dieselbe Zahl wären der Bruch,
 * gegen den §3.5 gebaut ist.
 */
const SPEICHER = (() => {
  const f = (FIXTURES.fixtures as unknown as Array<{
    id: string;
    now: string;
    savedSpeicherEur: number | null;
    money: SiteEarnings;
  }>).find((x) => x.id === 'dv-tag-laufend')!;
  const stur = f.savedSpeicherEur;
  const money: SiteEarnings = {
    ...f.money,
    savedSpeicherEur: stur,
    savedSteuerungEur: stur == null || f.money.savedEur == null ? null : f.money.savedEur - stur,
    steuerungSplitReason: stur == null ? 'no_battery_data' : null,
  };
  return speicherAussage(money, { now: new Date(f.now) })!;
})();

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
      label: 'Unterm Strich · Heute',
      value: '371,43 €',
      kosten: false,
      speicher: SPEICHER,
      attribution: 'Speicher + 79,87 € · davon Steuerung + 12,10 €',
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
    // Seit P5 sind es ZWEI Blöcke: die Erlöskarte im C-Kleid (Label, Zahl,
    // Segment, Speicher-Sektion, Ringe) und die Fahrplan-Zeile.
    expect(blocks).toHaveLength(2);
    expect(blocks[0].classList.contains('vp-hero-money')).toBe(true);
    // 1 · Label 12/700 Versalien + Provenienz-Abzeichen.
    expect(blocks[0].querySelector('.vp-c-label')?.textContent).toContain('Unterm Strich · Heute');
    // 2 · die EINE Zahl.
    expect(blocks[0].querySelector('.vp-c-stm-zahl')?.textContent).toBe('371,43 €');
    // 3 · das Segment steht DIREKT unter der Zahl, die es regiert.
    expect(blocks[0].querySelector('.vp-c-ck-seg .vp-seg')).not.toBeNull();
    // 4 · DIESELBE Speicher-Sektion wie auf der Erlöse-Seite — ohne eigenen
    //     Rahmen (ein Rahmen je Karte).
    const sek = blocks[0].querySelector('.vp-c-speicher');
    expect(sek?.classList.contains('is-sektion')).toBe(true);
    expect(sek?.classList.contains('vp-c-card')).toBe(false);
    expect(sek?.textContent).toContain('Speicher heute');
    expect(sek?.textContent).toContain('davon Steuerung');
    // 5 · die zwei Ringe wohnen IN der Karte, nicht in einem eigenen Block.
    expect(blocks[0].querySelectorAll('.vp-c-ck-ring')).toHaveLength(2);
    // Die frühere Kopfzeile „Bilanz" ist entfallen — das Label sagt es schon.
    expect(rail!.textContent).not.toContain('Bilanz');
    expect(blocks[1].querySelector('.vp-hero-plan')?.textContent).toContain('abends verkaufen');
    // Die Bühne bleibt zweispaltig.
    expect(container.querySelector('.vp-cockpit-hero.vp-stage-norail')).toBeNull();
  });

  it('trägt den gemessenen Speicherbestand als eigene Zeile, nie in der Kasse', () => {
    const { container } = renderStage(pilstingView());
    const bestand = container.querySelector('.vp-c-sp-bestand');
    // NBSP vor der Einheit — deshalb wird nur die Zahl geprüft.
    expect(bestand?.textContent).toContain('35,8');
    expect(bestand?.textContent).toContain('kWh');
    expect(bestand?.querySelector('.vp-chip')?.textContent).toBe('Kein Abzug');
    // Der laufende Zeitraum sagt sein Wort statt nur seine Farbe.
    expect(container.querySelector('.vp-c-speicher .vp-chip')?.textContent).toBe('Zwischenstand');
  });

  it('färbt ein negatives Netto und behält sein Vorzeichen im Text', () => {
    const { container } = renderStage(
      pilstingView({
        money: { label: 'Unterm Strich · Heute', value: '− 4,12 €', kosten: true, speicher: SPEICHER },
      }),
    );
    const zahl = container.querySelector('.vp-c-stm-zahl');
    expect(zahl?.classList.contains('is-kosten')).toBe(true);
    expect(zahl?.textContent).toContain('−');
  });

  it('Haushalt: ohne Zeitraum-Segment bleibt die Leiste voll (Ringe führen)', () => {
    // Ein Eigenverbrauchs-Haushalt hat keinen zeitraum-bezogenen Geld-Modus →
    // kein Segment. Es entsteht KEIN leerer Rahmen, die Leiste trägt den Rest.
    const { container } = renderStage(pilstingView({ money: null }));
    const rail = container.querySelector('.vp-hero-side')!;
    expect(rail.querySelector('.vp-seg')).toBeNull();
    // Ohne Geld-Zahl gibt es keine Zahl und keine Speicher-Sektion — die
    // Ringe tragen sich selbst, damit die Leiste nie leer dasteht.
    expect(rail.querySelector('.vp-c-stm-zahl')).toBeNull();
    expect(rail.querySelector('.vp-c-speicher')).toBeNull();
    expect(rail.querySelectorAll(':scope > .vp-rail-blk')).toHaveLength(2);
    expect(rail.querySelectorAll('.vp-c-ck-ring')).toHaveLength(2);
  });

  it('hält den Ring-Platz mit dem ehrlichen Satz statt mit „0 %"', () => {
    const { container } = renderStage(
      pilstingView({ rings: [], ringsNote: 'Autarkie und Eigenverbrauch gibt es je Zeitraum.' }),
    );
    expect(container.querySelector('.vp-c-ck-ring')).toBeNull();
    expect(container.querySelector('.vp-c-note')?.textContent).toContain('je Zeitraum');
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

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { CockpitHero } from './CockpitHero';
import { ControlStrip } from './ControlStrip';
import type { LiveSnapshot } from '../live';
import type { SiteEntity, SiteSource, SiteTopology } from '../api';
import { ebStand } from '../test/flussBilanzFixtures';

// Die Bühne lädt `EnergieBuehne` nach (React.lazy). Unter Last dauerte der erste Import länger als die Frist eines
// `waitFor` (1 s) und der erste Fall scheiterte zufällig; vorgewärmt löst `lazy` sofort auf — geprüft wird das Bild,
// nicht die Ladezeit des Testlaufs.
beforeAll(async () => {
  await import('./EnergieBuehne');
});

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
    steuerung?: React.ReactNode;
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
      steuerung={over.steuerung ?? null}
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

  it('ohne Leitkachel gehört die Bühne ganz dem Fluss - kein zweiter Werteblock „Dieser Moment“ (Konzept b1, E1)', async () => {
    const { container } = renderStage();
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-lp')).not.toBeNull());
    // Die vier Werte stehen an den Knoten; eine rechte Spalte nur für sie gibt es nicht mehr.
    expect(container.querySelector('.vp-hero-side')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero.vp-stage-norail')).not.toBeNull();
    expect(container.querySelector('.vp-eb-moment, .vp-eb-mk')).toBeNull();
    expect(container.querySelector('[aria-label^="Werkzeuge:"]')).toBeNull();
  });

  it('am Telefon (showRail = false) steht sie nicht in der Bühne, sondern im Raster', () => {
    const { container } = renderStage({ seite: <div className="leit" />, showRail: false });
    expect(container.querySelector('.vp-hero-side')).toBeNull();
  });
});

describe('Die Steuerzeile (Konzept b1, Entscheid E2)', () => {
  const zeile = (
    <ControlStrip
      variant="zeile"
      view={{
        state: 'healthy',
        tone: 'ok',
        sentence: 'Ihr Gerät regelt gerade auf 2,1 kW → Wechselrichter bestätigt 2,1 kW',
        agoNote: 'geprüft vor 12 s',
        reason: 'Mittags-PV wird gespeichert und am Abend verkauft.',
      }}
    />
  );

  it('steht am Rechner rechts unter der Leitkachel - kein Bühnenfuß', () => {
    const { container } = renderStage({ seite: <div className="leit" />, steuerung: zeile });
    const steuer = container.querySelector('.vp-hero-side .vp-hero-steuer');
    expect(steuer?.textContent).toContain('regelt gerade auf');
    expect(container.querySelector('.vp-hero-leit + .vp-hero-steuer')).toBe(steuer);
    expect(container.querySelector('.vp-stage-foot')).toBeNull();
    // Der Grund steht nicht als Absatz darunter, erst im Blatt „Warum?“.
    expect(container.textContent).not.toContain('Abend verkauft');
  });

  it('steht ohne rechte Spalte (Telefon, oder ohne Leitkachel) am Bühnenfuß über die volle Breite', () => {
    for (const over of [{ seite: <div className="leit" />, showRail: false }, {}]) {
      const { container, unmount } = renderStage({ ...over, steuerung: zeile });
      const foot = container.querySelector('.vp-stage-foot');
      expect(foot?.querySelector('.vp-steuer')).not.toBeNull();
      // Ein Geschwister der Spalten (grid-column: 1/-1), nie ein Kind der Fluss-Spalte.
      expect(container.querySelector('.vp-hero-flow .vp-stage-foot')).toBeNull();
      expect(container.querySelector('.vp-hero-side')).toBeNull();
      unmount();
    }
  });

  it('fehlt ganz, wenn es keine Steuerung zu zeigen gibt', () => {
    const { container } = renderStage();
    expect(container.querySelector('.vp-stage-foot')).toBeNull();
    expect(container.querySelector('.vp-steuer')).toBeNull();
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

/**
 * Schramm „Zuhause“ (07.11.2026): drei KACO als „Weitere Erzeuger“, KEIN Hauptgerät - reines
 * Monitoring. Die Erzeuger haben (noch) keine eigene telemetry_v2, die Box noch kein
 * Standort-Sample; ihre PV kommt allein über die gepinnten Quellen. Das Cockpit sagte „Ist Ihr
 * Gerät mit Strom versorgt?“, während drei Wechselrichter lieferten.
 */
describe('Eine reine Erzeugeranlage ohne Hauptgerät zeigt ihre Erzeugung', () => {
  const ohneWerte: LiveSnapshot = {
    pvKw: null, loadKw: null, gridKw: null, battKw: null, socPct: null, socAt: null,
  } as unknown as LiveSnapshot;
  const prod = (id: string, label: string) => ({
    id, entityType: 'producer', typeLabel: 'Erzeuger', label, category: 'producer', health: 'never',
    capabilities: [{ channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: null }],
  });
  const topology = {
    schemaVersion: '1.0',
    entities: [prod('k1', 'Kaco 1'), prod('k2', 'Kaco 2'), prod('k3', 'Kaco 3')],
    topology: {
      schema_version: '1.0',
      nodes: [{
        role: 'pv', flow_active: false,
        members: [
          { entity_id: 'k3', label: 'Kaco 3', primary: true },
          { entity_id: 'k2', label: 'Kaco 2', primary: false },
          { entity_id: 'k1', label: 'Kaco 1', primary: false },
        ],
      }],
    },
  } as unknown as SiteTopology;
  const pins = [
    { id: 'k1', edgeSourceId: 'src-wqng3qfp' },
    { id: 'k2', edgeSourceId: 'src-sgw8hrpt' },
    { id: 'k3', edgeSourceId: 'src-5ahgajrq' },
  ] as unknown as SiteEntity[];
  const quelle = (sourceId: string, pvKw: number): SiteSource => ({
    deviceId: 'box', sourceId, kind: 'source', role: 'pv-generation', label: null, brand: 'kaco',
    model: null, pvKw, powerKw: null, loadKw: null, health: 'ok', readAt: null, reportedAt: '',
  });

  it('zeichnet den Fluss mit der PV-Summe statt der Strom-und-Internet-Hilfe', async () => {
    const { container, queryByText } = render(
      <CockpitHero
        topology={topology}
        snapshot={ohneWerte}
        sources={[quelle('src-wqng3qfp', 0.52), quelle('src-sgw8hrpt', 0.52), quelle('src-5ahgajrq', 0.35)]}
        pins={pins}
        onOpenSub={() => {}}
      />,
    );
    expect(queryByText('Was kann ich tun?')).toBeNull();
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-lp')).not.toBeNull());
  });

  it('ohne liefernde Quelle bleibt es bei der ehrlichen Hilfe', () => {
    const { getByText } = render(
      <CockpitHero topology={topology} snapshot={ohneWerte} sources={[]} pins={pins} onOpenSub={() => {}} />,
    );
    expect(getByText('Was kann ich tun?')).toBeTruthy();
  });
});

/**
 * Schramm „Zuhause“, 07.11.2026 14:20 - fiktiv nachgestellt (`test/flussBilanzFixtures.ts`): eine
 * PV-Zuordnung nannte nur den PIKO, das Cockpit zeigte „Erzeugung 1,2 kW · Bezug 5,9 kW · Verbrauch
 * 9,6 kW“ und „Sonne deckt 12 % des Verbrauchs“. Die Reproduktion ist der Regressionstest.
 */
describe('Der Fluss geht auf (flussBilanz)', () => {
  const NB = ' ';
  const knoten = (c: HTMLElement, rolle: string) => c.querySelector(`.vp-lp-k-${rolle}`)?.getAttribute('aria-label') ?? '';
  const buehne = (fall: Parameters<typeof ebStand>[0] = {}) => {
    const s = ebStand(fall);
    return render(
      <CockpitHero
        topology={s.topology}
        snapshot={s.snapshot}
        sources={s.sources}
        pins={s.pins}
        pvRollen={s.pvRollen}
        verbrauchRollen={s.verbrauchRollen}
        onOpenSub={() => {}}
      />,
    );
  };

  it('Erzeugung 3,7 + Bezug 5,9 = Verbrauch 9,6 kW, der Satz nennt 38 % - nicht mehr 1,2 kW und 12 %', async () => {
    const { container } = buehne();
    await waitFor(() => expect(container.querySelector('.vp-lp')).not.toBeNull());
    expect(knoten(container, 'pv')).toBe(`Sonne: 3,7${NB}kW, Erzeugung`);
    expect(knoten(container, 'grid')).toBe(`Netz: 5,9${NB}kW, Bezug`);
    expect(knoten(container, 'load')).toBe(`Haus: 9,6${NB}kW, Verbrauch`);
    expect(container.querySelector('.vp-eb-satz')?.textContent).toBe(`Sonne deckt 38${NB}% des Verbrauchs, der Rest kommt aus dem Netz.`);
    expect(container.querySelector('.vp-eb-luecke')).toBeNull();
    // Das Blatt der Sonne nennt den zugeordneten PIKO und die drei KACO mit ihrer Messung - Summe = Knoten.
    fireEvent.click(container.querySelector('.vp-lp-k-pv')!);
    await waitFor(() => expect(document.body.querySelector('.vp-rolle-pv')).not.toBeNull());
    const blatt = document.body.querySelector('.vp-rolle-pv')!.textContent ?? '';
    for (const name of ['Kostal PIKO Scheune', 'Kaco Ost', 'Kaco Mitte', 'Kaco West']) expect(blatt).toContain(name);
    expect(blatt).toContain(`3,7${NB}kW`);
    expect(blatt).toContain('Geräte ohne Zuordnung zählen mit ihrer eigenen Messung.');
  });

  it('ein KACO, den die Box nicht liest, steht unter dem Satz statt still in der Sonne', async () => {
    const { container } = buehne({ veraltet: ['eb-kaco-west'] });
    await waitFor(() => expect(container.querySelector('.vp-lp')).not.toBeNull());
    expect(knoten(container, 'pv')).toBe(`Sonne: 3,0${NB}kW, Erzeugung`);
    expect(knoten(container, 'load')).toBe(`Haus: 8,9${NB}kW, Verbrauch`);
    expect(container.querySelector('.vp-eb-luecke')?.textContent).toBe('Nicht mitgezählt: Kaco West (meldet sich gerade nicht).');
  });

  it('passen die Werte nicht zusammen, gibt es keine Prozente, sondern beide Zahlen', async () => {
    const { container } = buehne({ teilverbrauch: true });
    await waitFor(() => expect(container.querySelector('.vp-lp')).not.toBeNull());
    const satz = container.querySelector('.vp-eb-satz')?.textContent ?? '';
    expect(satz).toBe(
      `Die Werte passen gerade nicht zusammen: Erzeugung und Bezug liefern 9,6${NB}kW, der Verbrauch zeigt 7,9${NB}kW. ` +
        'Darum rechnet das Cockpit keine Anteile aus.',
    );
    expect(satz).not.toContain('%');
  });
});

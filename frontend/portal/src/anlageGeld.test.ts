import { describe, expect, it } from 'vitest';
import type { OverviewSite } from './api';
import { anlageBereiche, VERLAUF_TABS } from './ebenenNav';
import {
  GELD_ANSICHT,
  GELD_BAUSTEIN,
  GELD_BLOCK,
  GELD_UNTERSEITEN,
  anlageAufEbene,
  anlageOhneGeld,
  bausteineOhneGeld,
  ohneGeld,
  unterseiteOhneGeld,
} from './anlageGeld';
import { CANONICAL_DESKTOP, CANONICAL_PHONE, type BausteinId } from './cockpitLayout';
import { anlageSurface, type AnlageSurfaceInput } from './surface';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';
import { geldAnlagen } from './uebersicht';
import { NODE_MARKET } from './usageProfile';

/**
 * Die Geld-Regel JE ANLAGE (UEMS AP-01 IP-8, A13 — Captain 10.09.2026: „Die
 * Messdatenkunden brauchen keine Geldanzeige.") gegen das Referenzunternehmen
 * Ahrenberg: Halle 1 steuert und hat PV + Speicher, Halle 2 und Werk Lindach
 * messen nur.
 */

const { an1, an2, an3 } = FIXTURE_IDS;

function zeile(id: string, roleCounts: OverviewSite['roleCounts']): OverviewSite {
  return { id, name: id, roleCounts } as OverviewSite;
}

const HALLE1 = zeile(an1, { pv: 1, storage: 1, consumer: 0, grid: 1 });
const HALLE2 = zeile(an2, { pv: 0, storage: 0, consumer: 1, grid: 1 });
const LINDACH = zeile(an3, { pv: 0, storage: 0, consumer: 0, grid: 1 });

/** Eine Anlage, an der JEDE Geld-Quelle des Lese-Modells anspringt. */
const ALLES: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: true,
    activeStrategyNodeTypes: [NODE_MARKET],
    plantKind: 'direktvermarktung',
    hasLeistungspreis: true,
  },
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: 120 },
  flows: [
    {
      flowId: 'f-1',
      name: 'Wallbox nur bei PV-Überschuss',
      activeVersion: 1,
      latestLifecycle: 'active',
      latestDocument: {
        schema_version: '1.0',
        name: 'Wallbox nur bei PV-Überschuss',
        runtime: 'edge',
        nodes: [{ id: 'n1', type: 'vp.entity.control', type_version: '1.0.0' }],
        edges: [],
        triggers: [],
      },
    },
  ],
  entities: [
    { id: 'e-batt', entityType: 'battery-hybrid', label: null, capabilities: { measure: [{ channel: 'soc_pct' }] } },
    { id: 'e-pv', entityType: 'producer', label: null, capabilities: { measure: [{ channel: 'pv_power_kw' }] } },
    { id: 'e-grid', entityType: 'grid-meter', label: null, capabilities: { measure: [{ channel: 'power_kw' }] } },
    { id: 'e-lp', entityType: 'ev-charger', label: null, capabilities: { measure: [{ channel: 'power_kw' }] } },
  ],
} as AnlageSurfaceInput;

describe('der Grundfakt je Anlage folgt der Ebene (`geldAnlagen`)', () => {
  it('Werk Lindach und Halle 2 am 15.11.2026 bleiben ohne Geld, Halle 1 nicht', () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an3, f, LINDACH)).toBe(true);
    expect(anlageOhneGeld(an2, f, HALLE2)).toBe(true);
    expect(anlageOhneGeld(an1, f, HALLE1)).toBe(false);
  });

  it('Halle 2 ab 01.12.2026: steuert der Ladepunkt, zeigt sie Geld', () => {
    const f = ahrenbergFunktionen();
    f.standorte[0].steuern.anlagen[1].teilnahme.zustand = 'aktiv';
    expect(anlageOhneGeld(an2, f, HALLE2)).toBe(false);
  });

  it('ein Erzeuger oder ein Speicher reicht — auch ohne Steuerung', () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an3, f, zeile(an3, { pv: 1, storage: 0, consumer: 0, grid: 1 }))).toBe(false);
    expect(anlageOhneGeld(an3, f, zeile(an3, { pv: 0, storage: 1, consumer: 0, grid: 1 }))).toBe(false);
  });

  it('unbekannt ist nie „erlaubt": ohne Zeile der Übersicht zählt keine Rolle, nur die Steuerung', () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an3, f, null)).toBe(true);
    expect(anlageOhneGeld(an1, f, null)).toBe(false);
    // Eine fremde Zeile ist keine Aussage über diese Anlage.
    expect(anlageOhneGeld(an3, f, zeile(an1, { pv: 1, storage: 1, consumer: 0, grid: 1 }))).toBe(true);
  });

  it('ohne Ebene bleibt alles wie vorher: keine Funktionen, oder die Anlage steht auf keinem Standort', () => {
    expect(anlageAufEbene(an3, null)).toBe(false);
    expect(anlageOhneGeld(an3, null, LINDACH)).toBe(false);
    const nurAhrenberg = ahrenbergFunktionen({ standorte: [ahrenbergFunktionen().standorte[0]] });
    expect(anlageAufEbene(an3, nurAhrenberg)).toBe(false);
    expect(anlageOhneGeld(an3, nurAhrenberg, LINDACH)).toBe(false);
  });
});

describe('W7: ein Tarif erhält Kosten nur auf den Anlagenflächen', () => {
  const nurMessenBleibtAufEbeneOhneGeld = () => {
    expect(geldAnlagen([HALLE2], ahrenbergFunktionen()).has(an2)).toBe(false);
  };

  it("nur messen + Tarif 'ohne': kein Geld (unverändert)", () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an2, f, HALLE2, 'ohne')).toBe(true);
    nurMessenBleibtAufEbeneOhneGeld();
  });

  it("nur messen + Tarif 'fest': Geld auf den Anlagenflächen", () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an2, f, HALLE2, 'fest')).toBe(false);
    nurMessenBleibtAufEbeneOhneGeld();
  });

  it("nur messen + Tarif 'dynamisch': Geld auf den Anlagenflächen", () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an2, f, HALLE2, 'dynamisch')).toBe(false);
    nurMessenBleibtAufEbeneOhneGeld();
  });

  it('tarifArt undefined/null: altes Verhalten', () => {
    const f = ahrenbergFunktionen();
    expect(anlageOhneGeld(an2, f, HALLE2, undefined)).toBe(true);
    expect(anlageOhneGeld(an2, f, HALLE2, null)).toBe(true);
    nurMessenBleibtAufEbeneOhneGeld();
  });
});

describe('der Wächter: jede Geld-Fläche ist eingeordnet — auch jede künftige', () => {
  const alles = anlageSurface(ALLES);

  it('jeder Cockpit-Baustein beider kanonischen Listen hat einen Eintrag', () => {
    const bausteine = [...new Set<BausteinId>([...CANONICAL_DESKTOP, ...CANONICAL_PHONE])].sort();
    expect(Object.keys(GELD_BAUSTEIN).sort()).toEqual(bausteine);
  });

  it('jeder Block, jede Ansicht und jeder Verlauf-Reiter der vollen Anlage hat einen Eintrag', () => {
    for (const b of alles.cockpitBlocks) expect(Object.keys(GELD_BLOCK), `Block ${b.id}`).toContain(b.id);
    for (const v of alles.deepViews) expect(Object.keys(GELD_ANSICHT), `Ansicht ${v}`).toContain(v);
    for (const t of VERLAUF_TABS) if (t.view) expect(Object.keys(GELD_ANSICHT), `Reiter ${t.label}`).toContain(t.view);
  });

  it('die volle Anlage hat Geld — sonst bewiese das Filtern nichts', () => {
    expect(alles.moneyStreams.length).toBeGreaterThan(0);
    expect(alles.cockpitBlocks.some((b) => GELD_BLOCK[b.id])).toBe(true);
    expect(alles.deepViews.filter((v) => GELD_ANSICHT[v]).sort()).toEqual(['erloes-historie', 'lastspitzen', 'marktpreise']);
  });

  it('ohne Geld: kein Geld-Block, kein Geld-Strom, keine Geld-Ansicht — die Betriebsmodelle bleiben', () => {
    const ohne = ohneGeld(alles);
    expect(ohne.geldfrei).toBe(true);
    expect(ohne.moneyStreams).toEqual([]);
    expect(ohne.cockpitBlocks.filter((b) => GELD_BLOCK[b.id])).toEqual([]);
    expect(ohne.deepViews.filter((v) => GELD_ANSICHT[v])).toEqual([]);
    expect(ohne.modes).toEqual(alles.modes);
    // Energie bleibt: Status, Energiefluss, Messwerte, Wetter.
    expect(ohne.cockpitBlocks.map((b) => b.id)).toContain('energiefluss');
    expect(ohne.deepViews).toEqual(expect.arrayContaining(['live', 'wetter', 'telemetrie-historie']));
  });
});

describe('Verlauf: keine Erlöse, keine Marktpreise, keine Lastspitzen', () => {
  const alles = anlageSurface(ALLES);
  const reiter = (s: typeof alles) => anlageBereiche(s).find((b) => b.key === 'verlauf')!.tabs.map((t) => t.label);

  it('die Geld-Reiter sind genau Erlöse, Marktpreise und Lastspitzen', () => {
    expect(GELD_UNTERSEITEN).toEqual(['erloese', 'marktpreise', 'lastspitzen']);
  });

  it('eine geldfreie Anlage trägt keinen Geld-Reiter — jede andere wie vorher', () => {
    expect(reiter(alles)).toEqual(expect.arrayContaining(['Erlöse', 'Marktpreise', 'Lastspitzen']));
    const ohne = reiter(ohneGeld(alles));
    for (const t of VERLAUF_TABS) {
      if (t.view && GELD_ANSICHT[t.view]) expect(ohne, `Reiter ${t.label}`).not.toContain(t.label);
    }
    expect(ohne).toEqual(['Messwerte', 'Prognose', 'Wetter']);
  });

  it('ein Lesezeichen auf eine Geld-Seite landet auf den Messwerten — nur bei einer geldfreien Anlage', () => {
    const ohne = ohneGeld(alles);
    for (const sub of GELD_UNTERSEITEN) {
      expect(unterseiteOhneGeld(sub, ohne)).toBe('messwerte');
      expect(unterseiteOhneGeld(sub, alles)).toBe(sub);
    }
    expect(unterseiteOhneGeld('prognose', ohne)).toBe('prognose');
    expect(unterseiteOhneGeld('steuerung', ohne)).toBe('steuerung');
  });
});

describe('Cockpit: kein Geld-Held, keine Steuerungs-Karte, keine Marktpreise', () => {
  it('eine geldfreie Anlage behält nur die Bausteine ohne Geld', () => {
    const ohne = ohneGeld(anlageSurface(ALLES));
    expect(bausteineOhneGeld(CANONICAL_DESKTOP, ohne)).toEqual(
      CANONICAL_DESKTOP.filter((id) => !['geld', 'steuerung', 'strompreis'].includes(id)),
    );
    expect(bausteineOhneGeld(CANONICAL_DESKTOP, anlageSurface(ALLES))).toEqual(CANONICAL_DESKTOP);
    expect(bausteineOhneGeld(CANONICAL_DESKTOP, null)).toEqual(CANONICAL_DESKTOP);
  });
});

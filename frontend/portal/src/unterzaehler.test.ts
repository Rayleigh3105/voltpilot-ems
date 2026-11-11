/**
 * Unterverteilungen (Konzept `vp-unterzaehler-anzeige`, Stufe 1, Entscheide UV-1…UV-4 A vom
 * 07.11.2026) - mit Schramms echten Werten vom 06.11.2026 14:29: Haus 11,18 kW (PV 4,5 + Netz
 * 6,677), UV Halle 11,252 kW, UV Keller 0,072 kW. Der Rest −0,14 kW liegt in der Toleranz der
 * Restregel und steht als 0,0 kW.
 */
import { describe, expect, it } from 'vitest';
import type { EntityEnergy, History, HistoryBucket, SiteTopology, TopologyEntity } from './api';
import { channelLabel, channelLabelFor } from './channels';
import { verbrauchListe } from './flussListen';
import { bereicheCsv, verbrauchBereiche } from './verbrauchBereiche';
import { restWort, UNTERZAEHLER_PRUEFEN, verbrauchKomposition } from './verbrauchKomposition';
import { zaehlerWerte } from './zaehlerWerte';

function entity(over: Partial<TopologyEntity> & { id: string }): TopologyEntity {
  return {
    id: over.id,
    entityType: over.entityType ?? 'sub-meter',
    typeLabel: over.typeLabel ?? 'Unterzähler',
    label: over.label ?? null,
    category: over.category ?? 'consumer',
    health: over.health ?? 'ok',
    capabilities: over.capabilities ?? [],
  };
}

function schramm(halleKw = 11.252, kellerKw = 0.072): SiteTopology {
  const cap = (channel: string, value: number | null, role: string | null = null) =>
    ({ channel, unit: channel.endsWith('_kwh') ? 'kWh' : 'kW', role, primary: false, value });
  return {
    schemaVersion: '1.0',
    entities: [
      entity({ id: 'haus', entityType: 'house-load', typeLabel: 'Hausverbrauch' }),
      entity({
        id: 'halle', label: 'UV Halle',
        capabilities: [cap('power_kw', halleKw, 'consumer'), cap('power_l1_kw', 3.89), cap('power_l2_kw', 3.82),
          cap('power_l3_kw', 3.54), cap('energy_kwh', 70802.308), cap('energy_export_kwh', 1.069)],
      }),
      entity({ id: 'keller', label: 'UV Keller', capabilities: [cap('power_kw', kellerKw, 'consumer')] }),
    ],
    topology: {
      schema_version: '1.0',
      nodes: [{
        role: 'consumer', flow_active: true, direction: 'out',
        members: [
          { entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 11.18 },
          { entity_id: 'halle', label: 'UV Halle', primary: false, value_kw: halleKw },
          { entity_id: 'keller', label: 'UV Keller', primary: false, value_kw: kellerKw },
        ],
      }],
    },
  };
}

describe('Cockpit „Verbrauch im Detail“ mit Unterverteilungen (UV-1, UV-4)', () => {
  it('zeigt UV Halle, UV Keller und den übrigen Haushalt mit dem Mess-Symbol', () => {
    const k = verbrauchKomposition({ topology: schramm(), profil: 'privat' });
    const liste = verbrauchListe(k, { heute: false, max: 6 });
    expect(liste?.zeilen.map((z) => [z.name, z.wert, z.icon])).toEqual([
      ['UV Halle', '11,3 kW', 'activity'],
      ['UV Keller', '0,1 kW', 'activity'],
      ['übriger Haushalt', '0,0 kW', 'home'],
    ]);
    expect(liste?.summe).toBe('11,2 kW');
  });

  it('nennt den Rest nach dem Anwendungsprofil - ohne Profil wie bisher', () => {
    expect(restWort('privat')).toBe('übriger Haushalt');
    expect(restWort('gewerbe')).toBe('ohne eigenen Zähler');
    expect(restWort(null)).toBe('übriger Haushalt');
    const gewerbe = verbrauchListe(verbrauchKomposition({ topology: schramm(), profil: 'gewerbe' }), { heute: false, max: 6 });
    expect(gewerbe?.zeilen.at(-1)?.name).toBe('ohne eigenen Zähler');
  });

  it('ein Unterzähler in Gegenrichtung zählt mit seinem Betrag, die Technik-Ebene sieht den Hinweis', () => {
    const k = verbrauchKomposition({ topology: schramm(-11.252), profil: 'privat' });
    const kunde = verbrauchListe(k, { heute: false, max: 6 });
    const admin = verbrauchListe(k, { heute: false, max: 6, technik: true });
    expect(kunde?.zeilen[0]).toMatchObject({ name: 'UV Halle', wert: '11,3 kW' });
    expect(kunde?.zeilen[0].sub ?? '').not.toContain('prüfen');
    expect(admin?.zeilen[0].sub).toContain(UNTERZAEHLER_PRUEFEN);
  });

  it('widersprechen sich Haus und Unterzähler, sagt die Technik-Ebene, was zu prüfen ist', () => {
    const k = verbrauchKomposition({ topology: schramm(14.0), profil: 'privat' });
    expect(k?.rest.konflikt).toBe(true);
    const admin = verbrauchListe(k, { heute: false, max: 6, technik: true });
    const rest = admin?.zeilen.find((z) => z.art === 'rest');
    expect(rest?.sub).toContain('Messwerte passen nicht zusammen');
    expect(rest?.sub).toContain(UNTERZAEHLER_PRUEFEN);
    const kunde = verbrauchListe(k, { heute: false, max: 6 });
    expect(kunde?.zeilen.find((z) => z.art === 'rest')?.sub).not.toContain(UNTERZAEHLER_PRUEFEN);
  });
});

// --- Zählerbaum: eine Maschine hinter einer Unterverteilung (R1) -----------

/**
 * Genau der gemeldete Fall (Screenshot, 10.11.2026): Netzanschluss 8,1 kW,
 * UV Halle 7,7 kW, UV Keller 0,1 kW, darin ein Kompressor mit 3,2 kW (hängt an
 * UV Halle, nicht an der Wurzel). Vor dem Zählerbaum-Fix zeigte die Liste
 * „Verbrauch, 3 Geräte, zusammen 11,0 kW“ bei 8,1 kW Bezug und das Cockpit
 * „Messwerte passen nicht zusammen (−2,9 kW)“.
 */
function haus(): SiteTopology {
  const cap = (value: number) => ({ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: false, value });
  return {
    schemaVersion: '1.0',
    entities: [
      entity({ id: 'haus', entityType: 'house-load', typeLabel: 'Hausverbrauch' }),
      entity({ id: 'halle', label: 'UV Halle' }),
      entity({ id: 'keller', label: 'UV Keller' }),
      entity({ id: 'kompressor', label: 'Kompressor', entityType: 'generic-load', typeLabel: 'Kompressor' }),
    ],
    topology: {
      schema_version: '1.0',
      nodes: [{
        role: 'consumer', flow_active: true, direction: 'out',
        members: [
          { entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 8.1 },
          { entity_id: 'halle', label: 'UV Halle', primary: false, value_kw: 7.7 },
          { entity_id: 'keller', label: 'UV Keller', primary: false, value_kw: 0.1 },
          {
            entity_id: 'kompressor', label: 'Kompressor', primary: false, value_kw: 3.2,
            haengt_an: 'halle',
          },
        ],
      }],
    },
  };
}

describe('Zählerbaum: eine Maschine hinter einer Unterverteilung (R1)', () => {
  it('zieht den Kompressor NICHT noch einmal vom Haus ab - kein Widerspruch am Haus', () => {
    const k = verbrauchKomposition({ topology: haus(), profil: 'privat' });
    expect(k?.hausKw).toBe(8.1);
    expect(k?.rest.konflikt).toBe(false);
    expect(k?.rest.kw).toBeCloseTo(0.3, 5); // 8,1 − (7,7 + 0,1)
  });

  it('UV Halle bekommt ihren eigenen Rest „ohne eigenen Zähler“ (7,7 − 3,2)', () => {
    const k = verbrauchKomposition({ topology: haus(), profil: 'privat' });
    const halle = k?.gruppen.flatMap((g) => g.teile).find((t) => t.entityId === 'halle');
    expect(halle?.kw).toBe(7.7);
    expect(halle?.eigenerRest?.label).toBe('ohne eigenen Zähler');
    expect(halle?.eigenerRest?.kw).toBeCloseTo(4.5, 5);
    expect(halle?.eigenerRest?.konflikt).toBe(false);
  });

  it('der Kompressor trägt seine Eltern-Komponente und bleibt an keiner Gruppen-Summe doppelt beteiligt', () => {
    const k = verbrauchKomposition({ topology: haus(), profil: 'privat' });
    const alle = k?.gruppen.flatMap((g) => g.teile) ?? [];
    const kompressor = alle.find((t) => t.entityId === 'kompressor');
    expect(kompressor?.haengtAn).toBe('halle');
    // Keine Gruppen-Summe zählt Kompressor UND UV Halle zusammen (7,7 + 3,2 wäre doppelt).
    for (const g of k?.gruppen ?? []) {
      if (g.kw != null) expect(g.kw).toBeLessThan(7.7 + 3.2);
    }
  });
});

describe('Kanalnamen und Zählerwerte (UV-3)', () => {
  it('ein Zählerstand heißt am Zähler „Zählerstand Bezug“, sonst bleibt „Energie“', () => {
    expect(channelLabelFor('energy_kwh', 'sub-meter')).toBe('Zählerstand Bezug');
    expect(channelLabelFor('energy_kwh', 'grid-meter')).toBe('Zählerstand Bezug');
    expect(channelLabelFor('energy_kwh', 'wallbox')).toBe('Energie');
    expect(channelLabel('energy_export_kwh')).toBe('Zählerstand Einspeisung');
    expect(channelLabel('power_l2_kw')).toBe('Leistung L2');
  });

  it('die Geräteseite zeigt Phasen und Zählerstände, ohne Wert ein Strich, veraltet keine Zahl', () => {
    const t = schramm().entities;
    const w = zaehlerWerte(['halle'], t);
    expect(w?.zeilen.map((z) => [z.label, z.wert])).toEqual([
      ['Leistung L1', '3,9 kW'],
      ['Leistung L2', '3,8 kW'],
      ['Leistung L3', '3,5 kW'],
      ['Zählerstand Bezug', '70.802 kWh'],
      ['Zählerstand Einspeisung', '1 kWh'],
    ]);
    expect(w?.stumm).toBeNull();
    expect(zaehlerWerte(['keller'], t)).toBeNull();
    const still = zaehlerWerte(['halle'], t.map((e) => (e.id === 'halle' ? { ...e, health: 'stale' } : e)));
    expect(still?.stumm).toContain('meldet sich gerade nicht');
  });
});

// --- Verlauf „Verbrauch nach Bereichen“ (UV-2) ------------------------------

const TAG = new Date(2026, 10, 2); // Mo., 02.11.2026, lokale Zeit

function bucket(tag: number, loadKwh: number | null): HistoryBucket {
  const d = new Date(TAG.getFullYear(), TAG.getMonth(), TAG.getDate() + tag);
  return {
    start: d.toISOString(), pvKwh: null, loadKwh, gridImportKwh: null, gridExportKwh: null,
    batteryChargeKwh: null, batteryDischargeKwh: null, socMinPct: null, socMaxPct: null, socLastPct: null,
    priceEurMwh: null, costEur: null,
  };
}

function woche(haus: (number | null)[]): History {
  return {
    range: 'month', from: TAG.toISOString(), to: TAG.toISOString(), bucketMinutes: 1440,
    buckets: haus.map((h, i) => bucket(i, h)),
    totals: {} as History['totals'], protocol: [], plan: [],
  } as History;
}

function energie(kwh: (number | null)[], counterFalls = false): EntityEnergy {
  const buckets = kwh.map((v, i) => ({ start: bucket(i, 0).start, kwh: v }));
  const known = kwh.filter((v): v is number => v != null);
  return {
    range: 'month', from: '', to: '', bucketMinutes: 1440, source: 'zaehler', buckets,
    totalKwh: counterFalls || known.length === 0 ? null : known.reduce((a, b) => a + b, 0), counterFalls,
  };
}

describe('Verlauf: Verbrauch nach Bereichen', () => {
  it('kWh je Unterverteilung und Rest, Anteile am Haus, Säulen je Tag', () => {
    const b = verbrauchBereiche({
      history: woche([62, 61]),
      range: 'month',
      profil: 'privat',
      teile: [
        { entityId: 'keller', label: 'UV Keller', unterzaehler: true, energie: energie([2, 2]) },
        { entityId: 'halle', label: 'UV Halle', unterzaehler: true, energie: energie([59, 58]) },
      ],
    });
    expect(b?.hausKwh).toBe(123);
    expect(b?.zeilen.map((z) => [z.label, z.kwh, z.sub])).toEqual([
      ['UV Halle', 117, 'Unterzähler'],
      ['UV Keller', 4, 'Unterzähler'],
      ['übriger Haushalt', 2, 'berechnet: Haus minus Unterzähler'],
    ]);
    expect(b?.zeilen[0].anteil).toBeCloseTo(117 / 123);
    expect(b?.saeulen.map((s) => [s.haus, s.teile, s.rest])).toEqual([
      [62, [59, 2], 1],
      [61, [58, 2], 1],
    ]);
    const csv = bereicheCsv(b!, 'month');
    expect(csv.split('\r\n')[0]).toBe('Beginn;Zeitraum;Haus kWh;UV Halle kWh;UV Keller kWh;übriger Haushalt kWh');
    expect(csv).toContain(';"Summe";123,000;117,000;4,000;2,000');
  });

  it('Zählerbaum R1: eine Maschine hinter einer Unterverteilung wird vom Haus nicht noch einmal abgezogen', () => {
    const b = verbrauchBereiche({
      history: woche([62, 61]),
      range: 'month',
      profil: 'privat',
      teile: [
        { entityId: 'keller', label: 'UV Keller', unterzaehler: true, energie: energie([2, 2]), haengtAn: null },
        { entityId: 'halle', label: 'UV Halle', unterzaehler: true, energie: energie([59, 58]), haengtAn: null },
        {
          entityId: 'kompressor', label: 'Kompressor', unterzaehler: false,
          energie: energie([25, 24]), haengtAn: 'halle',
        },
      ],
    });
    // Derselbe Rest wie ohne den Kompressor (117 + 4 = 121, Haus 123 → Rest 2) -
    // der Kompressor steckt schon in UV Halles 117 kWh, kein zweiter Abzug.
    expect(b?.zeilen.find((z) => z.art === 'rest')).toMatchObject({ kwh: 2 });
    // Der Kompressor bleibt trotzdem eine eigene, sichtbare Zeile.
    expect(b?.zeilen.find((z) => z.key === 'kompressor')?.kwh).toBe(49);
  });

  it('fehlt einem Teil ein Tag, ist der Rest nicht bestimmbar - nie eine Zahl mit der Lücke', () => {
    const b = verbrauchBereiche({
      history: woche([62, 61]),
      range: 'month',
      teile: [{ entityId: 'halle', label: 'UV Halle', unterzaehler: true, energie: energie([59]) }],
    });
    const rest = b?.zeilen.at(-1);
    expect(rest?.kwh).toBeNull();
    expect(rest?.sub).toContain('UV Halle ohne Werte');
    expect(b?.saeulen[1].rest).toBeNull();
  });

  it('ein fallender Zähler gibt keine Summe, und der Rest sagt warum', () => {
    const b = verbrauchBereiche({
      history: woche([62, 61]),
      range: 'month',
      teile: [{ entityId: 'halle', label: 'UV Halle', unterzaehler: true, energie: energie([59, null], true) }],
    });
    expect(b?.zeilen[0]).toMatchObject({ kwh: null, sub: expect.stringContaining('springt zurück') });
    expect(b?.zeilen.at(-1)?.kwh).toBeNull();
  });

  it('liegen die Teile über dem Haus, wird es gesagt statt auf 0 geklemmt', () => {
    const b = verbrauchBereiche({
      history: woche([50, 50]),
      range: 'month',
      profil: 'gewerbe',
      teile: [{ entityId: 'halle', label: 'UV Halle', unterzaehler: true, energie: energie([60, 60]) }],
    });
    expect(b?.zeilen.at(-1)).toMatchObject({ label: 'ohne eigenen Zähler', kwh: null });
    expect(b?.zeilen.at(-1)?.sub).toContain('Messwerte passen nicht zusammen');
  });

  it('ohne Teil oder ohne Historie gibt es keine Karte', () => {
    expect(verbrauchBereiche({ history: woche([1]), range: 'month', teile: [] })).toBeNull();
    expect(verbrauchBereiche({ history: null, range: 'month', teile: [] })).toBeNull();
  });
});

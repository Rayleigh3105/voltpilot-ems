import { describe, expect, it } from 'vitest';
import {
  SPEICHER,
  auftragSatz,
  erwarteteLaeufe,
  geraete,
  imFenster,
  jetztWerte,
  kopfsatz,
  kurzName,
  leiste,
  ordnen,
  quellenAnteil,
  reihen,
  reihenfolgeAus,
  reihenfolgeRumpf,
  speicherBild,
  symbolFuer,
  type Reihen,
} from './bild';
import type { VerbraucherEintrag } from '../verbraucherZone';
import { N, raster, slotVon, uhr, uhrTag, dauer, spannen, spannenText } from './zeit';

const NOW = new Date(2026, 8, 29, 13, 10);
const r = raster(NOW);
const iso = (t: number) => new Date(r.start + t * 900_000).toISOString();

function leereReihen(): Reihen {
  const n = () => Array.from({ length: N }, () => null as number | null);
  return { pv: n(), last: n(), netz: n(), bat: n(), soc: n(), preis: n(), temp: n(), abgeregelt: n(), gemessenBis: r.jetzt, morgenBekannt: false };
}

const eintrag = (o: Partial<VerbraucherEintrag> & { entityId: string }): VerbraucherEintrag => ({
  name: 'Heizstab', typ: 'heating-rod', typLabel: 'Heizstab', ladepunkt: false, regeln: 0,
  steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 1 },
  optionen: { schreibbar: true, quellen: [{ id: 'ueberschuss', gesperrt: false }], ziele: [], vorgaben: {} },
  ...o,
});

describe('zeit', () => {
  it('rastert heute und morgen in 192 Viertelstunden', () => {
    expect(r.jetzt).toBe(52);
    expect(slotVon(r, iso(0))).toBe(0);
    expect(slotVon(r, iso(191))).toBe(191);
    expect(slotVon(r, new Date(r.start - 60_000).toISOString())).toBeNull();
    expect(slotVon(r, 'kein Datum')).toBeNull();
  });
  it('spricht Uhrzeiten und Dauern', () => {
    expect(uhr(52)).toBe('13:00');
    expect(uhrTag(124)).toBe('morgen 07:00');
    expect(dauer(10)).toBe('2 Std 30 Min');
    expect(dauer(2)).toBe('30 Min');
    expect(spannenText(spannen([false, true, true, false, true], 52))).toBe('13:15–13:45, 14:00–14:15');
  });
});

describe('reihen', () => {
  it('nimmt Gemessenes vor jetzt, danach den Plan, und Preise aus der Börse', () => {
    const rh = reihen({
      raster: r,
      verlauf: { buckets: [{ start: iso(10), pvKwh: 1, loadKwh: 0.5, gridImportKwh: 0, gridExportKwh: 0.25, batteryChargeKwh: 0.25, batteryDischargeKwh: 0, socLastPct: 50, priceEurMwh: 100 }] } as never,
      plan: { slots: [{ start: iso(60), pvKw: 5, loadKw: 1, gridKw: -2, batteryKw: 2, socPct: 80, priceEurMwh: 50, curtailKw: 0 }] } as never,
      preise: { points: [{ ts: iso(100), end: iso(101), priceEurMwh: 123 }] } as never,
    });
    expect(rh.pv[10]).toBe(4);
    expect(rh.netz[10]).toBe(-1);
    expect(rh.bat[10]).toBe(1);
    expect(rh.pv[60]).toBe(5);
    expect(rh.preis[60]).toBe(5);
    expect(rh.preis[100]).toBeCloseTo(12.3);
    expect(rh.morgenBekannt).toBe(true);
    // Unbekannt bleibt unbekannt - nie eine Null.
    expect(rh.pv[20]).toBeNull();
  });

  it('nimmt nur frische Telemetrie als jetzt und rechnet den Speicher aus der Bilanz', () => {
    const p = [{ ts: new Date(NOW.getTime() - 60_000).toISOString(), powerKw: -1, socPct: 70, pvPowerKw: 6, loadKw: 3, gridLimitKw: null }];
    expect(jetztWerte(p, NOW.getTime())).toMatchObject({ pv: 6, bat: 2, soc: 70 });
    const alt = [{ ...p[0], ts: new Date(NOW.getTime() - 30 * 60_000).toISOString() }];
    expect(jetztWerte(alt, NOW.getTime())).toBeNull();
  });

  it('teilt die Herkunft anteilig auf', () => {
    const rh = leereReihen();
    rh.last[52] = 4; rh.netz[52] = 1; rh.bat[52] = -1; rh.pv[52] = 2;
    const a = quellenAnteil(rh, 52)!;
    expect(a.netz).toBeCloseTo(0.25);
    expect(a.sp).toBeCloseTo(0.25);
    expect(a.pv).toBeCloseTo(0.5);
    rh.last[53] = null;
    expect(quellenAnteil(rh, 53)).toBeNull();
  });
});

describe('geraete', () => {
  it('liest Zustand und Satz nur aus Gemeldetem', () => {
    const rh = leereReihen();
    rh.netz[52] = -0.4;
    const [ohne, wartet, laeuft] = geraete({
      raster: r,
      reihen: rh,
      verbraucher: { verbraucher: [eintrag({ entityId: 'a' }), eintrag({ entityId: 'b' }), eintrag({ entityId: 'c' })], ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null }, rangliste: [] },
      status: [
        { entityId: 'b', state: 'waiting', reasonCode: 'storage_first', reportedAt: NOW.toISOString() },
        { entityId: 'c', state: 'running_optimized', actualKw: 2.5, confirmed: true, reportedAt: NOW.toISOString() },
      ],
    });
    expect(ohne.pill).toEqual(['stale', 'unbekannt']);
    expect(wartet.pill).toEqual(['wait', 'wartet']);
    expect(wartet.warum).toBe('Wartet · braucht 1,0 kW, frei 0,4 kW');
    expect(laeuft.pill).toEqual(['on', 'läuft']);
    expect(laeuft.jetztKw).toBe(2.5);
  });

  it('nennt einen Eingriff mit Ende', () => {
    const [g] = geraete({
      raster: r,
      reihen: leereReihen(),
      verbraucher: { verbraucher: [eintrag({ entityId: 'a' })], ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null }, rangliste: [] },
      overrides: [{ entityId: 'a', kind: 'start', targetCommand: 'on_off', endsAt: new Date(NOW.getTime() + 3600_000).toISOString() }],
    });
    expect(g.eingriff?.art).toBe('an');
    expect(g.pill).toEqual(['hand', 'Eingriff: an']);
    expect(g.warum).toContain('bis 14:10');
  });
});

describe('Wörter', () => {
  it('bildet den Auftrag als Satz', () => {
    const g = { form: 'schalten' as const, ladepunkt: false };
    expect(auftragSatz({ quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 2 }, g)).toBe('Mit Sonnenstrom ab 2,0 kW');
    expect(auftragSatz({ quelle: 'guenstig', herkunft: 'policy', preisgrenzeCtKwh: 8.5 }, g)).toBe('Unter 8,5 ct');
    expect(auftragSatz({ quelle: 'feste_zeiten', herkunft: 'policy', fenster: { tage: 'weekdays', von: '06:30', bis: '08:30' } }, g)).toBe('06:30–08:30 werktags');
    expect(auftragSatz({ quelle: 'ueberschuss', herkunft: 'policy', ziel: 'laufzeit_bis', zielLaufzeitMinuten: 360, zielFenster: { tage: 'daily', von: '', bis: '20:00' } }, g)).toBe('6 Std bis 20:00, Sonne zuerst');
    expect(auftragSatz({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }, { form: 'stufenlos', ladepunkt: true })).toBe('Nur Sonnenstrom');
    expect(auftragSatz({ quelle: 'freigabe_ueberschuss', herkunft: 'policy' }, { form: 'freigabe', ladepunkt: false })).toBe('Anheben bei Sonne');
  });

  it('kürzt Namen und wählt ein Bild nach dem Namen, nie eine Fähigkeit', () => {
    expect(kurzName('Wallbox Werkstatt')).toBe('Werkstatt');
    expect(kurzName('Heizstab Warmwasser')).toBe('Heizstab');
    expect(symbolFuer('generic-load', 'Poolpumpe')).toBe('waves');
    expect(symbolFuer('generic-load', 'Waschmaschine')).toBe('washer');
    expect(symbolFuer('heating-rod', 'Stab')).toBe('flame');
  });
});

describe('Erwartung', () => {
  it('erwartet Sonnenstrom nur, wo genug eingespeist würde, und Fenster über Mitternacht', () => {
    const rh = leereReihen();
    rh.netz[60] = -3; rh.netz[61] = -0.5;
    const bits = erwarteteLaeufe({ quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 2 }, { form: 'schalten', nennKw: 2, ladepunkt: false }, rh);
    expect(bits[60]).toBe(true);
    expect(bits[61]).toBe(false);
    expect(imFenster(90, '22:00', '07:00')).toBe(true);
    expect(imFenster(40, '22:00', '07:00')).toBe(false);
    // Ohne Auftrag keine Erwartung.
    expect(erwarteteLaeufe({ quelle: 'ueberschuss', herkunft: 'ohne' }, { form: 'schalten', nennKw: 2, ladepunkt: false }, rh).some(Boolean)).toBe(false);
  });
});

describe('Reihenfolge', () => {
  it('liest Gruppen als Mitglieder und schreibt den Rumpf zurück', () => {
    const ids = reihenfolgeAus([
      { position: 2, art: 'ladepunkt', entityId: null, name: null, mitglieder: [{ entityId: 'l1', name: 'A' }, { entityId: 'l2', name: 'B' }] },
      { position: 1, art: 'speicher', entityId: null, name: 'Speicher' },
    ]);
    expect(ids).toEqual([SPEICHER, 'l1', 'l2']);
    expect(reihenfolgeRumpf(ids, [])).toEqual([{ art: 'speicher' }, { art: 'verbraucher', entityId: 'l1' }, { art: 'verbraucher', entityId: 'l2' }]);
  });

  it('stellt Sonnen-Kunden nach Platz, den Rest darunter', () => {
    const gs = geraete({
      raster: r,
      reihen: leereReihen(),
      verbraucher: {
        verbraucher: [
          eintrag({ entityId: 'a' }),
          eintrag({ entityId: 'b', steuerart: { quelle: 'feste_zeiten', herkunft: 'policy' } }),
          eintrag({ entityId: 'c' }),
        ],
        ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
        rangliste: [],
      },
    });
    expect(ordnen(['c', SPEICHER, 'a', 'b'], gs, true)).toEqual({ rang: ['c', SPEICHER, 'a'], rest: ['b'] });
  });
});

describe('Jetzt', () => {
  it('sagt den Kopfsatz und verteilt die Sonne', () => {
    const rh = leereReihen();
    rh.pv[52] = 8; rh.last[52] = 5; rh.netz[52] = -1; rh.bat[52] = 2; rh.soc[52] = 60;
    const gs = geraete({
      raster: r,
      reihen: rh,
      verbraucher: { verbraucher: [eintrag({ entityId: 'h', name: 'Heizstab' })], ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null }, rangliste: [] },
      consumers: [{ id: 'h', confirmationChannel: 'power_kw', ratedPowerKw: 3 } as never],
      status: [{ entityId: 'h', state: 'running_optimized', actualKw: 3, reportedAt: NOW.toISOString() }],
    });
    const s = kopfsatz(rh, 52, gs, 52);
    expect(`${s.vor}${s.sonne}${s.nach}`).toBe('Sonne 8,0 kW: Heizstab läuft. Der Speicher lädt. 1,0 kW gehen ins Netz.');
    const l = leiste(rh, 52, gs, [SPEICHER, 'h'], 52)!;
    expect(l.teile.map((x) => x.art)).toEqual(['haus', 'batt', 'dev', 'netz']);
    const sp = speicherBild({ raster: r, reihen: rh, name: 'Speicher', kwh: 10, kw: 5, reservePct: 10 });
    expect(sp.pill).toEqual(['on', 'lädt']);
  });

  it('sagt nachts, woher der Strom kommt, und ohne Werte nichts Erfundenes', () => {
    const rh = leereReihen();
    rh.pv[80] = 0; rh.netz[80] = 1.5; rh.bat[80] = -0.8; rh.last[80] = 2.3;
    const s = kopfsatz(rh, 80, [], 52);
    expect(s.vor).toBe('Keine Sonne. Der Speicher liefert 0,8 kW, das Netz 1,5 kW.');
    expect(kopfsatz(leereReihen(), 80, [], 52).vor).toBe('Für diese Viertelstunde liegen keine Werte vor.');
  });
});

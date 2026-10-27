import { describe, expect, it } from 'vitest';
import evDyn from '../fahrplanVektoren/laeufe/ev-dyn-tag.json';
import evFest51a from '../fahrplanVektoren/laeufe/ev-fest-51a-tag.json';
import { preisRolle } from '../preisRolle';
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
  momentZeile,
  ordnen,
  quellenAnteil,
  reihen,
  reihenfolgeAus,
  reihenfolgeRumpf,
  speicherBild,
  symbolFuer,
  unterzeile,
  type Reihen,
} from './bild';
import type { VerbraucherEintrag } from '../verbraucherZone';
import { N, TAG, raster, slotVon, uhr, uhrTag, dauer, spannen, spannenText } from './zeit';

const NOW = new Date(2026, 8, 29, 13, 10);
const r = raster(NOW);
const iso = (t: number) => new Date(r.start + t * 900_000).toISOString();

function leereReihen(): Reihen {
  const n = () => Array.from({ length: N }, () => null as number | null);
  return { pv: n(), last: n(), netz: n(), bat: n(), soc: n(), preis: n(), bezug: n(), einspeise: n(), temp: n(), abgeregelt: n(), gemessenBis: r.jetzt, morgenBekannt: false };
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

  it('trägt die Speicheruntergrenze von „Sonne + Speicher“ nur, wo der Fahrplan eine hat', () => {
    const ohne = reihen({ raster: r, plan: { slots: [{ start: iso(60), pvKw: 5, loadKw: 1, socPct: 80 }] } as never });
    // Ein Fahrplan ohne Untergrenze (jede Anlage ohne die Quelle) trägt keine Reihe.
    expect(ohne.speicherGrenze).toBeUndefined();
    const mit = reihen({
      raster: r,
      plan: { slots: [
        { start: iso(60), socPct: 80, evReleaseFloorSocPct: 35 },
        { start: iso(61), socPct: 79, evReleaseFloorSocPct: null },
        { start: iso(62), socPct: 78, evReleaseFloorSocPct: 0 },
      ] } as never,
    });
    expect(mit.speicherGrenze?.[60]).toBe(35);
    // Keine Untergrenze in einem Slot (der Plan handelt) bleibt null - nie 0.
    expect(mit.speicherGrenze?.[61]).toBeNull();
    // Eine echte 0 % bleibt eine Zahl.
    expect(mit.speicherGrenze?.[62]).toBe(0);
    expect(mit.speicherGrenze?.[59]).toBeNull();
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
    expect(auftragSatz({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }, { form: 'stufenlos', ladepunkt: true })).toBe('Nur Sonne');
    expect(auftragSatz({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'speicher' }, { form: 'stufenlos', ladepunkt: true })).toBe('Sonne + Speicher');
    expect(auftragSatz({ quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'mindestleistung' }, { form: 'stufenlos', ladepunkt: true })).toBe('Sonne + Minimum');
    expect(auftragSatz({ quelle: 'guenstig', herkunft: 'saeule', preisgrenzeCtKwh: 30 }, { form: 'stufenlos', ladepunkt: true })).toBe('Günstig unter 30,0 ct');
    expect(auftragSatz({ quelle: 'sofort', herkunft: 'standard' }, { form: 'stufenlos', ladepunkt: true })).toBe('Schnell · immer sofort voll');
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
    // „Günstig“ vergleicht den BEZUGSPREIS (wie der Server), nie den Börsenpreis; ohne ihn keine Erwartung.
    rh.preis[70] = 5; rh.bezug[70] = 31; rh.bezug[71] = 29;
    const guenstig = erwarteteLaeufe({ quelle: 'guenstig', herkunft: 'policy', preisgrenzeCtKwh: 30 }, { form: 'schalten', nennKw: 2, ladepunkt: false }, rh);
    expect([guenstig[70], guenstig[71], guenstig[72]]).toEqual([false, true, false]);
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

describe('unterzeile/momentZeile · sonne (Konzept vp-fahrplan-eigenverbrauch-konzept §4.7, Scheibe S4)', () => {
  it('nennt den Börsenpreis wie bisher, ohne `sonne` (Vorgabe false)', () => {
    const rh = leereReihen();
    rh.preis[52] = 8.4; rh.temp[52] = 22; rh.soc[52] = 64;
    expect(unterzeile(rh, 52, true)).toBe('Börsenpreis 8,4 ct/kWh · 22 °C draußen · Speicher 64 %');
    expect(unterzeile(rh, 52, true, false)).toBe('Börsenpreis 8,4 ct/kWh · 22 °C draußen · Speicher 64 %');
  });

  it('lässt den Börsenpreis (und die Morgen-Notiz) weg, mit `sonne = true`', () => {
    const rh = leereReihen();
    rh.preis[52] = 8.4; rh.temp[52] = 22; rh.soc[52] = 64;
    expect(unterzeile(rh, 52, true, true)).toBe('22 °C draußen · Speicher 64 %');
    // Die Morgen-Notiz ist ebenfalls eine Preis-Aussage - auch sie entfällt.
    const morgen = leereReihen();
    morgen.morgenBekannt = false;
    expect(unterzeile(morgen, TAG, false, true)).toBe('');
    expect(unterzeile(morgen, TAG, false, false)).toBe('Preise für morgen kommen gegen 13 Uhr');
  });

  it('momentZeile: derselbe Kopf ohne den Preis-Teil bei `sonne = true`', () => {
    const rh = leereReihen();
    rh.pv[52] = 3.2; rh.preis[52] = 11.9;
    expect(momentZeile(rh, 52, [], 52).kopf).toBe('13:00–13:15 · Sonne 3,2 kW · 11,9 ct/kWh');
    expect(momentZeile(rh, 52, [], 52, true).kopf).toBe('13:00–13:15 · Sonne 3,2 kW');
  });
});

describe('reihen() + preisRolle · Ende zu Ende über den echten § 51a-Lauf (Scheibe S4)', () => {
  it('klassiert über `bild.reihen` genauso wie der Fahrplan - 19 Nullstunden, 10:00-14:45', () => {
    const lauf = evFest51a as { slots: Array<Record<string, unknown>> };
    const r51a = raster(new Date(2026, 9, 27));
    const rh = reihen({ raster: r51a, plan: { slots: lauf.slots } as never });
    const rolle = preisRolle({
      slots: rh.bezug.slice(0, TAG).map((importPriceCtKwh, i) => ({ importPriceCtKwh, exportValueCtKwh: rh.einspeise[i] })),
      tarifArt: 'fest',
      plantKind: 'eigenverbrauch',
    });
    expect(rolle.bezug).toBe('flach');
    expect(rolle.einspeisung).toBe('flach_mit_nullstunden');
    expect(rolle.erzaehlung).toBe('sonne');
    expect(rolle.nullstunden).toHaveLength(19);
    // Dieselbe Spanne wie in fahrplanWhy.sonne.test.ts (ev-fest-51a-tag): 10:00-14:45 lokal.
    const von = Math.min(...rolle.nullstunden);
    const bis = Math.max(...rolle.nullstunden);
    expect(uhrTag(von)).toBe('10:00');
    expect(uhrTag(bis + 1)).toBe('14:45');
  });

  it('der dynamische Lauf (ev-dyn-tag) bleibt die Preis-Erzählung über dieselbe Ableitung', () => {
    const lauf = evDyn as { slots: Array<Record<string, unknown>> };
    const rDyn = raster(new Date(2026, 9, 27));
    const rh = reihen({ raster: rDyn, plan: { slots: lauf.slots } as never });
    const rolle = preisRolle({
      slots: rh.bezug.slice(0, TAG).map((importPriceCtKwh, i) => ({ importPriceCtKwh, exportValueCtKwh: rh.einspeise[i] })),
      tarifArt: 'dynamisch',
      plantKind: 'eigenverbrauch',
    });
    expect(rolle.bezug).toBe('schwankt');
    expect(rolle.erzaehlung).toBe('preis');
  });
});

// Die Fälle der Audit-Bühne `vp-ocpp-haushalt` (Haushalt mit einer Wallbox) an
// der Laden-Karte - je Befund das, was die Karte vorher behauptete.
describe('Ladepunkt im Haushalt (Audit vp-ocpp-haushalt)', () => {
  const JETZT = NOW.toISOString();
  const vor = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  const wallbox = eintrag({
    entityId: 'wb', name: 'Wallbox Garage', typ: 'ev-charger', typLabel: 'Wallbox', ladepunkt: true,
    chargePointId: 'WB-1', steuerart: { quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' },
  } as Partial<VerbraucherEintrag> & { entityId: string });
  type Lp = NonNullable<Parameters<typeof geraete>[0]['charging']>;
  const charging = (cp: Partial<Lp['chargers'][number]> = {}, con: Record<string, unknown> = {}, budget: Record<string, unknown> = {}): Lp => ({
    budget: { deviceId: 'box', enabled: true, controlEnabled: true, connectorCount: 1, ...budget } as Lp['budget'],
    chargers: [{
      deviceId: 'box', chargePointId: 'WB-1', priority: false, connected: true, ready: true, lastSeen: JETZT, reportedAt: JETZT,
      connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 11, meteredAt: JETZT, sessionSince: vor(95), ...con }],
      ...cp,
    }] as Lp['chargers'],
  });
  const bildVon = (c: Lp) => geraete({
    raster: r, reihen: leereReihen(), charging: c,
    verbraucher: { verbraucher: [wallbox], ladepunkte: { standard: null, standardFolger: 0, gesamt: 1, rahmen: null }, rangliste: [] },
  })[0];

  it('regelt VoltPilot alles, steht keine Sperre an der Karte', () => {
    const g = bildVon(charging());
    expect(g.ladepunkt?.sperre).toBeNull();
    expect(g.ladepunkt?.angesteckt).toBe(true);
    expect(g.an).toBe(true);
  });

  it('W-01 · Box ab Werk: die Karte sagt, dass VoltPilot nicht regelt', () => {
    const g = bildVon(charging({}, {}, { controlEnabled: false, controlNote: 'Die Verbrauchersteuerung ist an dieser Box noch nicht freigegeben.' }));
    expect(g.ladepunkt?.sperre?.kind).toBe('nicht_freigegeben');
    expect(g.ladepunkt?.sperre?.satz).toBe('VoltPilot regelt diese Wallbox noch nicht – sie lädt mit voller Leistung');
  });

  it('W-05 · Säule hält die Grenze nicht (Rücklesung abweichend): nicht steuerbar', () => {
    const g = bildVon(charging({}, { readback: 'abweichend', readbackNote: 'Die Säule hält 0 kW nicht ein.' }));
    expect(g.ladepunkt?.sperre?.kind).toBe('keine_grenzen');
    expect(g.ladepunkt?.sperre?.satz).toBe('Diese Wallbox nimmt keine Ladegrenzen an – VoltPilot kann sie nicht steuern');
  });

  it('W-05 · Sicherheitsprofil abgelehnt (ready=false mit Satz der Box): nicht steuerbar', () => {
    const g = bildVon(charging({ ready: false, note: 'Ladesäule nicht eingerichtet: das Sicherheitsprofil wurde abgelehnt (NotSupported)' }));
    expect(g.ladepunkt?.sperre?.kind).toBe('keine_grenzen');
  });

  it('⚠ W-12 · Wallbox seit 2 h getrennt: nicht „angesteckt", nicht „lädt", Sperre mit letztem Kontakt', () => {
    const g = bildVon(charging({ connected: false, lastSeen: vor(120) }, { powerKw: 7.4, meteredAt: vor(120) }));
    expect(g.ladepunkt?.angesteckt).toBe(false);
    expect(g.ladepunkt?.laedt).toBe(false);
    expect(g.ladepunkt?.sitzungSeit).toBeNull();
    expect(g.an).toBeNull();
    expect(g.jetztKw).toBeNull();
    expect(g.pill).toEqual(['stale', 'keine Verbindung']);
    expect(g.ladepunkt?.sperre?.kind).toBe('getrennt');
    expect(g.ladepunkt?.sperre?.satz).toMatch(/^Wallbox nicht erreichbar seit \d{2}:\d{2} Uhr$/);
    expect(g.warum).toBe(g.ladepunkt?.sperre?.satz);
  });

  it('⚠ W-21 · Auto voll (SuspendedEV): das Vektor-Wort, nie „wartet"', () => {
    const g = bildVon(charging({}, { status: 'SuspendedEV', charging: false, powerKw: 0, allocatedKw: 11 }));
    expect(g.ladepunkt?.zustand?.kind).toBe('auto_pausiert');
    expect(g.pill).toEqual(['wait', 'Auto pausiert']);
    expect(g.warum).toBe('Auto pausiert · voll oder Auto-Timer');
    expect(g.ladepunkt?.sperre).toBeNull();
  });
});

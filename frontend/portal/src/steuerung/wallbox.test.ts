import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ladestandAlter, messwertAlter, type ChargeConnector } from '../ladepunkte';
import type { FahrerEinstellungen, LadepunktAnsicht, LadepunktErtraege, LadepunktListe } from '../ladepunktErtraege';
import type { FahrzeugPlan, GeraetBild, LadepunktBezug } from './bild';
import { N, raster } from './zeit';

const NBSP = String.fromCharCode(160);
import {
  abfahrtSetzen, abfahrtZeile, ertragZeile, fahrerAnfrage, haltSatz, kmZu, ladestandAlterText, ladestandZuletztText,
  naechsteAbfahrt, pctKm, planZeile, plantZurueck, rueckspeiseHalt, rueckspeiseLage, rueckspeisePlan, rueckspeiseSatz,
  schnellSatz, wallboxMispel, wochentageText,
} from './laden';

/** MiSpeL MP-41b - die Ableitungen der Wallbox-Karte (BK-41 A, Vertrag mispel-ladepunkt-bidirektional.md § 5a). */

const FAHRER: FahrerEinstellungen = {
  erfasst: true, rueckspeisen: 'v2h', rueckspeisen_wirksam: 'v2h', reserve_pct: 40, vollzyklen_je_tag: 1,
  abfahrten: [{ wochentage: [1, 2, 3, 4, 5], abfahrt: '07:15', abfahrt_soc_pct: 80 }], naechste_fahrt: null,
  km_je_prozent: 3.84, geaendert_am: null, geaendert_von: null,
};

function ansicht(bidi: boolean, f: Partial<FahrerEinstellungen> | null = {}, v2g = bidi): LadepunktAnsicht {
  return {
    anlage: 's', komponente: 'e-wb', name: 'Wallbox', typ: 'ev-charger', charge_point_id: 'CP', am: '2026-10-05',
    faehigkeit: { erfasst: bidi, nutzbarkeit: bidi ? 'bidirektional' : 'unidirektional', v2h: bidi, v2g, rueckspeisung_bei_einspeisung_unterbunden: false, rueckspeiseleistung_kw: null, gueltig_ab: null, gueltig_bis: null },
    einordnung: 'ladepunkt_der_festlegung', einordnung_fundstelle: '', z2: [], befunde: [], fassungen: [],
    fahrer_einstellungen: f == null ? undefined : { ...FAHRER, ...f },
  };
}

function geraet(lp: Partial<LadepunktBezug> | null, kw: (number | null)[] = [], herkunft: GeraetBild['herkunft'] = [], mehr: Partial<GeraetBild> = {}): GeraetBild {
  return {
    id: 'e-wb', kw, herkunft, eingriff: null, steuerart: null, ...mehr,
    ladepunkt: lp == null ? null : { chargePointId: 'CP', connectorId: 1, angesteckt: true, sitzungSeit: null, sitzungKwh: null, karte: null, laedt: false, ladestandPct: null, fahrzeugBidirektional: null, ...lp },
  } as unknown as GeraetBild;
}

const liste = (...a: LadepunktAnsicht[]): LadepunktListe => ({ anlage: 's', am: '2026-10-05', ladepunkte: a });

describe('MP-41b · welcher Zustand an der Wallbox gilt', () => {
  it('Bestand: ohne Antwort, ohne Eintrag oder „nur laden“ bleibt die Karte wie heute (null)', () => {
    expect(wallboxMispel(geraet({ ladestandPct: 62 }), null)).toBeNull();
    expect(wallboxMispel(geraet({ ladestandPct: 62 }), liste())).toBeNull();
    expect(wallboxMispel(geraet({ ladestandPct: 62 }), liste(ansicht(false)))).toBeNull();
  });

  it('gemeldeter Ladestand → Abfahrt und Reserve; ohne → heutiges Ladeziel; „kann nicht“ nur auf ausdrückliche Meldung', () => {
    expect(wallboxMispel(geraet({ ladestandPct: 62 }), liste(ansicht(true)))?.fahrzeug).toBe('mit_ladestand');
    expect(wallboxMispel(geraet({ ladestandPct: null }), liste(ansicht(true)))?.fahrzeug).toBe('ohne_ladestand');
    expect(wallboxMispel(geraet({ ladestandPct: 55, fahrzeugBidirektional: false }), liste(ansicht(true)))?.fahrzeug).toBe('ohne_rueckspeisen');
    expect(wallboxMispel(geraet({ angesteckt: false, ladestandPct: 62 }), liste(ansicht(true)))?.fahrzeug).toBe('kein_auto');
    // Unbekannt ist kein „nein“: ohne Meldung der Wallbox gilt das Auto nicht als „ohne Rückspeise-Funktion“.
    expect(wallboxMispel(geraet({ ladestandPct: 62, fahrzeugBidirektional: null }), liste(ansicht(true)))?.fahrzeug).toBe('mit_ladestand');
  });

  it('die Stufen tragen nie über die Fähigkeit (A1 S. 26 Fn. 21); ohne Fahrer-Zeile gilt „aus“ mit der Reserve des Fensters', () => {
    const m = wallboxMispel(geraet({ ladestandPct: 62 }), liste(ansicht(true, {}, false)))!;
    expect(m.traegt).toEqual({ aus: true, v2h: true, v2g: false });
    const ohne = { ...ansicht(true, null), fahrzeugfenster: { mindest_soc_pct: 30, kapazitaet_kwh: null, anwesenheit: [] } };
    const f = wallboxMispel(geraet({ ladestandPct: 62 }), liste(ohne))!.fahrer;
    expect(f).toMatchObject({ erfasst: false, rueckspeisen: 'aus', reserve_pct: 30, km_je_prozent: null });
  });
});

describe('MP-41b · Prozent, Kilometer, Wochentage', () => {
  it('km auf 10 gerundet aus km_je_prozent; ohne Kapazität keine Zahl (unbekannt ist keine Null)', () => {
    expect(kmZu(80, 3.84)).toBe(`≈${NBSP}310${NBSP}km`);
    expect(kmZu(40, 3.84)).toBe(`≈${NBSP}150${NBSP}km`);
    expect(kmZu(80, null)).toBeNull();
    expect(pctKm(80, null)).toBe('80 %');
    expect(pctKm(62, 3.84)).toBe(`62 % (≈${NBSP}240${NBSP}km)`);
  });

  it('Wochentage: Läufe ab drei Tagen zusammen, sonst einzeln', () => {
    expect(wochentageText([1, 2, 3, 4, 5])).toBe('Mo–Fr');
    expect(wochentageText([6, 7])).toBe('Sa, So');
    expect(wochentageText([1, 3, 4, 5, 7])).toBe('Mo, Mi–Fr, So');
    expect(wochentageText([1, 2, 3, 4, 5, 6, 7])).toBe('täglich');
  });

  it('die Zeile „Abfahrt und Reserve“ und die nächste Abfahrt ab jetzt', () => {
    const di1310 = new Date(2026, 8, 29, 13, 10).getTime();
    expect(abfahrtZeile(FAHRER, di1310)).toEqual({ titel: `Abfahrt Mo–Fr 07:15 · 80 % (≈${NBSP}310${NBSP}km)`, unter: 'Reserve 40 % · höchstens eine volle Ladung am Tag zurück' });
    expect(naechsteAbfahrt(FAHRER, di1310)).toEqual({ wann: 'morgen 07:15', socPct: 80, einmalig: false });
    const fr = new Date(2026, 9, 2, 9, 0).getTime();
    expect(naechsteAbfahrt(FAHRER, fr)?.wann).toBe('Mo 07:15');
    const einmal = { ...FAHRER, naechste_fahrt: { abfahrt: '2026-09-30T05:30', abfahrt_soc_pct: 100 } };
    expect(abfahrtZeile(einmal, di1310).titel).toBe(`Nur die nächste Fahrt: Mi 05:30 · 100 % (≈${NBSP}380${NBSP}km)`);
    expect(abfahrtZeile(einmal, di1310).unter).toContain('danach wieder Mo–Fr 07:15');
    expect(abfahrtZeile({ ...FAHRER, abfahrten: [], reserve_pct: null, vollzyklen_je_tag: null }, di1310))
      .toEqual({ titel: 'Keine Abfahrt · Tippen, um Abfahrt und Reserve festzulegen', unter: 'Keine Reserve gesagt' });
  });
});

describe('MP-41b · der Satz unter „Zurückspeisen“ ist ein Wunsch, kein Ist', () => {
  const m = (f: Partial<FahrerEinstellungen>, fahrzeug: 'mit_ladestand' | 'ohne_rueckspeisen' = 'mit_ladestand') =>
    ({ ...wallboxMispel(geraet({ ladestandPct: 62 }), liste(ansicht(true, f)))!, fahrzeug });

  it('V2H vor V2G in Worten, Reserve in % und km', () => {
    expect(rueckspeiseSatz(m({}))).toBe(`Das Auto darf Strom ans Haus abgeben — nie unter 40 % (≈${NBSP}150${NBSP}km).`);
    expect(rueckspeiseSatz(m({ rueckspeisen: 'v2g', rueckspeisen_wirksam: 'v2g' }))).toBe(`Das Auto darf Strom erst ans Haus, dann ins Netz abgeben — nie unter 40 % (≈${NBSP}150${NBSP}km).`);
    expect(rueckspeiseSatz(m({ rueckspeisen: 'aus', rueckspeisen_wirksam: 'aus' }))).toBe('Das Auto lädt nur und gibt nichts ab.');
  });

  it('ohne Reserve speist es nicht zurück; der Wunsch über der Fähigkeit von heute wird benannt', () => {
    expect(rueckspeiseSatz(m({ reserve_pct: null }))).toContain('Ohne Reserve gibt das Auto nichts ab.');
    expect(rueckspeiseSatz(m({ rueckspeisen: 'v2g', rueckspeisen_wirksam: 'v2h' }))).toBe(`Das Auto darf Strom ans Haus abgeben — nie unter 40 % (≈${NBSP}150${NBSP}km). „Haus + Netz“ trägt der Ladepunkt heute nicht.`);
    expect(rueckspeiseSatz(m({}, 'ohne_rueckspeisen'))).toBe('„Ins Haus“ gilt wieder, sobald ein Auto mit Rückspeise-Funktion ansteckt.');
  });

  it('MP-41c: geplant ist ein Zurückspeisen nur aus dem Fahrzeug-Eintrag, nie aus dem Lade-Plan oder der Messung', () => {
    expect(plantZurueck(geraet({}, [null, 3, -2], [null, 'plan', 'plan']))).toBe(false);
    expect(plantZurueck(geraet({}, [], [], { fahrzeugPlan: fplan({}) }))).toBe(false);
    expect(plantZurueck(geraet({}, [], [], { fahrzeugPlan: fplan({ 72: 2.4 }) }))).toBe(true);
    expect(plantZurueck(geraet({}, [], [], { fahrzeugPlan: fplan({ 72: 0.02 }) }))).toBe(false);
  });
});

/** Ein Fahrzeug-Eintrag ab 13:00 (Raster 52) über 96 Viertelstunden, Zurückspeisen in kW (Betrag) je Viertelstunde. */
function fplan(zurueck: Record<number, number>, standMs: number | null = new Date(2026, 8, 29, 13, 0).getTime()): FahrzeugPlan {
  const z: (number | null)[] = Array.from({ length: N }, (_, t) => (t >= 52 && t < 148 ? zurueck[t] ?? 0 : null));
  return { standMs, zurueck: z, endeMs: new Date(2026, 8, 30, 13, 0).getTime() };
}

// BK-41c: 18:00–21:30 ans Haus, 14 Viertelstunden = 8,825 kWh.
const ZURUECK = Object.fromEntries([2.4, 2.8, 3.2, 3.2, 3.0, 2.9, 2.7, 2.6, 2.5, 2.4, 2.2, 2.0, 1.8, 1.6].map((kw, i) => [72 + i, kw]));
const R = raster(new Date(2026, 8, 29, 13, 10));

describe('MP-41c · BK-41c-1 A: der Plan des Zurückspeisens auf der Karte', () => {
  const m = (mehr: Partial<GeraetBild> = {}, f: Partial<FahrerEinstellungen> = {}, lp: Partial<LadepunktBezug> = { ladestandPct: 62 }) => {
    const g = geraet(lp, [], [], mehr);
    return { g, m: wallboxMispel(g, liste(ansicht(true, f)))! };
  };

  it('Fenster von–bis, Menge und Stand aus den Rückspeise-Viertelstunden', () => {
    const p = rueckspeisePlan({ fahrzeugPlan: fplan(ZURUECK) })!;
    expect(p).toMatchObject({ von: 72, bis: 86, weitere: 0, standMs: new Date(2026, 8, 29, 13, 0).getTime() });
    expect(p.kwh).toBeCloseTo(8.825, 6);
    expect(rueckspeisePlan({ fahrzeugPlan: fplan({ 72: 2, 73: 2, 80: 1 }) })).toMatchObject({ von: 72, bis: 74, weitere: 1 });
    expect(rueckspeisePlan({ fahrzeugPlan: null })).toBeNull();
  });

  it('die Plan-Zeile wie abgestimmt; über Mitternacht und „Haus + Netz“ in Worten', () => {
    const { m: mm } = m();
    expect(planZeile(rueckspeisePlan({ fahrzeugPlan: fplan(ZURUECK) })!, mm, R)).toEqual({
      titel: `Heute 18:00–21:30 ans Haus · ≈${NBSP}9${NBSP}kWh`,
      unter: `Plan von 13:00 · nie unter 40${NBSP}% · morgen 07:15 wieder 80${NBSP}%`,
    });
    const nacht = rueckspeisePlan({ fahrzeugPlan: fplan({ 94: 2, 95: 2, 96: 2 }) })!;
    const v2g = { fahrer: { ...mm.fahrer, rueckspeisen: 'v2g' as const, rueckspeisen_wirksam: 'v2g' as const } };
    expect(planZeile(nacht, v2g, R).titel).toBe(`Heute 23:30–morgen 00:15 ans Haus und ins Netz · ≈${NBSP}2${NBSP}kWh`);
    // Unter 1 kWh mit einer Stelle - „≈ 0 kWh“ wäre eine erfundene Null.
    expect(planZeile(rueckspeisePlan({ fahrzeugPlan: fplan({ 80: 2 }) })!, mm, R).titel).toBe(`Heute 20:00–20:15 ans Haus · ≈${NBSP}0,5${NBSP}kWh`);
    expect(planZeile(rueckspeisePlan({ fahrzeugPlan: fplan({ 100: 4 }) })!, mm, R).titel).toBe(`Morgen 01:00–01:15 ans Haus · ≈${NBSP}1${NBSP}kWh`);
  });

  it('die fünf Lagen: geplant, kein Zurückspeisen im Plan, angehalten, ohne Reserve, noch nicht eingeschaltet', () => {
    const lage = (mehr: Partial<GeraetBild>, f: Partial<FahrerEinstellungen> = {}) => {
      const x = m(mehr, f);
      return rueckspeiseLage(x.g, x.m, R);
    };
    expect(lage({ fahrzeugPlan: fplan(ZURUECK) })?.art).toBe('geplant');
    expect(lage({ fahrzeugPlan: fplan({}) })).toEqual({ art: 'kein', satz: 'Bis morgen 13:00 plant VoltPilot kein Zurückspeisen — es lohnt sich gerade nicht.' });
    expect(lage({ fahrzeugPlan: fplan(ZURUECK), steuerart: { quelle: 'sofort', herkunft: 'saeule' } as GeraetBild['steuerart'] })).toBeNull();
    expect(lage({ fahrzeugPlan: fplan(ZURUECK) }, { reserve_pct: null })).toBeNull();
    expect(lage({ fahrzeugPlan: null })).toEqual({ art: 'nicht_eingeschaltet', satz: 'An dieser Anlage plant VoltPilot das Zurückspeisen noch nicht. Ihre Wahl ist gespeichert.' });
    // „Aus“ gewählt oder ein Auto ohne Rückspeise-Funktion: der Satz zur Stufe sagt schon alles.
    expect(lage({ fahrzeugPlan: null }, { rueckspeisen: 'aus', rueckspeisen_wirksam: 'aus' })).toBeNull();
    const ohne = m({ fahrzeugPlan: null }, {}, { ladestandPct: 55, fahrzeugBidirektional: false });
    expect(rueckspeiseLage(ohne.g, ohne.m, R)).toBeNull();
  });
});

describe('MP-41c · BK-41c-3 A: „Schnell“ heißt immer nur laden - Zurückspeisen ruht', () => {
  const SOFORT = { quelle: 'sofort', herkunft: 'saeule' } as GeraetBild['steuerart'];

  it('derselbe Halte-Grund wie im Optimierer: Lademodus am Stecker vor Steuerart vor Szene', () => {
    expect(rueckspeiseHalt({ eingriff: { art: 'aus', bisMs: null }, steuerart: SOFORT, szene: 'Urlaub' })).toBe('lademodus_aus');
    expect(rueckspeiseHalt({ eingriff: { art: 'an', bisMs: null }, steuerart: null, szene: null })).toBe('lademodus_schnell');
    expect(rueckspeiseHalt({ eingriff: null, steuerart: SOFORT, szene: 'Urlaub' })).toBe('lademodus_sofort');
    expect(rueckspeiseHalt({ eingriff: null, steuerart: null, szene: 'Urlaub' })).toBe('szene');
    expect(rueckspeiseHalt({ eingriff: null, steuerart: { quelle: 'ueberschuss', herkunft: 'saeule' } as GeraetBild['steuerart'], szene: null })).toBeNull();
  });

  it('der Satz unterscheidet Eingriff und Steuerart - nur an der Wallbox-Karte, sonst Bestand', () => {
    expect(schnellSatz({ eingriff: null }, true)).toBe('Lädt immer sofort mit voller Leistung, auch mit Netzstrom — so ist dieser Ladepunkt eingestellt.');
    expect(schnellSatz({ eingriff: { art: 'an', bisMs: null } }, true)).toBe('Lädt so schnell es geht, nur für diese Ladung. Netzstrom erlaubt.');
    expect(schnellSatz({ eingriff: null }, false)).toBe('Lädt so schnell es geht, nur für diese Ladung. Netzstrom erlaubt.');
  });

  it('„Zurückspeisen ruht …“ statt des Wunsches - die Wahl des Fahrers bleibt gespeichert', () => {
    const satz = (mehr: Partial<GeraetBild>, f: Partial<FahrerEinstellungen> = {}) =>
      rueckspeiseSatz(wallboxMispel(geraet({ ladestandPct: 62 }, [], [], mehr), liste(ansicht(true, f)))!);
    expect(satz({ steuerart: SOFORT })).toBe('Zurückspeisen ruht, solange „Schnell“ gilt — mit „Smart“ plant VoltPilot es wieder. Ihre Wahl „Ins Haus“ bleibt gespeichert.');
    expect(satz({ eingriff: { art: 'an', bisMs: null } })).toBe('Zurückspeisen ruht bis dahin. Ihre Wahl „Ins Haus“ bleibt gespeichert.');
    expect(satz({ eingriff: { art: 'aus', bisMs: null } }, { rueckspeisen: 'v2g', rueckspeisen_wirksam: 'v2g' })).toBe('Zurückspeisen ruht bis dahin. Ihre Wahl „Haus + Netz“ bleibt gespeichert.');
    expect(satz({ szene: 'Urlaub' })).toBe('Zurückspeisen ruht, solange die Szene „Urlaub“ läuft. Ihre Wahl „Ins Haus“ bleibt gespeichert.');
    // Wer „Aus“ gewählt hat, dem ruht nichts: der Satz bleibt.
    expect(satz({ steuerart: SOFORT }, { rueckspeisen: 'aus', rueckspeisen_wirksam: 'aus' })).toBe('Das Auto lädt nur und gibt nichts ab.');
    expect(haltSatz({ halt: 'lademodus_sofort', szene: null, fahrer: FAHRER })).toContain('solange „Schnell“ gilt');
  });
});

describe('MP-41c · BK-41c-2 A: der Ladestand nach seiner eigenen Uhr', () => {
  const t = (iso: string) => Date.parse(iso);

  it('bis eine Minute „jetzt“, danach „vor N Min.“; ohne eigene Uhr wie bisher „jetzt“', () => {
    const um = t('2026-10-04T17:59:50Z');
    expect(ladestandAlterText(um, t('2026-10-04T18:00:50Z'))).toBe('jetzt');
    expect(ladestandAlterText(um, t('2026-10-04T18:00:51Z'))).toBe('vor 1 Min.');
    expect(ladestandAlterText(um, t('2026-10-04T18:03:00Z'))).toBe('vor 3 Min.');
    expect(ladestandAlterText(null, t('2026-10-04T18:03:00Z'))).toBe('jetzt');
  });

  it('ein alter Ladestand nennt im Kopf, von wann er ist - und schaltet die Karte auf das Ladeziel', () => {
    const um = new Date(2026, 8, 29, 12, 58).getTime();
    const mm = wallboxMispel(geraet({ ladestandPct: null, ladestandUm: um, ladestandZuletztPct: 62 }), liste(ansicht(true)))!;
    expect(mm.fahrzeug).toBe('ohne_ladestand');
    expect(ladestandZuletztText(mm, R)).toBe(`Ladestand zuletzt 62${NBSP}% um 12:58`);
    const frisch = wallboxMispel(geraet({ ladestandPct: 62, ladestandUm: um }), liste(ansicht(true)))!;
    expect(frisch).toMatchObject({ fahrzeug: 'mit_ladestand', ladestandUm: um, ladestandZuletzt: null });
    expect(ladestandZuletztText(frisch, R)).toBeNull();
  });

  /**
   * Die geteilten Vektoren (`docs/contracts/v2/mispel-ladepunkt-fahrzeug-vectors.json`): Box und Cloud lesen
   * `box`/`edge`/`portal`, die Karte liest `portal` und - wo ein Fall ihn trägt - den Block `karte`.
   */
  const vektoren = JSON.parse(readFileSync(join(process.cwd(), '../../docs/contracts/v2/mispel-ladepunkt-fahrzeug-vectors.json'), 'utf8')) as {
    jetzt: string;
    faelle: { name: string; portal: { socPct: number | null; socMeasuredAt: string | null }; karte?: {
      metered_at: string; ablesungen: { jetzt: string; leistung: string; ladestand: string; alter: string | null }[];
    } }[];
  };

  it('Vektoren: ein Ladestand ohne eigene Uhr ist unbekannt, nie frisch', () => {
    for (const f of vektoren.faelle) {
      const alter = ladestandAlter({ socMeasuredAt: f.portal.socMeasuredAt }, t(vektoren.jetzt));
      expect(alter, f.name).toBe(f.portal.socPct == null ? 'unbekannt' : 'frisch');
    }
  });

  it('Vektoren: die Ablesungen der Karte - zwei Uhren, ein Fenster, das Alter in Worten', () => {
    const mitKarte = vektoren.faelle.filter((f) => f.karte);
    expect(mitKarte.length).toBeGreaterThanOrEqual(1);
    for (const f of mitKarte) {
      const con: ChargeConnector = { connectorId: 1, charging: true, socPct: f.portal.socPct, socMeasuredAt: f.portal.socMeasuredAt, meteredAt: f.karte!.metered_at };
      for (const a of f.karte!.ablesungen) {
        const jetzt = t(a.jetzt);
        expect(messwertAlter(con, jetzt), `${f.name} ${a.jetzt} Leistung`).toBe(a.leistung);
        expect(ladestandAlter(con, jetzt), `${f.name} ${a.jetzt} Ladestand`).toBe(a.ladestand);
        expect(a.ladestand === 'frisch' ? ladestandAlterText(t(String(con.socMeasuredAt)), jetzt) : null, `${f.name} ${a.jetzt} Alter`).toBe(a.alter);
      }
    }
  });
});

describe('MP-41b · Schreiben ersetzt ganz (§ 5a)', () => {
  it('eine Abfahrt ersetzt die erste, ihre Tage fallen aus den übrigen heraus', () => {
    const plan = [{ wochentage: [1, 2, 3, 4, 5], abfahrt: '07:15', abfahrt_soc_pct: 80 }, { wochentage: [6, 7], abfahrt: '09:00', abfahrt_soc_pct: 90 }];
    expect(abfahrtSetzen(plan, { wochentage: [6, 1, 2, 3, 4, 5], abfahrt: '07:30', abfahrt_soc_pct: 85 })).toEqual([
      { wochentage: [1, 2, 3, 4, 5, 6], abfahrt: '07:30', abfahrt_soc_pct: 85 },
      { wochentage: [7], abfahrt: '09:00', abfahrt_soc_pct: 90 },
    ]);
    expect(abfahrtSetzen(plan, { wochentage: [], abfahrt: '07:30', abfahrt_soc_pct: 85 })).toEqual([plan[1]]);
  });

  it('die Anfrage trägt den ganzen Stand, nur die Änderung neu', () => {
    expect(fahrerAnfrage({ ...FAHRER, abfahrten: [{ wochentage: [1], abfahrt: '07:15:00', abfahrt_soc_pct: 80 }] }, { rueckspeisen: 'v2g' })).toEqual({
      rueckspeisen: 'v2g', reserve_pct: 40, vollzyklen_je_tag: 1,
      abfahrten: [{ wochentage: [1], abfahrt: '07:15', abfahrt_soc_pct: 80 }], naechste_fahrt: null,
    });
  });
});

describe('MP-41b · der Monat an der Karte', () => {
  const e = (summe: number | null, ins: number | null = 108): LadepunktErtraege => ({
    anlage: 's', monat: '2026-11', ladepunkte: [{ komponente: 'e-wb', name: 'Wallbox', einordnung: 'ladepunkt_der_festlegung' }],
    teile: [{ schluessel: 'a', erster_tag: '2026-11-01', letzter_tag: '2026-11-30', formelsatz: 'A2', formelsatz_bezeichnung: '', nur_ladepunkt: true, stand: 'vorlaeufig', wertequelle: null,
      mengen: [{ nr: '11', begriff: '', fundstelle: '', kwh: 34 }], ins_haus: { nr: '', begriff: '', fundstelle: '', kwh: ins } }],
    posten: [], vergleich: { stand: summe == null ? 'offen' : 'bestimmt', grund: null, summe_eur: summe },
  });

  it('Mengen ins Haus und (11) ins Netz, die Summe nur, wenn bestimmt; fehlende Menge heißt „offen“', () => {
    expect(ertragZeile(e(15.42), 'e-wb')).toEqual({ titel: 'November: 108 kWh ins Haus · 34 kWh ins Netz', unter: '+15,42 € gegenüber nur laden · in Verlauf › Erlöse' });
    expect(ertragZeile(e(null, null), 'e-wb')).toEqual({ titel: 'November: offen ins Haus · 34 kWh ins Netz', unter: 'Vergleich mit „nur laden“ noch offen · in Verlauf › Erlöse' });
    expect(ertragZeile(e(15.42), 'e-anderer')).toBeNull();
    expect(ertragZeile(null, 'e-wb')).toBeNull();
  });
});

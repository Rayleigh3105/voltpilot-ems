import { describe, expect, it } from 'vitest';
import type { FahrerEinstellungen, LadepunktAnsicht, LadepunktErtraege, LadepunktListe } from '../ladepunktErtraege';
import type { GeraetBild, LadepunktBezug } from './bild';

const NBSP = String.fromCharCode(160);
import {
  abfahrtSetzen, abfahrtZeile, ertragZeile, fahrerAnfrage, kmZu, naechsteAbfahrt, pctKm, plantZurueck, rueckspeiseSatz,
  wallboxMispel, wochentageText,
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

function geraet(lp: Partial<LadepunktBezug> | null, kw: (number | null)[] = [], herkunft: GeraetBild['herkunft'] = []): GeraetBild {
  return {
    id: 'e-wb', kw, herkunft,
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

  it('„plant VoltPilot noch nicht“, solange der Fahrplan keinen negativen Sollwert trägt', () => {
    expect(plantZurueck(geraet({}, [null, 3, 3], [null, 'plan', 'plan']))).toBe(false);
    expect(plantZurueck(geraet({}, [null, 3, -2], [null, 'plan', 'plan']))).toBe(true);
    expect(plantZurueck(geraet({}, [-2], ['gemessen']))).toBe(false);
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

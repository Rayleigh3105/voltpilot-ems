import { describe, expect, it } from 'vitest';
import type { AnlagenCheck, AnlagenCheckEinheit, AnlagenCheckUrteil, SpeicherBilanz } from './api';
import { aufzaehlung, kachelFuss, seitKurz, seitLang, solarKachel, solarKarte, speicherBilanz } from './anlagenCheck';

const NB = ' ';

function einheit(id: string, verhaeltnis: number | null, zustand: AnlagenCheckEinheit['zustand'], extra: Partial<AnlagenCheckEinheit> = {}): AnlagenCheckEinheit {
  return {
    id,
    name: id,
    gemessenKwh: 100,
    erwartetKwh: 100,
    verhaeltnis,
    zustand,
    keineWerteSeit: null,
    wenigerSeit: null,
    gewerteteTage: 7,
    ...extra,
  };
}

function urteil(gesamt: AnlagenCheckUrteil['gesamt'], einheiten: AnlagenCheckEinheit[], extra: Partial<AnlagenCheckUrteil> = {}): AnlagenCheckUrteil {
  // bis = Sonntag, 08.11.2026
  return { gesamt, von: '2026-11-02', bis: '2026-11-08', fensterTage: 7, sonnenTage: 7, abgeregelteTage: 0, einheiten, ...extra };
}

function check(u: AnlagenCheckUrteil, modus: AnlagenCheck['modus'] = 'einheiten'): AnlagenCheck {
  return { pv: true, modus, kachel: u, zeitraum: null, ohneGeraet: [] };
}

describe('Kachel „Solaranlage“ (Bedienkonzept §6.3, Zustände)', () => {
  it('alle gut: „Alle 4 liefern wie erwartet“, grün, breit', () => {
    const k = solarKachel(check(urteil('wie_erwartet', [
      einheit('Kaco 1', 1.01, 'wie_erwartet'), einheit('Kaco 2', 0.98, 'wie_erwartet'),
      einheit('Kaco 3', 0.99, 'wie_erwartet'), einheit('PIKO', 1.0, 'wie_erwartet'),
    ])))!;
    expect(k.marke).toEqual({ text: 'Alle 4 liefern wie erwartet', art: 'ok' });
    expect(k.zeilen.map((z) => z.wert)).toEqual([`101${NB}%`, `98${NB}%`, `99${NB}%`, `100${NB}%`]);
    expect(k.zeilen[0].fuellung).toBe(100);
    expect(k.klein).toBe(false);
    expect(k.fuss).toBe('letzte 7 Tage · gemessen gegen erwartet');
  });

  it('eine Einheit fällt ab: Marke im Warn-Ton, Zeile im Warn-Ton', () => {
    const k = solarKachel(check(urteil('weniger', [
      einheit('Kaco 1', 1.01, 'wie_erwartet'), einheit('Kaco 3', 0.76, 'weniger'),
    ])))!;
    expect(k.marke).toEqual({ text: 'Kaco 3 liefert weniger', art: 'warn' });
    expect(k.zeilen[1]).toMatchObject({ wert: `76${NB}%`, warn: true, fuellung: 76 });
  });

  it('zwei fallen ab: beide genannt, Plural', () => {
    const k = solarKachel(check(urteil('weniger', [
      einheit('A', 0.6, 'weniger'), einheit('B', 0.6, 'weniger'), einheit('C', 1, 'wie_erwartet'),
    ])))!;
    expect(k.marke.text).toBe('A und B liefern weniger');
  });

  it('ganze Anlage: eine Zeile, klein, „Liefert wie erwartet“', () => {
    const k = solarKachel(check(urteil('wie_erwartet', [einheit('Ganze Anlage', 0.96, 'wie_erwartet')], { fensterTage: 14 }), 'ganze_anlage'))!;
    expect(k.marke.text).toBe('Liefert wie erwartet');
    expect(k.klein).toBe(true);
    expect(k.fuss).toBe('letzte 14 Tage · gemessen gegen erwartet');
  });

  it('zu wenig Sonne: Striche, Fuß nennt die Bedingung', () => {
    const k = solarKachel(check(urteil('zu_wenig_sonne', [einheit('A', null, 'offen'), einheit('B', null, 'offen')], { sonnenTage: 2 })))!;
    expect(k.marke).toEqual({ text: 'Zu wenig Sonne für einen Vergleich', art: 'ohne' });
    expect(k.zeilen.map((z) => [z.wert, z.fuellung])).toEqual([['—', 0], ['—', 0]]);
    expect(k.fuss).toBe('letzte 7 Tage · ab 3 Tagen mit Sonne');
  });

  it('Messwerte fehlen: nie „liefert weniger“, sondern „keine Werte seit Di.“', () => {
    const k = solarKachel(check(urteil('messwerte_fehlen', [
      einheit('Kaco 1', 1.0, 'wie_erwartet'),
      einheit('Kaco 3', null, 'fehlt', { keineWerteSeit: '2026-11-03' }),
    ])))!;
    expect(k.marke).toEqual({ text: 'Von Kaco 3 fehlen Messwerte', art: 'ohne' });
    expect(k.zeilen[1]).toMatchObject({ wert: 'keine Werte seit Di.', wort: true, warn: false });
  });

  it('abgeregelte Tage: „5 von 7 Tagen · 2 Tage abgeregelt, nicht gewertet“', () => {
    expect(kachelFuss(urteil('wie_erwartet', [], { sonnenTage: 5, abgeregelteTage: 2 }))).toBe(
      '5 von 7 Tagen · 2 Tage abgeregelt, nicht gewertet',
    );
    expect(kachelFuss(urteil('wie_erwartet', [], { sonnenTage: 6, abgeregelteTage: 1 }))).toBe(
      '6 von 7 Tagen · 1 Tag abgeregelt, nicht gewertet',
    );
  });

  it('keine PV: keine Kachel', () => {
    expect(solarKachel({ ...check(urteil('noch_zu_frueh', [])), pv: false })).toBeNull();
    expect(solarKachel(null)).toBeNull();
  });

  it('über 100 % füllt die Spur höchstens ganz', () => {
    const k = solarKachel(check(urteil('wie_erwartet', [einheit('A', 1.4, 'wie_erwartet'), einheit('B', 1, 'wie_erwartet')])))!;
    expect(k.zeilen[0]).toMatchObject({ wert: `140${NB}%`, fuellung: 100 });
  });
});

describe('Karte „Erzeugung nach Einheiten“', () => {
  const zeitraum = (gesamt: AnlagenCheckUrteil['gesamt'] | null, einheiten: AnlagenCheckEinheit[], bisAbgeschlossen: string | null = '2026-09-06') => ({
    ...check(urteil('wie_erwartet', einheiten)),
    zeitraum: {
      z: 'woche' as const, von: '2026-08-31', bis: '2026-09-06', bisAbgeschlossen,
      gemessenKwh: 249.7, erwartetKwh: 262.2, gesamt, sonnenTage: 7, abgeregelteTage: 0, einheiten,
      eimer: 'tag' as const,
      saeulen: [{ start: '2026-08-31', kwh: [20, 10, 3] }, { start: '2026-09-06', kwh: [15, null, 2] }],
    },
  });

  it('Kopf, Zeilen, Säulen und der Satz „seit Mittwoch“', () => {
    const m = solarKarte(zeitraum('weniger', [
      einheit('Dach Scheune', 0.98, 'wie_erwartet', { gemessenKwh: 152.3, erwartetKwh: 155 }),
      einheit('Dach Wohnhaus', 0.98, 'wie_erwartet', { gemessenKwh: 74.6, erwartetKwh: 76 }),
      einheit('Carport', 0.74, 'weniger', { gemessenKwh: 22.8, erwartetKwh: 31, wenigerSeit: '2026-09-02' }),
    ]))!;
    expect(m.sub).toBe(`249,7${NB}kWh · erwartet 262${NB}kWh`);
    expect(m.zeilen[2]).toEqual({ id: 'Carport', name: 'Carport', erwartet: `erwartet 31${NB}kWh`, wert: `22,8${NB}kWh`, prozent: `74${NB}%`, warn: true });
    expect(m.saeulen.map((s) => [s.kopf, s.summe])).toEqual([['Mo., 31.08.', 33], ['So., 06.09.', 17]]);
    expect(m.satz).toBe('Carport liefert seit Mittwoch weniger als erwartet.');
  });

  it('alles gut, Tag ohne Satz, heute offen', () => {
    const e = [einheit('A', 1, 'wie_erwartet'), einheit('B', 1, 'wie_erwartet'), einheit('C', 1, 'wie_erwartet')];
    expect(solarKarte(zeitraum('wie_erwartet', e))!.satz).toBe('Alle 3 liefern wie erwartet.');
    expect(solarKarte(zeitraum(null, e))!.satz).toBeNull();
    expect(solarKarte(zeitraum(null, e, null))!.satz).toBe('Der Vergleich beginnt mit dem ersten abgeschlossenen Tag.');
  });

  it('nennt Einheiten ohne gemessenes Gerät', () => {
    const c = { ...zeitraum('wie_erwartet', [einheit('A', 1, 'wie_erwartet'), einheit('B', 1, 'wie_erwartet')]), ohneGeraet: ['Dach Ost'] };
    expect(solarKarte(c)!.hinweis).toBe('Ohne gemessenes Gerät, nicht verglichen: Dach Ost.');
  });

  it('ohne Zeitraum oder ohne PV keine Karte', () => {
    expect(solarKarte(check(urteil('wie_erwartet', [])))).toBeNull();
  });
});

describe('Wörter für Tage', () => {
  it('innerhalb der Woche der Wochentag, sonst das Datum', () => {
    expect(seitKurz('2026-11-03', '2026-11-08')).toBe('seit Di.');
    expect(seitKurz('2026-10-20', '2026-11-08')).toBe('seit 20.10.');
    expect(seitLang('2026-11-04', '2026-11-08')).toBe('seit Mittwoch');
    expect(seitLang('2026-10-20', '2026-11-08')).toBe('seit dem 20.10.');
    expect(aufzaehlung(['A', 'B', 'C'])).toBe('A, B und C');
  });
});

describe('Speicher-Bilanz (§6.5)', () => {
  const basis: SpeicherBilanz = {
    zustand: 'normal', von: '2026-10-14', bis: '2026-11-12', fensterTage: 30, tageMitDaten: 30,
    hineinKwh: 212.2, herausKwh: 193.4, ausgleichKwh: 0, wirkungsgrad: 0.9114, verlustKwh: 18.8,
    vollzyklen: 19.34, vollzyklenSeitBeginn: 412.4, kapazitaetKwh: 10, vergleichMin: 0.904, vergleichMax: 0.921,
    vergleichMonate: 12, satz: 'unauffaellig',
    monate: [{ monat: '2026-10', hineinKwh: 220, herausKwh: 200, wirkungsgrad: 0.91, vollzyklen: 20 }],
  };

  it('normal: drei Zahlen und der Satz gegen die 12 Monate', () => {
    const m = speicherBilanz(basis)!;
    expect(m.titel).toBe('Speicher-Bilanz · 30 Tage');
    expect(m.zellen).toEqual([
      { titel: 'Wirkungsgrad', wert: `91${NB}%`, sub: `212${NB}kWh hinein, 193${NB}kWh heraus` },
      { titel: 'Vollzyklen', wert: '19', sub: 'seit Beginn 412' },
      { titel: 'Verlust', wert: `19${NB}kWh`, sub: 'Wärme und Eigenbedarf' },
    ]);
    expect(m.satz).toEqual({ text: `Unauffällig – wie in den letzten 12 Monaten (90–92${NB}%).`, ton: 'ok' });
    expect(m.monate[0]).toEqual({ monat: 'Okt. 2026', wirkungsgrad: `91${NB}%`, vollzyklen: '20', verlust: `20${NB}kWh` });
  });

  it('niedriger: kein Urteil, nur der Vergleich', () => {
    expect(speicherBilanz({ ...basis, wirkungsgrad: 0.78, satz: 'niedriger' })!.satz).toEqual({
      text: `Niedriger als in den letzten 12 Monaten (90–92${NB}%).`, ton: 'warn',
    });
  });

  it('wenig geladen: Striche und der Satz ab 5 Vollzyklen', () => {
    const m = speicherBilanz({ ...basis, zustand: 'wenig', hineinKwh: 14, wirkungsgrad: null, verlustKwh: null, vollzyklen: 1, satz: null })!;
    expect(m.zellen[0]).toEqual({ titel: 'Wirkungsgrad', wert: '—', sub: `erst 14${NB}kWh geladen` });
    expect(m.satz!.text).toBe('Noch zu wenig geladen für eine Bilanz – ab etwa 5 Vollzyklen.');
  });

  it('ohne Kapazität: 90 Tage, ohne Vollzyklen', () => {
    const m = speicherBilanz({ ...basis, kapazitaetKwh: null, vollzyklen: null, vollzyklenSeitBeginn: null, fensterTage: 90 })!;
    expect(m.titel).toBe('Speicher-Bilanz · 90 Tage');
    expect(m.zellen.map((z) => z.titel)).toEqual(['Wirkungsgrad', 'Verlust']);
  });

  it('ohne Daten keine Karte', () => {
    expect(speicherBilanz({ ...basis, zustand: 'ohne_daten' })).toBeNull();
    expect(speicherBilanz(null)).toBeNull();
  });
});

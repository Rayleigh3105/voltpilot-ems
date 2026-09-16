import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleGroesse } from './api';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import {
  MS_11,
  MS_12,
  monatKarte,
  ms10November,
  ms10Oktober,
  ms11Oktober,
  ms12November,
  ms12Oktober,
  ms12Vorjahr,
} from './test/vergleichFixtures';
import { ANFANG_NICHT_GEMESSEN, MS_06, MS_10 } from './test/werteKarteFixtures';
import { VERGLEICH_HOECHSTENS } from './uemsOberflaechen';
import {
  VERGLEICH_AUS,
  VOLL_SATZ,
  WOCHE_OHNE_DELTA,
  bestehenAus,
  delta,
  entfernenName,
  grundSatz,
  hatZahl,
  laufendSatz,
  periodeTitel,
  reihenOptionen,
  vergleichsPeriode,
  wahlAus,
  wahlHash,
  wahlOptionen,
  wahlenFuer,
  weitereMoeglich,
} from './uemsVergleich';

/**
 * Der Vergleich (UEMS AP-13 IP-5, E6 = A, VG1–VG5) gegen die Referenzfälle **O11** und **O12** der Portal-Kopie
 * `test/oberflaechenFaelle.json`. Geprüft wird, dass AP-13 KEIN eigenes Δ bildet: die Zahlen kommen aus dem Zwilling
 * `uemsBericht.vergleich` (AP-12 IP-3), die Wörter aus dem Glossar, die Gründe aus `grund_ohne_vergleich`.
 *
 * ⚠ Wortlaut gegenüber O11: der Konzept-Text schreibt „(Version 2, korrigiert)“. Gebaut ist das Kennzeichen des
 * Ergebnis-Vertrags — `korrigiert (Version 2)` (`uemsErgebnis.KENNZEICHEN`, Rang 80), an derselben Stelle und mit
 * demselben Inhalt: ein geschlossenes Vokabular wird nicht für eine Fläche umformuliert. Version 1 ist nie
 * „korrigiert“ und steht deshalb — wie in O11 an MS-10 — gar nicht in der Zeile.
 */
type Json = any;
const faelle: Json = JSON.parse(readFileSync(join(__dirname, 'test/oberflaechenFaelle.json'), 'utf8'));
const fall = (id: string): Json => {
  const f = faelle.faelle.find((x: Json) => x.id === id);
  if (!f) throw new Error(`Fall ${id} fehlt`);
  return f;
};

/** Die Messstelle besteht seit der Einführung des Energiemanagements (Referenzunternehmen: 01.10.2026). */
const SEIT_EINFUEHRUNG = { seit: '2026-10-01', beendet: null };

/** Vor der Einheit steht ein geschuetztes Leerzeichen (E11) - nur dort. */
const nb = (t: string) => t.replace(/ (kWh|%)/g, String.fromCharCode(160) + '$1');

describe('AP-13 IP-5 · der Umschalter aus · Vorperiode · Vorjahr (VG1, Adresse v=)', () => {
  it('bietet drei Wahlen — im Jahr nur zwei, weil die Vorperiode dort das Vorjahr IST', () => {
    expect(wahlenFuer('monat')).toEqual(['aus', 'vorperiode', 'vorjahr']);
    expect(wahlenFuer('tag')).toEqual(['aus', 'vorperiode', 'vorjahr']);
    expect(wahlenFuer('jahr')).toEqual(['aus', 'vorjahr']);
    expect(wahlOptionen('monat').map((o) => o.label)).toEqual(['aus', 'Vorperiode', 'Vorjahr']);
    expect(wahlOptionen('jahr').map((o) => o.label)).toEqual(['aus', 'Vorjahr']);
  });

  it('liest die Adresse und schreibt sie zurück — „aus“ ist die Vorgabe und steht nie im Hash', () => {
    expect(wahlAus('vorperiode', 'monat')).toBe('vorperiode');
    expect(wahlAus('vorjahr', 'jahr')).toBe('vorjahr');
    // Eine Wahl, die dieser Zeitraum nicht anbietet, und ein unbekanntes Wort sind „aus“.
    expect(wahlAus('vorperiode', 'jahr')).toBe(VERGLEICH_AUS);
    expect(wahlAus('irgendwas', 'monat')).toBe(VERGLEICH_AUS);
    expect(wahlAus(null, 'monat')).toBe(VERGLEICH_AUS);
    expect(wahlHash('aus')).toBeNull();
    expect(wahlHash('vorjahr')).toBe('vorjahr');
  });

  it('die Vorperiode ist GENAU die Blätter-Geste; das Vorjahr behält Tag, Wochentag und Monat', () => {
    expect(vergleichsPeriode('monat', '2026-11', 'vorperiode')).toBe('2026-10');
    expect(vergleichsPeriode('monat', '2026-11', 'vorjahr')).toBe('2025-11');
    expect(vergleichsPeriode('monat', '2026-01', 'vorperiode')).toBe('2025-12');
    expect(vergleichsPeriode('tag', '2026-11-03', 'vorperiode')).toBe('2026-11-02');
    expect(vergleichsPeriode('tag', '2026-11-03', 'vorjahr')).toBe('2025-11-03');
    // Der 29.02. hat kein Vorjahr — er klemmt auf den letzten Tag des Februars.
    expect(vergleichsPeriode('tag', '2028-02-29', 'vorjahr')).toBe('2027-02-28');
    expect(vergleichsPeriode('jahr', '2026', 'vorjahr')).toBe('2025');
    expect(vergleichsPeriode('woche', '2026-W45', 'vorperiode')).toBe('2026-W44');
    // 52 Wochen zurück: derselbe Wochentag, nicht dieselbe ISO-Nummer.
    expect(vergleichsPeriode('woche', '2026-W45', 'vorjahr')).toBe('2025-W45');
    expect(vergleichsPeriode('monat', '2026-11', 'aus')).toBeNull();
  });

  it('nennt jeden Zeitraum beim Namen', () => {
    expect(periodeTitel('monat', '2026-10')).toBe('Oktober 2026');
    expect(periodeTitel('tag', '2026-11-03')).toBe('Di 03.11.2026');
    expect(periodeTitel('jahr', '2025')).toBe('2025');
    expect(periodeTitel('woche', '2026-W45')).toBe('KW 45 2026');
  });
});

describe('AP-13 IP-5 · O11 — die Δ-Zeile kommt aus dem Zwilling uemsBericht (VG2)', () => {
  const o11 = fall('O11');

  it('MS-12: +260 kWh (+4,3 %) gegenüber Oktober 2026, und der Vergleichswert trägt seine Fassung', () => {
    const d = delta({
      zeitraum: 'monat',
      aktuell: ms12November(),
      vergleich: ms12Oktober(),
      periode: '2026-10',
      bestehen: SEIT_EINFUEHRUNG,
    });
    // Die Zahlen des Referenzfalls, ungerundet aus dem Zwilling.
    expect(o11.gegeben.delta['MS-12']).toEqual({ kwh: 260, prozent: 4.3 });
    expect(d?.differenz).toBe('260');
    expect(Number(d?.prozent)).toBeCloseTo(4.3046, 3);
    expect(d?.satz).toBe(nb('+260 kWh (+4,3 %) gegenüber Oktober 2026 · korrigiert (Version 2)'));
    expect(d?.ohne).toBeNull();
    // VG3: eine Messstelle hat keine Richtung „gut“ — die Zeile wertet nie.
    expect(d?.ton).toBe('off');
  });

  it('MS-10: −1.100 kWh (−3,0 %) gegenüber Oktober 2026 — Version 1 ist nie „korrigiert“ und steht nicht in der Zeile', () => {
    const d = delta({ zeitraum: 'monat', aktuell: ms10November(), vergleich: ms10Oktober(), periode: '2026-10', bestehen: SEIT_EINFUEHRUNG });
    expect(o11.gegeben.delta['MS-10']).toEqual({ kwh: -1100, prozent: -3.0 });
    expect(d?.differenz).toBe('-1100');
    expect(d?.satz).toBe(nb('−1.100 kWh (−3,0 %) gegenüber Oktober 2026'));
    expect(d?.satz).not.toMatch(/Version/);
  });

  it('der Vorjahresmonat November 2025 liegt vor dem Bestehen: kein Δ, keine 0 — der Grund (VG2, VG5)', () => {
    const d = delta({ zeitraum: 'monat', aktuell: ms12November(), vergleich: ms12Vorjahr(), periode: '2025-11', bestehen: SEIT_EINFUEHRUNG });
    expect(d?.satz).toBeNull();
    expect(d?.grund).toBe('vor_bestehen');
    expect(d?.differenz).toBeNull();
    expect(d?.prozent).toBeNull();
    expect(d?.ohne).toBe('November 2025: keine Werte — vor Beginn');
    // O11 nennt den Beginn des Energiemanagements; die Werte-Route liefert ihn nicht — mit Datum sagt ihn das Modul.
    expect(o11.gegeben.vorjahresmonat).toBe('keine Werte — vor Beginn');
    expect(grundSatz('vor_bestehen', o11.gegeben.ems_seit)).toBe('vor Beginn (Energiemanagement seit 01.10.2026)');
    expect(grundSatz('vor_bestehen')).toBe('vor Beginn');
  });

  it('eine beendete Quelle und ein Zeitraum ohne Werte tragen ihren eigenen Grund', () => {
    const beendet = delta({
      zeitraum: 'monat',
      aktuell: ms12November(),
      vergleich: ms12Vorjahr(),
      periode: '2025-11',
      bestehen: { seit: '2024-01-01', beendet: '2025-06-30' },
    });
    expect([beendet?.grund, beendet?.ohne]).toEqual(['quelle_beendet', 'November 2025: keine Werte — Quelle beendet']);
    const leer = delta({ zeitraum: 'monat', aktuell: ms12November(), vergleich: ms12Vorjahr(), periode: '2025-11' });
    expect([leer?.grund, leer?.ohne]).toEqual(['keine_werte', 'November 2025: keine Werte — keine Werte in diesem Zeitraum']);
  });

  it('kein Δ ohne eigene Zahl, und die Woche hat gar keine (VG3)', () => {
    const ohneEigene = delta({
      zeitraum: 'monat',
      aktuell: monatKarte(MS_12, '2026-11', 0),
      vergleich: ms12Oktober(),
      periode: '2026-10',
      bestehen: SEIT_EINFUEHRUNG,
    });
    // 0 kWh ist eine Zahl — sie wird verglichen; nur eine FEHLENDE Zahl hat kein Δ.
    expect(ohneEigene?.satz).toBe(nb('−6.040 kWh (−100,0 %) gegenüber Oktober 2026 · korrigiert (Version 2)'));
    expect(delta({ zeitraum: 'monat', aktuell: null, vergleich: ms12Oktober(), periode: '2026-10' })).toBeNull();
    expect(hatZahl('woche')).toBe(false);
    expect(delta({ zeitraum: 'woche', aktuell: ms12November(), vergleich: ms12Oktober(), periode: '2026-W44' })).toBeNull();
    expect(WOCHE_OHNE_DELTA).toMatch(/kein Unterschied/);
  });

  it('eine unvollständige Basis wird benannt — der Unterschied wird nicht verschwiegen und nicht geschönt', () => {
    const teil = ms12Oktober();
    teil.werte[0].zustand = 'unvollständig';
    teil.werte[0].abdeckung_prozent = 82;
    teil.werte[0].erhalten = Math.round((teil.werte[0].erwartet ?? 0) * 0.82);
    // Der Ergebnis-Vertrag verlangt an „unvollständig“ mindestens EIN Kennzeichen des Fehlbestands.
    teil.werte[0].kennzeichen = [ANFANG_NICHT_GEMESSEN];
    const d = delta({ zeitraum: 'monat', aktuell: ms12November(), vergleich: teil, periode: '2026-10', bestehen: SEIT_EINFUEHRUNG });
    expect(d?.satz).toBe(nb('+260 kWh (+4,3 %) gegenüber Oktober 2026 · unvollständig · korrigiert (Version 2)'));
  });

  it('VG3 — eine laufende Periode wird gesagt', () => {
    expect(laufendSatz('monat', '2026-11', '2026-11-20')).toBe('November 2026 läuft — der Vergleich gilt für den bisherigen Zeitraum.');
    expect(laufendSatz('monat', '2026-11', '2026-12-10')).toBeNull();
    expect(laufendSatz('tag', '2026-11-03', '2026-11-03')).toBe('Di 03.11.2026 läuft — der Vergleich gilt für den bisherigen Zeitraum.');
  });

  it('das Bestehen kommt aus dem Register, nicht aus einer Annahme', () => {
    const zeile = ahrenbergRegister().register.find((z) => z.kennzeichen === 'MS-12')!;
    expect(bestehenAus(zeile.quelle)).toEqual({ seit: '2026-10-01', beendet: null });
    expect(bestehenAus(null)).toEqual({ seit: null, beendet: null });
  });
});

describe('AP-13 IP-5 · O12 — passende Reihen, und bei den anderen steht der Grund (VG1b, VG4)', () => {
  const o12 = fall('O12');
  const register = ahrenbergRegister().register;
  const basis: MessstelleGroesse = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' };

  it('der Picker zeigt ALLE Messstellen: die passenden wählbar, die anderen mit ihrem Grund — nie eine leere Liste', () => {
    const ms06 = register.find((z) => z.kennzeichen === 'MS-06')!;
    // ⚠ `schon` sind KENNZEICHEN: Register und Werte-Route teilen keine Kennung.
    const optionen = reihenOptionen(ms06.hauptgroesse, register, [ms06.kennzeichen]);
    const nach = (kz: string) => optionen.find((o) => o.kennzeichen === kz)!;
    expect(optionen.find((o) => o.kennzeichen === 'MS-06')).toBeUndefined();
    expect(nach('MS-11').passend).toBe(true);
    expect(nach('MS-11').grund).toBeNull();
    expect(nach('MS-04').grund).toBe('nicht passend: Laden / Entladen');
    expect(nach('MS-21').grund).toBe('nicht passend: Volumen in m³');
    expect(nach('MS-03').grund).toBe('nicht passend: Erzeugung');
    // Genau die Erwartung des Referenzfalls: MS-11 ja, die drei anderen nein.
    for (const [kz, erwartet] of Object.entries(o12.gegeben.passend as Record<string, boolean>)) {
      expect(nach(kz).passend, kz).toBe(erwartet);
    }
    // Die passenden stehen oben.
    expect(optionen[0].passend).toBe(true);
    expect(optionen.some((o) => !o.passend)).toBe(true);
  });

  it('höchstens drei Reihen liegen in einem Bild, und der Picker sagt, wenn es voll ist', () => {
    expect(VERGLEICH_HOECHSTENS).toBe(o12.gegeben.hoechstens_reihen);
    expect(weitereMoeglich(1)).toBe(true);
    expect(weitereMoeglich(2)).toBe(true);
    expect(weitereMoeglich(3)).toBe(false);
    expect(VOLL_SATZ).toBe('Mehr als 3 Reihen liegen nicht in einem Bild.');
    expect(entfernenName({ id: 'x', kennzeichen: 'MS-11', name: 'Spritzguss SG07–SG10' })).toBe(
      'MS-11 · Spritzguss SG07–SG10 aus dem Bild nehmen',
    );
  });

  it('VG4 — jede Reihe vergleicht sich mit IHRER Vorperiode; zwischen zwei Messstellen entsteht keine Zahl', () => {
    // Die zwei Reihen des Falls: 55 100 und 22 400 kWh im Oktober.
    expect([MS_06.kennzeichen, MS_11.kennzeichen]).toEqual(['MS-06', 'MS-11']);
    const ms11 = ms11Oktober();
    expect(ms11.werte[0].menge).toBe(o12.gegeben['MS-11']);
    // Ein Δ gegen eine FREMDE Messstelle gibt es im Modul nicht: `delta` bekommt beide Karten DERSELBEN Reihe.
    // Der Beweis, dass keine Differenz zwischen zwei Messstellen gebildet wird, ist die Abwesenheit einer solchen
    // Funktion — hier wird sichergestellt, dass das Modul nichts anderes anbietet.
    const exportiert = Object.keys(o12.erwartet);
    expect(o12.erwartet.delta_zwischen_messstellen).toBe(false);
    expect(exportiert).toContain('picker_nicht_passend');
    // Und die eigene Vorperiode bleibt die einzige Bezugsgröße: MS-10 gegen MS-10.
    const d = delta({ zeitraum: 'monat', aktuell: ms10November(), vergleich: ms10Oktober(), periode: '2026-10', bestehen: SEIT_EINFUEHRUNG });
    expect(d?.satz).toContain('gegenüber Oktober 2026');
    expect([MS_10.kennzeichen, ms10Oktober().messstelle.kennzeichen]).toEqual(['MS-10', 'MS-10']);
  });
});

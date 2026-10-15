import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SteuerungTag, SteuerungZeitraum } from './api';
import { spanne, steuerungKachel, steuerungKarte, tagKurz } from './steuerungZeitraum';

/**
 * **Die Steuerung mit Bestand in Worten** (Bedienkonzept
 * `vp-herzogau-p3-kachel-konzept` §3 und §6, Captain 14.10.2026: HZ-3 A,
 * P3-1 bis P3-4 je A).
 *
 * Die Zahlen rechnet der Server (`SteuerungMitBestand.java`); dieser Test
 * liest denselben Vertrag wie die Java-Tests
 * (`docs/contracts/steuerung-tag-vectors.json`, Block `mit_bestand`), baut
 * daraus die Antwort `steuerungZeitraum`, wie die Anlagen-Route sie schickt,
 * und prüft, was Kachel und Karte daraus machen: am 13.10. um 08:15 + 0,01 €
 * statt − 8,00 €, am 14.10. die 7 Tage ehrlich bei − 0,29 € neben dem Monat
 * + 23,53 €.
 */
interface VertragTag {
  tag: string;
  steuerung_eur: number;
  vorsprung_start_kwh: number | null;
  vorsprung_ende_kwh: number | null;
  bezug_ct_kwh: number;
  erwartet: { bewertung_ct_kwh: number; bestand_eur: number | null; mit_bestand_eur: number | null; gruende: string[] };
}
interface VertragFenster {
  von: string;
  bis: string;
  mit_bestand_eur: number | null;
}
interface VertragZeitpunkt {
  name: string;
  angefragt: string;
  laeuft: boolean;
  heute?: Omit<VertragTag, 'erwartet'>;
  erwartet: {
    heute: { tag: string; mit_bestand_eur: number | null; gruende: string[] } | null;
    monat: VertragFenster;
    sieben: VertragFenster;
    tage: string[];
  };
}
interface VertragFall {
  tage: VertragTag[];
  zeitpunkte: VertragZeitpunkt[];
  minus_tage?: { kalendertag: number; mit_bestand: number };
}

const MIT_BESTAND = (
  JSON.parse(
    readFileSync(resolve(process.cwd(), '../../docs/contracts/steuerung-tag-vectors.json'), 'utf8'),
  ) as { mit_bestand: Record<'oktober' | 'monatsgrenze' | 'sommerzeit' | 'luecke', VertragFall> }
).mit_bestand;

const nb = (s: string | null | undefined) => (s ?? '').replace(/\u00a0/g, ' ');
const r2 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-9)) / 100;

/** Ein Tag, wie die Anlagen-Route ihn schickt: Kasse auf den Cent, Rest aus dem Vertrag. */
function tagApi(t: VertragTag, messungBis: string | null = null): SteuerungTag {
  return {
    tag: t.tag,
    steuerungEur: r2(t.steuerung_eur),
    vorsprungStartKwh: t.vorsprung_start_kwh,
    vorsprungEndeKwh: t.vorsprung_ende_kwh,
    bezugCtKwh: t.bezug_ct_kwh,
    bewertungCtKwh: t.erwartet.bewertung_ct_kwh,
    bestandEur: t.erwartet.bestand_eur,
    mitBestandEur: t.erwartet.mit_bestand_eur,
    gruende: t.erwartet.gruende,
    messungBis,
  };
}

/** Die Antwort `steuerungZeitraum` zu einem Zeitpunkt eines Vertragsfalls. */
function antwort(fall: VertragFall, angefragt: string, laeuft: boolean, messungBis: string | null = null): SteuerungZeitraum {
  const z = fall.zeitpunkte.find((x) => x.angefragt === angefragt && x.laeuft === laeuft);
  if (!z) throw new Error(`kein Zeitpunkt ${angefragt}`);
  const tage = new Map(fall.tage.map((t) => [t.tag, t]));
  const heute =
    z.heute && z.erwartet.heute
      ? tagApi(
          {
            ...z.heute,
            erwartet: {
              bewertung_ct_kwh: 23.98,
              bestand_eur: r2(((z.heute.vorsprung_ende_kwh as number) - (z.heute.vorsprung_start_kwh as number)) * 0.2398),
              mit_bestand_eur: z.erwartet.heute.mit_bestand_eur,
              gruende: z.erwartet.heute.gruende,
            },
          },
          messungBis,
        )
      : tage.has(angefragt)
        ? tagApi(tage.get(angefragt)!, messungBis)
        : null;
  const fenster = (f: VertragFenster) => ({ von: f.von, bis: f.bis, mitBestandEur: f.mit_bestand_eur });
  return {
    bezugCtKwh: 25,
    bewertungCtKwh: 23.98,
    monat: fenster(z.erwartet.monat),
    sieben: fenster(z.erwartet.sieben),
    heute,
    tage: z.erwartet.tage.map((d) => tagApi(tage.get(d)!)),
  };
}

const OKT = MIT_BESTAND.oktober;

describe('Steuerung mit Bestand · Oktober Herzogau (Konzept §6)', () => {
  it('13.10., 08:15: + 0,01 € statt − 8,00 €; vorn der Monat + 25,86 €, darunter 6.–12. Oktober + 9,45 €', () => {
    const z = antwort(OKT, '2026-10-13', true, '2026-10-13T06:15:00Z');
    const k = steuerungKachel(z, true);
    expect(nb(k.wert)).toBe('+ 25,86 €');
    expect(k.ton).toBe('neutral');
    expect(k.unter).toBe('diesen Monat · mehr als ohne smarte Steuerung');
    expect(k.zweit).toEqual({ label: 'letzte 7 Tage', wert: expect.any(String) });
    expect(nb(k.zweit!.wert)).toBe('+ 9,45 €');

    const karte = steuerungKarte(z, true);
    expect(karte.chip).toBe('Zwischenstand');
    expect(karte.tag.label).toBe('Heute bis 08:15');
    expect(nb(karte.tag.wert)).toBe('+ 0,01 €');
    expect(karte.tag.grund).toBe('gestern verkauft, heute nachgekauft');
    expect(karte.anker.map((a) => [nb(a.label), nb(a.wert)])).toEqual([
      ['Letzte 7 Tage · 6.–12. Oktober', '+ 9,45 €'],
      ['Oktober bisher', '+ 25,86 €'],
    ]);
    expect(karte.liste!.zeilen[0]).toEqual({ label: 'Mo 12.10.', wert: expect.any(String), grund: null });
    expect(nb(karte.liste!.zeilen[0].wert)).toBe('+ 1,70 €');
    expect([nb(karte.liste!.summe.label), nb(karte.liste!.summe.wert)]).toEqual(['Summe 6.–12. Oktober', '+ 9,45 €']);
    // Die alte Kalendertag-Zahl steht nur noch im Rechenweg, als Schritt 1.
    const sichtbar = [karte.tag, ...karte.anker, ...karte.liste!.zeilen].map((z2) => nb(z2.wert));
    expect(sichtbar).not.toContain('− 8,00 €');
    expect(nb(karte.rechenweg[0].formel)).toBe('Schritt 1 · Kassenrechnung heute bis 08:15 = − 8,00 €');
    expect(nb(karte.rechenweg[1].formel)).toBe('Schritt 2 · Rückstand 33,4 kWh um 00:00, 0,0 kWh um 08:15 = 33,4 kWh aufgeholt');
    expect(nb(karte.rechenweg[2].formel)).toBe('Schritt 3 · 33,4 kWh × 23,98 ct = + 8,01 €');
    expect(nb(karte.rechenweg[3].formel)).toBe('Schritt 4 · Heute mit Bestand: − 8,00 € + 8,01 € = + 0,01 €');
  });

  it('14.10., vor dem ersten Eimer: die 7 Tage 7.–13.10. ehrlich bei − 0,29 € in Tinte, neben + 23,53 €', () => {
    const z = antwort(OKT, '2026-10-14', true);
    const k = steuerungKachel(z, true);
    expect(nb(k.wert)).toBe('+ 23,53 €');
    expect(nb(k.zweit!.wert)).toBe('− 0,29 €');
    expect(k.zweit!.label).toBe('letzte 7 Tage');
    const karte = steuerungKarte(z, true);
    expect(karte.tag.label).toBe('Heute');
    expect(karte.tag.wert).toBe('—');
    expect(karte.tag.grund).toBe('noch keine Viertelstunde ausgewertet');
    expect(nb(karte.anker[0].label)).toBe('Letzte 7 Tage · 7.–13. Oktober');
    expect(karte.liste!.zeilen.map((x) => x.label)).toEqual([
      'Di 13.10.',
      'Mo 12.10.',
      'So 11.10.',
      'Sa 10.10.',
      'Fr 09.10.',
      'Do 08.10.',
      'Mi 07.10.',
    ]);
    expect(karte.rechenweg).toEqual([]);
  });

  it('Rückblick 13.10.: − 2,32 € unter Null, Daten statt „letzte 7 Tage“, Rechenweg − 4,48 € + 2,16 €', () => {
    const z = antwort(OKT, '2026-10-13', false);
    const k = steuerungKachel(z, false);
    expect(nb(k.wert)).toBe('+ 23,53 €');
    expect(k.ton).toBe('ok');
    expect(nb(k.unter)).toBe('1.–13. Oktober · mehr als ohne smarte Steuerung');
    expect(nb(k.zweit!.label)).toBe('7.–13. Oktober');
    expect(nb(k.zweit!.wert)).toBe('− 0,29 €');

    const karte = steuerungKarte(z, false);
    expect(karte.chip).toBe('unter Null');
    expect(karte.tag.label).toBe('Steuerung an diesem Tag');
    expect(nb(karte.tag.wert)).toBe('− 2,32 €');
    expect(karte.tag.grund).toBe('gestern verkauft, heute nachgekauft · anders geladen und entladen');
    expect(karte.anker.map((a) => [nb(a.label), nb(a.wert)])).toEqual([
      ['7.–13. Oktober', '− 0,29 €'],
      ['1.–13. Oktober', '+ 23,53 €'],
    ]);
    expect(karte.rechenweg.map((r) => nb(r.formel))).toEqual([
      'Schritt 1 · Kassenrechnung des Tages = − 4,48 €',
      'Schritt 2 · Rückstand 33,4 kWh um 00:00, Rückstand 24,4 kWh um 24:00 = 9,0 kWh aufgeholt',
      'Schritt 3 · 9,0 kWh × 23,98 ct = + 2,16 €',
      'Schritt 4 · An diesem Tag mit Bestand: − 4,48 € + 2,16 € = − 2,32 €',
    ]);
    expect(nb(karte.rechenweg[2].herkunft)).toMatch(/^Bezugspreis 25,0 ct × 95,9 %/);
  });

  it('Rückblick 12.10.: der Verkaufstag mit + 1,70 € statt + 12,10 €, ohne Grund und ohne Chip', () => {
    const z = antwort(OKT, '2026-10-12', false);
    const karte = steuerungKarte(z, false);
    expect(nb(karte.tag.wert)).toBe('+ 1,70 €');
    expect(karte.tag.grund).toBeNull();
    expect(karte.chip).toBeNull();
    expect(nb(karte.anker[0].label)).toBe('6.–12. Oktober');
    expect(nb(karte.anker[0].wert)).toBe('+ 9,45 €');
    expect(nb(karte.anker[1].wert)).toBe('+ 25,85 €');
    expect(nb(karte.rechenweg[1].formel)).toContain('43,4 kWh zurückgefallen');
  });

  it('Grund-Wörter wie in der Tabelle des Konzepts; 4 statt 6 Minus-Tage', () => {
    const worte = Object.fromEntries(
      antwort(OKT, '2026-10-14', true).tage.map((t) => [t.tag, steuerungKarte(
        { ...antwort(OKT, '2026-10-14', true), heute: t },
        false,
      ).tag.grund]),
    );
    expect(worte).toEqual({
      '2026-10-07': 'gestern verkauft, heute nachgekauft',
      '2026-10-08': 'gestern verkauft, heute nachgekauft · anders geladen und entladen',
      '2026-10-09': null,
      '2026-10-10': 'anders geladen und entladen',
      '2026-10-11': 'anders geladen und entladen',
      '2026-10-12': null,
      '2026-10-13': 'gestern verkauft, heute nachgekauft · anders geladen und entladen',
    });
    const minusKasse = OKT.tage.filter((t) => t.steuerung_eur < 0).length;
    const minusBestand = OKT.tage.filter((t) => (t.erwartet.mit_bestand_eur as number) < 0).length;
    expect([minusKasse, minusBestand]).toEqual([6, 4]);
    expect(OKT.minus_tage).toEqual({ kalendertag: 6, mit_bestand: 4 });
  });
});

describe('Steuerung mit Bestand · Eigenschaften über alle Vertragsfälle', () => {
  const faelle = (['oktober', 'monatsgrenze', 'sommerzeit', 'luecke'] as const).map(
    (n) => [n, MIT_BESTAND[n]] as [string, VertragFall],
  );

  it('die Zeilen „Tag für Tag“ ergeben auf den Cent die 7 Tage, die Tage des Monats den Monat', () => {
    let geprueft = 0;
    for (const [name, fall] of faelle) {
      for (const zp of fall.zeitpunkte) {
        const z = antwort(fall, zp.angefragt, zp.laeuft);
        if (z.sieben?.mitBestandEur != null) {
          const summe = r2(z.tage.reduce((s, t) => s + (t.mitBestandEur as number), 0));
          expect(summe, `${name} ${zp.name}`).toBe(z.sieben.mitBestandEur);
          geprueft++;
        }
        if (z.monat.mitBestandEur != null) {
          // Der Tag des Zeitpunkts ersetzt den vollen Tag (08:15 statt 24:00).
          const jeTag = new Map(fall.tage.map((t) => [t.tag, t.erwartet.mit_bestand_eur]));
          if (z.heute) jeTag.set(z.heute.tag, z.heute.mitBestandEur);
          const imMonat = [...jeTag.entries()]
            .filter(([tag]) => tag >= z.monat.von && tag <= z.monat.bis)
            .map(([, eur]) => ({ mitBestandEur: eur }));
          const summe = r2(imMonat.reduce((s, t) => s + (t.mitBestandEur as number), 0));
          expect(summe, `${name} ${zp.name} Monat`).toBe(z.monat.mitBestandEur);
          geprueft++;
        }
      }
    }
    expect(geprueft).toBeGreaterThanOrEqual(12);
  });

  it('je Tag: Kasse + Bestand = Zahl mit Bestand, sichtbar im Rechenweg', () => {
    for (const [name, fall] of faelle) {
      for (const t of fall.tage) {
        const e = t.erwartet;
        if (e.mit_bestand_eur == null) continue;
        expect(r2(r2(t.steuerung_eur) + (e.bestand_eur as number)), `${name} ${t.tag}`).toBe(e.mit_bestand_eur);
      }
    }
  });

  it('nie „Woche“ für die 7 Tage — laufend „letzte 7 Tage“, zurückgeblättert das Datum', () => {
    for (const [, fall] of faelle) {
      for (const zp of fall.zeitpunkte) {
        const z = antwort(fall, zp.angefragt, zp.laeuft);
        const k = steuerungKachel(z, zp.laeuft);
        const karte = steuerungKarte(z, zp.laeuft);
        const text = [k.unter, k.zweit?.label, ...karte.anker.map((a) => a.label), karte.liste?.summe.label]
          .filter(Boolean)
          .join(' ');
        expect(text).not.toMatch(/Woche/);
        expect(k.zweit?.label).toBe(zp.laeuft ? 'letzte 7 Tage' : spanne(zp.erwartet.sieben.von, zp.erwartet.sieben.bis));
      }
    }
  });

  it('über die Monatsgrenze: „26. September – 2. Oktober“, der 01.10. beginnt nach dem Anker', () => {
    const z = antwort(MIT_BESTAND.monatsgrenze, '2026-10-03', true);
    const karte = steuerungKarte(z, true);
    expect(nb(karte.anker[0].label)).toBe('Letzte 7 Tage · 26. September – 2. Oktober');
    expect(karte.liste!.zeilen.map((x) => x.label)).toEqual(['Fr 02.10.', 'Do 01.10.', 'Mi 30.09.', 'Di 29.09.']);
    const erster = z.tage.find((t) => t.tag === '2026-10-01')!;
    expect(erster.vorsprungStartKwh).toBe(0);
  });

  it('Lücke: „—“ statt einer Zahl, der Grund im Klartext, Monat und 7 Tage leer', () => {
    const z = antwort(MIT_BESTAND.luecke, '2026-10-08', false);
    const k = steuerungKachel(z, false);
    expect(k.wert).toBe('—');
    expect(k.ton).toBe('leer');
    expect(k.unter).toMatch(/Ladestand fehlt/);
    expect(k.zweit!.wert).toBe('—');
    const karte = steuerungKarte(
      { ...z, heute: z.tage.find((t) => t.tag === '2026-10-06')! },
      false,
    );
    expect(karte.tag.wert).toBe('—');
    expect(karte.tag.grund).toMatch(/Ladestand fehlt/);
    expect(nb(karte.rechenweg[1].formel)).toBe('Schritt 2 · Ladestand um 24:00 fehlt');
    expect(karte.rechenweg).toHaveLength(2);
  });

  it('Sommerzeit: der 25.10. steht einmal in der Liste — Kalendertage, nie 7 × 24 h', () => {
    const z = antwort(MIT_BESTAND.sommerzeit, '2026-10-31', false);
    expect(steuerungKarte(z, false).liste!.zeilen.map((x) => x.label)).toEqual(['Mo 26.10.', 'So 25.10.']);
  });
});

describe('Steuerung mit Bestand · Datumswörter', () => {
  it('benennt Tage und Spannen aus dem ISO-Datum, ohne Uhr', () => {
    expect(tagKurz('2026-10-12')).toBe('Mo 12.10.');
    expect(tagKurz('2026-10-25')).toBe('So 25.10.');
    expect(tagKurz('2027-03-28')).toBe('So 28.03.');
    expect(nb(spanne('2026-10-07', '2026-10-13'))).toBe('7.–13. Oktober');
    expect(nb(spanne('2026-12-28', '2027-01-03'))).toBe('28. Dezember – 3. Januar');
    expect(nb(spanne('2026-10-01', '2026-10-01'))).toBe('1. Oktober');
  });
});

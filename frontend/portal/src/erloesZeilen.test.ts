import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from './api';
import { eurAmount } from './format';
import FIXTURES from './erloeseFixtures.json';
import {
  balkenGeometrie,
  ergebnisZeilen,
  heroSatz,
  rundeKaufmaennisch,
  vorzeichenEuro,
  type ErgebnisZeilenInput,
} from './erloesZeilen';

/**
 * Ebene 0 der neuen Ergebnis-Karte — die REINE Ableitung.
 *
 * Die 15 Fixtures des Konzepts `vp-erloese-seite-konzept-e2` sind die
 * Testvektoren: `src/erloeseFixtures.json` ist die eingefrorene Kopie seiner
 * `derived.json`, also rechnet der Test mit genau den Zahlen, aus denen die
 * abgenommenen Mockups entstanden sind.
 */

interface Fixture {
  id: string;
  titel: string;
  range: 'day' | 'week' | 'month' | 'year';
  label: string;
  laeuft: boolean;
  money: SiteEarnings;
  checks: Record<string, boolean>;
}

const FX = FIXTURES.fixtures as unknown as Fixture[];

/**
 * Die Wortzählung des Konzepts (§3.12): ein Wort muss einen Buchstaben oder
 * eine Ziffer tragen — Zahlen zählen mit, Trennzeichen wie „·" nicht.
 */
function woerter(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-zÄÖÜäöüß0-9]/.test(w)).length;
}

function view(f: Fixture) {
  const input: ErgebnisZeilenInput = {
    money: f.money,
    periodLabel: f.label,
    laeuft: f.laeuft,
    range: f.range,
  };
  return ergebnisZeilen(input);
}

describe('erloesZeilen · Rundung', () => {
  it('rundet kaufmännisch — halb WEG von der Null', () => {
    // Math.round(-1.585 * 100) / 100 ergäbe -1,58 und widerspräche dem Text.
    expect(rundeKaufmaennisch(-1.585, 2)).toBe(-1.59);
    expect(rundeKaufmaennisch(1.585, 2)).toBe(1.59);
    expect(rundeKaufmaennisch(63.233, 2)).toBe(63.23);
    expect(rundeKaufmaennisch(-0.005, 2)).toBe(-0.01);
  });

  it('E4 = a: jede Zeile ist die Rundung ihres EIGENEN Werts, die Lücke wird benannt', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const v = view(f);
    // Die Zeilen: 26,13 + 38,68 − 1,59 = 63,22 — der Hero ist 63,23.
    expect(v.zeilen.map((z) => z.eur)).toEqual([26.13, 38.68, -1.59, 63.23]);
    expect(v.hero?.eur).toBe(63.23);
    expect(v.rundungsluecke).toBe(0.01);
    // Der Cent-Ausgleich (E4 = b) hätte −1,58 geschrieben; er ist NICHT gewählt.
    expect(v.zeilen[2].text).toBe(vorzeichenEuro(-1.59));
  });
});

describe('erloesZeilen · Vorzeichen aus dem WERT (Befund B1)', () => {
  it('ein negativer Einspeise-Erlös rendert als „−", nicht als „+"', () => {
    const f = FX.find((x) => x.id === 'dv-praemie-ruht')!;
    expect(f.money.einspeiseErloesEur).toBeLessThan(0);
    const einspeisung = view(f).zeilen[0];
    expect(einspeisung.ton).toBe('minus');
    expect(einspeisung.text.startsWith('−')).toBe(true);
  });

  it('der Wasserfall zieht die negative Einspeisung nach LINKS', () => {
    const f = FX.find((x) => x.id === 'dv-praemie-ruht')!;
    const v = view(f);
    const seg = v.zeilen[0].segment!;
    expect(seg.von).toBe(0);
    expect(seg.bis).toBeLessThan(0);
    expect(v.skala.lo).toBeLessThan(0);
  });

  it('eine Gutschrift beim Netzbezug (negative Kosten) rendert als „+"', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const money: SiteEarnings = { ...f.money, stromkostenEur: -0.42 };
    const z = ergebnisZeilen({ money, periodLabel: f.label, laeuft: false, range: 'day' })
      .zeilen[2];
    expect(z.eur).toBe(0.42);
    expect(z.ton).toBe('plus');
  });

  it('die Rolle der Zeile entscheidet NICHTS — nur der Wert', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const money: SiteEarnings = { ...f.money, einspeiseErloesEur: -3.2 };
    const z = ergebnisZeilen({ money, periodLabel: f.label, laeuft: false, range: 'day' })
      .zeilen[0];
    expect(z.text).toBe(vorzeichenEuro(-3.2));
  });
});

describe('erloesZeilen · alle 15 Fixtures', () => {
  it.each(FX.map((f) => [f.id, f] as const))('%s — vier Zeilen in fester Reihenfolge', (_id, f) => {
    const v = view(f);
    expect(v.zeilen.map((z) => z.id)).toEqual([
      'einspeisung',
      'eigenverbrauch',
      'stromkosten',
      'ergebnis',
    ]);
  });

  it.each(FX.map((f) => [f.id, f] as const))(
    '%s — der Wasserfall geht auf: letztes Segment = Hero',
    (_id, f) => {
      const v = view(f);
      const erg = v.zeilen[3].segment!;
      expect(erg.von).toBe(0);
      // Die Zwischensumme nach der dritten Zeile IST das Netto (exakt gerechnet).
      const letzteZwischensumme = [...v.zeilen.slice(0, 3)]
        .reverse()
        .find((z) => z.segment)!.segment!.bis;
      expect(letzteZwischensumme).toBeCloseTo(erg.bis, 6);
      expect(erg.bis).toBeCloseTo(v.exakt.netto!, 6);
    },
  );

  it.each(FX.map((f) => [f.id, f] as const))('%s — die Null liegt in der Skala', (_id, f) => {
    const v = view(f);
    expect(v.skala.lo).toBeLessThanOrEqual(0);
    expect(v.skala.hi).toBeGreaterThanOrEqual(0);
    expect(v.skala.hi).toBeGreaterThan(v.skala.lo);
  });

  it.each(FX.map((f) => [f.id, f] as const))(
    '%s — der Kurzsatz hat höchstens acht Wörter (§3.12)',
    (_id, f) => {
      expect(woerter(view(f).satz)).toBeLessThanOrEqual(8);
    },
  );

  it.each(FX.map((f) => [f.id, f] as const))(
    '%s — jeder Zeilenname hat 1–3 Wörter, jedes Sekundär-Teil höchstens 4 (§3.12)',
    (_id, f) => {
      for (const z of view(f).zeilen) {
        expect(woerter(z.name)).toBeGreaterThanOrEqual(1);
        expect(woerter(z.name)).toBeLessThanOrEqual(3);
        // Die Sekundärzeile hat den Wert-Chip abgelöst (§2 Prinzip 5). Sie ist
        // Text, darf also länger sein als eine Kapsel — aber kein Nebensatz:
        // je Teil höchstens vier Wörter („Vergütung nicht hinterlegt",
        // „kein Stromtarif hinterlegt").
        for (const teil of z.sekundaer?.teile ?? []) {
          expect(woerter(teil)).toBeLessThanOrEqual(4);
        }
        if (z.sekundaer?.link) expect(woerter(z.sekundaer.link.text)).toBeLessThanOrEqual(4);
      }
    },
  );

  it('„bisher" steht NUR im laufenden Zeitraum (Befund B4)', () => {
    for (const f of FX) {
      const satz = view(f).satz;
      if (!f.laeuft) expect(satz).not.toMatch(/bisher/i);
    }
    // …und im laufenden Zeitraum steht es wirklich.
    const laufend = FX.filter((f) => f.laeuft);
    expect(laufend.length).toBeGreaterThan(0);
    for (const f of laufend) expect(view(f).satz).toMatch(/bisher|Bisher/);
  });
});

describe('erloesZeilen · Sekundärzeilen nennen den WEG, wo etwas fehlt (B6)', () => {
  it('ohne Stromtarif: „Stromtarif hinterlegen ›" statt einer erfundenen Zahl', () => {
    const f = FX.find((x) => x.id === 'eeg-ohne-tarif')!;
    const v = view(f);
    expect(v.zeilen[1].eur).toBeNull();
    expect(v.zeilen[1].text).toBe('—');
    expect(v.zeilen[1].sekundaer).toEqual(
      expect.objectContaining({
        teile: ['kein Stromtarif hinterlegt'],
        link: { text: 'Stromtarif hinterlegen ›', ziel: 'tarif' },
        ton: 'warn',
      }),
    );
    // Kein Segment über einer fehlenden Zahl.
    expect(v.zeilen[1].segment).toBeNull();
  });

  it('ohne MaStR-Verknüpfung: „Anlage verknüpfen ›"', () => {
    const f = FX.find((x) => x.id === 'eeg-ohne-mastr')!;
    expect(view(f).zeilen[0].sekundaer).toEqual(
      expect.objectContaining({
        teile: ['Börsenpreis', 'Vergütung nicht hinterlegt'],
        link: { text: 'Anlage verknüpfen ›', ziel: 'mastr' },
        ton: 'warn',
      }),
    );
  });

  it('Negativpreis-Tag: die Prämie, die WIRKLICH angefallen ist — nicht „ruht"', () => {
    // Der Erlös ist negativ, die Prämie der Viertelstunden mit Börsenpreis >= 0
    // ist trotzdem angefallen. Die Sekundärzeile nennt sie; DASS sie in den
    // negativen Stunden ruht, sagt Ebene 2 (§3.4) — nicht die Zeile.
    const f = FX.find((x) => x.id === 'dv-praemie-ruht')!;
    expect(f.money.einspeiseErloesEur).toBeLessThan(0);
    expect(view(f).zeilen[0].sekundaer?.teile).toContain(`Prämie ${eurAmount(0.61)}`);
  });

  it('ohne jede Marktprämie sagt die Sekundärzeile „Prämie ruht" — im NORMALEN Ton', () => {
    const f = FX.find((x) => x.id === 'dv-praemie-ruht')!;
    const money: SiteEarnings = { ...f.money, marktpraemieEur: 0 };
    const sek = ergebnisZeilen({ money, periodLabel: f.label, laeuft: false, range: 'day' })
      .zeilen[0].sekundaer;
    // ⚠ Ton NORMAL, nicht `warn`: eine ruhende Prämie ist eine Tatsache, kein
    //   Mangel — es gibt nichts zu hinterlegen, also auch keinen Weg (§3.4).
    expect(sek).toEqual(expect.objectContaining({ ton: 'normal', link: null }));
    expect(sek?.teile).toContain('Prämie ruht');
  });

  it('Standard-Satz statt „Ihr Stromtarif", wo keiner hinterlegt ist', () => {
    const f = FX.find((x) => x.id === 'eeg-ohne-tarif')!;
    expect(view(f).zeilen[2].sekundaer?.teile).toContain('Standard-Satz');
  });
});

describe('erloesZeilen · Geometrie (der SVG-Beweis ohne Browser)', () => {
  it.each(FX.map((f) => [f.id, f] as const))(
    '%s — jeder Balken liegt im Koordinatenraum und die Null steht überall gleich',
    (_id, f) => {
      const v = view(f);
      const geo = balkenGeometrie(v);
      const nullX = geo[0].nullX;
      for (const g of geo) {
        expect(g.nullX).toBe(nullX);
        expect(g.nullX).toBeGreaterThanOrEqual(0);
        expect(g.nullX).toBeLessThanOrEqual(1000);
        if (!g.balken) continue;
        expect(g.balken.x).toBeGreaterThanOrEqual(0);
        expect(g.balken.breite).toBeGreaterThan(0);
        expect(g.balken.x + g.balken.breite).toBeLessThanOrEqual(1000.01);
      }
    },
  );

  it('die Geometrie des Screenshot-Falls ist festgenagelt', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    expect(balkenGeometrie(view(f))).toMatchInlineSnapshot(`
      [
        {
          "balken": {
            "breite": 403.19,
            "x": 0,
          },
          "id": "einspeisung",
          "nullX": 0,
        },
        {
          "balken": {
            "breite": 596.81,
            "x": 403.19,
          },
          "id": "eigenverbrauch",
          "nullX": 0,
        },
        {
          "balken": {
            "breite": 24.45,
            "x": 975.55,
          },
          "id": "stromkosten",
          "nullX": 0,
        },
        {
          "balken": {
            "breite": 975.55,
            "x": 0,
          },
          "id": "ergebnis",
          "nullX": 0,
        },
      ]
    `);
  });
});

describe('erloesZeilen · Leer-Zustand', () => {
  it('ohne Antwort behauptet die Karte nichts', () => {
    const v = ergebnisZeilen({ money: null, periodLabel: 'Juli 2026', laeuft: false, range: 'month' });
    expect(v.hero).toBeNull();
    expect(v.satz).toBe('Für Juli 2026 lässt sich noch kein Ergebnis berechnen.');
    expect(v.zeilen.every((z) => z.eur === null && z.segment === null && z.sekundaer === null)).toBe(
      true,
    );
  });

  it('heroSatz kennt den laufenden und den abgeschlossenen Zeitraum', () => {
    expect(heroSatz(63.23, 'Mi., 02.09.2026', true, 'day')).toBe('Heute bisher unterm Strich.');
    expect(heroSatz(63.23, 'Di., 01.09.2026', false, 'day')).toBe('Di., 01.09.2026 unterm Strich.');
    expect(heroSatz(-2.1, 'Mi., 02.09.2026', true, 'day')).toBe(
      'Bisher mehr Stromkosten als Ertrag.',
    );
    expect(heroSatz(41.2, 'August 2026', false, 'month')).toBe('August 2026 unterm Strich.');
  });
});

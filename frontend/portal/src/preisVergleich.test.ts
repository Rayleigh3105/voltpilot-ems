import { describe, expect, it } from 'vitest';

import type { SiteEarnings } from './api';
import { abrechnung } from './erloeseSeite';
import FIXTURES from './erloeseFixtures.json';
import { NBSP } from './format';
import { MERKSATZ, NULL_CT_TITEL, preisVergleich } from './preisVergleich';

/**
 * „Preise im Zeitraum" gegen die eingefrorenen Konzept-Fixtures
 * (`src/erloeseFixtures.json`) — dieselben Zahlen, aus denen die Mockups des
 * Konzepts „Erlöse · Preise und Verdienst" entstanden sind.
 */
interface Fixture {
  id: string;
  money: SiteEarnings;
}
const FX = (FIXTURES as unknown as { fixtures: Fixture[] }).fixtures;
const fx = (id: string): SiteEarnings => {
  const f = FX.find((x) => x.id === id);
  if (!f) throw new Error(`Fixture ${id} fehlt`);
  return f.money;
};

const n = (s: string) => s.replace(new RegExp(NBSP, 'g'), ' ');
const zeile = (v: ReturnType<typeof preisVergleich>, id: string) => {
  const z = v.liste.zeilen.find((x) => x.id === id);
  if (!z) throw new Error(`Zeile ${id} fehlt`);
  return z;
};

describe('preisVergleich · drei Balken in der Reihenfolge der Abrechnung', () => {
  it('Eigenverbrauch · Einspeisung · Netzbezug — mit ihren Rollenfarben', () => {
    const v = preisVergleich({ money: fx('dv-monat'), netzladenErlaubt: false });
    expect(v.liste.zeilen.map((z) => z.id)).toEqual(['eigenverbrauch', 'einspeisung', 'netzbezug']);
    expect(v.liste.zeilen.map((z) => z.rolle)).toEqual(['eigenverbrauch', 'einspeisung', 'netzbezug']);
    expect(v.liste.zeilen.map((z) => n(z.wert))).toEqual(['25,0 ct', '9,3 ct', '25,0 ct']);
  });

  it('nennt DIESELBEN Ø-Preise wie die Abrechnung — eine Wahrheit, zwei Bilder', () => {
    for (const id of ['dv-monat', 'dv-tag-laufend', 'eeg-tag-abgeschlossen']) {
      const m = fx(id);
      const v = preisVergleich({ money: m });
      const posten = abrechnung(m).posten;
      for (const [zid, pid] of [
        ['eigenverbrauch', 'eigenverbrauch'],
        ['einspeisung', 'einspeisung'],
        ['netzbezug', 'netzbezug'],
      ] as const) {
        const ct = n(zeile(v, zid).wert).replace(' ct', '');
        const p = posten.find((x) => x.id === pid)!;
        expect(n(p.unter ?? ''), `${id} · ${zid}`).toContain(`Ø ${ct} ct/kWh`);
      }
    }
  });

  it('jeder Balken beginnt bei 0 und endet auf seinem Wert — auf EINER Skala', () => {
    const v = preisVergleich({ money: fx('dv-monat') });
    expect(v.liste.skala.min).toBe(0);
    expect(v.liste.skala.max).toBeCloseTo(25, 6);
    const einsp = zeile(v, 'einspeisung').segmente[0];
    expect(einsp.von).toBe(0);
    expect(einsp.bis).toBeCloseTo((891.32 / 9573.8) * 100, 3);
  });
});

describe('preisVergleich · die Antwort über den Balken', () => {
  it('sagt, dass selbst genutzter Strom mehr wert war — wenn es stimmt', () => {
    expect(preisVergleich({ money: fx('dv-monat') }).merksatz).toBe(MERKSATZ);
  });

  it('schweigt, wenn ein Wert fehlt — statt etwas zu behaupten', () => {
    expect(preisVergleich({ money: fx('eeg-ohne-tarif') }).merksatz).toBeNull();
  });

  it('schweigt auch, wenn die Einspeisung mehr wert war', () => {
    const m = { ...fx('dv-monat'), einspeiseErloesEur: 5000 } as SiteEarnings;
    expect(preisVergleich({ money: m }).merksatz).toBeNull();
  });
});

describe('preisVergleich · die Grundlage steht als Unterzeile', () => {
  it('Direktvermarktung: Börse + Marktprämie, der E12-Satz wortgleich im ⓘ', () => {
    const v = preisVergleich({ money: fx('dv-monat') });
    const e = zeile(v, 'einspeisung');
    expect(e.unter!.text).toBe('verdient: Börse + Marktprämie');
    expect(e.info!.titel).toBe(NULL_CT_TITEL);
    expect(n(e.info!.text)).toBe(
      'Prämie gilt noch (1,91 ct) — erst unter 0,0 ct ruht sie. Deshalb kann Einspeisen richtig sein, obwohl der Speicher Platz hat.',
    );
    expect(n(zeile(v, 'netzbezug').unter!.text)).toBe('bezahlt: fester Tarif 25 ct/kWh');
    expect(zeile(v, 'eigenverbrauch').unter!.text).toBe('gespart: vermiedener Netzbezug');
  });

  it('Direktvermarktung ohne Prämie: kein ⓘ, und die Zeile sagt, dass sie ruht', () => {
    const m = {
      ...fx('dv-monat'),
      marktpraemieEur: 0,
      marketValueSolarCtKwh: 8.4,
    } as SiteEarnings;
    const e = zeile(preisVergleich({ money: m }), 'einspeisung');
    expect(e.unter!.text).toBe('verdient: Börse · Marktprämie ruht');
    expect(e.info).toBeNull();
  });

  it('feste Vergütung (EEG) — ohne Direktvermarktungs-Größen', () => {
    const v = preisVergleich({ money: fx('eeg-tag-abgeschlossen') });
    expect(zeile(v, 'einspeisung').unter!.text).toBe(
      'verdient: feste Vergütung (EEG), 20 Jahre ab Inbetriebnahme',
    );
    expect(zeile(v, 'einspeisung').info).toBeNull();
    expect(n(zeile(v, 'netzbezug').unter!.text)).toBe('bezahlt: fester Tarif 32 ct/kWh');
  });

  it('dynamischer Tarif: Börsenpreis plus Aufschlag', () => {
    const m = { ...fx('dv-monat'), tarifArt: 'dynamisch', tarifParamCtKwh: 18 } as SiteEarnings;
    expect(n(zeile(preisVergleich({ money: m }), 'netzbezug').unter!.text)).toBe(
      'bezahlt: Börsenpreis + 18,0 ct Aufschlag',
    );
  });

  it('nicht verknüpft: Börsenpreis — und der Weg zur Verknüpfung', () => {
    const m = { ...fx('eeg-tag-abgeschlossen'), exportVerguetungPriced: false } as SiteEarnings;
    const unter = zeile(preisVergleich({ money: m }), 'einspeisung').unter!;
    expect(unter.text).toBe('verdient: Börsenpreis · nicht verknüpft');
    expect(unter.link).toEqual({ text: 'Anlage verknüpfen ›', ziel: 'mastr' });
  });
});

describe('preisVergleich · fehlend ist keine Null', () => {
  it('ohne Stromtarif: „—", leere Spur, Grund und Weg — nie ein Null-Balken', () => {
    const v = preisVergleich({ money: fx('eeg-ohne-tarif') });
    const ev = zeile(v, 'eigenverbrauch');
    expect(ev.vorhanden).toBe(false);
    expect(ev.wert).toBe('—');
    expect(ev.segmente).toEqual([]);
    expect(ev.unter).toEqual({
      text: 'kein Stromtarif hinterlegt',
      link: { text: 'Stromtarif hinterlegen ›', ziel: 'tarif' },
    });
    const nb = zeile(v, 'netzbezug').unter!;
    expect(nb.text).toBe('bezahlt: Börsenpreis + übliche Netzentgelte, Abgaben, Umsatzsteuer');
    expect(nb.link).toEqual({ text: 'Tarif hinterlegen ›', ziel: 'tarif' });
  });

  it('nichts eingespeist ist eine gemessene Null der MENGE — kein Preis', () => {
    const m = { ...fx('eeg-tag-abgeschlossen'), einspeiseErloesEur: 0, eingespeistKwh: 0 } as SiteEarnings;
    const e = zeile(preisVergleich({ money: m }), 'einspeisung');
    expect(e.vorhanden).toBe(false);
    expect(e.unter!.text).toBe('nichts eingespeist');
  });

  it('unbekannte Menge heißt nicht „nichts"', () => {
    const m = { ...fx('eeg-tag-abgeschlossen'), stromkostenEur: 1.2, bezogenKwh: null } as SiteEarnings;
    expect(zeile(preisVergleich({ money: m }), 'netzbezug').unter!.text).toBe('ohne Menge kein Durchschnittspreis');
  });

  it('ein negativer Einspeisepreis trägt Vorzeichen und Minus-Ton', () => {
    const v = preisVergleich({ money: fx('dv-praemie-ruht') });
    const e = zeile(v, 'einspeisung');
    expect(n(e.wert)).toBe('− 0,2 ct');
    expect(e.minus).toBe(true);
    expect(v.liste.skala.min).toBeLessThan(0);
  });
});

describe('preisVergleich · Fußzeile und Begriffe', () => {
  it('nennt den Speicher und die Bewertung in EINER ruhigen Zeile', () => {
    expect(preisVergleich({ money: fx('dv-monat'), netzladenErlaubt: false }).fuss).toBe(
      'Speicher lädt nur Sonnenstrom · Bewertung: heutige Tarif- und Vergütungsangaben — nicht Ihre Abrechnung',
    );
  });

  it('nennt den Netzlade-Erlös nur, wenn er etwas bewegt hat', () => {
    const m = { ...fx('dv-monat'), arbitrageEur: 12.4 } as SiteEarnings;
    expect(n(preisVergleich({ money: m, netzladenErlaubt: true }).fuss)).toContain(
      'Speicher darf aus dem Netz laden · davon durch Netzladen + 12,40 €',
    );
  });

  it('lässt den Speicher weg, wenn die Anlage es nicht sagt', () => {
    expect(preisVergleich({ money: fx('dv-monat') }).fuss).toBe(
      'Bewertung: heutige Tarif- und Vergütungsangaben — nicht Ihre Abrechnung',
    );
  });

  it('trägt dieselben Begriffe wie Ebene 2', () => {
    const begriffe = preisVergleich({ money: fx('dv-monat') }).glossar.map((g) => g.begriff);
    expect(begriffe).toContain('Marktprämie');
    expect(begriffe).toContain('Monatsmarktwert Solar');
    expect(begriffe).toContain('Wert des Eigenverbrauchs');
  });
});

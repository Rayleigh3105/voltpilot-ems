import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from './api';
import FIXTURES from './erloeseFixtures.json';
import { ergebnisZeilen, type ErgebnisZeilenView } from './erloesZeilen';
import {
  durchschnittCt,
  ebene1,
  ebene2,
  nullCtSatz,
  speicherSchritte,
  type RechenZeile,
} from './erloesEbenen';

/**
 * Ebene 1 + Ebene 2 — die REINE Ableitung.
 *
 * Der tragende Test ist „jede Rechenzeile geht auf": jede Zeile, die wirklich
 * RECHNET, trägt ihre `probe` (Formel-Ergebnis gegen Server-Summe), und der
 * Test fährt sie über alle 15 Fixtures des Konzepts. Das ist die Eigenschaft,
 * die §3.3 Regel 2 verlangt — der Kunde soll nachrechnen können, nicht glauben.
 */

interface Fixture {
  id: string;
  range: 'day' | 'week' | 'month' | 'year';
  label: string;
  laeuft: boolean;
  savedSpeicherEur: number | null;
  geplantEur: number | null;
  money: SiteEarnings;
  checks: Record<string, boolean>;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];

function viewOf(f: Fixture): ErgebnisZeilenView {
  return ergebnisZeilen({ money: f.money, periodLabel: f.label, laeuft: f.laeuft, range: f.range });
}

/** Alle Rechenzeilen einer Fixture — Ebene 1 aller vier Zeilen + die Schritte. */
function alleZeilen(f: Fixture): RechenZeile[] {
  const view = viewOf(f);
  const out: RechenZeile[] = [];
  for (const id of ['einspeisung', 'eigenverbrauch', 'stromkosten', 'ergebnis'] as const) {
    out.push(...(ebene1(f.money, view, id)?.zeilen ?? []));
  }
  const steuerung =
    f.savedSpeicherEur == null || f.money.savedEur == null
      ? null
      : f.money.savedEur - f.savedSpeicherEur;
  out.push(
    ...speicherSchritte({
      money: f.money,
      sturEur: f.savedSpeicherEur,
      steuerungEur: steuerung,
      geplantEur: f.geplantEur,
    }),
  );
  return out;
}

describe('erloesEbenen · jede Rechenzeile geht auf (§3.3 Regel 2)', () => {
  it.each(FX.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    const zeilen = alleZeilen(f);
    const gerechnet = zeilen.filter((z) => z.probe);
    // Nicht vakuum: jede Fixture rechnet wirklich etwas.
    expect(gerechnet.length).toBeGreaterThanOrEqual(3);
    for (const z of gerechnet) {
      const { ist, soll } = z.probe!;
      expect(Math.abs(ist - soll), `${z.formel} — ${z.herkunft}`).toBeLessThanOrEqual(0.011);
    }
  });

  it('die Identitäten des Konzepts sind in den Fixtures selbst grün', () => {
    // Der Generator des Konzepts hat sie scharf geprüft; sie reisen als Beleg
    // mit, damit ein späterer Fixture-Austausch nicht unbemerkt eine kaputte
    // Zahlenwelt einschleppt.
    for (const f of FX) {
      for (const [name, ok] of Object.entries(f.checks)) {
        expect(ok, `${f.id} · ${name}`).toBe(true);
      }
    }
  });
});

describe('erloesEbenen · Ø-Preise nur als Quotient zweier Server-Summen (§3.3 Regel 1)', () => {
  it('ohne Menge steht KEIN Durchschnittspreis', () => {
    expect(durchschnittCt(10, null)).toBeNull();
    expect(durchschnittCt(null, 100)).toBeNull();
    expect(durchschnittCt(10, 0)).toBeNull();
    expect(durchschnittCt(10, 0.01)).toBeNull();
    expect(durchschnittCt(21.34, 345.4)).toBeCloseTo(6.178, 3);
  });

  it('eine Zeile ohne Menge nennt nur die Summe, nie einen erfundenen Preis', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const money: SiteEarnings = { ...f.money, bezogenKwh: null };
    const z = ebene1(money, viewOf(f), 'stromkosten')!.zeilen[0];
    expect(z.formel).not.toMatch(/ct/);
    expect(z.formel).toMatch(/^= /);
  });
});

describe('erloesEbenen · Ebene 1 der Einspeisung', () => {
  it('Direktvermarktung: Börse + Marktprämie + Summe', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const e1 = ebene1(f.money, viewOf(f), 'einspeisung')!;
    expect(e1.zeilen).toHaveLength(3);
    expect(e1.zeilen[0].herkunft).toBe('Börsenpreis Ihrer Einspeise-Zeiten (Ø)');
    expect(e1.zeilen[1].formel.startsWith('+ ')).toBe(true);
    expect(e1.zeilen[1].herkunft).toMatch(/Marktprämie: 8,11 − 5,80/);
    expect(e1.zeilen[1].herkunft).toMatch(/vorläufig/);
    expect(e1.zeilen[2].formel.startsWith('= ')).toBe(true);
  });

  it('EEG mit Verknüpfung: EINE Zeile mit der festen Vergütung', () => {
    const f = FX.find((x) => x.id === 'eeg-tag-abgeschlossen')!;
    const e1 = ebene1(f.money, viewOf(f), 'einspeisung')!;
    expect(e1.zeilen).toHaveLength(1);
    expect(e1.zeilen[0].herkunft).toBe('Ihre feste Einspeisevergütung (EEG)');
  });

  it('EEG ohne Verknüpfung nennt den WEG statt einer Vergütung', () => {
    const f = FX.find((x) => x.id === 'eeg-ohne-mastr')!;
    const e1 = ebene1(f.money, viewOf(f), 'einspeisung')!;
    expect(e1.zeilen[0].herkunft).toMatch(/Anlage verknüpfen ›$/);
  });
});

describe('erloesEbenen · Ebene 1 des Eigenverbrauchs und der Kosten', () => {
  it('ohne Stromtarif rechnet die Zeile NICHTS und nennt den Weg', () => {
    const f = FX.find((x) => x.id === 'eeg-ohne-tarif')!;
    const e1 = ebene1(f.money, viewOf(f), 'eigenverbrauch')!;
    expect(e1.zeilen[0].formel).toMatch(/× — = —$/);
    expect(e1.zeilen[0].herkunft).toMatch(/Stromtarif hinterlegen ›$/);
    expect(e1.zeilen[0].probe).toBeUndefined();
  });

  it('der Standard-Satz wird beim Namen genannt (B6)', () => {
    const f = FX.find((x) => x.id === 'eeg-ohne-tarif')!;
    const e1 = ebene1(f.money, viewOf(f), 'stromkosten')!;
    expect(e1.zeilen[0].herkunft).toMatch(/übliche Netzentgelte, Abgaben, Umsatzsteuer/);
  });
});

describe('erloesEbenen · Ebene 1 des Ergebnisses (E4 = a)', () => {
  it('zeigt die exakte Addition, WEIL die gerundeten Zeilen nicht aufgehen', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const view = viewOf(f);
    expect(view.rundungsluecke).toBe(0.01);
    const e1 = ebene1(f.money, view, 'ergebnis')!;
    expect(e1.zeilen).toHaveLength(2);
    expect(e1.zeilen[0].formel).toMatch(/^26,13 \+ 38,68 − 1,59 = /);
    expect(e1.zeilen[1].formel).toMatch(/^exakt: 26,134 \+ 38,684 − 1,585 = 63,233 → /);
  });

  it('ohne Lücke steht die Rundungs-Zeile NICHT — sie erklärte einen Widerspruch, den niemand sieht', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const money: SiteEarnings = {
      ...f.money,
      einspeiseErloesEur: 26.13,
      eigenverbrauchsWertEur: 38.68,
      stromkostenEur: 1.59,
      nettoErgebnisEur: 63.22,
    };
    const view = ergebnisZeilen({ money, periodLabel: f.label, laeuft: false, range: 'day' });
    expect(view.rundungsluecke).toBe(0);
    expect(ebene1(money, view, 'ergebnis')!.zeilen).toHaveLength(1);
  });

  it.each(FX.map((f) => [f.id, f] as const))(
    '%s — die Rundungs-Zeile steht genau dann, wenn eine Lücke existiert',
    (_id, f) => {
      const view = viewOf(f);
      const zeilen = ebene1(f.money, view, 'ergebnis')?.zeilen ?? [];
      expect(zeilen.length).toBe(Math.abs(view.rundungsluecke) >= 0.005 ? 2 : 1);
    },
  );
});

describe('erloesEbenen · Ebene 2', () => {
  it('Direktvermarktung: Bezug, Einspeisung, Monatsmarktwert, anzulegender Wert, Prämie, E12', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const e2 = ebene2({ money: f.money, netzladenErlaubt: false });
    const labels = e2.zeilen.map((z) => z.label);
    expect(labels).toEqual([
      'Bezugspreis',
      'Einspeisepreis',
      'Monatsmarktwert Solar',
      'Anzulegender Wert',
      'Marktprämie',
      'Bei 0,0 ct Börsenpreis',
      'Speicher',
      'Bewertung',
    ]);
    expect(e2.zeilen).toHaveLength(8); // §3.4: höchstens acht Zeilen
    expect(e2.zeilen[2].wert).toMatch(/vorläufig/);
    expect(e2.zeilen[6].wert).toBe('lädt nur Sonnenstrom');
  });

  it('der E12-Satz steht wortgleich zum Konzept', () => {
    expect(nullCtSatz(2.31)).toContain('Prämie gilt noch');
    expect(nullCtSatz(2.31)).toContain('erst unter 0,0');
    expect(nullCtSatz(2.31)).toContain(
      'Deshalb kann Einspeisen richtig sein, obwohl der Speicher Platz hat.',
    );
  });

  it('am Negativpreis-Tag sagt die Prämien-Zeile, dass sie ruht', () => {
    const f = FX.find((x) => x.id === 'dv-praemie-ruht')!;
    const zeile = ebene2({ money: f.money }).zeilen.find((z) => z.label === 'Marktprämie')!;
    expect(zeile.wert).toMatch(/ruht bei Börsenpreis unter 0$/);
  });

  it('EEG: keine Marktprämien-Zeilen, dafür die feste Vergütung', () => {
    const f = FX.find((x) => x.id === 'eeg-tag-abgeschlossen')!;
    const labels = ebene2({ money: f.money }).zeilen.map((z) => z.label);
    expect(labels).not.toContain('Marktprämie');
    expect(labels).not.toContain('Bei 0,0 ct Börsenpreis');
    const einsp = ebene2({ money: f.money }).zeilen.find((z) => z.label === 'Einspeisepreis')!;
    expect(einsp.wert).toMatch(/feste Vergütung \(EEG\), 20 Jahre ab Inbetriebnahme$/);
  });

  it.each(FX.map((f) => [f.id, f] as const))('%s — höchstens acht Zeilen (§3.4)', (_id, f) => {
    expect(ebene2({ money: f.money }).zeilen.length).toBeLessThanOrEqual(8);
  });

  it.each(FX.map((f) => [f.id, f] as const))(
    '%s — das Glossar erklärt nur, was vorkommt, und nichts doppelt',
    (_id, f) => {
      const g = ebene2({ money: f.money }).glossar;
      expect(new Set(g.map((x) => x.begriff)).size).toBe(g.length);
      const istDv = f.money.plantKind === 'direktvermarktung';
      expect(g.some((x) => x.begriff === 'Marktprämie')).toBe(istDv);
    },
  );
});

describe('erloesEbenen · Speicher-Schritte', () => {
  it('der Screenshot-Fall rechnet Schritt 1 bis 5 mit eingesetzten Zahlen', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const stur = f.savedSpeicherEur!;
    const schritte = speicherSchritte({
      money: f.money,
      sturEur: stur,
      steuerungEur: f.money.savedEur! - stur,
      geplantEur: f.geplantEur,
    });
    const formeln = schritte.map((s) => s.formel);
    expect(formeln[0]).toMatch(/^Schritt 1 · gemessen: .* Gutschrift$/);
    expect(formeln[1]).toMatch(/^Schritt 2 · gerechnet: .* Gutschrift$/);
    expect(formeln[2]).toMatch(/^Schritt 3 · Speicher gesamt: 24,55 − 27,22 = − /);
    expect(formeln[3]).toMatch(/^Schritt 4 · sturer Speicher: − /);
    expect(formeln[4]).toMatch(/^Schritt 5 · Steuerung: − 2,67 \+ 4,12 = \+ /);
    expect(formeln.some((x) => x.startsWith('Planwert:'))).toBe(true);
    expect(formeln.some((x) => x.startsWith('Fahrplan:'))).toBe(true);
  });

  it('der Bestandskonto-Hinweis steht GENAU EINMAL (§3.12)', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const schritte = speicherSchritte({ money: f.money, sturEur: f.savedSpeicherEur });
    const treffer = schritte.filter((s) => /zählt erst beim späteren Netzbezug/.test(s.herkunft));
    expect(treffer).toHaveLength(1);
    expect(treffer[0].formel).toMatch(/^Schritt 3/);
  });

  it('ohne Batterie-Stammdaten sagt Schritt 4 den WEG statt einer Zahl', () => {
    const f = FX.find((x) => x.id === 'dv-kein-split')!;
    const schritte = speicherSchritte({ money: f.money, splitReason: 'no_battery_data' });
    expect(schritte[3].formel).toBe('Schritt 4 · Steuerung: —');
    expect(schritte[3].herkunft).toMatch(/Speicher-Daten nachtragen ›$/);
  });

  it('ein älteres Backend ohne die Split-Felder schweigt — es behauptet keine fehlenden Stammdaten', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const schritte = speicherSchritte({ money: f.money });
    expect(schritte.map((s) => s.formel).some((x) => x.startsWith('Schritt 4'))).toBe(false);
    expect(schritte.map((s) => s.herkunft).join(' ')).not.toMatch(/nachtragen/);
  });

  it('ohne die Kassen-Zahlen gibt es GAR KEINE Schritte', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    expect(speicherSchritte({ money: { ...f.money, actualEur: null } })).toEqual([]);
  });

  it('eine ENTNAHME aus dem Speicher rechnet mit dem Betrag, nicht mit dem Vorzeichen', () => {
    const f = FX.find((x) => x.id === 'dv-tag-laufend')!;
    const money: SiteEarnings = {
      ...f.money,
      speicherDeltaKwh: -12,
      speicherWertCtKwh: 20,
      speicherWertEur: -2.4,
    };
    const planwert = speicherSchritte({ money }).find((s) => s.formel.startsWith('Planwert:'))!;
    // NBSP zwischen Zahl und Einheit (format.ts) — die Regex bleibt tolerant.
    expect(planwert.formel.replace(/\u00a0/g, ' ')).toMatch(/12,0 kWh × 20,00 ct = 2,40/);
    expect(Math.abs(planwert.probe!.ist - planwert.probe!.soll)).toBeLessThanOrEqual(0.011);
  });
});

/* ---------------------------------------------------------------------------
 * P6 · was die Preis-Karte hinterlassen hat (Konzept §3.1, E5/E11)
 *
 * Die Karte „Was den Preis gemacht hat" ist entfallen; ihre Zeilen wohnen hier.
 * Diese Tests fahren die 15 Konzept-Fixtures und nageln die zwei Regeln fest,
 * die dabei nicht verloren gehen durften.
 * ------------------------------------------------------------------------ */

describe('E5/E11 · die Preise über alle Fixtures', () => {
  const labels = (f: Fixture) =>
    ebene2({ money: f.money, netzladenErlaubt: null }).zeilen.map((z) => z.label);

  it('nennt die MARKT-Größen ausschließlich bei Direktvermarktung (Befund B9)', () => {
    for (const f of FX) {
      const l = labels(f);
      const marktzeilen = ['Monatsmarktwert Solar', 'Anzulegender Wert', 'Marktprämie'].filter((x) =>
        l.includes(x),
      );
      if (f.money.plantKind === 'direktvermarktung') {
        // Sie stehen dort, WO der Endpunkt sie liefert — ohne anzulegenden Wert
        // wird keine Prämie behauptet.
        expect(l).toContain('Einspeisepreis');
      } else {
        expect({ id: f.id, marktzeilen }).toEqual({ id: f.id, marktzeilen: [] });
      }
    }
  });

  it('gibt JEDER Fixture ihren Bezugspreis und ihre Bewertungs-Zeile', () => {
    for (const f of FX) {
      const l = labels(f);
      expect({ id: f.id, hat: l.includes('Bezugspreis') }).toEqual({ id: f.id, hat: true });
      expect({ id: f.id, hat: l.includes('Bewertung') }).toEqual({ id: f.id, hat: true });
    }
  });

  it('bleibt im Textbudget von acht Zeilen (§3.4)', () => {
    for (const f of FX) {
      const n = ebene2({ money: f.money, netzladenErlaubt: true }).zeilen.length;
      expect({ id: f.id, ok: n <= 8 }).toEqual({ id: f.id, ok: true });
    }
  });

  it('trägt die Netzladen-Zahl der früheren Preis-Karte, wo es eine gibt', () => {
    const f = FX.find((x) => x.id === 'dv-monat')!;
    const mit = ebene2({
      money: { ...f.money, arbitrageEur: 12.4 },
      netzladenErlaubt: true,
    }).zeilen.find((z) => z.label === 'Speicher');
    expect(mit?.wert).toContain('davon durch Netzladen');
    expect(mit?.wert).toContain('12,40');
    // Ohne Zurechnung wird kein Handel behauptet — auch nicht als „+ 0,00 €".
    const ohne = ebene2({
      money: { ...f.money, arbitrageEur: null },
      netzladenErlaubt: true,
    }).zeilen.find((z) => z.label === 'Speicher');
    expect(ohne?.wert).toBe('darf aus dem Netz laden');
  });
});

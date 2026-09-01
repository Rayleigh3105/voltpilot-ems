import { describe, expect, it } from 'vitest';

import {
  FORMEL_AUSLOESER,
  steuerungFormel,
  type SteuerungFormelInput,
} from './erloesKomposition';
import { NBSP } from './format';

/**
 * „Wie wird das berechnet?" — die Kunden-Erklärung am Steuerungs-Chip.
 *
 * Die tragende Regel ist die EHRLICHKEIT der Preis-Zeilen: was nicht hinterlegt
 * ist, wird nicht erfunden (kein Tarif ⇒ „Börsenpreis"), und eine Marktprämie
 * von 0 bekommt ihren GRUND nur, wenn beide ct-Größen wirklich vorliegen.
 */

function bezug(input: SteuerungFormelInput) {
  return steuerungFormel(input).preise.find((p) => p.label === 'Bezugspreis')!;
}
function einspeise(input: SteuerungFormelInput) {
  return steuerungFormel(input).preise.find((p) => p.label === 'Einspeisepreis')!;
}

describe('steuerungFormel — Gerüst', () => {
  it('trägt Auslöser, Kernsatz, drei Rechenzeilen und zwei Preise', () => {
    const f = steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30 });
    expect(f.ausloeser).toBe(FORMEL_AUSLOESER);
    expect(f.ausloeser).toBe('Wie wird das berechnet?');
    expect(f.zeilen.map((z) => z.label)).toEqual([
      'Ohne Steuerung',
      'Mit Steuerung',
      'Beitrag der Steuerung',
    ]);
    expect(f.preise.map((p) => p.label)).toEqual(['Bezugspreis', 'Einspeisepreis']);
  });

  it('nennt in der Rechnung beide Seiten und die Differenz', () => {
    const f = steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30 });
    const [ohne, mit, diff] = f.zeilen;
    expect(ohne.text).toContain('Speicher aus');
    expect(ohne.text).toContain('sofort eingespeist');
    expect(mit.text).toContain('Zähler');
    expect(diff.text).toContain('Kosten ohne Steuerung − Kosten mit Steuerung');
    expect(diff.text).toContain('über alle Viertelstunden des Zeitraums summiert');
  });

  it('B4 · „Ohne Steuerung" beschreibt die WIRKLICHE Baseline: Solarstrom wird direkt verbraucht', () => {
    const ohne = steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30 }).zeilen[0];
    expect(ohne.text).toContain('Solarstrom wird direkt verbraucht');
    expect(ohne.text).toContain('nach Abzug des direkt verbrauchten Solarstroms');
    expect(ohne.text).toContain('Solarüberschuss × Einspeisepreis');
    // NICHT die falsche „ohne Solarstrom gebraucht hätte"-Baseline (load × p − pv × s).
    expect(ohne.text).not.toContain('ohne Solarstrom');
  });

  it('benutzt keine internen Begriffe', () => {
    const f = steuerungFormel({ tarifArt: 'dynamisch', tarifParamCtKwh: 18 });
    const alles = [
      f.kern,
      f.hinweis,
      f.historik ?? '',
      ...f.zeilen.map((z) => `${z.label} ${z.text}`),
      ...f.preise.map((p) => `${p.label} ${p.text} ${p.zusatz ?? ''}`),
    ].join(' ');
    for (const wort of ['Baseline', 'Slot', 'Rollup', 'savedEur', 'Delta', 'MILP']) {
      expect(alles).not.toContain(wort);
    }
  });
});

describe('steuerungFormel — der Bezugspreis wird nie erfunden', () => {
  it('fester Tarif: nennt die hinterlegte Zahl', () => {
    expect(bezug({ tarifArt: 'fest', tarifParamCtKwh: 30 }).text).toBe(
      `Ihr fester Stromtarif: 30,0${NBSP}ct/kWh.`,
    );
  });

  it('fester Tarif ohne Zahl: nennt den Tarif, aber keinen Preis', () => {
    const t = bezug({ tarifArt: 'fest', tarifParamCtKwh: null }).text;
    expect(t).toBe('Ihr fester Stromtarif.');
    expect(t).not.toContain('ct/kWh');
  });

  it('dynamischer Tarif mit Aufschlag: Börsenpreis + Aufschlag', () => {
    expect(bezug({ tarifArt: 'dynamisch', tarifParamCtKwh: 18 }).text).toBe(
      `Ihr dynamischer Stromtarif: Börsenpreis der jeweiligen Viertelstunde + 18,0${NBSP}ct/kWh Aufschlag.`,
    );
  });

  it('dynamischer Tarif ohne Aufschlag: nur der Börsenpreis, kein erfundener Zuschlag', () => {
    const t = bezug({ tarifArt: 'dynamisch', tarifParamCtKwh: 0 }).text;
    expect(t).toContain('Börsenpreis der jeweiligen Viertelstunde');
    expect(t).not.toContain('Aufschlag');
  });

  it('ohne Tarif: sagt Börsenpreis UND warum', () => {
    const t = bezug({ tarifArt: 'ohne' }).text;
    expect(t).toContain('Börsenpreis');
    expect(t).toContain('kein Stromtarif hinterlegt');
  });

  it('B3 · ohne Tarif + Flag an (tarifPriced): Börsenpreis + Standard-Komponenten, kein Selbstwiderspruch', () => {
    const t = bezug({ tarifArt: 'ohne', tarifPriced: true }).text;
    expect(t).toContain('Börsenpreis');
    expect(t).toContain('Standard-Netzentgelte und Abgaben');
    expect(t).toContain('kein Stromtarif hinterlegt');
  });

  it('B3 · ohne Tarif + Flag aus (tarifPriced=false): reiner Börsenpreis, ohne Standard-Komponenten', () => {
    const t = bezug({ tarifArt: 'ohne', tarifPriced: false }).text;
    expect(t).toContain('kein Stromtarif hinterlegt');
    expect(t).not.toContain('Standard-Netzentgelte');
  });

  it('gar keine Tarif-Angabe verhält sich wie „ohne" — nie ein geratener Tarif', () => {
    expect(bezug({}).text).toBe(bezug({ tarifArt: 'ohne' }).text);
  });

  it('der Ø-Bezugspreis des Zeitraums belegt die Zeile — fehlt er, steht dort nichts', () => {
    expect(bezug({ tarifArt: 'fest', tarifParamCtKwh: 30, bezugspreisCtKwh: 32.5 }).zusatz).toBe(
      `Im Zeitraum im Schnitt 32,5${NBSP}ct/kWh.`,
    );
    expect(bezug({ tarifArt: 'fest', tarifParamCtKwh: 30 }).zusatz).toBeNull();
  });
});

describe('steuerungFormel — der Kernsatz folgt der Bewertung', () => {
  it('mit Tarif: „Ihrem Stromtarif"', () => {
    expect(steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30 }).kern).toContain(
      'Ihrem Stromtarif für den Netzbezug',
    );
  });

  it('ohne Tarif: „dem Börsenpreis" — nie ein Tarif, den es nicht gibt', () => {
    const kern = steuerungFormel({ tarifArt: 'ohne' }).kern;
    expect(kern).toContain('dem Börsenpreis für den Netzbezug');
    expect(kern).not.toContain('Ihrem Stromtarif');
  });

  it('tarifPriced=false: der Tarif ist hinterlegt, aber die Zahl ist Börsenpreis-bewertet', () => {
    const kern = steuerungFormel({
      tarifArt: 'fest',
      tarifParamCtKwh: 30,
      tarifPriced: false,
    }).kern;
    expect(kern).toContain('dem Börsenpreis für den Netzbezug');
  });

  it('B3 · ohne Tarif, aber tarifPriced=true (Produktions-Default an): NICHT nacktes „Börsenpreis"', () => {
    const kern = steuerungFormel({ tarifArt: 'ohne', tarifPriced: true }).kern;
    expect(kern).toContain('dem Börsenpreis plus Standard-Netzentgelte und Abgaben für den Netzbezug');
    expect(kern).not.toContain('Ihrem Stromtarif');
  });

  it('B3 · ohne Tarif, tarifPriced=false (Flag aus): weiterhin ehrlich nacktes „Börsenpreis"', () => {
    const kern = steuerungFormel({ tarifArt: 'ohne', tarifPriced: false }).kern;
    expect(kern).toContain('dem Börsenpreis für den Netzbezug');
    expect(kern).not.toContain('Standard-Netzentgelte');
  });
});

describe('steuerungFormel — die Marktprämie', () => {
  const dv: SteuerungFormelInput = { tarifArt: 'dynamisch', tarifParamCtKwh: 18, plantKind: 'direktvermarktung' };

  it('Eigenverbrauch: gar keine Marktprämie-Zeile', () => {
    expect(einspeise({ tarifArt: 'fest', plantKind: 'eigenverbrauch', marktpraemieEur: 12 }).zusatz).toBeNull();
  });

  it('Direktvermarktung mit Prämie: nennt den Betrag', () => {
    expect(einspeise({ ...dv, marktpraemieEur: 12.4 }).zusatz).toBe(
      `Dazu kommt die Marktprämie: 12,40${NBSP}€ in diesem Zeitraum.`,
    );
  });

  it('Prämie 0 MIT beiden ct-Größen: sagt den Grund („voll aus dem Markt")', () => {
    const z = einspeise({
      ...dv,
      marktpraemieEur: 0,
      anzulegenderWertCtKwh: 6.9,
      marketValueSolarCtKwh: 7.0,
    }).zusatz;
    expect(z).toContain('Derzeit keine Marktprämie');
    expect(z).toContain('Monatsmarktwert');
    expect(z).toContain(`7,0${NBSP}ct/kWh`);
    expect(z).toContain(`6,9${NBSP}ct/kWh`);
    expect(z).toContain('voll aus dem Markt');
  });

  it('Prämie 0 OHNE die ct-Größen: nennt keinen Grund, den niemand belegen kann', () => {
    const z = einspeise({ ...dv, marktpraemieEur: 0 }).zusatz;
    expect(z).toBe('In diesem Zeitraum fällt keine Marktprämie an.');
    expect(z).not.toContain('Monatsmarktwert');
  });

  it('Prämie 0, aber der Monatsmarktwert liegt UNTER dem anzulegenden Wert: kein erfundener Grund', () => {
    // Die Rechnung ergäbe hier eine Prämie — dass trotzdem 0 gemeldet ist, kann
    // diese Zeile nicht erklären, also behauptet sie es auch nicht.
    const z = einspeise({
      ...dv,
      marktpraemieEur: 0,
      anzulegenderWertCtKwh: 8.1,
      marketValueSolarCtKwh: 6.2,
    }).zusatz;
    expect(z).toBe('In diesem Zeitraum fällt keine Marktprämie an.');
  });

  it('kein Prämien-Betrag, aber ein anzulegender Wert: „wo sie anfällt"', () => {
    expect(einspeise({ ...dv, anzulegenderWertCtKwh: 8.1 }).zusatz).toBe(
      'Dazu kommt die Marktprämie, wo sie anfällt.',
    );
  });

  it('Direktvermarktung ganz ohne Angaben: keine Zeile', () => {
    expect(einspeise(dv).zusatz).toBeNull();
  });

  it('der Einspeisepreis selbst ist immer der Börsenpreis', () => {
    expect(einspeise({ ...dv, marktpraemieEur: 12 }).text).toBe(
      'Der Börsenpreis (Day-Ahead) der jeweiligen Viertelstunde.',
    );
  });
});

describe('steuerungFormel — das Portfolio kennt keinen einzelnen Tarif', () => {
  it('tarifneutral: nennt „der Stromtarif der jeweiligen Anlage"', () => {
    const f = steuerungFormel({ tarifneutral: true });
    expect(f.kern).toContain('dem Stromtarif der jeweiligen Anlage');
    expect(bezug({ tarifneutral: true }).text).toBe('Der Stromtarif der jeweiligen Anlage.');
  });

  it('tarifneutral: weder ein Ø-Preis noch eine Marktprämie einer einzelnen Anlage', () => {
    const input: SteuerungFormelInput = {
      tarifneutral: true,
      bezugspreisCtKwh: 32.5,
      plantKind: 'direktvermarktung',
      marktpraemieEur: 12,
    };
    expect(bezug(input).zusatz).toBeNull();
    expect(einspeise(input).zusatz).toBeNull();
  });
});

describe('steuerungFormel — das Bestandskonto wird verwiesen, nie dupliziert', () => {
  it('erklärt, warum die Zahl im Tagesverlauf sinken kann', () => {
    const h = steuerungFormel({}).hinweis;
    expect(h).toContain('reine Kassenrechnung');
    expect(h).toContain('mittags sinken');
    expect(h).toContain('erst am Tagesende vollständig');
  });

  it('zeigt auf die Bestandszeile NUR, wo sie wirklich gerendert wird', () => {
    expect(steuerungFormel({ bestandSichtbar: true }).hinweis).toContain(
      'steht in der Zeile darunter',
    );
    expect(steuerungFormel({ bestandSichtbar: false }).hinweis).not.toContain(
      'Zeile darunter',
    );
    expect(steuerungFormel({}).hinweis).not.toContain('Zeile darunter');
  });

  it('wiederholt den Bestandssatz nicht — er wohnt in `bestandZeile`', () => {
    const h = steuerungFormel({ bestandSichtbar: true }).hinweis;
    expect(h).not.toContain('Planwert');
    expect(h).not.toContain('Speicherenergie');
  });
});

describe('steuerungFormel — der Historik-Satz (B5)', () => {
  const satz = (input: SteuerungFormelInput) => steuerungFormel(input).historik;

  it('mit Tarif/Vergütung: sagt, dass eine Änderung die Vergangenheit umschreibt', () => {
    const faelle: SteuerungFormelInput[] = [
      { tarifArt: 'fest', tarifParamCtKwh: 30 },
      { tarifArt: 'dynamisch', tarifParamCtKwh: 18 },
      { tarifArt: 'ohne', tarifPriced: true },
      { tarifArt: 'ohne', plantKind: 'direktvermarktung' },
      { tarifneutral: true },
    ];
    for (const input of faelle) {
      const s = satz(input);
      expect(s).not.toBeNull();
      expect(s).toContain('heute hinterlegten');
      expect(s).toContain('zurückliegende Auswertungen');
    }
  });

  it('reiner Börsenpreis (nacktes ohne): kein Historik-Satz — nichts umzuschreiben', () => {
    expect(satz({ tarifArt: 'ohne' })).toBeNull();
    expect(satz({ tarifArt: 'ohne', tarifPriced: false })).toBeNull();
    expect(satz({})).toBeNull();
  });
});

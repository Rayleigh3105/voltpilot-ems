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
      'Ohne smarte Steuerung',
      'Mit Steuerung',
      'Beitrag der Steuerung',
    ]);
    expect(f.preise.map((p) => p.label)).toEqual(['Bezugspreis', 'Einspeisepreis']);
  });

  it('nennt in der Rechnung beide Seiten und die Differenz', () => {
    const f = steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30 });
    const [ohne, mit, diff] = f.zeilen;
    expect(ohne.text).toContain('Derselbe Speicher, stur betrieben');
    expect(mit.text).toContain('Zähler');
    expect(diff.text).toContain('Kosten ohne smarte Steuerung − Kosten mit Steuerung');
    expect(diff.text).toContain('über alle Viertelstunden des Zeitraums summiert');
  });

  /**
   * ⚠ **DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG** (Captain
   * 04.09.2026). Der frühere B4-Fall nagelte die Baseline „Speicher aus,
   * Solarstrom direkt verbraucht" fest — die beschreibt eine Anlage OHNE
   * Speicher und damit `savedEur`, nicht die Zahl, die der Chip zeigt.
   */
  it('beschreibt die Vergleichs-Anlage MIT Speicher — und nennt nie „Speicher aus"', () => {
    const f = steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30 });
    const ohne = f.zeilen[0];
    expect(ohne.text).toContain('lädt jeden Solarüberschuss');
    expect(ohne.text).toContain('kennt keine Preise und hält nie für später');
    expect(ohne.text).not.toContain('Speicher aus');
    expect(f.kern).toContain('mit demselben Speicher, aber ohne smarte Steuerung');
    expect(`${f.kern} ${ohne.text}`).not.toMatch(/ohne Speicher\b/);
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

  it('A1 · dynamisch ohne Aufschlag, aber tariflich bewertet (Preisblatt/Default-Flag): Börsenpreis + Standard-Komponenten', () => {
    // Preisblatt-Kunde bzw. Produktions-Default an: der Ø-Bezugspreis daneben zeigt
    // ~30 ct, ein nacktes „Börsenpreis" wäre der B3-Selbstwiderspruch.
    for (const param of [null, 0]) {
      const t = bezug({ tarifArt: 'dynamisch', tarifParamCtKwh: param, tarifPriced: true }).text;
      expect(t).toContain('Ihr dynamischer Stromtarif');
      expect(t).toContain('Börsenpreis der jeweiligen Viertelstunde');
      expect(t).toContain('Standard-Netzentgelte und Abgaben');
      expect(t).not.toContain('Aufschlag');
    }
  });

  it('A1 · dynamisch ohne Aufschlag + tarifPriced=false (Flag aus): reiner Börsenpreis, ohne Standard-Komponenten', () => {
    const t = bezug({ tarifArt: 'dynamisch', tarifParamCtKwh: 0, tarifPriced: false }).text;
    expect(t).toBe('Ihr dynamischer Stromtarif: der Börsenpreis der jeweiligen Viertelstunde.');
    expect(t).not.toContain('Standard-Netzentgelte');
  });

  it('A1 · dynamisch MIT Aufschlag behält seinen Satz, auch bei tarifPriced=true', () => {
    expect(bezug({ tarifArt: 'dynamisch', tarifParamCtKwh: 18, tarifPriced: true }).text).toBe(
      `Ihr dynamischer Stromtarif: Börsenpreis der jeweiligen Viertelstunde + 18,0${NBSP}ct/kWh Aufschlag.`,
    );
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

  it('A1 · dynamisch ohne Aufschlag, aber tarifPriced=true: der Kernsatz sagt „Ihrem Stromtarif" (passt zum ~30-ct-Ø)', () => {
    // Nur die Preis-ZEILE benennt die Komponenten; der Kernsatz bleibt „Ihrem
    // Stromtarif" — korrekt gegen einen tariflich bewerteten Ø-Bezugspreis.
    const kern = steuerungFormel({ tarifArt: 'dynamisch', tarifParamCtKwh: 0, tarifPriced: true }).kern;
    expect(kern).toContain('Ihrem Stromtarif für den Netzbezug');
    expect(kern).not.toContain('dem Börsenpreis für den Netzbezug');
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

  it('Direktvermarktung: die Einspeisepreis-Zeile bleibt der Börsenpreis', () => {
    expect(einspeise({ ...dv, marktpraemieEur: 12 }).text).toBe(
      'Der Börsenpreis (Day-Ahead) der jeweiligen Viertelstunde.',
    );
    expect(einspeise({ ...dv, marktpraemieEur: 12 }).text).not.toContain('feste Einspeisevergütung');
  });
});

describe('steuerungFormel — A1: die EEG-Einspeisevergütung', () => {
  // Eine EEG-vergütete Eigenverbrauchs-Anlage: die Einspeisung ist zur festen
  // Vergütung bewertet, ein „Börsenpreis" widerspräche der Karte-Zahl sichtbar.
  const eeg: SteuerungFormelInput = {
    tarifArt: 'ohne',
    plantKind: 'eigenverbrauch',
    exportVerguetungPriced: true,
  };

  it('Kernsatz UND Zeile nennen die feste Einspeisevergütung statt des Börsenpreises', () => {
    const f = steuerungFormel(eeg);
    expect(f.kern).toContain('Ihrer festen Einspeisevergütung für die Einspeisung');
    expect(f.kern).not.toContain('dem Börsenpreis für die Einspeisung');
    expect(einspeise(eeg).text).toBe('Ihre feste Einspeisevergütung nach EEG.');
    expect(einspeise(eeg).text).not.toContain('Börsenpreis');
  });

  it('der Netzbezug bleibt davon unberührt (weiterhin „Börsenpreis" ohne Tarif)', () => {
    // A1 dreht NUR die Einspeise-Seite; der Bezugspreis folgt weiter dem Tarif.
    expect(steuerungFormel(eeg).kern).toContain('dem Börsenpreis für den Netzbezug');
  });

  it('ohne das Flag ist alles byte-identisch zu vorher (Börsenpreis)', () => {
    const ohneFlag: SteuerungFormelInput = { tarifArt: 'ohne', plantKind: 'eigenverbrauch' };
    expect(steuerungFormel(ohneFlag).kern).toContain('dem Börsenpreis für die Einspeisung');
    expect(einspeise(ohneFlag).text).toBe('Der Börsenpreis (Day-Ahead) der jeweiligen Viertelstunde.');
  });

  it('Flag ausdrücklich false: Börsenpreis (nichts wird behauptet)', () => {
    const flagAus: SteuerungFormelInput = {
      tarifArt: 'ohne',
      plantKind: 'eigenverbrauch',
      exportVerguetungPriced: false,
    };
    expect(steuerungFormel(flagAus).kern).toContain('dem Börsenpreis für die Einspeisung');
    expect(einspeise(flagAus).text).toBe('Der Börsenpreis (Day-Ahead) der jeweiligen Viertelstunde.');
  });

  it('tarifneutral gewinnt: ein Portfolio nennt keine einzelne feste Vergütung', () => {
    const portfolio: SteuerungFormelInput = { tarifneutral: true, exportVerguetungPriced: true };
    expect(steuerungFormel(portfolio).kern).toContain('dem Börsenpreis für die Einspeisung');
    expect(einspeise(portfolio).text).toBe('Der Börsenpreis (Day-Ahead) der jeweiligen Viertelstunde.');
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

/**
 * Der AUFTEILUNGS-Schritt (Erlöse-Konzept `vp-erloese-seite-konzept-e2` §3.5,
 * P5): dieselbe Summe, zerlegt in den stur arbeitenden Vergleichs-Speicher und
 * den Mehrwert der Steuerung — mit den EINGESETZTEN Zahlen, weil genau das die
 * Frage hinter dem Chip ist.
 */
describe('steuerungFormel — der Ergebnis-Schritt', () => {
  const zeile = (input: SteuerungFormelInput) =>
    steuerungFormel(input).zeilen.find((z) => z.label === 'Im Zeitraum') ?? null;

  it('nennt die Zahl mit ihrem Vorzeichen UND ihre Messlatte', () => {
    const z = zeile({ savedSteuerungEur: 3.1 });
    expect(z).not.toBeNull();
    expect(z?.text).toMatch(/3,10/);
    expect(z?.text).toContain('gegenüber demselben Speicher ohne smarte Steuerung');
  });

  it('erklärt auch die Lage, in der die Steuerung hinten liegt', () => {
    const z = zeile({ savedSteuerungEur: -0.3 });
    expect(z?.text).toMatch(/− ?0,30|-0,30/);
  });

  it('gibt es ohne den Steuerungs-Anteil gar nicht — nie eine geratene Zahl', () => {
    expect(zeile({})).toBeNull();
    expect(zeile({ savedSteuerungEur: null })).toBeNull();
  });

  it('zeigt NIRGENDS die Gesamtzahl — sie erreicht diese Eingabe gar nicht mehr', () => {
    const f = steuerungFormel({ tarifArt: 'fest', tarifParamCtKwh: 30, savedSteuerungEur: 3.1 });
    const alles = [f.kern, ...f.zeilen.map((z) => `${z.label} ${z.text}`)].join(' ');
    expect(alles).not.toContain('12,40');
    expect(alles).not.toContain('stur arbeitender Speicher hätte');
  });
});

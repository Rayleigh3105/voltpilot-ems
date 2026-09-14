import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EINHEITEN_NORMIERUNG,
  erzeugungsHakenErlaubt,
  FEHLER,
  formelGroesse,
  gewichteteSumme,
  richtungMitErzeugungsHaken,
  SUMME_NACHKOMMASTELLEN,
  zyklus,
  type Summand,
  type Term,
} from './uemsMessstelleFormel';

// Arbeitsverzeichnis ist frontend/portal; die geteilte Vektor-Datei liegt zwei Ebenen darüber.
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const vectors: any = JSON.parse(readFileSync(resolve(V2, 'messstelle-formel-vectors.json'), 'utf8'));
const faelle = (familie: string): any[] => vectors.cases[familie];

describe('uemsMessstelleFormel — die Regel-Konstanten stehen in der Datei', () => {
  it('Fehlertabelle (Code · Status · geprüft von)', () => {
    expect(vectors.fehler).toEqual(FEHLER.map((f) => ({ ...f })));
  });
  it('Einheiten-Normierung ≡ Katalog', () => {
    expect(vectors.einheiten_normierung).toEqual(EINHEITEN_NORMIERUNG);
  });
  it('Nachkommastellen der Summe', () => {
    expect(vectors.summe_nachkommastellen).toEqual(SUMME_NACHKOMMASTELLEN);
  });
});

describe('formelGroesse — die Hauptgröße aus den Termen', () => {
  it.each(faelle('groesse'))('Größe: $name', (c) => {
    const u = formelGroesse(c.input.terme as Term[]);
    expect({ fehler: u.fehler, grund: u.grund, hauptgroesse: u.hauptgroesse }).toEqual(c.expected);
  });
});

describe('zyklus — Bausteine, aber nie im Kreis', () => {
  it.each(faelle('zyklus'))('Zyklus: $name', (c) => {
    const u = zyklus(c.input.kennzeichen, c.input.verweise, c.input.bestehende);
    expect({ zyklus: u.zyklus, kette: u.kette }).toEqual(c.expected);
  });
});

describe('gewichteteSumme — der Wert, und null statt Teilsumme', () => {
  it.each(faelle('summe'))('Summe: $name', (c) => {
    const u = gewichteteSumme(c.input.ziel_einheit, c.input.terme as Summand[]);
    expect({ wert: u.wert, unvollstaendig: u.unvollstaendig, fehlende: u.fehlende }).toEqual(c.expected);
  });
});

describe('AP-08 „gilt als Erzeugung"-Haken — nur am richtungslosen Kanal', () => {
  it.each(faelle('haken'))('Haken: $name', (c) => {
    const richtung: string | null = c.input.katalog_richtung ?? null;
    expect({
      erlaubt: erzeugungsHakenErlaubt(richtung),
      richtung: richtungMitErzeugungsHaken(richtung, c.input.gilt_als_erzeugung),
    }).toEqual(c.expected);
  });
});

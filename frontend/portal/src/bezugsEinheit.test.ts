import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EINHEIT_UMGERECHNET,
  EINHEIT_UNBEKANNT,
  SAETZE,
  einheit,
  groesseVon,
  istGanzzahlig,
  satz,
  synonym,
  type Umrechnung,
} from './bezugsEinheit';
import { dez, dezText, dezVergleich, type Dez } from './dez';

/**
 * Das EINHEITEN-Modul (UEMS AP-09 IP-3) gegen die geteilte Vektor-Datei
 * `docs/contracts/v2/bezugsdaten-vectors.json` — Familie `einheit` — und gegen
 * die drei Zusagen, die kein Referenzfall stellt: die Umrechnungsgrenze, die
 * exakte Rechnung und die Synonyme einer Vorlage. Der Java-Zwilling
 * `BezugsEinheitTest` fährt dieselbe Datei.
 */

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const vectors = JSON.parse(readFileSync(resolve(V2, 'bezugsdaten-vectors.json'), 'utf8')) as Record<string, unknown>;

const einheiten = vectors.einheiten as Record<string, string[]>;
const umrechnungen = vectors.umrechnung as Umrechnung[];
const befundSaetze = vectors.befund_saetze as Record<string, string>;
const faelle = vectors.cases as Array<Record<string, unknown>>;

const gleich = (a: Dez | null, b: string | null): boolean =>
  a === null || b === null ? a === null && b === null : dezText(a) === dezText(dez(b));

describe('bezugsEinheit — die Familie `einheit` der Vektor-Datei', () => {
  for (const fall of faelle) {
    for (const p of (fall.pruefungen ?? []) as Array<Record<string, unknown>>) {
      if (p.regel !== 'einheit') continue;
      const pr = p as unknown as { name: string; eingang: Record<string, unknown>; ergebnis: Record<string, unknown> };
      it(`${fall.id} · ${pr.name}`, () => {
        const ein = pr.eingang;
        const soll = pr.ergebnis;
        const ist = einheit(
          dez(ein.betrag as string),
          (ein.geliefert as string | null) ?? null,
          ein.ziel as string,
          einheiten,
          umrechnungen,
        );
        expect(gleich(ist.betrag, (soll.betrag as string | null) ?? null)).toBe(true);
        expect(ist.einheit).toBe(soll.einheit);
        expect(ist.befunde).toEqual(soll.befunde);
      });
    }
  }
});

describe('bezugsEinheit — die Zusagen ohne Referenzfall', () => {
  it('die Kundensätze wohnen im Modul und sind die des Vertrags', () => {
    for (const [befund, text] of Object.entries(SAETZE)) {
      expect(text).toBe(befundSaetze[befund]);
    }
    expect(Object.keys(SAETZE).sort()).toEqual([EINHEIT_UMGERECHNET, EINHEIT_UNBEKANNT].sort());
    expect(satz(EINHEIT_UNBEKANNT)).toBe('Unbekannte Einheit — erlaubt sind die Einheiten dieser Größe.');
    expect(() => satz('gibt_es_nicht')).toThrow();
  });

  it('über Größen-Grenzen wird nie gerechnet (E4/U1)', () => {
    let geprueft = 0;
    for (const [groesseA, worteA] of Object.entries(einheiten)) {
      for (const [groesseB, worteB] of Object.entries(einheiten)) {
        if (groesseA === groesseB) continue;
        for (const geliefert of worteA) {
          for (const ziel of worteB) {
            const ist = einheit(dez('1'), geliefert, ziel, einheiten, umrechnungen);
            expect(ist.betrag).toBeNull();
            expect(ist.befunde).toEqual([EINHEIT_UNBEKANNT]);
            geprueft += 1;
          }
        }
      }
    }
    expect(geprueft).toBeGreaterThan(50);
    expect(groesseVon('Paletten', einheiten)).toBeNull();
    expect(einheit(dez('688720'), 'lbs', 'kg', einheiten, umrechnungen).befunde).toEqual([EINHEIT_UNBEKANNT]);
  });

  it('die Umrechnung ist exakt, nicht gerundet', () => {
    // Verglichen wird NUMERISCH, wie der Vertrag es sagt: „312400" und
    // „312400.0" sind derselbe Betrag (die Nachkommastellen sind Darstellung).
    const rechne = (betrag: string, von: string, nach: string, soll: string) => {
      const ist = einheit(dez(betrag), von, nach, einheiten, umrechnungen).betrag as Dez;
      expect(dezVergleich(ist, dez(soll))).toBe(0);
    };
    rechne('312.4', 't', 'kg', '312400');
    rechne('1234567.891', 't', 'kg', '1234567891');
    rechne('312400', 'kg', 't', '312.4');
    rechne('1500', 'l', 'm³', '1.5');
    rechne('298', 'min', 'h', '4.9667');
    rechne('2.5', 'h', 'min', '150');
    // Der Beweis, dass keine Gleitkommazahl im Spiel ist: 0,3 t sind als
    // `number` 300.00000000000006 kg, hier genau 300.
    rechne('0.3', 't', 'kg', '300');
    expect(dezText(einheit(dez('0.3'), 't', 'kg', einheiten, umrechnungen).betrag as Dez)).toBe('300');
  });

  it('ein Synonym der Vorlage ersetzt das Wort, es rechnet nie', () => {
    const synonyme = { Stk: 'Stück', Std: 'h', Kartons: 'Paletten' };
    const stueck = einheit(dez('96'), 'Stk.', 'Stück', einheiten, umrechnungen, synonyme);
    expect(dezText(stueck.betrag as Dez)).toBe('96');
    expect(stueck.befunde).toEqual([]);

    const stunden = einheit(dez('120'), 'Std', 'min', einheiten, umrechnungen, synonyme);
    expect(dezText(stunden.betrag as Dez)).toBe('7200');
    expect(stunden.befunde).toEqual([EINHEIT_UMGERECHNET]);

    // Eine Vorlage kann das Vokabular nicht erweitern.
    expect(einheit(dez('4'), 'Kartons', 'Stück', einheiten, umrechnungen, synonyme).befunde).toEqual([
      EINHEIT_UNBEKANNT,
    ]);
    // Ohne Vorlage bleibt „Stk." unbekannt — Synonyme sind eine ENTSCHEIDUNG.
    expect(einheit(dez('96'), 'Stk.', 'Stück', einheiten, umrechnungen).befunde).toEqual([EINHEIT_UNBEKANNT]);
    expect(synonym('Stk', undefined)).toBe('Stk');
    expect(synonym(null, synonyme)).toBeNull();
  });

  it('Stück, Personen und Schichten nehmen keine Nachkommastellen an (U5)', () => {
    expect(istGanzzahlig('Stück')).toBe(true);
    expect(istGanzzahlig('Personen')).toBe(true);
    expect(istGanzzahlig('Schichten')).toBe(true);
    expect(istGanzzahlig('kg')).toBe(false);
    expect(istGanzzahlig('h')).toBe(false);
  });

  it('es bleibt keine zweite Fassung: bezugsdaten.ts reicht das Modul weiter', () => {
    const quelle = readFileSync(resolve(process.cwd(), 'src/bezugsdaten.ts'), 'utf8');
    expect(quelle).not.toContain('dezSkaliere(betrag');
    expect(quelle).not.toContain('einheiten[groesse]');
    expect(quelle).toContain("} from './bezugsEinheit';");
  });
});

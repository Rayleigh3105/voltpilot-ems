import { describe, expect, it } from 'vitest';
import {
  NICHT_GEMELDET,
  NUR_HINTERLEGT,
  modusWort,
  ohneMeldung,
  rahmenZeilen,
  type RahmenSoll,
} from './ladeparkRahmen';
import type { LadeparkRahmen } from './verbraucherZone';

const IST: LadeparkRahmen = {
  netzanschlussKw: 32,
  hoechsteHausLastKw: 5,
  sicherheitsabstandPct: 10,
  mindestleistungKw: 4.2,
  budgetKw: 22,
  modus: 'gemessen',
};

const SOLL: RahmenSoll = {
  maxHouseLoadKw: 7,
  marginPct: 12,
  minPowerKw: 6,
  rotationMinutes: 15,
  staticBudget: true,
};

function zeile(zeilen: ReturnType<typeof rahmenZeilen>, key: string) {
  const z = zeilen.find((x) => x.key === key);
  if (!z) throw new Error(`keine Zeile ${key}`);
  return z;
}

describe('rahmenZeilen', () => {
  it('zeigt das IST der Box, wo es eines gibt', () => {
    const z = rahmenZeilen(IST, SOLL);
    expect(zeile(z, 'hausreserve').wert).toContain('5');
    expect(zeile(z, 'hausreserve').quelle).toBe('gemeldet');
    expect(zeile(z, 'hausreserve').hinweis).toBeNull();
  });

  it('faellt auf das SOLL zurueck und BENENNT es', () => {
    const z = rahmenZeilen(null, SOLL);
    expect(zeile(z, 'hausreserve').wert).toContain('7');
    expect(zeile(z, 'hausreserve').quelle).toBe('hinterlegt');
    expect(zeile(z, 'hausreserve').hinweis).toBe(NUR_HINTERLEGT);
  });

  it('behauptet ohne beides GAR KEINE Zahl', () => {
    const z = rahmenZeilen(null, null);
    for (const k of ['hausreserve', 'abstand', 'mindest', 'rotation']) {
      expect(zeile(z, k).wert).toBeNull();
      expect(zeile(z, k).quelle).toBe('unbekannt');
    }
  });

  it('kennt die Rotation nur als SOLL - die Box meldet sie nicht', () => {
    // Auch mit vollem Ist-Block bleibt die Rotation das, was hinterlegt ist.
    const z = rahmenZeilen(IST, SOLL);
    expect(zeile(z, 'rotation').quelle).toBe('hinterlegt');
    expect(zeile(z, 'rotation').wert).toContain('15');
    expect(rahmenZeilen(IST, null).find((x) => x.key === 'rotation')!.wert).toBeNull();
  });

  it('liest eine 0 als WERT, nie als fehlend', () => {
    const z = rahmenZeilen({ ...IST, sicherheitsabstandPct: 0 }, SOLL);
    expect(zeile(z, 'abstand').wert).toContain('0');
    expect(zeile(z, 'abstand').quelle).toBe('gemeldet');
  });

  it('nimmt die gepflegte Grenze, wenn die Box keine meldet', () => {
    const z = rahmenZeilen({ gepflegteGrenzeKw: 63 }, null);
    expect(zeile(z, 'netzanschluss').wert).toContain('63');
  });

  it('nennt die Budget-Art in beiden Richtungen', () => {
    expect(zeile(rahmenZeilen(IST, null), 'modus').wert).toBe('gemessen');
    expect(zeile(rahmenZeilen(null, { staticBudget: true }), 'modus').wert).toBe('statisch');
    expect(zeile(rahmenZeilen(null, { staticBudget: false }), 'modus').wert).toBe('gemessen');
  });

  it('haelt die Reihenfolge der Mockups', () => {
    expect(rahmenZeilen(IST, SOLL).map((z) => z.key)).toEqual([
      'netzanschluss', 'hausreserve', 'abstand', 'mindest', 'rotation', 'modus',
    ]);
  });
});

describe('modusWort', () => {
  it('uebersetzt die zwei bekannten Woerter', () => {
    expect(modusWort('measured')).toBe('gemessen');
    expect(modusWort('static')).toBe('statisch');
  });

  it('reicht ein UNBEKANNTES Wort durch, statt es zu raten', () => {
    expect(modusWort('irgendwas')).toBe('irgendwas');
  });

  it('behauptet ohne Wort nichts', () => {
    expect(modusWort(null)).toBeNull();
    expect(modusWort('  ')).toBeNull();
  });
});

describe('ohneMeldung', () => {
  it('ist wahr ohne Rahmen und ohne eine einzige gemeldete Zahl', () => {
    expect(ohneMeldung(null)).toBe(true);
    expect(ohneMeldung({ gepflegteGrenzeKw: 32 })).toBe(true);
  });

  it('ist falsch, sobald die Box IRGENDETWAS gemeldet hat', () => {
    expect(ohneMeldung({ budgetKw: 0 })).toBe(false);
    expect(ohneMeldung(IST)).toBe(false);
  });
});

describe('der Leer-Satz', () => {
  it('ist ein Wort, keine Zahl', () => {
    expect(NICHT_GEMELDET).not.toMatch(/\d/);
  });
});

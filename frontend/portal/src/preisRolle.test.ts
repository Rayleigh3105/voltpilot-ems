import { describe, expect, it } from 'vitest';
import { bildPreisArt } from './fahrplanTag';
import dv0500 from './fahrplanVektoren/laeufe/dv-0500.json';
import evDyn from './fahrplanVektoren/laeufe/ev-dyn-tag.json';
import evFest51a from './fahrplanVektoren/laeufe/ev-fest-51a-tag.json';
import evFestFruehling from './fahrplanVektoren/laeufe/ev-fest-fruehling-tag.json';
import evFestNetzladen from './fahrplanVektoren/laeufe/ev-fest-netzladen-0500.json';
import evFest from './fahrplanVektoren/laeufe/ev-fest-tag.json';
import type { WhySlot } from './fahrplanWhy';
import { preisRolle, umstellungErkannt, type PreisRolleSlot } from './preisRolle';
import { gateStrompreis } from './strompreis';
import type { ActiveMode } from './surface';

// ---------------------------------------------------------------------------
// Einheiten-Vektoren (synthetische Viertelstunden)
// ---------------------------------------------------------------------------

function slot(importPriceCtKwh: number | null, exportValueCtKwh: number | null): PreisRolleSlot {
  return { importPriceCtKwh, exportValueCtKwh };
}

describe('preisRolle — bezug/einspeisung (synthetisch)', () => {
  it('bezug flach, einspeisung flach: die Sonnen-Erzählung (Festtarif, feste Vergütung)', () => {
    const slots = Array.from({ length: 4 }, () => slot(30, 8.1));
    const rolle = preisRolle({ slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(rolle.bezug).toBe('flach');
    expect(rolle.einspeisung).toBe('flach');
    expect(rolle.erzaehlung).toBe('sonne');
    expect(rolle.nullstunden).toEqual([]);
  });

  it('bezug schwankt (dynamischer Tarif): immer die Preis-Erzählung, auch mit fester Vergütung', () => {
    const slots = [slot(20, 8.1), slot(35, 8.1), slot(28, 8.1)];
    const rolle = preisRolle({ slots, tarifArt: 'dynamisch', plantKind: 'eigenverbrauch' });
    expect(rolle.bezug).toBe('schwankt');
    expect(rolle.einspeisung).toBe('flach');
    expect(rolle.erzaehlung).toBe('preis');
  });

  it('einspeisung flach mit Nullstunden (§ 51a): bleibt die Sonnen-Erzählung, Nullstunden gezählt', () => {
    const slots = [slot(30, 7.9), slot(30, 0), slot(30, 0), slot(30, 7.9)];
    const rolle = preisRolle({ slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(rolle.einspeisung).toBe('flach_mit_nullstunden');
    expect(rolle.erzaehlung).toBe('sonne');
    expect(rolle.nullstunden).toEqual([1, 2]);
  });

  it('einspeisung schwankt echt (Netzladen an / DV): die Preis-Erzählung, obwohl der Bezug flach bleibt', () => {
    const slots = [slot(30, 9.5), slot(30, 18.2), slot(30, 27.3)];
    const rolle = preisRolle({ slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(rolle.bezug).toBe('flach');
    expect(rolle.einspeisung).toBe('schwankt');
    expect(rolle.erzaehlung).toBe('preis');
  });

  it('Lücke (Vergütung nicht hinterlegt): die Sonnen-Erzählung bleibt, auch wenn die Einspeisung im Rückfall zur Börse schwankt', () => {
    const slots = [slot(30, 9.5), slot(30, 18.2), slot(30, 27.3)];
    const rolle = preisRolle({ slots, tarifArt: 'fest', plantKind: 'eigenverbrauch', luecke: true });
    expect(rolle.einspeisung).toBe('schwankt');
    expect(rolle.luecke).toBe(true);
    expect(rolle.erzaehlung).toBe('sonne');
  });

  it('unbekannt (kein Lauf): Stammdaten-Rückfall wie bisher — bekannter, nicht-dynamischer Tarif ohne Direktvermarktung bleibt Sonne', () => {
    expect(preisRolle({ tarifArt: 'fest', plantKind: 'eigenverbrauch' }).erzaehlung).toBe('sonne');
    expect(preisRolle({ tarifArt: 'ohne', plantKind: 'eigenverbrauch' }).erzaehlung).toBe('sonne');
    expect(preisRolle({ tarifArt: 'dynamisch', plantKind: 'eigenverbrauch' }).erzaehlung).toBe('preis');
    expect(preisRolle({ tarifArt: 'fest', plantKind: 'direktvermarktung' }).erzaehlung).toBe('preis');
    expect(preisRolle({ tarifArt: null, plantKind: 'eigenverbrauch' }).erzaehlung).toBe('preis');
  });
});

// ---------------------------------------------------------------------------
// Vektoren aus dem echten Optimierer-Lauf (werkzeug/laeufe/, report.md §5.2/§5.5)
// ---------------------------------------------------------------------------

interface Lauf {
  klasse: string;
  slots: WhySlot[];
}

const LAEUFE: Record<string, Lauf> = {
  'ev-fest-tag': evFest as Lauf,
  'ev-dyn-tag': evDyn as Lauf,
  'ev-fest-51a-tag': evFest51a as Lauf,
  'ev-fest-fruehling-tag': evFestFruehling as Lauf,
  'ev-fest-netzladen-0500': evFestNetzladen as Lauf,
  'dv-0500': dv0500 as Lauf,
};

describe('preisRolle — Wächter-Vektoren (report.md §5.5, echte Optimierer-Läufe)', () => {
  it.each([
    ['ev-fest-tag', 'flach', 'flach', 'sonne', 0],
    ['ev-dyn-tag', 'schwankt', 'flach', 'preis', 0],
    ['ev-fest-51a-tag', 'flach', 'flach_mit_nullstunden', 'sonne', 19],
    ['ev-fest-fruehling-tag', 'flach', 'flach', 'sonne', 0],
    ['ev-fest-netzladen-0500', 'flach', 'schwankt', 'preis', 0],
    ['dv-0500', 'flach', 'schwankt', 'preis', 0],
  ] as const)('%s: bezug=%s, einspeisung=%s, erzaehlung=%s, %i Nullstunden', (name, bezug, einspeisung, erzaehlung, nNullstunden) => {
    const lauf = LAEUFE[name];
    const rolle = preisRolle({
      slots: lauf.slots,
      tarifArt: 'fest',
      plantKind: lauf.klasse === 'dv' ? 'direktvermarktung' : 'eigenverbrauch',
    });
    expect(rolle.bezug).toBe(bezug);
    expect(rolle.einspeisung).toBe(einspeisung);
    expect(rolle.erzaehlung).toBe(erzaehlung);
    expect(rolle.nullstunden).toHaveLength(nNullstunden);
  });

  it('kein Rückschritt: in der Preis-Erzählung (dynamisch, DV) bleibt der Bezug sichtbar klassifiziert', () => {
    expect(preisRolle({ slots: LAEUFE['ev-dyn-tag'].slots, tarifArt: 'dynamisch', plantKind: 'eigenverbrauch' }).erzaehlung).toBe(
      'preis',
    );
    expect(
      preisRolle({ slots: LAEUFE['dv-0500'].slots, tarifArt: 'fest', plantKind: 'direktvermarktung' }).erzaehlung,
    ).toBe('preis');
  });
});

// ---------------------------------------------------------------------------
// Regressions-Wächter: die drei bestehenden Tore bleiben ohne sichtbare Änderung
// (report.md §5.4) — sie gehen über `preisRolle` auf, liefern aber dieselben
// Entscheidungen wie vor der Umstellung.
// ---------------------------------------------------------------------------

describe('Wächter: die drei bestehenden Tore ohne sichtbare Änderung (report.md §5.4)', () => {
  it('fahrplanTag.bildPreisArt bleibt für jeden Lauf-Vektor unverändert', () => {
    expect(bildPreisArt(LAEUFE['ev-fest-tag'].slots, 'fest', 'eigenverbrauch')).toBeNull();
    expect(bildPreisArt(LAEUFE['ev-fest-fruehling-tag'].slots, 'fest', 'eigenverbrauch')).toBeNull();
    expect(bildPreisArt(LAEUFE['ev-fest-51a-tag'].slots, 'fest', 'eigenverbrauch')).toBeNull();
    expect(bildPreisArt(LAEUFE['ev-dyn-tag'].slots, 'dynamisch', 'eigenverbrauch')).toBe('bezug');
    // Netzladen an / DV: der Bezug selbst bleibt flach — bildPreisArt entscheidet
    // (bewusst, §5.4) allein über `bezug`, nicht über `erzaehlung`.
    expect(bildPreisArt(LAEUFE['ev-fest-netzladen-0500'].slots, 'fest', 'eigenverbrauch')).toBeNull();
    expect(bildPreisArt(LAEUFE['dv-0500'].slots, 'fest', 'direktvermarktung')).toBe('boerse');
    // Älterer Lauf ohne Preisfelder: Stammdaten-Rückfall, wortgleich wie bisher.
    expect(bildPreisArt([], null, 'eigenverbrauch')).toBe('boerse');
    expect(bildPreisArt([], 'fest', 'eigenverbrauch')).toBeNull();
  });

  it('strompreis.gateStrompreis bleibt für jede Stammdaten-Kombination unverändert', () => {
    const markt = { kind: 'marktvermarktung' } as ActiveMode;
    const peak = { kind: 'lastspitzenkappung' } as ActiveMode;
    expect(gateStrompreis([markt], 'fest')).toBe(true);
    expect(gateStrompreis([], 'dynamisch')).toBe(true);
    expect(gateStrompreis([markt], 'dynamisch')).toBe(true);
    expect(gateStrompreis([], 'fest')).toBe(false);
    expect(gateStrompreis([peak], 'ohne')).toBe(false);
    expect(gateStrompreis([], null)).toBe(false);
  });
});

describe('umstellungErkannt (report.md §5.3, Scheibe S5)', () => {
  it('meldet eine Umstellung, widersprechen sich Stammdaten und der jüngste Lauf', () => {
    // Stammdaten sagen „fest" (Sonne), der eben umgestellte Lauf rechnet noch dynamisch (Preis).
    const stammdaten = preisRolle({ tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    const lauf = preisRolle({ slots: LAEUFE['ev-dyn-tag'].slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(umstellungErkannt(stammdaten, lauf)).toBe(true);
  });

  it('meldet keine Umstellung, stimmen Stammdaten und Lauf überein', () => {
    const stammdatenFest = preisRolle({ tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    const laufFest = preisRolle({ slots: LAEUFE['ev-fest-tag'].slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(umstellungErkannt(stammdatenFest, laufFest)).toBe(false);

    const stammdatenDyn = preisRolle({ tarifArt: 'dynamisch', plantKind: 'eigenverbrauch' });
    const laufDyn = preisRolle({ slots: LAEUFE['ev-dyn-tag'].slots, tarifArt: 'dynamisch', plantKind: 'eigenverbrauch' });
    expect(umstellungErkannt(stammdatenDyn, laufDyn)).toBe(false);
  });

  it('meldet keine Umstellung ohne Lauf - beide Seiten lösen über denselben Rückfall auf', () => {
    const stammdaten = preisRolle({ tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    const ohneLauf = preisRolle({ tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(umstellungErkannt(stammdaten, ohneLauf)).toBe(false);
  });
});

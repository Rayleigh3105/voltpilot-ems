import { describe, expect, it } from 'vitest';
import {
  RANGLISTE_SPEICHER_TAG,
  type RanglisteEintrag,
  ranglisteFolgen,
  ranglisteRumpf,
  ranglisteZusammenfassung,
  verschiebe,
  zeilenKey,
  zeilenTag,
  zeilenTitel,
  ziehe,
} from './verbraucherZone';

/**
 * Die Rangliste als BEDIENBARE Liste (Verbrauchsmanagement v1 §5, Paket P4) -
 * die reine Hälfte. Die Maschine dahinter beweist `RanglisteAbleitungTest`.
 */

const speicher: RanglisteEintrag = {
  position: 1, art: 'speicher', entityId: null, name: 'Speicher', mitglieder: [],
};
const heizstab: RanglisteEintrag = {
  position: 2, art: 'verbraucher', entityId: 'e-heiz', name: 'Heizstab',
  mitglieder: [{ entityId: 'e-heiz', name: 'Heizstab' }],
};
const gruppe: RanglisteEintrag = {
  position: 3, art: 'ladepunkt', entityId: null, name: null,
  mitglieder: [
    { entityId: 'e-1', name: 'Stellplatz 2' },
    { entityId: 'e-2', name: 'Stellplatz 3' },
    { entityId: 'e-3', name: 'Carport' },
  ],
};
const wallbox: RanglisteEintrag = {
  position: 6, art: 'ladepunkt', entityId: 'e-wb', name: 'Wallbox Garage',
  mitglieder: [{ entityId: 'e-wb', name: 'Wallbox Garage' }],
};

describe('die Zeile', () => {
  it('nennt eine Gruppe bei den Namen ihrer Mitglieder', () => {
    expect(zeilenTitel(gruppe)).toBe('Stellplatz 2 · Stellplatz 3 · Carport');
    expect(zeilenTag(gruppe)).toBe('3 Ladepunkte');
  });

  it('nennt einen einzelnen Ladepunkt beim Namen', () => {
    expect(zeilenTitel(wallbox)).toBe('Wallbox Garage');
    expect(zeilenTag(wallbox)).toBe('Ladepunkt');
  });

  it('sagt am Speicher, was seine Position bewirkt - und bei einem Verbraucher nichts', () => {
    expect(zeilenTag(speicher)).toBe(RANGLISTE_SPEICHER_TAG);
    expect(zeilenTag(heizstab)).toBe('');
  });

  it('erfindet keinen Namen, wo keiner gemeldet ist', () => {
    const ohne: RanglisteEintrag = {
      position: 1, art: 'ladepunkt', entityId: null, name: null,
      mitglieder: [{ entityId: 'e-x', name: '' }],
    };
    expect(zeilenTitel(ohne)).toBe('Ladepunkte');
  });

  it('gibt jeder Zeile einen stabilen Schlüssel - auch der Gruppe ohne Kennung', () => {
    expect(zeilenKey(speicher)).toBe('speicher');
    expect(zeilenKey(heizstab)).toBe('e-heiz');
    expect(zeilenKey(gruppe)).toBe('gruppe:e-1,e-2,e-3');
  });
});

describe('die Zusammenfassung zählt GERÄTE, nicht Zeilen', () => {
  it('rechnet eine Gruppe mit ihren Mitgliedern', () => {
    expect(ranglisteZusammenfassung([speicher, heizstab, gruppe]))
      .toBe('Speicher zuerst · 5 Einträge');
  });

  it('nennt den ersten Eintrag, wenn der Speicher nicht oben steht', () => {
    expect(ranglisteZusammenfassung([heizstab, speicher]))
      .toBe('Heizstab zuerst · 2 Einträge');
  });

  it('behauptet über eine leere Liste nichts', () => {
    expect(ranglisteZusammenfassung([])).toBeNull();
  });
});

describe('sortieren', () => {
  it('verschiebt eine Zeile um genau einen Platz', () => {
    const out = verschiebe([speicher, heizstab, gruppe], 2, -1);
    expect(out.map(zeilenKey)).toEqual(['speicher', 'gruppe:e-1,e-2,e-3', 'e-heiz']);
  });

  it('lässt die Liste am Rand unverändert - und gibt sie identisch zurück', () => {
    const liste = [speicher, heizstab];
    expect(verschiebe(liste, 0, -1)).toBe(liste);
    expect(verschiebe(liste, 1, 1)).toBe(liste);
    expect(verschiebe(liste, 9, 1)).toBe(liste);
  });

  it('zieht eine Zeile an eine andere Position', () => {
    const out = ziehe([speicher, heizstab, gruppe], 0, 2);
    expect(out.map(zeilenKey)).toEqual(['e-heiz', 'gruppe:e-1,e-2,e-3', 'speicher']);
  });

  it('ist beim Ziehen auf denselben Platz ein No-op', () => {
    const liste = [speicher, heizstab];
    expect(ziehe(liste, 1, 1)).toBe(liste);
  });
});

describe('der Rumpf für PUT /rangliste', () => {
  it('löst eine Gruppe in ihre Mitglieder auf - der Server gruppiert wieder', () => {
    expect(ranglisteRumpf([gruppe, speicher, heizstab])).toEqual([
      { art: 'ladepunkt', entityId: 'e-1' },
      { art: 'ladepunkt', entityId: 'e-2' },
      { art: 'ladepunkt', entityId: 'e-3' },
      { art: 'speicher' },
      { art: 'verbraucher', entityId: 'e-heiz' },
    ]);
  });

  it('schickt den Speicher-Platz ohne Kennung', () => {
    expect(ranglisteRumpf([speicher])).toEqual([{ art: 'speicher' }]);
  });

  it('kommt auch ohne mitglieder aus (älterer Server)', () => {
    const alt: RanglisteEintrag = {
      position: 1, art: 'verbraucher', entityId: 'e-alt', name: 'Alt',
    };
    expect(ranglisteRumpf([alt])).toEqual([{ art: 'verbraucher', entityId: 'e-alt' }]);
  });
});

describe('die Folgen-Karte', () => {
  it('nennt die ersten Zeilen in ihrer Reihenfolge und die Pflichten', () => {
    const out = ranglisteFolgen([speicher, heizstab, gruppe]);
    expect(out[0]).toBe('Ist die Leistung knapp, bekommt Speicher, dann Heizstab, '
      + 'dann Stellplatz 2 · Stellplatz 3 · Carport');
    expect(out[1]).toContain('trotzdem zuerst erfüllt');
  });

  it('erklärt, was die POSITION zum Speicher bewirkt - nie, wo ein Gerät steht', () => {
    // ⚠ Eine Liste kann Ladepunkte auf BEIDEN Seiten haben (eine go-e über,
    // die Säulen unter dem Speicher). Ein Satz über „Ihre Ladepunkte" wäre dann
    // eine Falschaussage; der Satz spricht deshalb über die Position.
    const gemischt = ranglisteFolgen([wallbox, speicher, gruppe]).at(-1)!;
    expect(gemischt).toContain('Alles über dem Speicher');
    expect(gemischt).toContain('alles darunter');
    expect(ranglisteFolgen([speicher, gruppe]).at(-1)).toBe(gemischt);
  });

  it('behauptet ohne Speicher nichts über eine Seite', () => {
    const out = ranglisteFolgen([heizstab, gruppe]);
    expect(out).toHaveLength(2);
    expect(out.join(' ')).not.toContain('Speicher');
  });

  it('sagt über eine leere Liste gar nichts', () => {
    expect(ranglisteFolgen([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { ALL_SETTINGS, SETTING_DEFS } from './modeSettings';
import { PROVENIENZ } from './historieWelten';
import {
  AUTHORITY,
  AUTHORITY_ORDER,
  aktuellerPreisSlot,
  authorityOf,
  bezugspreisLeerText,
  bezugspreisSatz,
  bezugspreisVorschau,
  BOX_ADDRESS_NOTE,
  effectChips,
  effectsOf,
  hasVoltpilotValue,
  honestyNote,
  honestyOf,
  voltpilotGroupFor,
  voltpilotRows,
  ZUSTAENDIG_BOX,
  ZUSTAENDIG_PORTAL,
  type PreisSlot,
} from './settingsSurface';
import { settingsGroupFor } from './settingsNav';

describe('E4 · die drei Autoritäts-Stufen', () => {
  it('leitet die Stufe aus `editability` ab — nie aus einer zweiten Liste', () => {
    expect(authorityOf(SETTING_DEFS.stromtarif)).toBe(1);
    expect(authorityOf(SETTING_DEFS.netzladen)).toBe(1);
    expect(authorityOf(SETTING_DEFS.speicherschonung)).toBe(1);
    expect(authorityOf(SETTING_DEFS['anzulegender-wert'])).toBe(1);
    expect(authorityOf(SETTING_DEFS.leistungspreis)).toBe(2);
    expect(authorityOf(SETTING_DEFS['abrechnung-leistung'])).toBe(2);
    expect(authorityOf(SETTING_DEFS['lastspitzen-reserve'])).toBe(2);
    // Und zwar für JEDE Einstellung der Registry, ohne Lücke.
    for (const def of ALL_SETTINGS) {
      expect(authorityOf(def)).toBe(def.editability === 'voltpilot' ? 2 : 1);
    }
  });

  it('jede Stufe hat Zeichen, Kurzform, Namen und einen erklärenden Satz', () => {
    expect(AUTHORITY_ORDER).toEqual([1, 2, 3]);
    for (const level of AUTHORITY_ORDER) {
      const info = AUTHORITY[level];
      expect(info.mark.length).toBeGreaterThan(0);
      expect(info.badge.length).toBeGreaterThan(0);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.note.length).toBeGreaterThan(10);
    }
    // Die drei Zeichen sind unterscheidbar (sonst wäre die Legende sinnlos).
    expect(new Set(AUTHORITY_ORDER.map((l) => AUTHORITY[l].mark)).size).toBe(3);
  });

  it('sagt NIE „VoltPilot richtet ein" — der Copy-Wächter verbietet die Gegenwartsform', () => {
    // M3 hat die Anfragewand abgeschafft; ② ist ein Zustand, keine Aufforderung.
    for (const level of AUTHORITY_ORDER) {
      const info = AUTHORITY[level];
      expect(`${info.label} ${info.note} ${info.badge}`).not.toMatch(/VoltPilot richtet ein/);
    }
  });
});

describe('E4/D4 · die Stufe-②-Werte werden SICHTBAR', () => {
  const peakSite = {
    plantKind: 'eigenverbrauch',
    leistungspreisEurKw: 128.5,
    abrechnungLeistung: 'jahr' as const,
    peakReserveSocPct: 25,
  };

  it('verteilt sie nach dem Entwurf: Vertragswerte ins Geld, die Reserve zum Speicher', () => {
    expect(voltpilotGroupFor('leistungspreis')).toBe('geld');
    expect(voltpilotGroupFor('abrechnung-leistung')).toBe('geld');
    expect(voltpilotGroupFor('lastspitzen-reserve')).toBe('speicher');
    // Was der Kunde selbst stellt, hat hier KEINE Zuordnung — das ist die
    // Heimat-Adresse in `settingsNav`, und die beiden dürfen nie kollidieren.
    for (const id of ['stromtarif', 'netzladen', 'speicherschonung', 'anzulegender-wert'] as const) {
      expect(voltpilotGroupFor(id)).toBeNull();
      expect(settingsGroupFor(id)).not.toBeNull();
    }
    // Und umgekehrt: ein ②-Wert behält seine Heimat im Modus (kein toter Link).
    for (const id of ['leistungspreis', 'abrechnung-leistung', 'lastspitzen-reserve'] as const) {
      expect(settingsGroupFor(id)).toBeNull();
    }
  });

  it('zeigt sie einer Anlage, die sie WIRKLICH trägt', () => {
    expect(voltpilotRows('geld', peakSite).map((d) => d.id)).toEqual([
      'leistungspreis',
      'abrechnung-leistung',
    ]);
    expect(voltpilotRows('speicher', peakSite).map((d) => d.id)).toEqual(['lastspitzen-reserve']);
  });

  it('erfindet auf einer Hausanlage ohne Lastspitzenkappung KEINE Zeile', () => {
    const haus = { plantKind: 'eigenverbrauch' };
    expect(voltpilotRows('geld', haus)).toEqual([]);
    expect(voltpilotRows('speicher', haus)).toEqual([]);
    expect(hasVoltpilotValue(haus, 'leistungspreis')).toBe(false);
    expect(hasVoltpilotValue(haus, 'lastspitzen-reserve')).toBe(false);
  });

  it('die Abrechnungsperiode hängt am Leistungspreis, nicht an sich selbst', () => {
    // Ohne Leistungspreis gibt es nichts abzurechnen; MIT ihm steht die Periode
    // auch dann da, wenn das Feld selbst leer ist (der Wert liest sich „—").
    const ohnePeriode = { leistungspreisEurKw: 128.5, abrechnungLeistung: null };
    expect(hasVoltpilotValue(ohnePeriode, 'abrechnung-leistung')).toBe(true);
    expect(hasVoltpilotValue({ abrechnungLeistung: 'monat' as const }, 'abrechnung-leistung')).toBe(
      false,
    );
  });

  it('ein ②-Wert ist NIE eine ①-Zeile — er trägt kein Bearbeiten-Formular', () => {
    for (const def of [...voltpilotRows('geld', peakSite), ...voltpilotRows('speicher', peakSite)]) {
      expect(def.editability).toBe('voltpilot');
      expect(def.editForm).toBeNull();
    }
  });
});

describe('E5 · Wirkungs-Chips', () => {
  it('jede Einstellung sagt, worauf sie wirkt — in kanonischer Reihenfolge', () => {
    expect(effectChips('stromtarif')).toEqual(['Wirkt auf: Fahrplan', 'Wirkt auf: Erlöse']);
    expect(effectChips('speicherschonung')).toEqual(['Wirkt auf: Fahrplan', 'Wirkt auf: Ihr Speicher']);
    expect(effectChips('abrechnung-leistung')).toEqual(['Wirkt auf: Erlöse']);
    for (const def of ALL_SETTINGS) expect(effectsOf(def.id).length).toBeGreaterThan(0);
  });

  it('unterscheidet wirklich — eine Ableitung aus `claimedBy` allein könnte das nicht', () => {
    // Alle vier Kunden-Einstellungen beanspruchen dieselbe Modus-Art; aus ihr
    // allein wären die Chips identisch und damit falsch. Genau deshalb ist die
    // Wirkung eine Eigenschaft der EINSTELLUNG (Modul-Kommentar).
    const claims = new Set(
      ['stromtarif', 'netzladen', 'speicherschonung', 'anzulegender-wert'].map((id) =>
        SETTING_DEFS[id as 'stromtarif'].claimedBy.join(','),
      ),
    );
    expect(claims.size).toBe(1);
    expect(effectsOf('stromtarif')).not.toEqual(effectsOf('speicherschonung'));
  });
});

describe('E5 · Ehrlichkeits-Abzeichen', () => {
  it('Preis-/Vertragswerte sind BEWERTET, Verhaltens-Einstellungen GEPLANT', () => {
    expect(honestyOf('stromtarif')).toBe('bewertet');
    expect(honestyOf('anzulegender-wert')).toBe('bewertet');
    expect(honestyOf('leistungspreis')).toBe('bewertet');
    expect(honestyOf('netzladen')).toBe('geplant');
    expect(honestyOf('speicherschonung')).toBe('geplant');
  });

  it('KEINE Einstellung behauptet je, eine gemessene Zahl zu ändern', () => {
    for (const def of ALL_SETTINGS) {
      const art = honestyOf(def.id);
      expect(art).not.toBeNull();
      expect(art).not.toBe('gemessen');
      // Das Abzeichen benutzt die Historie-Vokabel, damit beide Flächen
      // dasselbe Wort für dieselbe Art Zahl benutzen.
      expect(PROVENIENZ[art!].label.length).toBeGreaterThan(0);
    }
    expect(honestyNote('bewertet')).toContain('nie eine gemessene');
    expect(honestyNote('geplant')).toContain('nie eine aufgezeichnete Messung');
  });
});

describe('E5 · die lebende Bezugspreis-Vorschau', () => {
  const slot = (over: Partial<PreisSlot> = {}): PreisSlot => ({
    start: '2026-07-31T10:00:00Z',
    priceEurMwh: 124,
    importPriceCtKwh: 32.5,
    importPriceSource: 'preisblatt',
    ...over,
  });

  it('nimmt den Slot, der JETZT läuft — nie einen fremden', () => {
    const slots = [
      slot({ start: '2026-07-31T09:45:00Z', importPriceCtKwh: 10 }),
      slot({ start: '2026-07-31T10:00:00Z', importPriceCtKwh: 32.5 }),
      slot({ start: '2026-07-31T10:15:00Z', importPriceCtKwh: 40 }),
    ];
    const now = new Date('2026-07-31T10:07:00Z');
    expect(aktuellerPreisSlot(slots, 15, now)?.importPriceCtKwh).toBe(32.5);
    // Außerhalb des Horizonts lieber gar nichts als eine fremde Zahl.
    expect(aktuellerPreisSlot(slots, 15, new Date('2026-07-31T23:00:00Z'))).toBeNull();
    expect(aktuellerPreisSlot([], 15, now)).toBeNull();
    expect(aktuellerPreisSlot(null, 15, now)).toBeNull();
  });

  it('liest die Komposition, die der Server mitgeschickt hat (keine zweite Rechnung)', () => {
    // 124 EUR/MWh = 12,4 ct Börse; der Rest bis 32,5 sind Netzentgelte/Abgaben.
    expect(bezugspreisSatz(bezugspreisVorschau(slot()))).toBe(
      'Ihr Bezugspreis gerade: 32,5 ct/kWh (Börsenpreis 12,4 + Netzentgelte/Abgaben 20,1)',
    );
  });

  it('nennt je Quelle genau das, was der Lauf hergibt — und erfindet sonst nichts', () => {
    expect(bezugspreisVorschau(slot({ importPriceSource: 'fest' }))?.aufschluesselung).toBe(
      '(Ihr Festpreis-Tarif)',
    );
    expect(bezugspreisVorschau(slot({ importPriceSource: 'spot' }))?.aufschluesselung).toBe(
      '(reiner Börsenpreis)',
    );
    // Unbekannte Quelle: die Zahl ja, die Aufschlüsselung nein.
    const unbekannt = bezugspreisVorschau(slot({ importPriceSource: 'irgendwas' }));
    expect(unbekannt?.wert).toBe(32.5);
    expect(unbekannt?.aufschluesselung).toBeNull();
    // Ohne Spot-Preis lässt sich nicht aufteilen.
    expect(bezugspreisVorschau(slot({ priceEurMwh: null }))?.aufschluesselung).toBeNull();
    // Ein Aufschlags-Anteil im Rundungsrauschen ist keine Information.
    expect(
      bezugspreisVorschau(slot({ priceEurMwh: 325, importPriceCtKwh: 32.5 }))?.aufschluesselung,
    ).toBeNull();
  });

  it('degradiert ehrlich statt eine Zahl zu erfinden', () => {
    expect(bezugspreisVorschau(null)).toBeNull();
    expect(bezugspreisVorschau(slot({ importPriceCtKwh: null }))).toBeNull();
    expect(bezugspreisSatz(null)).toBeNull();
    expect(bezugspreisLeerText('ohne')).toContain('nicht in Euro');
    expect(bezugspreisLeerText(null)).toContain('nicht in Euro');
    expect(bezugspreisLeerText('dynamisch')).toContain('Fahrplan');
  });
});

describe('E7 · die Grenze zur Box wird beidseitig ausgesprochen (D5)', () => {
  it('sagt WOFÜR (Portal) und WOMIT (Gerät) — und behauptet keinen Link ins Heimnetz', () => {
    expect(ZUSTAENDIG_PORTAL).toContain('WOFÜR');
    expect(ZUSTAENDIG_BOX).toContain('WOMIT');
    expect(BOX_ADDRESS_NOTE).toContain('8484');
    // Kein http(s)-Link: das Portal kennt die Adresse der Box nicht.
    expect(`${ZUSTAENDIG_BOX} ${BOX_ADDRESS_NOTE}`).not.toMatch(/https?:\/\//);
  });
});

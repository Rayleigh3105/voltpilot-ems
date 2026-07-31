import { describe, expect, it } from 'vitest';
import { parseRoute } from './nav';
import {
  einstellungenHash,
  geldGroupSummary,
  parseSettingsAnchor,
  SETTING_HINT,
  settingsGroupFor,
} from './settingsNav';
import { ALL_SETTINGS, settingsPageSettings } from './modeSettings';

describe('settingsGroupFor — wo eine Einstellung auf der Seite wohnt (E1)', () => {
  it('Geld & Verträge trägt Tarif, Vergütung und Netzladen', () => {
    expect(settingsGroupFor('stromtarif')).toBe('geld');
    expect(settingsGroupFor('anzulegender-wert')).toBe('geld');
    expect(settingsGroupFor('netzladen')).toBe('geld');
  });

  it('der Umgang mit dem Speicher gehört zum Speicher, nicht zum Geld', () => {
    // Entwurf §7 P4, Gruppe C: es ist eine Verhaltens-, keine Geld-Einstellung.
    expect(settingsGroupFor('speicherschonung')).toBe('speicher');
  });

  it('was gar nicht auf der Seite wohnt, bekommt KEINE Adresse (nie ein toter Link)', () => {
    for (const id of ['leistungspreis', 'abrechnung-leistung', 'lastspitzen-reserve'] as const) {
      expect(settingsGroupFor(id)).toBeNull();
    }
  });

  it('JEDE Einstellung mit Heimat hat auch eine Gruppe — und umgekehrt', () => {
    for (const def of ALL_SETTINGS) {
      expect(settingsGroupFor(def.id) != null).toBe(def.home === 'einstellungen');
    }
    // Und jede Zeile, die die Seite rendert, ist einer Gruppe zugeordnet.
    for (const def of settingsPageSettings()) expect(settingsGroupFor(def.id)).not.toBeNull();
  });
});

describe('einstellungenHash / parseSettingsAnchor — die Adresse einer Gruppe', () => {
  it('ist ein Parameter im Hash, KEIN zweites #', () => {
    const hash = einstellungenHash('s-1', 'geld');
    expect(hash).toBe('#/anlage/s-1/technik?abschnitt=geld');
    expect(hash.indexOf('#', 1)).toBe(-1);
  });

  it('ändert die Route nicht — der Router schneidet den Parameter ab', () => {
    const plain = parseRoute(einstellungenHash('s-1'));
    const anchored = parseRoute(einstellungenHash('s-1', 'geld'));
    expect(anchored).toEqual(plain);
    expect(anchored).toEqual({ page: 'anlagen', siteId: 's-1', sub: 'technik' });
  });

  it('liest die Gruppe zurück und rät nie', () => {
    expect(parseSettingsAnchor(einstellungenHash('s-1', 'speicher'))).toBe('speicher');
    expect(parseSettingsAnchor(einstellungenHash('s-1'))).toBeNull();
    expect(parseSettingsAnchor('#/anlage/s-1/technik?abschnitt=erfunden')).toBeNull();
    expect(parseSettingsAnchor('#/anlage/s-1/technik?z=tag')).toBeNull();
    expect(parseSettingsAnchor('')).toBeNull();
  });

  it('jede erzeugte Adresse ist auch wieder lesbar (Rundlauf)', () => {
    for (const def of settingsPageSettings()) {
      const group = settingsGroupFor(def.id);
      expect(parseSettingsAnchor(einstellungenHash('s-1', group))).toBe(group);
    }
  });
});

describe('Copy der Gruppe', () => {
  it('jede Einstellung der Seite trägt ihre Erklärzeile', () => {
    for (const def of settingsPageSettings()) {
      expect(SETTING_HINT[def.id]).toBeTruthy();
    }
  });

  it('die Erklärzeilen nennen kein Innenleben', () => {
    for (const text of Object.values(SETTING_HINT)) {
      expect(text).not.toMatch(/Optimizer|MILP|Broker|Entität|Messpunkt|RLS/i);
    }
  });

  it('die Zusammenfassung nennt nur, was hinterlegt ist', () => {
    expect(
      geldGroupSummary({ tarifLabel: 'Ohne Angabe', netzladenLabel: 'Nur Solarladen (EEG)' }),
    ).toBe('Ohne Angabe · Nur Solarladen (EEG)');
    expect(
      geldGroupSummary({
        tarifLabel: 'Dynamisch',
        anzulegenderWertLabel: '8,11 ct/kWh',
        netzladenLabel: 'Netzladen aktiv',
      }),
    ).toBe('Dynamisch · 8,11 ct/kWh · Netzladen aktiv');
    // Ein fehlender anzulegender Wert erzeugt keinen leeren Trenner.
    expect(
      geldGroupSummary({
        tarifLabel: 'Fest: 32,5 ct/kWh',
        anzulegenderWertLabel: null,
        netzladenLabel: 'Nur Solarladen (EEG)',
      }),
    ).toBe('Fest: 32,5 ct/kWh · Nur Solarladen (EEG)');
  });
});

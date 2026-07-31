import { describe, expect, it } from 'vitest';
import type { SupplyPrice } from './api';
import { supplyPriceFormValues, type SupplyPriceFormValues } from './supplyPrice';
import {
  TARIF_PARAM_FIELDS,
  clearSupplyPricePatch,
  initialDrafts,
  initialPriceMode,
  priceModeCards,
  priceModeConsequence,
  priceModeExplain,
  priceModeMirror,
  supplyComponentWarning,
  supplyPriceSummary,
  switchTarifArt,
  tarifParamField,
  tarifParamWarning,
  tarifSwitchNote,
} from './tariffInput';

// ---------------------------------------------------------------------------
// 1 · Ein Wert je Tarifart — die reproduzierte Wunde 1
// ---------------------------------------------------------------------------

describe('switchTarifArt — eine Zahl wird nie umgedeutet', () => {
  it('DIE Falle: ein Aufschlag von 18 wandert NICHT als Strompreis mit', () => {
    // Genau der live reproduzierte Fall (Report §4.1): „Dynamisch · 18" als
    // Aufschlag, dann auf „Fest" umgeschaltet.
    const sw = switchTarifArt(initialDrafts('dynamisch', '18'), 'dynamisch', '18', 'fest');
    expect(sw.param).toBe('');
    expect(sw.restored).toBe(false);
    expect(sw.carriedNothing).toBe(true);
    // Und der alte Wert ist nicht weg, er liegt nur unter SEINER Bedeutung.
    expect(sw.drafts).toEqual({ dynamisch: '18', fest: '' });
  });

  it('die Gegenrichtung ebenso: 32,5 ct Festpreis werden nie ein Aufschlag', () => {
    const sw = switchTarifArt(initialDrafts('fest', '32,5'), 'fest', '32,5', 'dynamisch');
    expect(sw.param).toBe('');
    expect(sw.drafts).toEqual({ fest: '32,5', dynamisch: '' });
  });

  it('zurückwechseln setzt den EIGENEN Wert wieder ein (nichts geht verloren)', () => {
    const one = switchTarifArt(initialDrafts('dynamisch', '18'), 'dynamisch', '18', 'fest');
    const two = switchTarifArt(one.drafts, 'fest', '32,5', 'dynamisch');
    expect(two.param).toBe('18');
    expect(two.restored).toBe(true);
    // Und der frisch getippte Festpreis wartet weiterhin unter „fest".
    expect(two.drafts.fest).toBe('32,5');
  });

  it('„Ohne Angabe" hat kein Feld: nichts steht drin, nichts geht verloren', () => {
    const sw = switchTarifArt(initialDrafts('fest', '32,5'), 'fest', '32,5', 'ohne');
    expect(sw.param).toBe('');
    expect(tarifParamField('ohne')).toBeNull();
    const back = switchTarifArt(sw.drafts, 'ohne', '', 'fest');
    expect(back.param).toBe('32,5');
  });

  it('ein leeres Feld löst keine Warnung aus', () => {
    const sw = switchTarifArt(initialDrafts('dynamisch', ''), 'dynamisch', '', 'fest');
    expect(sw.carriedNothing).toBe(false);
    expect(tarifSwitchNote(sw, 'dynamisch', 'fest')).toBeNull();
  });

  it('initialDrafts trägt den Wert NUR unter der gespeicherten Tarifart', () => {
    expect(initialDrafts('fest', '32,5')).toEqual({ fest: '32,5', dynamisch: '' });
    expect(initialDrafts('dynamisch', '18')).toEqual({ fest: '', dynamisch: '18' });
    expect(initialDrafts('ohne', '')).toEqual({ fest: '', dynamisch: '' });
  });
});

describe('tarifSwitchNote — der Bedeutungswechsel wird ANGESAGT', () => {
  it('nennt beide Bedeutungen beim Namen und beruhigt wegen des alten Werts', () => {
    const sw = switchTarifArt(initialDrafts('dynamisch', '18'), 'dynamisch', '18', 'fest');
    const note = tarifSwitchNote(sw, 'dynamisch', 'fest');
    expect(note).toContain('Andere Bedeutung');
    expect(note).toContain('der gesamte Aufschlag auf den Börsenpreis');
    expect(note).toContain('zählt Ihr gesamter Arbeitspreis');
    expect(note).toContain('bleibt gemerkt');
  });

  it('trägt grammatisch auch in der Gegenrichtung', () => {
    const sw = switchTarifArt(initialDrafts('fest', '32,5'), 'fest', '32,5', 'dynamisch');
    expect(tarifSwitchNote(sw, 'fest', 'dynamisch')).toContain(
      'bisher stand hier Ihr gesamter Arbeitspreis. Für „Dynamisch" zählt der gesamte Aufschlag auf den Börsenpreis',
    );
  });

  it('sagt beim Zurückwechseln, dass der eigene Wert wieder da ist', () => {
    const one = switchTarifArt(initialDrafts('dynamisch', '18'), 'dynamisch', '18', 'fest');
    const two = switchTarifArt(one.drafts, 'fest', '', 'dynamisch');
    expect(tarifSwitchNote(two, 'fest', 'dynamisch')).toContain('wieder im Feld');
  });

  it('schweigt, wenn die neue Tarifart gar kein Feld hat', () => {
    const sw = switchTarifArt(initialDrafts('fest', '32,5'), 'fest', '32,5', 'ohne');
    expect(tarifSwitchNote(sw, 'fest', 'ohne')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 · Plausibilitätsspannen: Warnung, nie Sperre
// ---------------------------------------------------------------------------

describe('tarifParamWarning — warnt, sperrt nie, und nennt die andere Bedeutung', () => {
  it('lässt reale Werte beider Tarifarten in Ruhe', () => {
    for (const v of ['25', '32,5', '45', '20', '60']) {
      expect(tarifParamWarning('fest', v)).toBeNull();
    }
    for (const v of ['5', '15', '18', '25', '30']) {
      expect(tarifParamWarning('dynamisch', v)).toBeNull();
    }
  });

  it('fängt genau die Verwechslung: ein Aufschlag im Festpreis-Feld', () => {
    const w = tarifParamWarning('fest', '18');
    expect(w).toContain('Ungewöhnlich niedrig');
    expect(w).toContain('Aufschlag');
    expect(w).toContain('Speichern können Sie den Wert trotzdem');
  });

  it('fängt die Gegenrichtung: ein Festpreis im Aufschlag-Feld', () => {
    const w = tarifParamWarning('dynamisch', '32,5');
    expect(w).toContain('Ungewöhnlich hoch');
    expect(w).toContain('festen Arbeitspreis');
    expect(w).toContain('Speichern können Sie den Wert trotzdem');
  });

  it('fängt die reine Marge im Sammelaufschlag-Feld', () => {
    const w = tarifParamWarning('dynamisch', '1,5');
    expect(w).toContain('Netzentgelte, Abgaben UND Marge zusammen');
  });

  it('warnt bei einem absurd hohen Arbeitspreis', () => {
    expect(tarifParamWarning('fest', '95')).toContain('Ungewöhnlich hoch');
  });

  it('schweigt bei leerem, unlesbarem oder feldlosem Zustand', () => {
    expect(tarifParamWarning('fest', '')).toBeNull();
    expect(tarifParamWarning('fest', '   ')).toBeNull();
    expect(tarifParamWarning('fest', 'abc')).toBeNull();
    expect(tarifParamWarning('ohne', '18')).toBeNull();
  });

  it('die Spannen selbst sind die dokumentierten', () => {
    expect(TARIF_PARAM_FIELDS.fest.range).toMatchObject({ min: 20, max: 60 });
    expect(TARIF_PARAM_FIELDS.dynamisch.range).toMatchObject({ min: 5, max: 30 });
  });
});

describe('supplyComponentWarning — dieselbe Wort-Kollision im Preisblatt', () => {
  it('warnt, wenn der Sammelaufschlag in die Marge-Zeile gerät', () => {
    const w = supplyComponentWarning('vertriebsaufschlagCt', '18');
    expect(w).toContain('nur die Marge');
    expect(w).toContain('Speichern können Sie den Wert trotzdem');
  });

  it('lässt eine echte Marge in Ruhe und schweigt zu allen anderen Zeilen', () => {
    expect(supplyComponentWarning('vertriebsaufschlagCt', '1,5')).toBeNull();
    expect(supplyComponentWarning('vertriebsaufschlagCt', '5')).toBeNull();
    expect(supplyComponentWarning('netzentgeltArbeitspreisCt', '18')).toBeNull();
    expect(supplyComponentWarning('umlagenCt', '99')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3 · „Schnell / Genau" (D3)
// ---------------------------------------------------------------------------

function sheet(over: Partial<SupplyPrice> = {}): SupplyPrice {
  return {
    present: true,
    hasComponents: true,
    netzentgeltArbeitspreisCt: 7.6,
    stromsteuerCt: 2.05,
    konzessionsabgabeCt: 1.59,
    umlagenCt: 2.946,
    vertriebsaufschlagCt: 1.5,
    ustPct: 19,
    komponentenStand: null,
    updatedAt: null,
    ...over,
  };
}

describe('initialPriceMode — der Modus ist der GESPEICHERTE Zustand', () => {
  it('ein gepflegtes Preisblatt ist „Genau"', () => {
    expect(initialPriceMode(sheet())).toBe('genau');
  });

  it('alles andere ist „Schnell" - auch eine leere Zeile', () => {
    expect(initialPriceMode(null)).toBe('schnell');
    expect(initialPriceMode(undefined)).toBe('schnell');
    expect(initialPriceMode(sheet({ present: true, hasComponents: false }))).toBe('schnell');
  });
});

describe('priceMode — eine Preis-Wahrheit je Formular', () => {
  const genauValues: SupplyPriceFormValues = supplyPriceFormValues(null);

  it('die Karten benennen den Unterschied ohne Fachjargon', () => {
    const cards = priceModeCards('dynamisch');
    expect(cards.map((c) => c.id)).toEqual(['schnell', 'genau']);
    expect(cards[0].hint).toContain('Aufschlag auf den Börsenpreis');
    expect(cards[1].hint).toContain('Preisblatt');
    // „Ohne Angabe" hat keine Schnell-Zahl, das sagt die Karte auch.
    expect(priceModeCards('ohne')[0].hint).toContain('Keine eigene Preisangabe');
  });

  it('erklärt, WOMIT gerechnet wird', () => {
    expect(priceModeExplain('schnell', 'dynamisch')).toContain('Börsenpreis + Ihr Aufschlag');
    expect(priceModeExplain('genau', 'dynamisch')).toContain('Summe Ihrer Komponenten');
    expect(priceModeExplain('schnell', 'ohne')).toContain('keinen eigenen Bezugspreis');
  });

  it('spiegelt den jeweils anderen Weg read-only (verlustfrei sichtbar)', () => {
    // In „Genau": die Schnell-Zahl bleibt sichtbar - und zählt nicht.
    expect(priceModeMirror('genau', 'dynamisch', '18', genauValues, 'schnell')).toMatch(
      /Aufschlag 18 ct\/kWh.*nicht gerechnet/,
    );
    // In „Schnell": das gepflegte Preisblatt steht zusammengefasst da.
    const m = priceModeMirror('schnell', 'dynamisch', '18', genauValues, 'genau');
    expect(m).toContain('gepflegtes Preisblatt');
    expect(m).toContain('15,686 ct/kWh netto');
    expect(m).toContain('19 % USt');
  });

  it('spiegelt nichts, wo es nichts zu spiegeln gibt', () => {
    expect(priceModeMirror('genau', 'dynamisch', '', genauValues, 'schnell')).toBeNull();
    expect(priceModeMirror('genau', 'ohne', '18', genauValues, 'schnell')).toBeNull();
    expect(priceModeMirror('schnell', 'dynamisch', '18', genauValues, 'schnell')).toBeNull();
  });

  it('kündigt die entwertende Folge VORHER an (die E3-Regel)', () => {
    expect(priceModeConsequence('genau', 'schnell', 'dynamisch')).toContain('entfernt');
    expect(priceModeConsequence('genau', 'schnell', 'dynamisch')).toContain('nicht Ihre Zahl');
    // „Ohne Angabe" hat keine Schnell-Zahl - der Satz behauptet auch keine.
    expect(priceModeConsequence('genau', 'schnell', 'ohne')).toContain('entfernt');
    expect(priceModeConsequence('genau', 'schnell', 'ohne')).not.toContain('Ihre Zahl');
    expect(priceModeConsequence('genau', 'genau')).toBeNull();
    expect(priceModeConsequence('schnell', 'schnell')).toBeNull();
    expect(priceModeConsequence('schnell', 'genau')).toBeNull();
  });

  it('die Zusammenfassung rechnet die gezeigten Zeilen zusammen', () => {
    expect(supplyPriceSummary(genauValues)).toBe('Σ 15,686 ct/kWh netto + 19 % USt');
  });

  it('der Entwertungs-PATCH leert jede Komponente, nie den USt-Satz', () => {
    const patch = clearSupplyPricePatch();
    expect(patch).toEqual({
      komponentenStand: null,
      netzentgeltArbeitspreisCt: null,
      stromsteuerCt: null,
      konzessionsabgabeCt: null,
      umlagenCt: null,
      vertriebsaufschlagCt: null,
    });
    expect('ustPct' in patch).toBe(false);
  });
});

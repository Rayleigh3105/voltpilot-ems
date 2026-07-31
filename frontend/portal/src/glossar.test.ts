import { describe, expect, it } from 'vitest';
import {
  GLOSSAR,
  GROUP_LABEL,
  MAX_HITS,
  noHitText,
  normalizeTerm,
  searchSettings,
  VERAEUSSERUNGSFORM_FRAGE,
  VERAEUSSERUNGSFORM_LABEL,
  VERAEUSSERUNGSFORM_TIP,
} from './glossar';
import { TARIF_PARAM_FIELDS } from './tariffInput';

const hitIds = (q: string) => searchSettings(q).map((h) => h.id);

describe('E6 · die Suche findet über Label UND Synonym', () => {
  it('beantwortet die Frage, die B10 unbeantwortbar nannte: „Wo stelle ich meinen Strompreis ein?"', () => {
    expect(hitIds('Strompreis')).toContain('stromtarif');
    expect(searchSettings('Strompreis')[0].group).toBe('geld');
  });

  it('findet dieselbe Zeile unter allen Wörtern, unter denen jemand sucht', () => {
    for (const q of ['Arbeitspreis', 'Bezugspreis', 'ct/kWh', 'Börsenpreis', 'Preisblatt', 'Netzentgelt']) {
      expect(hitIds(q)).toContain('stromtarif');
    }
  });

  it('führt die zwei Aufschlags-Wörter zusammen, statt sie gleich zu benennen', () => {
    // Der Sammelaufschlag (Tarif) und der Vertriebsaufschlag (Preisblatt) sind
    // VERSCHIEDENE Größen — beide landen aber beim Stromtarif, weil dort beide
    // Felder wohnen. Das ist die umgesetzte Absicht von D6.
    expect(hitIds('Aufschlag')).toContain('stromtarif');
    expect(hitIds('Vertriebsaufschlag')).toContain('stromtarif');
    expect(TARIF_PARAM_FIELDS.dynamisch.label).toContain('gesamt');
    expect(TARIF_PARAM_FIELDS.dynamisch.label).not.toBe('Vertriebsaufschlag (ct/kWh)');
  });

  it('kennt die ALTEN Namen — sonst wäre die Umbenennung eine Sackgasse', () => {
    expect(hitIds('Anlagentyp')).toContain('veraeusserungsform');
    expect(hitIds('Veräußerungsform')).toContain('veraeusserungsform');
  });

  it('verengt bei mehreren Wörtern, statt zu verbreitern', () => {
    const eins = searchSettings('speicher');
    const zwei = searchSettings('speicher netz');
    expect(eins.length).toBeGreaterThan(zwei.length);
    expect(zwei.every((h) => eins.some((e) => e.id === h.id) || h.group === 'geld')).toBe(true);
  });

  it('normalisiert Umlaute, ß und Satzzeichen', () => {
    expect(normalizeTerm('Veräußerungs-Form!')).toBe('veraeusserungs form');
    expect(hitIds('veraeusserungsform')).toContain('veraeusserungsform');
    expect(hitIds('LÖSCHEN')).toContain('loeschen');
  });

  it('eine leere Eingabe trifft NICHTS (die Suche tut nicht so, als hätte jemand gesucht)', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('deckelt die Trefferliste — eine lange Liste ist keine Antwort', () => {
    // „e" kommt in fast jedem Eintrag vor.
    expect(searchSettings('e').length).toBeLessThanOrEqual(MAX_HITS);
  });

  it('sagt bei keinem Treffer, wo man stattdessen schaut', () => {
    expect(searchSettings('quantencomputer')).toEqual([]);
    expect(noHitText('quantencomputer')).toContain('quantencomputer');
    expect(noHitText('quantencomputer')).toContain('sechs Gruppen');
  });
});

describe('E6 · der Index selbst', () => {
  it('jeder Eintrag hat eine eindeutige Id und zeigt auf eine echte Gruppe', () => {
    const ids = GLOSSAR.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of GLOSSAR) {
      expect(GROUP_LABEL[e.group]).toBeTruthy();
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
    }
  });

  it('deckt alle sechs Gruppen ab — keine bleibt unauffindbar', () => {
    const groups = new Set(GLOSSAR.map((e) => e.group));
    for (const g of Object.keys(GROUP_LABEL)) expect(groups.has(g as never)).toBe(true);
  });

  it('jeder Eintrag ist über sein eigenes Label auffindbar', () => {
    for (const e of GLOSSAR) {
      // Das erste Wort des Labels genügt (die Suche vergleicht auf Teilkette).
      const wort = normalizeTerm(e.label).split(' ')[0];
      expect(hitIds(wort)).toContain(e.id);
    }
  });
});

describe('E6/D6 · die Umbenennungen', () => {
  it('„Anlagentyp" heißt jetzt Veräußerungsform, mit Kundenfrage und Fachwort', () => {
    expect(VERAEUSSERUNGSFORM_LABEL).toBe('Veräußerungsform');
    expect(VERAEUSSERUNGSFORM_FRAGE).toContain('vergütet');
    expect(VERAEUSSERUNGSFORM_TIP).toContain('§ 21b EEG');
  });

  it('„Ihr Strompreis" heißt jetzt Arbeitspreis (all-in, brutto)', () => {
    expect(TARIF_PARAM_FIELDS.fest.label).toBe('Arbeitspreis (all-in, brutto) (ct/kWh)');
    expect(TARIF_PARAM_FIELDS.fest.label).not.toContain('Ihr Strompreis');
    expect(TARIF_PARAM_FIELDS.fest.help).toContain('ohne Grundpreis');
  });
});

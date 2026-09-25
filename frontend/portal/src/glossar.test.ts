import { describe, expect, it } from 'vitest';
import {
  GLOSSAR,
  normalizeTerm,
  VERAEUSSERUNGSFORM_FRAGE,
  VERAEUSSERUNGSFORM_LABEL,
  VERAEUSSERUNGSFORM_TIP,
} from './glossar';
import { TARIF_PARAM_FIELDS } from './tariffInput';

describe('normalizeTerm · der Vergleich für Suchen im Portal', () => {
  it('normalisiert Umlaute, ß und Satzzeichen', () => {
    expect(normalizeTerm('Veräußerungs-Form!')).toBe('veraeusserungs form');
    expect(normalizeTerm('LÖSCHEN')).toBe('loeschen');
  });
});

describe('die Suchwörter der Einstellungen (Stichworte der Hilfe)', () => {
  it('jeder Eintrag hat eine eindeutige Id, ein Label und Suchwörter', () => {
    const ids = GLOSSAR.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of GLOSSAR) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
    }
  });

  it('kennt die ALTEN Namen - wer „Anlagentyp" sucht, findet die Erklärung', () => {
    const woerter = GLOSSAR.flatMap((e) => [e.label, ...e.synonyms].map(normalizeTerm));
    expect(woerter.some((w) => w.includes('anlagentyp'))).toBe(true);
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

  it('benennt die zwei Aufschläge verschieden - der Sammelaufschlag heißt „gesamt"', () => {
    // Der Sammelaufschlag (Tarif) und der Vertriebsaufschlag (Preisblatt) sind
    // VERSCHIEDENE Größen - die umgesetzte Absicht von D6.
    expect(TARIF_PARAM_FIELDS.dynamisch.label).toContain('gesamt');
    expect(TARIF_PARAM_FIELDS.dynamisch.label).not.toBe('Vertriebsaufschlag (ct/kWh)');
  });
});

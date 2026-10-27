import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Einspeiseverguetung, EinspeiseverguetungZustand } from './api';
import {
  angabeMoeglich,
  giltJetzt,
  herleitungOption,
  negativpreisSatz,
  OHNE_ANGABE,
  parseVerguetungInput,
  ruhtErklaerung,
  satzText,
  STICHTAG_FEHLER,
  STICHTAG_FRAGE,
  STICHTAG_WAHL,
  tagText,
  verguetungFolge,
  verguetungHinweise,
  verguetungInputText,
  verguetungZeile,
} from './einspeiseverguetung';

const NBSP = ' ';

/** Das geschlossene Vokabular des Servers - dieselbe Datei prüfen Optimierer und api. */
const VEKTOREN = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/einspeiseverguetung-vectors.json'), 'utf8'),
) as { zustaende: EinspeiseverguetungZustand[] };

function stand(over: Partial<Einspeiseverguetung> = {}): Einspeiseverguetung {
  return {
    zustand: 'eeg',
    wirksamCtKwh: 7.94,
    angegebenCtKwh: null,
    inbetriebnahmeAbSolarspitzengesetz: null,
    hergeleitetCtKwh: 7.94,
    hergeleitetGenaehert: false,
    inbetriebnahme: '2025-06-01',
    leistungKwp: 9.8,
    eegEndeAm: '2045-12-31',
    ohneVerguetungBeiNegativpreis: true,
    anzulegenderWertCtKwh: null,
    ...over,
  };
}

describe('einspeiseverguetung · jeder Zustand des Servers hat seine Zeile', () => {
  it('deckt das geschlossene Vokabular der Vertragsdatei ab - ohne Lücke', () => {
    expect(VEKTOREN.zustaende).toHaveLength(6);
    for (const zustand of VEKTOREN.zustaende) {
      const z = verguetungZeile(stand({ zustand, wirksamCtKwh: null }));
      expect(z, zustand).toBeDefined();
      expect(z.wert.length, zustand).toBeGreaterThan(0);
      expect(z.sub.length, zustand).toBeGreaterThan(0);
      // Nie eine erfundene Null, wo der Server keinen Satz nennt.
      expect(z.wert, zustand).not.toMatch(/^0/);
    }
  });

  it('hergeleitet: der Satz, und darunter woher er kommt', () => {
    expect(verguetungZeile(stand())).toEqual({
      wert: `7,94${NBSP}ct/kWh`,
      sub: 'hergeleitet aus EEG, Inbetriebnahme 01.06.2025',
      warn: false,
    });
  });

  it('angegeben: der eigene Satz, „von Ihnen angegeben"', () => {
    const s = stand({ zustand: 'angegeben', wirksamCtKwh: 12.5, angegebenCtKwh: 12.5 });
    expect(verguetungZeile(s)).toEqual({ wert: `12,50${NBSP}ct/kWh`, sub: 'von Ihnen angegeben', warn: false });
    // Auch 0 ist eine Angabe - sie steht als Zahl da, nicht als „ohne Angabe".
    expect(verguetungZeile(stand({ zustand: 'angegeben', wirksamCtKwh: 0, angegebenCtKwh: 0 })).wert).toBe(
      `0,00${NBSP}ct/kWh`,
    );
  });

  it('ohne Grundlage: „ohne Angabe", hervorgehoben - keine stille Null', () => {
    const s = stand({
      zustand: 'ohne_angabe',
      wirksamCtKwh: null,
      hergeleitetCtKwh: null,
      inbetriebnahme: null,
      leistungKwp: null,
      eegEndeAm: null,
      ohneVerguetungBeiNegativpreis: false,
    });
    expect(verguetungZeile(s)).toEqual({ wert: OHNE_ANGABE, sub: 'Vergütung nicht hinterlegt', warn: true });
  });

  it('nach dem Ende der EEG-Vergütung: Börsenpreis mit dem Tag, an dem sie endete', () => {
    const s = stand({ zustand: 'eeg_abgelaufen', wirksamCtKwh: null, inbetriebnahme: '2004-05-01', eegEndeAm: '2024-12-31' });
    expect(verguetungZeile(s)).toEqual({
      wert: 'Börsenpreis',
      sub: 'EEG-Vergütung endete am 31.12.2024',
      warn: false,
    });
  });

  it('Direktvermarktung und Netzladen: Börsenpreis mit Grund, kein fester Satz vorgetäuscht', () => {
    expect(verguetungZeile(stand({ zustand: 'direktvermarktung', wirksamCtKwh: null })).wert).toBe(
      'Börsenpreis + Marktprämie',
    );
    expect(verguetungZeile(stand({ zustand: 'netzladen', wirksamCtKwh: null })).sub).toBe(
      'solange Netzladen erlaubt ist',
    );
  });
});

describe('einspeiseverguetung · das Blatt', () => {
  it('nimmt eine Angabe genau dort an, wo sie auch wirkt', () => {
    expect(angabeMoeglich('eeg')).toBe(true);
    expect(angabeMoeglich('angegeben')).toBe(true);
    expect(angabeMoeglich('eeg_abgelaufen')).toBe(true);
    expect(angabeMoeglich('ohne_angabe')).toBe(true);
    expect(angabeMoeglich('netzladen')).toBe(false);
    expect(angabeMoeglich('direktvermarktung')).toBe(false);
  });

  it('„Gilt jetzt" ist dieselbe Aussage wie die Zeile', () => {
    const s = stand({ zustand: 'angegeben', wirksamCtKwh: 12.5, angegebenCtKwh: 12.5 });
    expect(giltJetzt(s)).toEqual({ wert: `12,50${NBSP}ct/kWh`, herkunft: 'von Ihnen angegeben' });
  });

  it('die Option „herleiten" zeigt, worauf Zurücksetzen führt - auch während ein eigener Satz gilt', () => {
    const s = stand({ zustand: 'angegeben', wirksamCtKwh: 12.5, angegebenCtKwh: 12.5 });
    expect(herleitungOption(s)).toBe(`7,94${NBSP}ct/kWh · Inbetriebnahme 01.06.2025, 9,8${NBSP}kWp · bis 31.12.2045`);
    // Ohne Leistung nennt sie nur die Inbetriebnahme.
    expect(herleitungOption(stand({ leistungKwp: null }))).toBe(
      `7,94${NBSP}ct/kWh · Inbetriebnahme 01.06.2025 · bis 31.12.2045`,
    );
  });

  it('ohne Inbetriebnahmedatum gibt es keine Herleitung - und den Weg dorthin', () => {
    const text = herleitungOption(stand({ zustand: 'ohne_angabe', inbetriebnahme: null, hergeleitetCtKwh: null }));
    expect(text).toBe('Ohne Inbetriebnahmedatum keine Herleitung - es gilt der Börsenpreis.');
  });

  it('nach dem Ende sagt die Option, seit wann der Börsenpreis gilt', () => {
    const s = stand({ zustand: 'eeg_abgelaufen', inbetriebnahme: '2004-05-01', eegEndeAm: '2024-12-31', hergeleitetCtKwh: 24.4 });
    expect(herleitungOption(s)).toMatch(/endete am 31\.12\.2024, seitdem gilt der Börsenpreis/);
  });

  it('nennt die Lage nach § 51a in beide Richtungen - und den Näherungswert nur, wo er gilt', () => {
    expect(verguetungHinweise(stand())).toEqual([
      'Bei negativem Börsenpreis gibt es für Ihre Anlage keine Vergütung (§ 51a EEG) - das gilt auch für einen eigenen Satz.',
    ]);
    const alt = stand({ ohneVerguetungBeiNegativpreis: false, hergeleitetGenaehert: true, inbetriebnahme: '2010-04-01' });
    expect(verguetungHinweise(alt)).toEqual([
      'Ihre Anlage ging vor dem 25.02.2025 in Betrieb: die Vergütung gilt auch bei negativem Börsenpreis.',
      'Für Anlagen vor dem 30.07.2022 ist die Herleitung ein Näherungswert. Den genauen Satz finden Sie in der Abrechnung Ihres Netzbetreibers.',
    ]);
    // Nach dem Ende der EEG-Vergütung gibt es keine, die „auch bei negativem Preis" gälte.
    expect(
      verguetungHinweise(stand({ zustand: 'eeg_abgelaufen', ohneVerguetungBeiNegativpreis: false, inbetriebnahme: '2004-05-01' })),
    ).toEqual([]);
  });

  it('ohne Datum stellt das Blatt die Frage statt eines Satzes - nie eine stille Annahme', () => {
    const ohne = stand({ zustand: 'ohne_angabe', inbetriebnahme: null, wirksamCtKwh: null, hergeleitetCtKwh: null });
    expect(negativpreisSatz(ohne)).toBeNull();
    expect(verguetungHinweise({ ...ohne, ohneVerguetungBeiNegativpreis: true })).toEqual([]);
    expect(STICHTAG_FRAGE).toBe('Wann ging Ihre Anlage in Betrieb?');
    expect(STICHTAG_WAHL.ab.hint).toMatch(/§ 51a/);
    expect(STICHTAG_FEHLER).toMatch(/negativem Börsenpreis/);
  });

  it('erklärt Direktvermarktung und Netzladen, statt etwas anzunehmen', () => {
    expect(ruhtErklaerung(stand())).toBeNull();
    const dv = ruhtErklaerung(stand({ zustand: 'direktvermarktung', anzulegenderWertCtKwh: 8.11 }))!;
    expect(dv).toBe(`Ihr Erlös ist der Börsenpreis, dazu kommt die Marktprämie aus Ihrem anzulegenden Wert (8,11${NBSP}ct/kWh).`);
    expect(ruhtErklaerung(stand({ zustand: 'direktvermarktung', anzulegenderWertCtKwh: null }))).toMatch(
      /„Anzulegender Wert" ein/,
    );
    const netz = ruhtErklaerung(stand({ zustand: 'netzladen', angegebenCtKwh: 12.5 }))!;
    expect(netz).toMatch(/Ausschließlichkeitsprinzip/);
    expect(netz).toContain(`Ihr Satz von 12,50${NBSP}ct/kWh gilt wieder, sobald Netzladen aus ist.`);
    expect(ruhtErklaerung(stand({ zustand: 'netzladen', angegebenCtKwh: null }))).not.toMatch(/gilt wieder/);
  });

  it('sagt nach dem Speichern, wann was wirkt', () => {
    expect(verguetungFolge(stand({ zustand: 'angegeben' }))).toMatch(/nächsten Fahrplan gilt Ihr Satz/);
    expect(verguetungFolge(stand({ zustand: 'eeg' }))).toMatch(/wieder der Satz aus dem EEG/);
    expect(verguetungFolge(stand({ zustand: 'ohne_angabe' }))).toMatch(/wieder der Börsenpreis/);
    expect(verguetungFolge(stand({ zustand: 'eeg_abgelaufen' }))).toMatch(/wieder der Börsenpreis/);
  });
});

describe('einspeiseverguetung · die Eingabe', () => {
  it('liest deutsches Komma und Punkt, höchstens drei Stellen, 0 bis 100', () => {
    expect(parseVerguetungInput('8,2')).toBe(8.2);
    expect(parseVerguetungInput(' 12.5 ')).toBe(12.5);
    expect(parseVerguetungInput('0')).toBe(0);
    expect(parseVerguetungInput('100')).toBe(100);
    expect(parseVerguetungInput('7,123')).toBe(7.123);
  });

  it('leer ist null, alles andere ungültig', () => {
    expect(parseVerguetungInput('')).toBeNull();
    expect(parseVerguetungInput('   ')).toBeNull();
    for (const falsch of ['abc', '-1', '100,5', '7,1234', '8,2 ct']) {
      expect(parseVerguetungInput(falsch), falsch).toBeUndefined();
    }
  });

  it('ein gespeicherter Satz wird zum Feldtext mit Komma', () => {
    expect(verguetungInputText(12.5)).toBe('12,5');
    expect(verguetungInputText(null)).toBe('');
  });

  it('Tage und Sätze im Hausformat', () => {
    expect(tagText('2025-06-01')).toBe('01.06.2025');
    expect(satzText(7.5)).toBe(`7,50${NBSP}ct/kWh`);
  });
});

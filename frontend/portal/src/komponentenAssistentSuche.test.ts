import { describe, expect, it } from 'vitest';
import {
  hervorheben,
  MAX_TREFFER,
  modellAliase,
  modellSuche,
  modellZusatz,
  normalisiereSuche,
  suchBegriffe,
  type ComponentTemplate,
} from './komponentenAssistent';

function tpl(over: Partial<ComponentTemplate> = {}): ComponentTemplate {
  return {
    templateRef: 'builtin:deye:sun-30k-sg01hp3-eu',
    kind: 'builtin',
    version: 1,
    brand: 'deye',
    brandLabel: 'Deye',
    model: 'sun-30k-sg01hp3-eu',
    modelLabel: 'SUN-30K-SG01HP3-EU',
    family: 'hybrid_3p',
    familyLabel: 'Hybrid, 3-phasig',
    communication: 'solarman_v5',
    communicationLabel: 'Solarman-Logger (WLAN-Stick)',
    ratedKw: 30,
    ...over,
  };
}

const KATALOG: ComponentTemplate[] = [
  tpl(),
  tpl({
    templateRef: 'builtin:deye:sun-30k-sg02hp3-eu-am3',
    model: 'sun-30k-sg02hp3-eu-am3',
    modelLabel: 'SUN-30K-SG02HP3-EU-AM3',
  }),
  tpl({
    templateRef: 'builtin:deye:sun-12k-sg04lp3',
    model: 'sun-12k-sg04lp3',
    modelLabel: 'SUN-12K-SG04LP3',
    ratedKw: 12,
  }),
  tpl({
    templateRef: 'builtin:fronius_sunspec:eco-27',
    brand: 'fronius_sunspec',
    brandLabel: 'Fronius (Modbus / SunSpec)',
    model: 'eco-27',
    modelLabel: 'Eco 27.0-3-S',
    family: 'sunspec_live',
    familyLabel: 'SunSpec (live)',
    communication: 'fronius_sunspec',
    communicationLabel: 'SunSpec über das Netzwerk',
    ratedKw: 27,
  }),
];

/**
 * ⚠ Der Captain-Befund als Test (NACHTRAG 5): wer sein Modell nicht schon
 * einer Marke zuordnen kann, findet es im Stufenmenü nicht - und wer den Namen
 * vom Typenschild abtippt, trifft die Schreibweise selten exakt.
 */
describe('die Modell-Suche findet über ALLE Marken hinweg', () => {
  it('findet den Live-Fall über einen Namens-TEIL', () => {
    const s = modellSuche(KATALOG, 'SG02');
    expect(s.treffer.map((t) => t.template.modelLabel)).toEqual(['SUN-30K-SG02HP3-EU-AM3']);
    expect(s.leer).toBeNull();
  });

  it('⚠ ist tolerant gegen Schreibweisen - Bindestriche, Leerzeichen, Groß/klein', () => {
    for (const q of ['SUN-30K', 'sun 30k', 'sun30k', 'SUN30k', 'sUn-30 K']) {
      const s = modellSuche(KATALOG, q);
      expect(s.treffer.length, q).toBe(2);
      expect(s.treffer.every((t) => t.template.modelLabel.startsWith('SUN-30K')), q).toBe(true);
    }
  });

  it('sucht über die MARKE genauso wie über das Modell', () => {
    expect(modellSuche(KATALOG, 'fronius').treffer.map((t) => t.template.modelLabel))
      .toEqual(['Eco 27.0-3-S']);
    // Mehrere Begriffe sind ein UND, nie ein ODER.
    expect(modellSuche(KATALOG, 'deye 12k').treffer.map((t) => t.template.modelLabel))
      .toEqual(['SUN-12K-SG04LP3']);
    expect(modellSuche(KATALOG, 'deye fronius').treffer).toEqual([]);
  });

  it('findet auch über Familie und Anbindung - das steht auf keinem Typenschild, aber im Kopf', () => {
    expect(modellSuche(KATALOG, '3-phasig').treffer.length).toBe(3);
    expect(modellSuche(KATALOG, 'solarman').treffer.length).toBe(3);
  });

  it('stellt das MODELL vor die Marke - wer „SG02" tippt, meint kein Fabrikat', () => {
    const s = modellSuche(KATALOG, 'sun');
    expect(s.treffer[0].template.modelLabel.startsWith('SUN')).toBe(true);
  });

  it('⚠ ohne Eingabe gibt es KEINE Treffer und keinen Zähler', () => {
    for (const q of ['', '   ']) {
      const s = modellSuche(KATALOG, q);
      expect(s.treffer).toEqual([]);
      expect(s.zaehler).toBeNull();
      expect(s.leer).toBeNull();
    }
  });

  it('nennt den GRUND, wenn nichts passt - und den Weg daneben', () => {
    const s = modellSuche(KATALOG, 'huawei');
    expect(s.treffer).toEqual([]);
    expect(s.leer).toMatch(/Keine Vorlage passt/);
    expect(s.leer).toMatch(/Marken-Auswahl/);
  });

  it('⚠ verschweigt den Deckel nie', () => {
    const viele = Array.from({ length: MAX_TREFFER + 5 }, (_, i) => tpl({
      templateRef: `builtin:deye:sun-x${i}`,
      model: `sun-x${i}`,
      modelLabel: `SUN-X${i}`,
    }));
    const s = modellSuche(viele, 'sun');
    expect(s.treffer.length).toBe(MAX_TREFFER);
    expect(s.gesamt).toBe(MAX_TREFFER + 5);
    expect(s.zaehler).toBe(`${MAX_TREFFER} von ${MAX_TREFFER + 5} Treffern - Suche verfeinern zeigt die übrigen.`);
  });
});

describe('die Zusatz-Angaben werden GELESEN, nie geraten', () => {
  it('nennt Nennleistung, Bauart und Anbindung', () => {
    expect(modellZusatz(tpl())).toBe('30 kW · Hybrid, 3-phasig · Solarman-Logger (WLAN-Stick)');
  });

  it('⚠ lässt eine unbekannte Nennleistung WEG statt 0 kW zu behaupten', () => {
    expect(modellZusatz(tpl({ ratedKw: null }))).toBe('Hybrid, 3-phasig · Solarman-Logger (WLAN-Stick)');
    expect(modellZusatz(tpl({ ratedKw: 0 }))).not.toMatch(/kW/);
    expect(modellZusatz(tpl({ ratedKw: null, familyLabel: null, communicationLabel: '' })))
      .toBe('');
  });
});

describe('die Hervorhebung trifft das ORIGINAL, nicht die normalisierte Fassung', () => {
  it('markiert quer über einen Bindestrich hinweg', () => {
    const teile = hervorheben('SUN-30K-SG01HP3', suchBegriffe('sun30k'));
    expect(teile.filter((t) => t.treffer).map((t) => t.text)).toEqual(['SUN-30K']);
    expect(teile.map((t) => t.text).join('')).toBe('SUN-30K-SG01HP3');
  });

  it('lässt einen Text ohne Treffer unangetastet', () => {
    expect(hervorheben('Deye', suchBegriffe('fronius'))).toEqual([{ text: 'Deye', treffer: false }]);
    expect(hervorheben('Deye', [])).toEqual([{ text: 'Deye', treffer: false }]);
  });

  it('normalisiert Umlaute und ß auf beiden Seiten', () => {
    expect(normalisiereSuche('Größe-Ä')).toBe('grossea');
    expect(normalisiereSuche('SUN-30K / EU')).toBe('sun30keu');
    expect(suchBegriffe('  A  B  ')).toEqual(['a', 'b']);
  });
});

describe('die TYPENSCHILD-VARIANTEN (Bauplan P8)', () => {
  const BM3 = 'SUN-30K-SG01HP3-EU-BM3';
  const BM4 = 'SUN-30K-SG01HP3-EU-BM4';
  const MIT_VARIANTEN = tpl({ modelAliases: [BM3, BM4] });

  it('findet das Modell über den Namen, der auf dem Gerät steht', () => {
    const { treffer } = modellSuche([MIT_VARIANTEN, ...KATALOG.slice(1)], 'BM3');
    expect(treffer).toHaveLength(1);
    // ⚠ Gewählt wird das MODELL, nie die Variante: der Vorlagen-Schlüssel und
    // die Modell-Kennung sind unverändert die des Katalog-Eintrags (an ihnen
    // hängt die Steuerungs-Freigabe).
    expect(treffer[0].template.model).toBe('sun-30k-sg01hp3-eu');
    expect(treffer[0].template.templateRef).toBe('builtin:deye:sun-30k-sg01hp3-eu');
    expect(treffer[0].modell.map((x) => x.text).join('')).toBe('SUN-30K-SG01HP3-EU');
  });

  it('findet auch das vollständige Typenschild', () => {
    const { treffer } = modellSuche([MIT_VARIANTEN, ...KATALOG.slice(1)], BM3);
    expect(treffer.map((x) => x.template.model)).toEqual(['sun-30k-sg01hp3-eu']);
  });

  it('nennt die Varianten im Zusatz, damit der Treffer sich erklärt', () => {
    expect(modellZusatz(MIT_VARIANTEN)).toContain(`Typenschild auch ${BM3} / ${BM4}`);
  });

  it('⚠ behauptet ohne Varianten NICHTS - absent, null und leer sind dasselbe', () => {
    expect(modellAliase(tpl())).toEqual([]);
    expect(modellAliase(tpl({ modelAliases: null }))).toEqual([]);
    expect(modellAliase(tpl({ modelAliases: [] }))).toEqual([]);
    expect(modellZusatz(tpl())).not.toContain('Typenschild');
    // Ein älterer Backend-Stand liefert das Feld gar nicht: die Suche bleibt,
    // was sie war.
    expect(modellSuche(KATALOG, 'BM3').treffer).toHaveLength(0);
  });

  it('räumt Leerraum und Nicht-Zeichenketten weg, statt sie anzuzeigen', () => {
    const t = tpl({ modelAliases: ['  ' + BM3 + ' ', '', 7 as unknown as string] });
    expect(modellAliase(t)).toEqual([BM3]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ansage,
  ausloeserText,
  ersteAktive,
  naechster,
  suche,
  sucheSichtbar,
  SUCHE_AB,
  tippSprung,
  umschalten,
  waehlbare,
  type VpOption,
} from './optionen';

const O = (value: string, label: string, extra: Partial<VpOption> = {}): VpOption => ({
  value,
  label,
  ...extra,
});

const ANLAGEN: VpOption[] = [
  O('a', 'Auernheim', { sub: 'Alles in Ordnung · DE-LU', dot: 'ok' }),
  O('b', 'Hof Lindenberg', { sub: 'Gerät meldet sich nicht · DE-LU', dot: 'warn' }),
  O('c', 'Solarpark Dachau', { sub: 'Alles in Ordnung · DE-LU', dot: 'ok' }),
];

describe('die Suche blendet sich selbst ein und aus', () => {
  it('bleibt unter der Schwelle weg - drei Zeilen liest man schneller als man tippt', () => {
    expect(sucheSichtbar(3)).toBe(false);
    expect(sucheSichtbar(SUCHE_AB - 1)).toBe(false);
  });

  it('erscheint ab der Schwelle', () => {
    expect(sucheSichtbar(SUCHE_AB)).toBe(true);
    expect(sucheSichtbar(40)).toBe(true);
  });

  it('lässt sich erzwingen und abschalten', () => {
    expect(sucheSichtbar(2, 'immer')).toBe(true);
    expect(sucheSichtbar(99, 'nie')).toBe(false);
  });
});

describe('die Suche ist tolerant - dieselbe wie die Modell-Suche', () => {
  it('findet über Schreibweisen hinweg', () => {
    for (const q of ['lindenberg', 'LINDENBERG', 'hof linden']) {
      expect(suche(ANLAGEN, q).zeilen.map((z) => z.key)).toEqual(['b']);
    }
  });

  it('durchsucht auch die NEBENZEILE', () => {
    expect(suche(ANLAGEN, 'meldet sich nicht').zeilen.map((z) => z.key)).toEqual(['b']);
  });

  it('durchsucht die unsichtbaren Stichwörter, ohne sie anzuzeigen', () => {
    const mit = [O('x', 'Wechselrichter Scheune', { keywords: 'SUN-30K SG01HP3 deye' })];
    expect(suche(mit, 'sg01').zeilen).toHaveLength(1);
    expect(suche(mit, 'sg01').zeilen[0]).toMatchObject({ art: 'option' });
  });

  it('verlangt JEDEN Begriff (UND, nie ODER)', () => {
    expect(suche(ANLAGEN, 'hof dachau').zeilen).toEqual([]);
  });

  it('hebt die Fundstelle im ORIGINAL hervor', () => {
    const z = suche(ANLAGEN, 'linden').zeilen[0];
    if (z.art !== 'option') throw new Error('Zeile erwartet');
    expect(z.treffer.label.filter((t) => t.treffer).map((t) => t.text)).toEqual(['Linden']);
  });

  it('sagt ehrlich, wenn nichts passt - nie ein stiller leerer Bereich', () => {
    const s = suche(ANLAGEN, 'huawei');
    expect(s.zeilen).toEqual([]);
    expect(s.leer).toContain('huawei');
  });

  it('lässt den leeren Satz vom Aufrufer überschreiben', () => {
    expect(suche(ANLAGEN, 'zzz', [], (q) => `nix zu ${q}`).leer).toBe('nix zu zzz');
  });

  it('sortiert Präfix-Treffer nach oben', () => {
    const opts = [O('1', 'Nordwind Hamburg'), O('2', 'Hamburger Hof')];
    expect(suche(opts, 'hamburg').zeilen.map((z) => z.key)).toEqual(['2', '1']);
  });

  it('lässt OHNE Eingabe die Reihenfolge des Aufrufers unangetastet', () => {
    // Eine Liste, die sich beim Öffnen umsortiert, nimmt jedem seine Ortskenntnis.
    expect(suche(ANLAGEN, '').zeilen.map((z) => z.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('Gruppen', () => {
  const KATALOG: VpOption[] = [
    O('d1', 'SUN-30K', { group: 'deye' }),
    O('f1', 'Symo 10.0-3-M', { group: 'fronius' }),
    O('d2', 'SUN-12K', { group: 'deye' }),
    O('frei', 'Eigenes Gerät'),
  ];
  const GRUPPEN = [
    { key: 'deye', label: 'Deye' },
    { key: 'fronius', label: 'Fronius' },
  ];

  it('bündelt in der Reihenfolge des Aufrufers, Ungruppiertes steht oben', () => {
    expect(suche(KATALOG, '', GRUPPEN).zeilen.map((z) => `${z.art}:${z.key}`)).toEqual([
      'option:frei',
      'gruppe:deye',
      'option:d1',
      'option:d2',
      'gruppe:fronius',
      'option:f1',
    ]);
  });

  it('lässt eine LEER gefilterte Gruppe samt Überschrift weg', () => {
    // Mit Eingabe sortiert die Suche nach Rang, dann alphabetisch -
    // „SUN-12K" vor „SUN-30K"; die leere Fronius-Gruppe fehlt ganz.
    expect(suche(KATALOG, 'sun', GRUPPEN).zeilen.map((z) => z.key)).toEqual(['deye', 'd2', 'd1']);
  });

  it('findet ein Modell auch über seinen GRUPPEN-Namen', () => {
    expect(suche(KATALOG, 'fronius', GRUPPEN).zeilen.map((z) => z.key))
      .toEqual(['fronius', 'f1']);
  });
});

describe('eine GESPERRTE Zeile bleibt sichtbar und nennt ihren Grund', () => {
  const MIT_SPERRE = [
    O('a', 'Marktoptimierung', { disabled: true, disabledHint: 'Noch nicht freigeschaltet' }),
    O('b', 'Eigenverbrauch'),
  ];

  it('wird mitgezeigt - sie ist die Antwort auf „warum geht das nicht?"', () => {
    expect(suche(MIT_SPERRE, '').zeilen).toHaveLength(2);
  });

  it('ist aber kein Ziel der Tastatur', () => {
    const z = suche(MIT_SPERRE, '').zeilen;
    expect(waehlbare(z)).toEqual([1]);
    expect(ersteAktive(z, null)).toBe(1);
  });
});

describe('die Tastatur-Arithmetik', () => {
  const z = suche(ANLAGEN, '').zeilen;

  it('geht Schritt für Schritt', () => {
    expect(naechster(z, -1, 1)).toBe(0);
    expect(naechster(z, 0, 1)).toBe(1);
    expect(naechster(z, 1, -1)).toBe(0);
  });

  it('LÄUFT NICHT UM - wie das native Select', () => {
    expect(naechster(z, 2, 1)).toBe(2);
    expect(naechster(z, 0, -1)).toBe(0);
  });

  it('springt mit Bild-auf/-ab bis an den Rand, nie darüber hinaus', () => {
    expect(naechster(z, 0, 10)).toBe(2);
    expect(naechster(z, 2, -10)).toBe(0);
  });

  it('überspringt Gruppen-Überschriften', () => {
    const g = suche(
      [O('a', 'A', { group: 'g1' }), O('b', 'B', { group: 'g2' })],
      '',
      [{ key: 'g1', label: 'G1' }, { key: 'g2', label: 'G2' }],
    ).zeilen;
    // [gruppe, a, gruppe, b]
    expect(naechster(g, 1, 1)).toBe(3);
  });

  it('öffnet auf dem GEWÄHLTEN Wert, sonst auf der ersten Zeile', () => {
    expect(ersteAktive(z, 'c')).toBe(2);
    expect(ersteAktive(z, null)).toBe(0);
    expect(ersteAktive(z, 'weg')).toBe(0);
    expect(ersteAktive([], null)).toBe(-1);
  });
});

describe('Tippen-zum-Springen (ohne sichtbares Suchfeld, wie nativ)', () => {
  const z = suche(ANLAGEN, '').zeilen;

  it('springt auf den Anfangsbuchstaben', () => {
    expect(tippSprung(z, 'h', -1)).toBe(1);
    expect(tippSprung(z, 's', -1)).toBe(2);
  });

  it('nimmt mehrere Zeichen als EIN Wort', () => {
    expect(tippSprung(z, 'sol', -1)).toBe(2);
  });

  it('bleibt stehen, wenn nichts passt', () => {
    expect(tippSprung(z, 'x', 0)).toBe(-1);
  });

  it('bleibt auf der aktuellen Zeile, wenn nur sie passt', () => {
    expect(tippSprung(z, 'auern', 0)).toBe(0);
  });
});

describe('die Ansage behauptet nur, was gezählt wurde', () => {
  it('schweigt ohne Suche - die Liste steht ja vollständig da', () => {
    expect(ansage(suche(ANLAGEN, ''), '')).toBe('');
  });

  it('zählt bei einer Suche', () => {
    expect(ansage(suche(ANLAGEN, 'hof'), 'hof')).toBe('1 Treffer');
    expect(ansage(suche(ANLAGEN, 'a'), 'a')).toBe('3 Treffer');
  });

  it('sagt den leeren Fall im Klartext', () => {
    expect(ansage(suche(ANLAGEN, 'zzz'), 'zzz')).toContain('zzz');
  });
});

describe('der Auslöser-Text', () => {
  it('nennt den gewählten Wert', () => {
    expect(ausloeserText(ANLAGEN, 'b', '–')).toBe('Hof Lindenberg');
  });

  it('fällt auf den Platzhalter zurück - nie auf eine rohe Kennung', () => {
    expect(ausloeserText(ANLAGEN, null, 'Bitte wählen')).toBe('Bitte wählen');
    expect(ausloeserText(ANLAGEN, 'weg', 'Bitte wählen')).toBe('Bitte wählen');
  });

  it('⚠ der LEERE String ist eine Zeile, wenn die Liste ihn führt', () => {
    // Das native `<option value="">` („Alle Mandanten", „Automatisch",
    // „Jetzt noch nicht verbinden") ist eine echte Wahl, kein „nichts
    // gewählt" - sie darf nicht als Platzhalter erscheinen.
    const mitAlle = [{ value: '', label: 'Alle Mandanten' }, ...ANLAGEN];
    expect(ausloeserText(mitAlle, '', 'Bitte wählen')).toBe('Alle Mandanten');
    // Führt die Liste ihn NICHT, bleibt es beim Platzhalter.
    expect(ausloeserText(ANLAGEN, '', 'Bitte wählen')).toBe('Bitte wählen');
  });

  it('reiht die Mehrfachauswahl auf', () => {
    expect(ausloeserText(ANLAGEN, ['a', 'c'], '–')).toBe('Auernheim, Solarpark Dachau');
    expect(ausloeserText(ANLAGEN, [], '–')).toBe('–');
  });
});

describe('Mehrfachauswahl', () => {
  it('schaltet um und behält die Reihenfolge der Wahl', () => {
    expect(umschalten([], 'a')).toEqual(['a']);
    expect(umschalten(['a'], 'b')).toEqual(['a', 'b']);
    expect(umschalten(['a', 'b'], 'a')).toEqual(['b']);
  });
});

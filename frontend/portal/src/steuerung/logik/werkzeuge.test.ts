import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { faerbe, faerbeZeile } from './einfaerben';
import { probenVergleich, vergleiche, zaehle } from './vergleich';
import { GRUPPEN, SPRACHWOERTER, suche, tabellenDerDatei, zeilen } from './woerter';

const WASSER = readFileSync('../../docs/contracts/v2/steuerlogik/wasser.logic.yaml', 'utf8');

describe('Wortliste', () => {
  it('ist die byte-gleiche Kopie des Vertrags', () => {
    expect(readFileSync('src/steuerung/logik/steuerlogik-woerter.json', 'utf8'))
      .toBe(readFileSync('../../docs/contracts/v2/steuerlogik-woerter.json', 'utf8'));
  });

  it('jede Tabelle der Datei steht in einer Gruppe der Nachschlageseite', () => {
    expect(GRUPPEN.map((g) => g.tabelle).sort()).toEqual(tabellenDerDatei().sort());
  });

  it('kennt die Schlüssel der Textform und findet Wörter auf Englisch und Deutsch', () => {
    expect(SPRACHWOERTER.has('on_when')).toBe(true);
    expect(SPRACHWOERTER.has('editable_by')).toBe(true);
    expect(SPRACHWOERTER.has('netzheizen')).toBe(false);
    expect(suche('holds')[0].zeilen[0]).toEqual({ wort: 'holds', deutsch: 'haelt', satz: 'holds(Bedingung, Dauer): gilt seit mindestens' });
    expect(suche('Neustart').some((g) => g.zeilen.some((z) => z.wort === 'after_restart'))).toBe(true);
    expect(zeilen(GRUPPEN[0]).length).toBe(14);
  });
});

describe('Einfärbung', () => {
  it('trennt Schlüssel der Sprache, Namen des Verfassers, Formel und Kommentar', () => {
    const z = faerbeZeile('      - Der Speicher hat das Ziel erreicht: t >= ziel   # Kommentar');
    expect(z.map((s) => s.art)).toEqual(['einzug', 'strich', 'name', 'zeichen', 'leer', 'bezeichner', 'leer', 'zeichen',
      'zeichen', 'leer', 'bezeichner', 'leer', 'kommentar']);
    const s = faerbeZeile('  heizstab: {level: "if(netzheizen, 3, 0)"}');
    expect(s.find((x) => x.t === 'level')?.art).toBe('schluessel');
    expect(s.find((x) => x.art === 'text')?.t).toBe('"if(netzheizen, 3, 0)"');
    const f = faerbeZeile('    when: holds(t < mindest, 2 min) and not warm');
    expect(f.find((x) => x.t === 'holds')?.art).toBe('funktion');
    expect(f.find((x) => x.t === '2 min')?.art).toBe('zahl');
    expect(f.find((x) => x.t === 'and')?.art).toBe('wort');
    const g = faerbeZeile('  t: {source: 3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a.temperature, name: Speicher}');
    expect(g.find((x) => x.t.startsWith('3d2c'))).toEqual({ t: '3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a.temperature', art: 'bezeichner' });
  });

  it('verliert kein Zeichen', () => {
    const zeilen = faerbe(WASSER);
    expect(zeilen.map((z) => z.map((s) => s.t).join('')).join('\n')).toBe(WASSER);
  });
});

describe('Vergleich zweier Fassungen', () => {
  it('nennt geänderte Zeilen mit ihren Nummern und fasst Gleiches zusammen', () => {
    const neu = WASSER.replace('default: 57 °C', 'default: 60 °C').replace('  frei:        known(t) and not warm\n', '');
    const teile = vergleiche(WASSER, neu);
    expect(zaehle(teile)).toEqual({ dazu: 1, weg: 2 });
    const weg = teile.filter((t) => t.art === 'weg');
    expect(weg.map((t) => (t.art === 'weg' ? t.alt : 0))).toEqual([
      WASSER.split('\n').findIndex((l) => l.includes('default: 57 °C')) + 1,
      WASSER.split('\n').findIndex((l) => l.startsWith('  frei:')) + 1,
    ]);
    expect(teile[0].art).toBe('ausgelassen');
    // Erst die alte Zeile, dann die neue.
    const i = teile.findIndex((t) => t.art === 'weg');
    expect(teile[i + 1].art).toBe('dazu');
    expect(vergleiche(WASSER, WASSER)).toEqual([{ art: 'ausgelassen', anzahl: WASSER.split('\n').length }]);
  });

  it('nennt Proben, die dazukamen, wegfielen oder ihr Ergebnis änderten', () => {
    const p = (name: string, besteht: boolean) => ({ name, besteht, abweichungen: [] });
    expect(probenVergleich({ proben: [p('A', true), p('B', true)] }, { proben: [p('A', false), p('C', true)] })).toEqual([
      { name: 'A', was: 'besteht nicht' }, { name: 'C', was: 'neu' }, { name: 'B', was: 'weg' },
    ]);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entferne, fuegeAn, lies, setze, skalar, verschiebe, Wort, zeilenVon } from './text';

const WASSER = readFileSync('../../docs/contracts/v2/steuerlogik/wasser.logic.yaml', 'utf8');

function js(text: string): Record<string, unknown> {
  const g = lies(text);
  if (!g.ok) throw new Error(`${g.fehler} (Zeile ${g.zeile})`);
  return g.doc.toJS() as Record<string, unknown>;
}

/** Die Zeilen, die sich unterscheiden (gleich lange Texte: Zeile für Zeile; sonst über den gemeinsamen Rand). */
function geaendert(alt: string, neu: string): { weg: string[]; dazu: string[] } {
  const a = alt.split('\n');
  const b = neu.split('\n');
  let vorne = 0;
  while (vorne < a.length && vorne < b.length && a[vorne] === b[vorne]) vorne++;
  let hinten = 0;
  while (hinten < a.length - vorne && hinten < b.length - vorne && a[a.length - 1 - hinten] === b[b.length - 1 - hinten]) {
    hinten++;
  }
  return { weg: a.slice(vorne, a.length - hinten), dazu: b.slice(vorne, b.length - hinten) };
}

describe('Skalare der Textform', () => {
  it('schreibt Uhrzeiten, Zahlwörter und Ja/Nein-Wörter in Anführungszeichen', () => {
    expect(skalar('06:00')).toBe('"06:00"');
    expect(skalar('57')).toBe('"57"');
    expect(skalar('yes')).toBe('"yes"');
    expect(skalar('on')).toBe('"on"');
    expect(skalar(new Wort('on'))).toBe('on');
    expect(skalar('57 °C')).toBe('57 °C');
    expect(skalar('t >= ziel - 3 K')).toBe('t >= ziel - 3 K');
    expect(skalar('-netz + 3 kW')).toBe('-netz + 3 kW');
    expect(skalar('a: b')).toBe('"a: b"');
    expect(skalar('if(a, 1, 0)')).toBe('if(a, 1, 0)');
    expect(skalar('if(a, 1, 0)', true)).toBe('"if(a, 1, 0)"');
    expect(skalar(3)).toBe('3');
    expect(skalar(true)).toBe('true');
  });
});

describe('Ändern ändert nur die betroffenen Zeilen', () => {
  it('ein Wert in einem Fluss-Objekt bleibt an seinem Platz', () => {
    const neu = setze(WASSER, ['settings', 'ziel', 'default'], '60 °C');
    expect((js(neu).settings as Record<string, Record<string, unknown>>).ziel.default).toBe('60 °C');
    const d = geaendert(WASSER, neu);
    expect(d.weg).toHaveLength(1);
    expect(d.dazu).toEqual([d.weg[0].replace('default: 57 °C', 'default: 60 °C')]);
  });

  it('eine Uhrzeit bekommt Anführungszeichen', () => {
    const neu = setze(WASSER, ['settings', 'netz_ab', 'default'], '05:30');
    expect(neu).toContain('default: "05:30"');
    expect((js(neu).settings as Record<string, Record<string, unknown>>).netz_ab.default).toBe('05:30');
  });

  it('ein neues Feld kommt in das Fluss-Objekt, ein entferntes geht samt Komma', () => {
    let neu = setze(WASSER, ['settings', 'ziel', 'help'], 'Bis dahin heizt die Sonne');
    expect(geaendert(WASSER, neu).dazu).toHaveLength(1);
    expect((js(neu).settings as Record<string, Record<string, unknown>>).ziel.help).toBe('Bis dahin heizt die Sonne');
    neu = entferne(neu, ['settings', 'ziel', 'editable_by']);
    const ziel = (js(neu).settings as Record<string, Record<string, unknown>>).ziel;
    expect(ziel.editable_by).toBeUndefined();
    expect(Object.keys(ziel)).toEqual(['name', 'default', 'range', 'step', 'help']);
    expect(geaendert(WASSER, neu).dazu).toHaveLength(1);
  });

  it('ein neuer Eintrag steht unter dem letzten seines Abschnitts, mit derselben Einrückung', () => {
    const neu = setze(WASSER, ['settings', 'reserve'],
      { name: 'Reserve', default: '0.3 kW', range: ['0 kW', '2 kW'], step: '0.1 kW', editable_by: new Wort('installer') });
    const d = geaendert(WASSER, neu);
    expect(d.weg).toEqual([]);
    expect(d.dazu).toEqual(['  reserve: {name: Reserve, default: 0.3 kW, range: [0 kW, 2 kW], step: 0.1 kW, editable_by: installer}']);
    const nach = neu.split('\n');
    expect(nach[nach.indexOf(d.dazu[0]) - 1]).toContain('netz_bis:');
    expect(Object.keys(js(neu).settings as object)).toEqual(['ziel', 'mindest', 'netz_ziel', 'netz_ab', 'netz_bis', 'reserve']);
  });

  it('ein Eintrag geht mit genau seiner Zeile', () => {
    const neu = entferne(WASSER, ['settings', 'netz_bis']);
    const d = geaendert(WASSER, neu);
    expect(d.dazu).toEqual([]);
    expect(d.weg).toHaveLength(1);
    expect(d.weg[0]).toContain('netz_bis:');
  });

  it('Bedingungen: anfügen, ersetzen, entfernen', () => {
    let neu = fuegeAn(WASSER, ['states', 'warm', 'on_when'], { 'Die Sonne scheint': 'sonne > 10°' });
    let d = geaendert(WASSER, neu);
    expect(d.dazu).toEqual(['      - Die Sonne scheint: sonne > 10°']);
    const warm = (js(neu).states as Record<string, Record<string, unknown>>).warm;
    expect(warm.on_when).toEqual([{ 'Der Speicher hat das Ziel erreicht': 't >= ziel' }, { 'Die Sonne scheint': 'sonne > 10°' }]);

    neu = setze(WASSER, ['states', 'netzheizen', 'on_when', 0], { 'Im Fenster': 'netzfenster' });
    d = geaendert(WASSER, neu);
    expect(d.weg).toEqual(['      - Uhrzeit liegt im Fenster: netzfenster']);
    expect(d.dazu).toEqual(['      - Im Fenster: netzfenster']);

    neu = entferne(WASSER, ['states', 'netzheizen', 'off_when_any', 1]);
    d = geaendert(WASSER, neu);
    expect(d.dazu).toEqual([]);
    expect(d.weg).toEqual(['      - Der Speicher ist warm genug: t >= netz_ziel']);
  });

  it('ein Wert eines Zählerschritts und eine Zeile der Lage', () => {
    let neu = setze(WASSER, ['states', 'stufe', 'steps', 3, 'not_before'], '8 min');
    expect(geaendert(WASSER, neu)).toEqual({ weg: ['        not_before: 6 min'], dazu: ['        not_before: 8 min'] });
    neu = setze(WASSER, ['status', 0, 'title'], 'Fühler gestört');
    expect(geaendert(WASSER, neu)).toEqual({ weg: ['    title: Störung Fühler'], dazu: ['    title: Fühler gestört'] });
    neu = setze(WASSER, ['status', 5, 'else'], true);
    expect(neu).toBe(WASSER);
  });

  it('eine Formel mit Kommas im Fluss-Objekt bekommt Anführungszeichen', () => {
    const neu = setze(WASSER, ['outputs', 'heizstab', 'level'], 'if(netzheizen, 2, if(frei, stufe, 0))');
    expect(neu).toContain('heizstab: {level: "if(netzheizen, 2, if(frei, stufe, 0))"}');
    expect((js(neu).outputs as Record<string, Record<string, unknown>>).heizstab.level).toBe('if(netzheizen, 2, if(frei, stufe, 0))');
  });

  it('die Reihenfolge der Lage: zwei Zeilen tauschen ihren Platz', () => {
    const neu = verschiebe(WASSER, ['status'], 1, 1);
    const lage = js(neu).status as { title: string }[];
    expect(lage.map((l) => l.title).slice(0, 3)).toEqual(['Störung Fühler', 'Nachtsperre', 'Heizt aus dem Netz']);
    expect(neu.length).toBe(WASSER.length);
  });

  it('Kommentare bleiben stehen', () => {
    let neu = setze(WASSER, ['settings', 'ziel', 'default'], '60 °C');
    neu = setze(neu, ['inputs', 'aussen'], { source: 'site.pv', name: 'PV', max_age: '60 s' });
    neu = entferne(neu, ['formulas', 'frei']);
    expect(neu.startsWith(WASSER.split('\n').slice(0, 2).join('\n'))).toBe(true);
  });

  it('ein fehlender Abschnitt entsteht, ein leerer geht', () => {
    const ohne = entferne(WASSER, ['constraints', 1]);
    const leer = entferne(ohne, ['constraints', 0]);
    expect(js(leer).constraints).toBeUndefined();
    const wieder = fuegeAn(leer, ['constraints'], { 'Ziel über Mindest': 'ziel >= mindest + 5 K' });
    expect(js(wieder).constraints).toEqual([{ 'Ziel über Mindest': 'ziel >= mindest + 5 K' }]);
    expect(wieder).toContain('constraints:\n  - Ziel über Mindest: ziel >= mindest + 5 K\n');
  });

  it('ein leeres Fluss-Objekt wird mit dem ersten Eintrag ein Block', () => {
    const text = 'logic: 1\nname: Neu\n\ndevices: {}\n\nstatus:\n  - else: true\n    title: Bereit\n    type: idle\n    text: Wartet.\n';
    const neu = setze(text, ['devices', 'stab'], { entity: 'abc', name: 'Heizstab' });
    expect(neu).toContain('devices:\n  stab: {entity: abc, name: Heizstab}\n\nstatus:');
    expect((js(neu).devices as Record<string, unknown>).stab).toEqual({ entity: 'abc', name: 'Heizstab' });
  });

  it('ein Zustand als Block mit Bedingungen', () => {
    const neu = setze(WASSER, ['states', 'sommer'], {
      type: 'boolean',
      on_when: [{ 'Die Sonne steht hoch': 'sonne > 30°' }],
      after_restart: new Wort('off'),
    });
    expect(geaendert(WASSER, neu).dazu).toEqual([
      '  sommer:',
      '    type: boolean',
      '    on_when:',
      '      - Die Sonne steht hoch: sonne > 30°',
      '    after_restart: off',
    ]);
    expect(Object.keys(js(neu).states as object)).toEqual(['warm', 'netzheizen', 'stufe', 'sommer']);
  });

  it('nennt die Zeilen eines Eintrags', () => {
    const g = lies(WASSER);
    if (!g.ok) throw new Error();
    const zeilen = WASSER.split('\n');
    const [von, bis] = zeilenVon(g, ['states', 'warm'])!;
    expect(zeilen[von - 1]).toBe('  warm:');
    expect(zeilen[bis - 1]).toBe('    after_restart: off');
    const [p] = zeilenVon(g, ['tests', 1])!;
    expect(zeilen[p - 1]).toBe('  - name: Kalte Nacht');
  });

  it('meldet die Zeile eines Textes, den YAML nicht liest', () => {
    const g = lies('logic: 1\nname: [kaputt\n');
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.zeile).not.toBeNull();
  });
});

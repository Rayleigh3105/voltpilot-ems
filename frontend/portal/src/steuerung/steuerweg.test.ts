import { describe, expect, it } from 'vitest';
import type { SteuerwegAntwort, SteuerwegGeraet, SteuerwegRegel } from '../api';
import { abschnittTitel, dauerText, geraetZeile, regelZeile, sichtbar, standText, uebernehmenFolgen, vergleichSatz, wegAnsicht } from './steuerweg';

const regel = (weg: SteuerwegRegel['weg'], extra: Partial<SteuerwegRegel> = {}): SteuerwegRegel => ({
  flowId: `f-${weg}`, name: `Regel ${weg}`, weg, gruende: [], logikId: null, logikFassung: null, vergleich: null,
  gemeldetAm: null, ...extra,
});

const antwort = (modus: SteuerwegAntwort['stand']['modus'], regeln: SteuerwegRegel[], extra: Partial<SteuerwegAntwort['stand']> = {},
  darf = true): SteuerwegAntwort => ({
  stand: { modus, seit: null, boxArt: 'docker', boxKannMitlauf: true, boxKannScharf: true, regeln, schritte: [],
    geraeteModus: 'alt', geraeteSeit: null, boxKannSteuerarten: true, geraete: [], ...extra },
  darf,
});

const geraet = (weg: SteuerwegGeraet['weg'], extra: Partial<SteuerwegGeraet> = {}): SteuerwegGeraet => ({
  art: 'steuerart', entityId: `e-${weg}`, name: `Gerät ${weg}`, weg, gruende: [], logikId: null, logikFassung: null,
  vergleich: null, gemeldetAm: null, ...extra,
});

describe('Der Schalter der Anlage', () => {
  it('bietet ab Werk den Vergleich an, nur wer darf und nur mit Regeln', () => {
    expect(wegAnsicht(antwort('alt', [regel('alt')])).knoepfe.map((k) => k.schritt)).toEqual(['mitlauf']);
    expect(wegAnsicht(antwort('alt', [regel('alt')], {}, false)).knoepfe).toEqual([]);
    expect(wegAnsicht(antwort('alt', [])).knoepfe).toEqual([]);
  });

  it('übernimmt erst aus dem Vergleich heraus, und zurück geht in jedem Zustand', () => {
    expect(wegAnsicht(antwort('mitlauf', [regel('mitlauf')])).knoepfe.map((k) => k.schritt)).toEqual(['uebernehmen', 'zurueck']);
    expect(wegAnsicht(antwort('kern', [regel('kern')])).knoepfe.map((k) => k.schritt)).toEqual(['zurueck']);
  });

  it('übernimmt nicht an einer Box, die nicht nach einer Logik schaltet, und sagt warum', () => {
    const w = wegAnsicht(antwort('mitlauf', [regel('mitlauf')], { boxKannScharf: false }));
    expect(w.knoepfe.map((k) => k.schritt)).toEqual(['zurueck']);
    expect(w.hinweis).toContain('Update');
    expect(wegAnsicht(antwort('alt', [regel('alt')], { boxKannMitlauf: false })).hinweis).toContain('Update');
  });

  it('hat auf einer Edge Light keinen Schritt: dort gibt es nur den neuen Weg', () => {
    const w = wegAnsicht(antwort('kern', [regel('kern')], { boxArt: 'light' }));
    expect(w.knoepfe).toEqual([]);
    expect(w.pille.wort).toBe('neuer Weg');
  });

  it('Edge Industrie trägt denselben Kern: auch dort nur der neue Weg', () => {
    const w = wegAnsicht(antwort('kern', [regel('kern')], { boxArt: 'industrie' }));
    expect(w.knoepfe).toEqual([]);
    expect(w.pille.wort).toBe('neuer Weg');
  });

  it('zeigt sich nur mit Regeln oder wenn der Schalter schon an ist', () => {
    expect(sichtbar(null)).toBe(false);
    expect(sichtbar(antwort('alt', []))).toBe(false);
    expect(sichtbar(antwort('mitlauf', []))).toBe(true);
    expect(sichtbar(antwort('alt', [regel('alt')]))).toBe(true);
  });
});

describe('Je Regel', () => {
  it('nennt im Vergleich beide Seiten und den Tag', () => {
    const z = regelZeile(regel('mitlauf', { vergleich: { zustand: 'mitlaufend', wunsch: { ein: true }, ist: { ein: false },
      verglichen_s: 7800, abweichend_s: 90, laengste_abweichung_s: 60 } }));
    expect(z.pille.wort).toBe('weicht ab');
    expect(regelZeile(regel('mitlauf', { vergleich: { zustand: 'mitlaufend', verglichen_s: 60, abweichend_s: 0 } })).pille.wort).toBe('gleich');
    expect(regelZeile(regel('mitlauf')).pille.wort).toBe('Vergleich');
    expect(z.satz).toBe('Neuer Weg: an, geschaltet: aus. Heute 2\u00a0Std 10\u00a0Min verglichen, 1\u00a0Min verschieden (längstens 1\u00a0Min).');
  });

  it('sagt „immer gleich“ ohne Abweichung und nichts ohne Meldung der Box', () => {
    expect(vergleichSatz({ zustand: 'mitlaufend', verglichen_s: 45, abweichend_s: 0 })).toBe('Heute 45\u00a0s verglichen, immer gleich.');
    expect(vergleichSatz(null)).toBeNull();
    expect(vergleichSatz({ zustand: 'mitlaufend' })).toBeNull();
  });

  it('nennt einen Halt der Box statt eines Wunschs, und den Grund einer Regel auf dem bisherigen Weg', () => {
    const k = regelZeile(regel('kern', { vergleich: { zustand: 'scharf', wunsch: { ein: true }, halt: { code: 'pausiert', text: 'Die Automatik ist pausiert.' } } }));
    expect(k.pille.klasse).toBe('lock');
    expect(k.satz).toBe('Die Automatik ist pausiert.');
    expect(regelZeile(regel('alt', { gruende: ['Die Regel ist im freien Editor gebaut.'] })).satz).toBe('Die Regel ist im freien Editor gebaut.');
    expect(regelZeile(regel('aus', { gruende: ['Grund'] })).pille.wort).toBe('läuft nicht');
  });

  it('schreibt Stände und Dauern, unbekannt bleibt unbekannt', () => {
    expect(standText(undefined)).toBe('unbekannt');
    expect(standText({ stufe: 0 })).toBe('aus');
    expect(standText({ stufe: 2 })).toBe('Stufe 2');
    expect(standText({})).toBe('kein Wunsch');
    expect(dauerText(59)).toBe('59\u00a0s');
    expect(dauerText(3600)).toBe('1\u00a0Std');
  });
});

describe('Vor dem Übernehmen', () => {
  it('nennt, was sich ändert, wo die Wege abwichen und was auf dem bisherigen Weg bleibt', () => {
    const f = uebernehmenFolgen(antwort('mitlauf', [
      regel('mitlauf', { name: 'Sonne', vergleich: { zustand: 'mitlaufend', verglichen_s: 100, abweichend_s: 10 } }),
      regel('mitlauf', { flowId: 'b', name: 'Nachts', vergleich: { zustand: 'mitlaufend', verglichen_s: 100, abweichend_s: 0 } }),
      regel('alt', { name: 'Frei' }),
    ]));
    expect(f[0]).toBe('Die Box schaltet 2 Regeln selbst; der bisherige Weg gibt sie ab.');
    expect(f[1]).toBe('Heute wichen die Wege ab bei: „Sonne“.');
    expect(f[2]).toBe('Auf dem bisherigen Weg bleiben: „Frei“.');
    expect(f[3]).toContain('Zurück geht jederzeit sofort');
  });
});

describe('Steuerarten und Heizstab-Regler am selben Schalter (Stufe 6, dritter Teil)', () => {
  it('nennt in der Überschrift, was an der Anlage läuft', () => {
    expect(abschnittTitel(antwort('alt', [regel('alt')]))).toBe('Wie Ihre Regeln laufen');
    expect(abschnittTitel(antwort('alt', [], { geraete: [geraet('alt')] }))).toBe('Wie Ihre Steuerarten laufen');
    expect(abschnittTitel(antwort('alt', [regel('alt')], { geraete: [geraet('alt')] }))).toBe('Wie Ihre Regeln und Steuerarten laufen');
  });

  it('zeigt sich mit Steuerarten auch ohne Regeln, und bietet ab Werk den Vergleich an', () => {
    const a = antwort('alt', [], { geraete: [geraet('alt')] });
    expect(sichtbar(a)).toBe(true);
    const w = wegAnsicht(a);
    expect(w.knoepfe.map((k) => k.schritt)).toEqual(['mitlauf']);
    expect(w.satz).toMatch(/^Ihre Steuerarten laufen wie bisher\./);
  });

  it('hält auf einer Edge Light die Regeln im Kern und schaltet die Steuerarten über den Schalter', () => {
    const light = { boxArt: 'light' as const };
    const teils = wegAnsicht(antwort('kern', [regel('kern')], { ...light, geraete: [geraet('alt')] }));
    expect(teils.pille.wort).toBe('teils neu');
    expect(teils.satz).toBe('Die Box rechnet Ihre Regeln schon selbst. Ihre Steuerarten laufen wie bisher; auch sie rechnet der neue Weg, erst nur zum Vergleich.');
    expect(teils.knoepfe.map((k) => k.schritt)).toEqual(['mitlauf']);
    const vergleich = wegAnsicht(antwort('kern', [regel('kern')], { ...light, geraeteModus: 'mitlauf', geraete: [geraet('mitlauf')] }));
    expect(vergleich.knoepfe.map((k) => [k.schritt, k.wort])).toEqual([['uebernehmen', 'Übernehmen'], ['zurueck', 'Vergleich beenden']]);
    const neu = wegAnsicht(antwort('kern', [regel('kern')], { ...light, geraeteModus: 'kern', geraete: [geraet('kern')] }));
    expect(neu.pille.wort).toBe('neuer Weg');
    expect(neu.satz).toBe('Die Box rechnet Ihre Regeln und Steuerarten selbst und schaltet danach. Zurück geht jederzeit sofort.');
    expect(neu.knoepfe.map((k) => k.wort)).toEqual(['Zurück zum bisherigen Weg']);
    // Ohne das Update kein Schritt für die Steuerarten, aber ein Satz, warum.
    const alt = wegAnsicht(antwort('kern', [regel('kern')], { ...light, boxKannSteuerarten: false, geraete: [geraet('alt')] }));
    expect(alt.knoepfe).toEqual([]);
    expect(alt.hinweis).toBe('Für den neuen Weg der Steuerarten braucht die Box ein Update.');
  });

  it('bewegt auf der Docker-Box, was noch zurück ist: Regeln schon im Kern, Steuerarten noch bisher', () => {
    const w = wegAnsicht(antwort('kern', [regel('kern')], { geraete: [geraet('alt')] }));
    expect(w.pille.wort).toBe('teils neu');
    expect(w.knoepfe.map((k) => k.schritt)).toEqual(['mitlauf', 'zurueck']);
  });

  it('nennt je Gerät, was es führt, und vor dem Übernehmen Regeln und Steuerarten', () => {
    expect(geraetZeile(geraet('alt', { art: 'heizstab', name: 'Heizstab' })).art).toBe('Heizstab-Regler');
    expect(geraetZeile(geraet('kern', { vergleich: { zustand: 'scharf', wunsch: { stufe: 2 } } })).satz).toBe('Die Box will: Stufe 2.');
    const f = uebernehmenFolgen(antwort('mitlauf', [regel('mitlauf')], { geraeteModus: 'mitlauf',
      geraete: [geraet('mitlauf', { name: 'Pumpe' }), geraet('mitlauf', { entityId: 'b', art: 'heizstab', name: 'Heizstab',
        vergleich: { zustand: 'mitlaufend', verglichen_s: 100, abweichend_s: 5 } }), geraet('alt', { name: 'Wallbox' })] }));
    expect(f[0]).toBe('Die Box schaltet 1 Regel und 2 Steuerarten selbst; der bisherige Weg gibt sie ab.');
    expect(f[1]).toBe('Heute wichen die Wege ab bei: „Heizstab“.');
    expect(f[2]).toBe('Auf dem bisherigen Weg bleiben: „Wallbox“.');
    expect(f[3]).toBe('Ihre Regeln und Steuerarten, Schutzgrenzen und Eingriffe bleiben, wie sie sind. Zurück geht jederzeit sofort.');
  });
});

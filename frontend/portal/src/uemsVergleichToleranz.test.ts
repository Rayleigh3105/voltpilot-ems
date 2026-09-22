import { describe, expect, it } from 'vitest';
import { befundZeilen, monatWort, prozentWort, type MessstelleVergleich, type VergleichMonat } from './uemsVergleichToleranz';

const monat = (m: Partial<VergleichMonat>): VergleichMonat => ({
  monat: '2026-12', fuehrend: '131200', vergleich: '129700', zustand: 'passt', grund: null,
  abweichung_prozent: '1.1', toleranz_prozent: '2', toleranz_fassung: 1, befund: false, ...m,
});
const antwort = (quellen: MessstelleVergleich['vergleichsquellen']): MessstelleVergleich => ({
  kennzeichen: 'MS-01', von: '2026-12', bis: '2026-12', vergleichsquellen: quellen, befunde: [],
});
const quelle = (id: string, monate: VergleichMonat[], name: string | null = 'Netzleistung am Wechselrichter') => ({
  quelle_id: id, komponente: name, kanal: 'grid.power', zweck: 'Plausibilität', monatsvergleich: 'ja' as const, monate,
});

describe('AP-16 IP-17 · Befund-Zeile an der Messstelle (R9)', () => {
  it('1,1 % passt, 3,4 % bitte prüfen — Abweichung und Toleranz, keine Ursache', () => {
    const zeilen = befundZeilen(antwort([
      quelle('a', [monat({})]),
      quelle('b', [monat({ vergleich: '126700', zustand: 'abweichung', abweichung_prozent: '3.4', befund: true })],
        'Abrechnungszähler'),
    ]));
    expect(zeilen.map(z => z.satz)).toEqual([
      'Vergleich Dezember 2026: 1,1 % Abweichung zur Netzleistung am Wechselrichter (Toleranz 2 %) — passt',
      'Abweichung zur Vergleichsquelle Abrechnungszähler im Dezember 2026: 3,4 % (Toleranz 2 %) — bitte prüfen',
    ]);
    expect(zeilen.map(z => z.zustand)).toEqual(['passt', 'abweichung']);
    for (const z of zeilen) expect(z.satz).not.toMatch(/Ursache|Ersatz|SEU|ISO-wesentlich|automatisch eingestuft/);
  });

  it('eine Lücke ist nie „passt“, sondern nicht vergleichbar mit Grund', () => {
    const [z] = befundZeilen(antwort([quelle('a', [monat({ zustand: 'nicht_vergleichbar',
      grund: 'vergleich_nicht_ganzer_monat', abweichung_prozent: null, befund: null, monat: '2026-11' })])]));
    expect(z.satz).toBe('Vergleich November 2026 mit Netzleistung am Wechselrichter: nicht vergleichbar — '
      + 'die Vergleichsquelle gilt nicht den ganzen Monat');
  });

  it('ohne Monatsmenge oder ohne Monat keine Zeile — Bestandskunden sehen nichts', () => {
    expect(befundZeilen(antwort([]))).toEqual([]);
    expect(befundZeilen(antwort([{ ...quelle('a', [monat({})]), monatsvergleich: 'ohne_monatsmenge' }]))).toEqual([]);
    expect(befundZeilen(antwort([quelle('a', [])]))).toEqual([]);
  });

  it('Wörter: Monat und Prozent mit Komma, eigene Fassung 0,5 %', () => {
    expect(monatWort('2027-03')).toBe('März 2027');
    expect(prozentWort('0.5')).toBe('0,5 %');
    const [z] = befundZeilen(antwort([quelle('a', [monat({ toleranz_prozent: '0.5', toleranz_fassung: 2,
      zustand: 'abweichung', abweichung_prozent: '1.1', befund: true })], null)]));
    expect(z.satz).toBe('Abweichung zur Vergleichsquelle grid.power im Dezember 2026: 1,1 % (Toleranz 0,5 %) — bitte prüfen');
  });
});

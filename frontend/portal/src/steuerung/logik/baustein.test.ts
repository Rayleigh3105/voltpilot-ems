import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BausteinEingesetzt, BausteinLuecke } from '../../api';
import { artKlasse, satzVorschlag, satzZeile, startWerte, symbol, tag, uhrSchritt, unterDemSatz, wertText, zahlSchritt, zeigbar } from './baustein';

/** Die Antwort des Logik-Dienstes, gepinnt vom Dienst selbst (`logikdienst/baustein_test.go`). */
const EINGESETZT = JSON.parse(readFileSync('../../docs/contracts/v2/examples/steuerlogik-baustein.valid.eingesetzt.json', 'utf8')) as BausteinEingesetzt;
const L = (k: string) => EINGESETZT.luecken.find((l) => l.kennung === k) as BausteinLuecke;

describe('Bausteine: Satz und Lücken', () => {
  it('schreibt den Satz mit den Werten, wie der Dienst sie nennt', () => {
    expect(satzZeile(EINGESETZT.satz, EINGESETZT.luecken)).toBe(
      'Wenn der Speicher unter 45 °C fällt, heize mit Heizstab Puffer aus dem Netz bis 50 °C, aber nur zwischen 05:30 und 22:00.');
    expect(startWerte(EINGESETZT.luecken)).toMatchObject({ mindest: '45 °C', heizstab: 'stab-puffer', t: 'fuehler-puffer', netz_ab: '05:30' });
  });

  it('stellt Fühler, die der Satz nicht nennt, darunter', () => {
    expect(unterDemSatz(EINGESETZT.luecken).map((l) => l.kennung)).toEqual(['t']);
  });

  it('rechnet Schritte im Bereich und auf dem Raster ab dem unteren Ende', () => {
    expect(zahlSchritt(L('mindest'), '45 °C', 1)).toBe('46 °C');
    expect(zahlSchritt(L('mindest'), '55 °C', 1)).toBeNull();
    expect(zahlSchritt(L('mindest'), '30 °C', -1)).toBeNull();
    const kw: BausteinLuecke = { kennung: 'ab', art: 'stellwert', name: 'Ab', im_satz: true, wert: '2 kW',
      stellwert: { kennung: 'ab', name: 'Ab', art: 'zahl', einheit: 'kW', vorgabe: '2 kW', von: 0.5, bis: 10, schritt: 0.5 } };
    expect(zahlSchritt(kw, '2 kW', -1)).toBe('1.5 kW');
    expect(zahlSchritt(kw, '1.3 kW', 1)).toBe('2 kW');
    expect(wertText(kw, '1.5 kW')).toBe('1,5 kW');
    expect(wertText(kw, '2 kW')).toBe('2,0 kW');
  });

  it('schiebt Uhrzeiten um eine halbe Stunde, über Mitternacht', () => {
    expect(uhrSchritt('05:30', 1)).toBe('06:00');
    expect(uhrSchritt('00:00', -1)).toBe('23:30');
    expect(uhrSchritt('23:45', 1)).toBe('00:30');
  });

  it('zeigt Geräte mit ihrem Namen, an/aus und Auswahl in Kundenwörtern', () => {
    expect(wertText(L('heizstab'), 'stab-ww')).toBe('Heizstab Warmwasser');
    const sw: BausteinLuecke = { kennung: 'w', art: 'stellwert', name: 'Winter', im_satz: true, wert: 'off',
      stellwert: { kennung: 'w', name: 'Winter', art: 'boolean', vorgabe: 'off' } };
    expect(wertText(sw, 'on')).toBe('an');
    expect(symbol(EINGESETZT)).toBe('flame');
  });
});

describe('Bausteine: So verhält sie sich', () => {
  it('ist ein Tag aus den Proben, nach der Uhrzeit, mit Titel und Fall', () => {
    const t = tag(EINGESETZT.verhalten);
    expect(t.map((m) => m.uhr)).toEqual([...t.map((m) => m.uhr)].sort());
    expect(t[0]).toMatchObject({ uhr: '05:30', titel: 'Heizt aus dem Netz', art: 'grid', besteht: true });
    expect(t.every((m) => m.besteht)).toBe(true);
    expect(artKlasse('solar')).toBe('on');
    expect(artKlasse('fault')).toBe('lock');
  });

  it('zeigt nur lesbare, passende Bausteine; eigene immer', () => {
    const k = { satz: [], luecken: [], herkunft: 'voltpilot' as const, von: null, eigen: false };
    expect(zeigbar([{ ...k, id: 'a', lesbar: true, passt: true }, { ...k, id: 'b', lesbar: true, passt: false },
      { ...k, id: 'c', lesbar: false, passt: false, eigen: true }]).map((b) => b.id)).toEqual(['a', 'c']);
  });

  it('schlägt dem Fachbetrieb einen Satz aus der Beschreibung vor', () => {
    expect(satzVorschlag('Ein Speicher wird warm.', ['heizstab'])).toBe('Ein Speicher wird warm: {heizstab}.');
    expect(satzVorschlag(null, ['a', 'b'])).toBe('Steuert {a}, {b}.');
  });
});

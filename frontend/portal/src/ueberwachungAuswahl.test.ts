import { describe, expect, it } from 'vitest';
import type { Wertverweis } from './ueberwachungApi';
import { anlageWerte, katalogWerte, ortOptionen, wertText } from './ueberwachungAuswahl';

const NBSP = ' ';

function wv(teil: Partial<Wertverweis> & Pick<Wertverweis, 'wertart' | 'name' | 'bezugJson'>): Wertverweis {
  return { satzname: '', bedingungen: ['ueber'], bekannt: true, zahlenwert: null, zustandswort: null, einheit: 'kW', ...teil };
}

describe('Konzept b1 · „+ Überwachung“: Ort und Wert wählen', () => {
  it('ordnet die Orte nach Art (Anlagen, Messstellen, Kennzahlen, Energieziele) und darin nach Namen', () => {
    const optionen = ortOptionen([
      { art: 'kennzahl', id: 'k1', name: 'Strom je Stück', sub: 'KZ-1' },
      { art: 'anlage', id: 'a2', name: 'Werk Süd' },
      { art: 'energieziel', id: 'e1', name: 'Energieziel 2029', sub: 'EZ-1' },
      { art: 'anlage', id: 'a1', name: 'Halle 1' },
      { art: 'messstelle', id: 'm1', name: 'Hauptzähler', sub: 'MS-01' },
    ]);
    expect(optionen.map((o) => o.value)).toEqual(['anlage:a1', 'anlage:a2', 'messstelle:m1', 'kennzahl:k1', 'energieziel:e1']);
    expect(optionen[2]).toMatchObject({ label: 'Hauptzähler', sub: 'MS-01', group: 'messstelle' });
  });

  it('nennt an einer Anlage zuerst die Live-Werte, dann die Geräte-Kanäle in Kundenworten', () => {
    const werte = anlageWerte([
      wv({ wertart: 'geraet.messwert', name: 'Zähler Halle · grid_power_kw', bezugJson: '{"komponente":"c1","kanal":"grid_power_kw"}', zahlenwert: 2.5 }),
      wv({ wertart: 'anlage.netz.leistung', name: 'Netzbezug', bezugJson: '{"anlage":"a1"}', zahlenwert: 131.04 }),
    ]);
    expect(werte.map((w) => [w.gruppe, w.wertart])).toEqual([['live', 'anlage.netz.leistung'], ['geraet', 'geraet.messwert']]);
    expect(werte[0]).toMatchObject({ bezug: { anlage: 'a1' }, wertText: `131,0${NBSP}kW`, aktuellerWert: 131.04, titelZusatz: 'Netzbezug' });
    expect(werte[1].bezug).toEqual({ komponente: 'c1', kanal: 'grid_power_kw' });
    expect(werte[1].name).toBe('Zähler Halle · Netzleistung');
  });

  it('stellt die Alarm-Vorlagen einer Erzeugeranlage als eigene Gruppe vor die Geräte-Kanäle, den Zustand in Kundenworten', () => {
    const werte = anlageWerte([
      wv({ wertart: 'geraet.messwert', name: 'PFC200 · grid_power_kw', bezugJson: '{"komponente":"c1","kanal":"grid_power_kw"}', zahlenwert: 2.5 }),
      wv({ wertart: 'erzeuger.anlage_folgt_nicht', name: 'Anlage folgt nicht', bezugJson: '{"anlage":"a1"}', bedingungen: ['zustand'], zustandswort: 'folgt_nicht', einheit: null }),
      wv({ wertart: 'erzeuger.fernsteuerung_nicht_bereit', name: 'Fernsteuerung nicht bereit', bezugJson: '{"anlage":"a1"}', bedingungen: ['zustand'], bekannt: false, einheit: null }),
      wv({ wertart: 'anlage.pv.leistung', name: 'Erzeugung', bezugJson: '{"anlage":"a1"}', zahlenwert: 42 }),
    ]);
    expect(werte.map((w) => [w.gruppe, w.wertart])).toEqual([
      ['live', 'anlage.pv.leistung'],
      ['erzeuger', 'erzeuger.anlage_folgt_nicht'],
      ['erzeuger', 'erzeuger.fernsteuerung_nicht_bereit'],
      ['geraet', 'geraet.messwert'],
    ]);
    expect(werte[1]).toMatchObject({ bezug: { anlage: 'a1' }, wertText: 'folgt nicht', titelZusatz: 'Anlage folgt nicht' });
    expect(werte[2].wertText).toBeNull();
  });

  it('erfindet keinen Wert: unbekannt ist kein Text und kein Vorschlag, ein kaputter Bezug fällt weg', () => {
    const werte = anlageWerte([
      wv({ wertart: 'anlage.pv.leistung', name: 'Erzeugung', bezugJson: '{"anlage":"a1"}', bekannt: false, zahlenwert: 0 }),
      wv({ wertart: 'anlage.pv.leistung', name: 'kaputt', bezugJson: 'kein json' }),
    ]);
    expect(werte).toHaveLength(1);
    expect(werte[0]).toMatchObject({ wertText: null, aktuellerWert: null });
  });

  it('liest Messstelle, Kennzahl und Energieziel aus dem Werte-Katalog, mit ihrem eigenen Bezug', () => {
    const ms = katalogWerte({ art: 'messstelle', id: 'm1', name: 'Hauptzähler' });
    expect(ms.map((w) => w.wertart)).toEqual(['messstelle.menge', 'messstelle.beobachtung', 'messstelle.monat_unvollstaendig']);
    expect(ms.every((w) => (w.bezug as { messstelle: string }).messstelle === 'm1' && w.wertText == null)).toBe(true);
    expect(katalogWerte({ art: 'kennzahl', id: 'k1', name: 'KZ' }).map((w) => [w.wertart, w.bezug])).toEqual([['kennzahl.bezugsbasis', { kennzahl: 'k1' }]]);
    expect(katalogWerte({ art: 'energieziel', id: 'e1', name: 'EZ' }).map((w) => [w.wertart, w.bezug])).toEqual([['energieziel.kurs', { energieziel: 'e1' }]]);
    expect(katalogWerte({ art: 'anlage', id: 'a1', name: 'Halle' })).toEqual([]);
  });

  it('schreibt Werte im UEMS-Format: kW mit einer Stelle, Prozent ohne, ein Zustand als Wort', () => {
    expect(wertText({ bekannt: true, zahlenwert: 64.4, zustandswort: null, einheit: '%' })).toBe(`64${NBSP}%`);
    expect(wertText({ bekannt: true, zahlenwert: 1234.56, zustandswort: null, einheit: 'kW' })).toBe(`1.234,6${NBSP}kW`);
    expect(wertText({ bekannt: true, zahlenwert: null, zustandswort: 'erreichbar', einheit: null })).toBe('erreichbar');
  });
});

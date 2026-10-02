import { describe, expect, it } from 'vitest';
import { prozentText, satz, wirkungKurz, type AbgleichMonat } from './mispelAbgleich';

const NBSP = String.fromCharCode(160);
const z = (groesse: string, rolle: string, richtung: string, g: number | null, m: number | null,
  ampel: 'gruen' | 'gelb' | 'rot' | 'grau', p: number | null, grund: null | 'luecke' | 'keine_msb_werte' = null) => ({
  groesse, rolle, richtung, messstelleId: groesse, messstelle: groesse, zaehlpunkt: null, messstellenbetreiber: null,
  abgleich: { geraetKwh: g, msbKwh: m, unterschiedKwh: g != null && m != null && p != null ? g - m : null, abweichungProzent: p, ampel, grund },
});
const monat = (zaehler: AbgleichMonat['zaehler'], groesste: string | null, differenzEur: number | null): AbgleichMonat => ({
  monat: '2026-11', zaehler, groessteAbweichung: groesste, schwellen: { gruenBisProzent: 2, gelbBisProzent: 5 },
  wirkung: differenzEur == null ? null : { schluessel: '2026-11', vorherFassung: 1, vorherWertequelle: 'geraet', saldierungVorherEur: 100,
    saldierungNachherEur: 100 + differenzEur, differenzEur,
    farben: [{ farbe: 'rot', formel: '(16)', begriff: 'rot', vorherKwh: 2270, nachherKwh: 2050 }] },
});

describe('Abgleich Gerät ↔ Messstellenbetreiber (MP-15, BK-15 A)', () => {
  it('nennt die größte Abweichung, ihre Ampel und die Wirkung in Euro', () => {
    const s = satz(monat([z('Z1NB', 'Z1', 'Bezug', 31180, 31500, 'gruen', -1), z('Z2E', 'Z2', 'Entladen', 9120, 8820, 'gelb', 3.4)], 'Z2E', -23));
    expect(s?.ampel).toBe('gelb');
    expect(s?.kopf).toBe('Gerät ↔ Messstellenbetreiber: gelb.');
    expect(s?.text).toBe(`Am Speicherzähler (Entladen) liegen beide +3,4${NBSP}% auseinander. Abgerechnet wird mit den Werten des Messstellenbetreibers; die Saldierung ist dadurch 23,00${NBSP}€ niedriger als in der Vorschau.`);
  });

  it('schweigt ohne Werte des Messstellenbetreibers und sagt grau, wenn nichts vergleichbar ist', () => {
    expect(satz(monat([z('Z1NB', 'Z1', 'Bezug', 100, null, 'grau', null, 'keine_msb_werte')], null, null))).toBeNull();
    const s = satz(monat([z('Z1NE', 'Z1', 'Einspeisung', 100, 90, 'grau', null, 'luecke')], null, null));
    expect(s?.ampel).toBe('grau');
    expect(s?.text).toContain('Lücke');
  });

  it('formatiert Prozent mit Vorzeichen und die Wirkung mit der größten Farbänderung', () => {
    expect(prozentText(-1)).toBe(`−1,0${NBSP}%`);
    expect(prozentText(0)).toBe(`±0,0${NBSP}%`);
    expect(prozentText(null)).toBe('—');
    expect(wirkungKurz(monat([], null, -23).wirkung)).toBe(`Rot (16) 2.270 → 2.050${NBSP}kWh · Saldierung −${NBSP}23,00${NBSP}€`);
    expect(wirkungKurz(null)).toBe('—');
  });
});

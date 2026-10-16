import { describe, expect, it } from 'vitest';
import {
  GERAET_ANLEGEN_HINWEIS,
  REGEL_BRUECKE_LABEL,
  SELBSTBAU_COMMUNICATION,
  bietetRegelBruecke,
  geraetAnlegenHash,
  istSelbstbau,
  komponenteAusHash,
  regelBrueckeHash,
  vorbefuellterName,
  type BrueckenKomponente,
  brueckenKomponente,
} from './selbstbauBruecke';

const waermepumpe: BrueckenKomponente = {
  entityId: 'e1',
  label: 'Wärmepumpe Keller',
  communication: SELBSTBAU_COMMUNICATION,
  channels: [
    { channel: 'wassertemperatur', label: 'Wassertemperatur', unit: '°C' },
    { channel: 'aufnahmeleistung', label: 'Aufnahmeleistung', unit: 'kW' },
  ],
};

describe('Gerät → Regel', () => {
  it('erkennt eine Selbstbau-Komponente an ihrer Anbindung', () => {
    expect(istSelbstbau(waermepumpe)).toBe(true);
    expect(istSelbstbau({ ...waermepumpe, communication: 'solarman_v5' })).toBe(false);
    expect(istSelbstbau({ entityId: 'e2', label: 'X' })).toBe(false);
  });

  it('bietet die Brücke nur an, wenn es etwas zu bedingen GIBT', () => {
    expect(bietetRegelBruecke(waermepumpe)).toBe(true);
    expect(bietetRegelBruecke({ ...waermepumpe, channels: [] })).toBe(false);
    expect(bietetRegelBruecke({ entityId: 'e3', label: 'Ohne' })).toBe(false);
  });

  it('schlägt einen Namen vor, der die Komponente nennt', () => {
    expect(vorbefuellterName(waermepumpe)).toBe('Wärmepumpe Keller: neue Regel');
    expect(vorbefuellterName({ entityId: 'e5', label: '  ' })).toBe('Neue Regel');
  });
});

describe('die Adressen', () => {
  it('führt in die Steuerung derselben Anlage', () => {
    expect(regelBrueckeHash('s1', 'e1')).toBe('#/anlage/s1/steuerung?komponente=e1');
    expect(geraetAnlegenHash('s1')).toBe('#/anlage/s1/modell?neu=selbstbau');
  });

  it('kodiert eine Kennung, die Sonderzeichen trägt', () => {
    expect(regelBrueckeHash('s1', 'a b')).toContain('komponente=a%20b');
  });

  it('liest den Parameter zurück - und behauptet ohne ihn nichts', () => {
    expect(komponenteAusHash('#/anlage/s1/steuerung?komponente=e1')).toBe('e1');
    expect(komponenteAusHash('#/anlage/s1/steuerung?vorlage=x&komponente=e9')).toBe('e9');
    expect(komponenteAusHash('#/anlage/s1/steuerung')).toBeNull();
    expect(komponenteAusHash('#/anlage/s1/steuerung?komponente=')).toBeNull();
  });
});

describe('Regel → Gerät', () => {
  it('nennt in der Sackgasse den Ausweg, nicht nur das Problem', () => {
    expect(GERAET_ANLEGEN_HINWEIS).toContain('eigenes Modbus-Gerät');
    expect(GERAET_ANLEGEN_HINWEIS).toContain('zur Auswahl');
    expect(REGEL_BRUECKE_LABEL).toContain('Regel');
  });
});

describe('brueckenKomponente (die Editor-Sicht der Brücke)', () => {
  it('leitet den Schalter aus dem SCHREIBWEG ab, nie aus einem Flag', () => {
    const k = brueckenKomponente({
      id: 'e-9', label: 'Heizstab', measure: ['temperatur'], actuate: ['on_off'],
    });
    expect(k.schalter).toEqual({ schaltbar: true, art: 'on_off' });
    expect(k.channels).toEqual([{ channel: 'temperatur' }]);
  });

  it('erkennt den Sollwert am Schreibweg', () => {
    const k = brueckenKomponente({
      id: 'e-9', label: 'Pumpe', measure: ['leistung'], actuate: ['setpoint_kw'],
    });
    expect(k.schalter?.art).toBe('setpoint');
  });

  it('behauptet OHNE Schreibweg keinen Schalter', () => {
    const k = brueckenKomponente({
      id: 'e-9', label: 'Fühler', measure: ['temperatur'], actuate: [],
    });
    expect(k.schalter).toBeNull();
  });
});

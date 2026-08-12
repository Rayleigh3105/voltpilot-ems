import { describe, expect, it } from 'vitest';
import {
  KEINE_ADRESSE,
  kopfSatz,
  loeschFolgen,
  nameFehler,
  prefill,
  vorschlagsName,
  zeilen,
  type EigeneVorlage,
} from './eigeneVorlagen';

function v(over: Partial<EigeneVorlage> = {}): EigeneVorlage {
  return {
    templateRef: 'custom:abc',
    version: 1,
    label: 'Wärmepumpe (Vorlage)',
    communication: 'modbus_baukasten',
    connection: { port: 502, unit_id: 1 },
    channels: [
      {
        slug: 'vorlauf',
        label: 'Vorlauf',
        unit: '°C',
        register: { kind: 'holding', address: 100, data_type: 's16', word_order: 'big' },
        scale: 0.1,
        offset: 0,
        min_read_interval_s: 10,
      },
    ],
    ...over,
  };
}

describe('eigeneVorlagen', () => {
  it('nennt Umfang und Anschluss, ohne eine Adresse zu behaupten', () => {
    const [z] = zeilen([v()]);
    expect(z.label).toBe('Wärmepumpe (Vorlage)');
    expect(z.umfang).toBe('1 Messwert · Port 502 · Unit-ID 1');
    expect(z.verwendbar).toBe(true);
    expect(KEINE_ADRESSE).toContain('Gerätetyp');
  });

  it('eine Vorlage ohne Messwerte ist nicht verwendbar', () => {
    expect(zeilen([v({ channels: [] })])[0].verwendbar).toBe(false);
    expect(zeilen([v({ channels: null })])[0].umfang).toBe('0 Messwerte · Port 502 · Unit-ID 1');
  });

  it('eine Notiz erscheint nur, wenn es eine gibt', () => {
    expect(zeilen([v()])[0].note).toBeNull();
    expect(zeilen([v({ note: '  ' })])[0].note).toBeNull();
    expect(zeilen([v({ note: 'Zwei Stück im Haus' })])[0].note).toBe('Zwei Stück im Haus');
  });

  it('der Kopf-Satz erklärt ohne Vorlagen, wie eine entsteht', () => {
    expect(kopfSatz(0)).toContain('selbst angelegten Gerät');
    expect(kopfSatz(1)).toBe('Eine eigene Vorlage, nur für diese Anlage.');
    expect(kopfSatz(3)).toContain('3 eigene Vorlagen');
  });

  it('die Folgenliste sagt, was GLEICH bleibt', () => {
    const folgen = loeschFolgen(zeilen([v()])[0]);
    expect(folgen[0]).toContain('Wärmepumpe (Vorlage)');
    expect(folgen[1]).toContain('laufen unverändert weiter');
  });

  it('ein leerer Name wird abgelehnt', () => {
    expect(nameFehler('  ')).toContain('Namen');
    expect(nameFehler('x'.repeat(201))).toContain('zu lang');
    expect(nameFehler('Wärmepumpe Keller')).toBeNull();
  });

  it('der Vorschlagsname spiegelt den des Servers', () => {
    expect(vorschlagsName('Wärmepumpe')).toBe('Wärmepumpe (Vorlage)');
  });

  it('⚠ die Vorbefüllung lässt die ADRESSE leer und trägt alles andere', () => {
    const p = prefill(v());
    expect(p.port).toBe('502');
    expect(p.unitId).toBe('1');
    expect(p.label).toBe('Wärmepumpe (Vorlage)');
    expect(p.zeilen).toEqual([
      {
        label: 'Vorlauf',
        unit: '°C',
        registerKind: 'holding',
        address: '100',
        dataType: 's16',
        wordOrder: 'big',
        scale: '0.1',
        offset: '0',
        minReadIntervalS: '10',
      },
    ]);
    // Es gibt kein Host-Feld in der Vorbefüllung - genau das ist die Aussage.
    expect(Object.keys(p)).not.toContain('host');
  });

  it('fehlende Angaben fallen auf die Vorgaben zurück, nie auf NaN', () => {
    const p = prefill(v({ connection: null, channels: [{ label: 'X', register: {} }] }));
    expect(p.port).toBe('502');
    expect(p.zeilen[0]).toMatchObject({
      registerKind: 'holding',
      dataType: 'u16',
      wordOrder: 'big',
      address: '',
      scale: '1',
      offset: '0',
      minReadIntervalS: '10',
    });
  });
});

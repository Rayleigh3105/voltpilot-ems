import { describe, expect, it } from 'vitest';
import * as S from './socSchaetzung';

describe('socSchaetzung: die Eingabe der Speicher-Eckpunkte', () => {
  it('leer ist der Normalfall - kein Fehler, kein Wert, keine Behauptung', () => {
    const e = S.leereEingabe();
    expect(S.istLeer(e)).toBe(true);
    expect(S.fehler(e)).toBeNull();
    expect(S.verbindungsWert(e)).toBeUndefined();
  });

  it('nimmt BEIDE echten Bauarten - LV wie HV - durch DIESELBE Regel', () => {
    for (const [leer, voll] of [
      ['48', '56'],
      ['600', '700'],
      ['40', '60'],
      ['100', '1000'],
    ]) {
      expect(S.fehler({ leer, voll })).toBeNull();
    }
  });

  it('nimmt das deutsche Komma - ein Formularfeld liefert Text', () => {
    expect(S.fehler({ leer: '48,0', voll: '56,4' })).toBeNull();
    expect(S.verbindungsWert({ leer: '48,0', voll: '56,4' }))
      .toEqual({ v_empty: 48, v_full: 56.4 });
  });

  it('verlangt BEIDE Angaben - aus einer allein lässt sich nichts schätzen', () => {
    expect(S.fehler({ leer: '48', voll: '' })).toMatch(/beide/i);
    expect(S.fehler({ leer: '', voll: '56' })).toMatch(/beide/i);
    expect(S.fehler({ leer: 'abc', voll: '56' })).toMatch(/beide/i);
    expect(S.verbindungsWert({ leer: '48', voll: '' })).toBeUndefined();
  });

  it('nennt beim NAMEN, was gar keine Batterie sein kann', () => {
    // Millivolt statt Volt, ein Prozentwert, eine Ziffer zu viel.
    expect(S.fehler({ leer: '48000', voll: '56000' })).toMatch(/Volt/);
    expect(S.fehler({ leer: '0', voll: '100' })).toMatch(/Volt/);
    expect(S.fehler({ leer: '-5', voll: '56' })).toMatch(/Volt/);
    expect(S.fehler({ leer: '48', voll: '4000' })).toMatch(/Volt/);
  });

  it('lehnt ein verdrehtes oder abstandsloses Paar ab', () => {
    expect(S.fehler({ leer: '700', voll: '600' })).toMatch(/über/);
    expect(S.fehler({ leer: '600', voll: '600' })).toMatch(/über/);
    expect(S.fehler({ leer: '600', voll: '600,2' })).toMatch(/über/);
    // Genau die Mindestspanne ist noch in Ordnung.
    expect(S.fehler({ leer: '600', voll: String(600 + S.SOC_VOLTAGE_MIN_SPAN) })).toBeNull();
  });

  it('schreibt NIE ein halbes oder unbrauchbares Paar in die Verbindung', () => {
    expect(S.verbindungsWert({ leer: '700', voll: '600' })).toBeUndefined();
    expect(S.verbindungsWert({ leer: '48000', voll: '56000' })).toBeUndefined();
    expect(S.verbindungsWert({ leer: '600', voll: '700' }))
      .toEqual({ v_empty: 600, v_full: 700 });
  });

  it('liest gespeicherte Eckpunkte zurück ins Formular - und nur echte', () => {
    expect(S.ausVerbindung({ soc_from_voltage: { v_empty: 48, v_full: 56.4 } }))
      .toEqual({ leer: '48', voll: '56,4' });
    expect(S.ausVerbindung({})).toEqual({ leer: '', voll: '' });
    expect(S.ausVerbindung({ soc_from_voltage: 'x' })).toEqual({ leer: '', voll: '' });
    expect(S.ausVerbindung({ soc_from_voltage: { v_empty: 'a' } }))
      .toEqual({ leer: '', voll: '' });
  });
});

describe('socSchaetzung: der Beleg der Box', () => {
  it('zeigt Spannung UND geschätzten Ladestand - die Zahl zum Kalibrieren', () => {
    expect(S.schaetzungSatz({ estimate: { socPct: 36, voltageV: 636 } }))
      .toBe('Aus der gemessenen Batteriespannung (636 V) geschätzt: 36 % Ladestand.');
  });

  it('behauptet NICHTS ohne Beleg der Box - eine Schätzung wird nie erfunden', () => {
    expect(S.schaetzungSatz(null)).toBeNull();
    expect(S.schaetzungSatz(undefined)).toBeNull();
    expect(S.schaetzungSatz({})).toBeNull();
    expect(S.schaetzungSatz({ estimate: null })).toBeNull();
    // Eine halbe Schätzung ist keine: ohne die Spannung wäre der Prozentwert
    // für den Kunden nicht nachprüfbar.
    expect(S.schaetzungSatz({ estimate: { socPct: 36 } })).toBeNull();
    expect(S.schaetzungSatz({ estimate: { voltageV: 636 } })).toBeNull();
    expect(S.schaetzungSatz({ estimate: { socPct: NaN, voltageV: 636 } })).toBeNull();
  });
});

describe('socSchaetzung: was die Fläche VERSPRICHT - und was nicht', () => {
  it('sagt ausdrücklich, dass es eine Schätzung ist und die Steuerung aus bleibt', () => {
    const alle = S.SOC_VOLTAGE_FOLGEN.join(' ');
    expect(alle).toMatch(/Schätzung/);
    expect(alle).toMatch(/LiFePO4/);
    expect(alle).toMatch(/Gesteuert wird Ihr Speicher dadurch nicht/);
    expect(alle).toMatch(/echten Wert vom BMS/);
    // Und dass ein echter BMS-Wert immer gewinnt.
    expect(alle).toMatch(/überschreibt ihn nie/);
  });

  it('spricht KUNDEN-Deutsch: kein Register, kein Modbus, kein BMS-Jargon', () => {
    const text = [
      S.SOC_VOLTAGE_TITEL,
      S.SOC_VOLTAGE_INTRO,
      S.SOC_VOLTAGE_ERNEUT_TESTEN,
      ...S.SOC_VOLTAGE_FOLGEN,
      ...S.SOC_VOLTAGE_FELDER.flatMap((f) => [f.label, f.hilfe]),
    ].join(' ');
    for (const wort of ['Register', 'Modbus', 'Solarman', 'Decoder', 'soc_pct']) {
      expect(text).not.toContain(wort);
    }
  });
});

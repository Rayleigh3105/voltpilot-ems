import { describe, expect, it } from 'vitest';
import {
  RUECKNAHME_FOLGEN,
  TOTMANN_HINWEIS,
  effektiverFc,
  folgen,
  freigabeZustand,
  leistungsBeleg,
  neueSchaltForm,
  regelAktion,
  schaltFehler,
  schaltRumpf,
  testErgebnis,
  testWertFehler,
  verbraucherRumpf,
  zahl,
} from './schaltFreigabe';

function onOff() {
  return { ...neueSchaltForm(), adresse: '3', nennleistung: '3,5' };
}

function sollwert() {
  return {
    ...neueSchaltForm(),
    art: 'setpoint' as const,
    registerArt: 'holding',
    adresse: '100',
    minWert: '1',
    maxWert: '10',
    sicherWert: '0',
    skalierung: '0,001',
    nennleistung: '10',
  };
}

describe('das Formular', () => {
  it('nimmt ein deutsches Komma als Normal-Eingabe', () => {
    expect(zahl('0,001')).toBeCloseTo(0.001);
    expect(zahl(' 3,5 ')).toBeCloseTo(3.5);
    expect(zahl('')).toBeNull();
    expect(zahl('abc')).toBeNull();
  });

  it('leitet den Funktionscode aus der Registerart ab', () => {
    // Eine Spule kennt nur FC5 - die Wahl darüber ist gar keine.
    expect(effektiverFc({ ...onOff(), registerArt: 'coil', fc: '16' })).toBe(5);
    // Ein Register bekommt FC16 als Vorauswahl, NICHT FC6.
    expect(effektiverFc({ ...sollwert(), fc: '16' })).toBe(16);
    expect(effektiverFc({ ...sollwert(), fc: '6' })).toBe(6);
  });

  it('nennt jeden Fehler beim Namen und sammelt sie alle', () => {
    const leer = neueSchaltForm();
    const e = schaltFehler(leer);
    expect(e.join(' ')).toContain('Registeradresse');
    expect(e.join(' ')).toContain('Nennleistung');
    expect(e.length).toBeGreaterThan(1);

    expect(schaltFehler({ ...onOff(), einWert: '1', ausWert: '1' }).join(' '))
      .toContain('nie wieder ausschalten');
    expect(schaltFehler({ ...onOff(), einWert: '300' }).join(' ')).toContain('nur 0 und 1');
    expect(schaltFehler({ ...sollwert(), registerArt: 'coil' }).join(' '))
      .toContain('braucht ein Register');
    expect(schaltFehler({ ...sollwert(), minWert: '10', maxWert: '1' }).join(' '))
      .toContain('unter dem größten');
    expect(schaltFehler({ ...sollwert(), skalierung: '0' }).join(' ')).toContain('ungleich 0');
    expect(schaltFehler(onOff())).toEqual([]);
    expect(schaltFehler(sollwert())).toEqual([]);
  });

  it('schickt nur die Felder der gewählten Schalt-Art', () => {
    // Ein Sollwert, der einen Ein-Wert mitschickte, suggerierte eine Konstante,
    // die niemand freigegeben hat - und umgekehrt.
    const on = schaltRumpf(onOff());
    expect(on.onValue).toBe(1);
    expect(on.minValue).toBeNull();
    const sp = schaltRumpf(sollwert());
    expect(sp.onValue).toBeNull();
    expect(sp.minValue).toBe(1);
    expect(sp.writeFc).toBe(16);
    expect(verbraucherRumpf(onOff()).ratedPowerKw).toBeCloseTo(3.5);
  });
});

describe('der Testwert', () => {
  it('muss IN der Klemme liegen und wird nie stillschweigend hineingeklemmt', () => {
    const f = sollwert();
    expect(testWertFehler(f, '5')).toBeNull();
    expect(testWertFehler(f, '30')).toContain('zwischen 1 und 10');
    expect(testWertFehler(f, '')).toContain('innerhalb der Grenzen');
    // Ein/Aus hat keinen Testwert - die Konstante steht fest.
    expect(testWertFehler(onOff(), '')).toBeNull();
  });
});

describe('das Test-Ergebnis', () => {
  it('sagt beim Erfolg, dass das Gerät von selbst zurückfällt', () => {
    const r = testErgebnis({ passed: true, switched: { written: 1, offAfterS: 30 } });
    expect(r.zustand).toBe('bestanden');
    expect(r.satz).toContain('30 Sekunden');
    expect(r.satz).toContain('von selbst');
  });

  it('trennt den Beleg vom Satz - und nennt einen widersprechenden Rückleser', () => {
    const ok = testErgebnis({
      passed: true,
      switched: { written: 1, offAfterS: 30, readback: 1, readbackMatches: true },
    });
    expect(ok.zustand === 'bestanden' && ok.belege[0]).toContain('meldet den geschriebenen Wert');
    const miss = testErgebnis({
      passed: true,
      switched: { written: 1, offAfterS: 30, readback: 0, readbackMatches: false },
    });
    expect(miss.zustand === 'bestanden' && miss.belege[0]).toContain('Achtung');
    // Ohne Rücklese-Register gibt es keinen Beleg - nie einen erfundenen.
    const none = testErgebnis({ passed: true, switched: { written: 1, offAfterS: 30 } });
    expect(none.zustand === 'bestanden' && none.belege).toEqual([]);
  });

  it('ist ein TIMEOUT ausdrücklich „unklar", nie „fehlgeschlagen"', () => {
    // Der Schreibvorgang kann angekommen sein und nur seine Antwort verloren -
    // genau dafür gibt es das automatische Aus auf der Box.
    const r = testErgebnis({ passed: false, errorCode: 'timeout' });
    expect(r.zustand).toBe('unklar');
    expect(r.satz).toContain('fällt es von selbst wieder zurück');
  });

  it('nennt eine bekannte Fehlklasse beim Namen und erfindet keine', () => {
    expect(testErgebnis({ passed: false, errorCode: 'unreachable' }).satz)
      .toContain('nicht erreichbar');
    expect(testErgebnis({ passed: false, errorCode: 'was-neues', message: 'Serverwort' }).satz)
      .toBe('Serverwort');
    expect(testErgebnis(null).zustand).toBe('laeuft');
  });
});

describe('die Evidenz', () => {
  it('behauptet ohne beide Messwerte GAR NICHTS', () => {
    expect(leistungsBeleg(null, 3)).toBeNull();
    expect(leistungsBeleg(0.2, null)).toBeNull();
  });

  it('nennt Richtung und beide Zahlen, und benennt auch das Ausbleiben', () => {
    expect(leistungsBeleg(0.1, 3.4)).toContain('gestiegen');
    expect(leistungsBeleg(3.4, 0.1)).toContain('gefallen');
    expect(leistungsBeleg(3.4, 3.41)).toContain('nicht verändert');
  });
});

describe('was der Assistent zusagt', () => {
  it('nennt bei Ein/Aus genau die zwei Werte', () => {
    const f = folgen({ ...onOff(), einWert: '1', ausWert: '0' });
    expect(f[0]).toContain('nur die Werte 1 (ein) und 0 (aus)');
    expect(f[0]).toContain('nie einen dritten');
  });

  it('nennt beim Sollwert die Klemme UND den Sicherheitswert', () => {
    const f = folgen(sollwert());
    expect(f[0]).toContain('zwischen 1 und 10');
    expect(f[1]).toContain('bricht die Verbindung ab');
  });

  it('nennt IMMER die ehrliche Totmann-Grenze', () => {
    // Ein generisches Modbus-Gerät hat keinen eingebauten Geräte-Totmann; wer
    // das nicht sagt, verspricht eine Sicherheit, die es nicht gibt.
    expect(folgen(onOff())).toContain(TOTMANN_HINWEIS);
    expect(folgen(sollwert())).toContain(TOTMANN_HINWEIS);
    expect(TOTMANN_HINWEIS).toContain('eigene Sicherheitsabschaltung');
  });

  it('nennt bei der Rücknahme, dass die Regeln stoppen', () => {
    expect(RUECKNAHME_FOLGEN.join(' ')).toContain('Regeln für dieses Gerät stoppen');
    expect(RUECKNAHME_FOLGEN.join(' ')).toContain('Messwerte');
  });
});

describe('der Freigabe-Zustand', () => {
  it('ist über alle drei Vertrauens-Stufen EINE Anzeige', () => {
    expect(freigabeZustand({ schaltbar: true, quelle: 'pruefstand' }).wort)
      .toBe('Von VoltPilot freigegeben');
    expect(freigabeZustand({ schaltbar: true, quelle: 'vorlage' }).wort)
      .toBe('Geprüfte Vorlage');
    expect(freigabeZustand({ schaltbar: true, quelle: 'selbst' }).wort)
      .toBe('Von Ihnen freigegeben');
  });

  it('ist „gesperrt" ein ZUSTAND, kein Fehler', () => {
    const z = freigabeZustand({ schaltbar: false });
    expect(z.stufe).toBe('gesperrt');
    expect(z.ton).toBe('unbekannt');
    expect(z.satz).toContain('liefert Messwerte');
    // Kein Warnton und kein Wort, das nach Defekt klingt.
    expect(z.satz).not.toContain('Fehler');
  });

  it('nennt das Datum der eigenen Freigabe, wenn es eines gibt', () => {
    expect(freigabeZustand({ schaltbar: true, quelle: 'selbst', releasedAt: '2026-08-12T10:00:00Z' })
      .satz).toContain('12.08.2026');
    expect(freigabeZustand({ schaltbar: true, quelle: 'selbst' }).satz)
      .not.toContain('am undefined');
  });
});

describe('die Brücke zur Regel-Welt', () => {
  it('bietet die Aktion NUR nach einer Freigabe an', () => {
    // Eine Aktion, die nichts bewirken kann, wäre ein Knopf ins Leere.
    expect(regelAktion({ schaltbar: false }, 'on_off')).toBeNull();
    expect(regelAktion({ schaltbar: true }, 'on_off')).toBe('onoff');
    expect(regelAktion({ schaltbar: true }, 'setpoint')).toBe('setpoint');
  });
});
